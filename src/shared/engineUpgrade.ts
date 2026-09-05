// Item 42: upgrading the container engine itself, rather than the estate's
// whole package set.
//
// The patch panel already installs updates; this is the narrow scope for the
// four packages Docker ships, and the reason it is its own thing rather than a
// `PatchScope` value is the caveat below.
//
// RESTARTING THE DAEMON STOPS EVERY CONTAINER, unless `live-restore` is on.
// Measured on a real daemon: `docker info --format '{{json .LiveRestoreEnabled}}'`
// answers `false` on a stock install. That flag is READ rather than the
// behaviour being tested -- this build asks the daemon what it is configured to
// do and reports the answer, which is a weaker claim than watching a restart
// and is stated as such wherever it is shown.
//
// AND `apt-get install docker-ce` ON THE WRONG HOST INSTALLS A SECOND ENGINE.
// Debian ships `docker.io`; Docker's own repository ships `docker-ce`, and they
// conflict. A host running the distribution's package has none of these four
// installed, so an "upgrade" would be a fresh install of a different engine
// from a repository the host may not even have.
//
// THE INSTALLED SET IS NOT PARSED, AND THAT IS DELIBERATE. The first version of
// this file decided it by searching the package block for the package names,
// and writing the fixture found the bug immediately: dpkg's own error is
// `dpkg-query: no packages found matching docker-ce`, which CONTAINS the name.
// A substring search over an error message concluded the package was installed
// on a host that has never had it. A correct parser for `dpkg-query` and
// `rpm -q` could be written -- but not verified here, with no Linux host
// carrying Docker's packages -- and an unverified parser standing between an
// operator and a second container engine is worse than no parser. So the block
// is SHOWN, and the operator confirms they have read it. The one thing parsed
// is the live-restore flag, which was measured.

import type { PackageManager } from './hostFacts'
import { packageJobSpec } from './packageStep'
import type { JobSpec } from './jobs'

/**
 * The packages Docker's own repository ships, in the order they depend.
 *
 * `containerd.io` and `docker-ce-cli` are separate packages and an upgrade that
 * named only `docker-ce` would leave a CLI and a runtime from the previous
 * release beside a new daemon.
 */
export const ENGINE_PACKAGES: readonly string[] = [
  'docker-ce',
  'docker-ce-cli',
  'containerd.io',
  'docker-compose-plugin'
]

export type EngineUpgradeRefusal = 'no-repo' | 'not-installed' | 'unchecked'

export const ENGINE_REFUSAL_HELP: Record<EngineUpgradeRefusal, string> = {
  'no-repo':
    'Docker publishes no repository for this package manager, so there are no docker-ce packages to upgrade. Whatever engine this server runs came from somewhere else, and upgrading it is that source’s business.',
  'not-installed':
    'Read what the precheck listed and confirm docker-ce is actually installed. If this server runs an engine from somewhere else — Debian’s docker.io, or a distribution package — installing docker-ce would put a SECOND, conflicting engine on the machine rather than upgrading the one that is there, and nothing in this build can tell those two cases apart from the package manager’s output.',
  unchecked:
    'Nothing has been read from this server yet. Run the precheck first: what is installed and whether the daemon keeps containers running across a restart are both facts about this host, and neither can be assumed.'
}

/** Managers Docker publishes a repository for. Alpine's `docker` package and
 *  Arch's come from their own distributions and are not these four. */
export function engineRepoExists(manager: PackageManager): boolean {
  return manager === 'apt' || manager === 'dnf' || manager === 'yum'
}

export const ENGINE_PRECHECK_MARKERS = {
  liveRestore: '===OPSMAXX-ENGLR===',
  packages: '===OPSMAXX-ENGPKG===',
  running: '===OPSMAXX-ENGRUN==='
} as const

/**
 * What has to be known before this can be offered.
 *
 * Read-only, no sudo, and every block `|| true` so one missing binary does not
 * cost the others. The package block's output is SHOWN rather than parsed --
 * `dpkg-query` and `rpm -q` word their answers differently and a parser for
 * them was not written here, because it could not be verified against a real
 * Linux host with Docker's packages on it. What IS parsed is the live-restore
 * flag, which was measured.
 */
