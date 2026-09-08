// Item 42's engine upgrade PLAN, which builds a job.
//
// Separate from `enginePrecheck.ts` because this half imports the job
// vocabulary and that half is needed by `shared/docker.ts`, which the MCP
// bridge can reach. See the header there.

import type { PackageManager } from './hostFacts'
import { packageJobSpec } from './packageStep'
import type { JobSpec } from './jobs'
import {
  ENGINE_PACKAGES,
  engineRepoExists,
  type EnginePrecheck,
  type EngineUpgradeRefusal
} from './enginePrecheck'

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