export function buildEnginePrecheckCommand(manager: PackageManager): string {
  const query =
    manager === 'apt'
      ? ENGINE_PACKAGES.map(
          (n) => `dpkg-query -W -f='\${Package} \${Version} \${Status}\\n' '${n}' 2>&1 || true`
        ).join('; ')
      : ENGINE_PACKAGES.map((n) => `rpm -q '${n}' 2>&1 || true`).join('; ')
  return [
    `echo "${ENGINE_PRECHECK_MARKERS.liveRestore}"`,
    `docker info --format '{{json .LiveRestoreEnabled}}' 2>&1 || true`,
    `echo "${ENGINE_PRECHECK_MARKERS.packages}"`,
    query,
    `echo "${ENGINE_PRECHECK_MARKERS.running}"`,
    'docker ps -q 2>/dev/null | wc -l || true'
  ].join('; ')
}

export interface EnginePrecheck {
  /** As the daemon reports its own configuration. `null` when it did not
   *  answer -- which is not `false`: a daemon that could not be asked has not
   *  said containers will stop. */
  liveRestore: boolean | null
  /** The package block, verbatim, for the operator to read. */
  packagesText: string
  /** How many containers are running, or null when that could not be counted. */
  running: number | null
}

function block(output: string, marker: string): string {
  const at = output.indexOf(marker)
  if (at < 0) return ''
  const from = at + marker.length
  let end = output.length
  for (const m of Object.values(ENGINE_PRECHECK_MARKERS)) {
    const i = output.indexOf(m, from)
    if (i >= 0 && i < end) end = i
  }
  return output.slice(from, end).trim()
}

export function parseEnginePrecheck(output: string): EnginePrecheck {
  const lr = block(output, ENGINE_PRECHECK_MARKERS.liveRestore)
  const run = Number(block(output, ENGINE_PRECHECK_MARKERS.running))
  return {
    // Exactly `true` or `false` and nothing else. A daemon that is not running
    // prints an error here, and reading that as `false` would produce the
    // confident sentence "your containers will stop" about a host where
    // nothing was asked.
    liveRestore: lr === 'true' ? true : lr === 'false' ? false : null,
    packagesText: block(output, ENGINE_PRECHECK_MARKERS.packages),
    running: Number.isFinite(run) && block(output, ENGINE_PRECHECK_MARKERS.running) !== '' ? run : null
  }
}

export interface EngineUpgradePlan {
  ok: boolean
  refusal: EngineUpgradeRefusal | null
  /** Everything that would otherwise be discovered afterwards. */
  caveats: string[]
  spec: JobSpec | null
}

/**
 * What upgrading the engine here would do.
 *
 * The caveats are not a formality and they are not sorted by severity: the
 * first one is always what happens to the containers, because that is the thing
 * an operator running this at four in the afternoon has not thought about.
 */
export function planEngineUpgrade(
  manager: PackageManager,
  precheck: EnginePrecheck | null,
  opts: { sudo?: boolean; precheckRead?: boolean } = {}
): EngineUpgradePlan {
  const no = (refusal: EngineUpgradeRefusal): EngineUpgradePlan => ({
    ok: false,
    refusal,
    caveats: [],
    spec: null
  })
  if (!engineRepoExists(manager)) return no('no-repo')
  if (precheck === null) return no('unchecked')
  // The human is the check here, for the reason in the header: no parser for
  // this block could be verified, and the cost of getting it wrong is a second
  // container engine on somebody's server.
  if (opts.precheckRead !== true) return no('not-installed')

  const caveats: string[] = []
  if (precheck.liveRestore === true) {
    caveats.push(
      'This daemon reports live-restore ON, so containers are configured to keep running across a daemon restart. That is what the daemon says about itself; nothing here has watched it happen.'
    )
  } else if (precheck.liveRestore === false) {
    caveats.push(
      precheck.running === null
        ? 'This daemon reports live-restore OFF: restarting it stops every container on this server, and the upgrade restarts it.'
        : `This daemon reports live-restore OFF: restarting it stops all ${precheck.running} running container(s) on this server, and the upgrade restarts it.`
    )
  } else {
    // Not `false`. A daemon that could not be asked has not said anything.
    caveats.push(
      'The daemon did not say whether live-restore is on, so whether this stops every container on the server is unknown rather than no.'
    )
  }
  caveats.push(
    'All four of Docker’s packages are upgraded together. Upgrading only the daemon leaves a CLI and a container runtime from the previous release beside it.'
  )
  caveats.push(
    'This upgrades from whichever repository the server is configured with. It does not add one, and it does not pin a version.'
  )

  return {
    ok: true,
    refusal: null,
    caveats,
    // The existing builder, not a second one: it validates every name, quotes
    // them, and appends the manager's own "what is installed now" step, which
    // is the only honest way to end an upgrade.
    spec: packageJobSpec(manager, 'install', [...ENGINE_PACKAGES], { sudo: opts.sudo })
  }
}
