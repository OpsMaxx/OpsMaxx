import type { JobSpec, JobStep } from './jobs'
import type { PackageManager } from './hostFacts'

// Item 34b: the second typed step kind.
//
// Same shape as 34a: an ACTION and a NAME, checked here, with the command built
// from them per package manager. What is different is that the command depends
// on which manager the server runs, and a job is ONE step list for every server
// in it -- `verifyApproval` compares the step text literally, so a spec whose
// command was substituted per server could not be checked against its own
// approval at all.
//
// So the manager is chosen once, by the operator, and a server that runs a
// different one is not a server this job may target. That is stricter than
// patch.ts, which builds a plan per server, and it is stricter on purpose: a
// patch run is "bring everything up to date" and this is "install exactly
// this", where a silent substitution is the whole danger.

export const PACKAGE_ACTIONS = ['install', 'remove', 'hold', 'unhold'] as const
export type PackageAction = (typeof PACKAGE_ACTIONS)[number]

// Anchored and narrow, for the reason serviceStep.ts gives about unit names:
// this value is interpolated into a command that runs as root. Package names
// across these managers use letters, digits and `. _ - + : ~ @`, and nothing
// else -- `+` for `g++`, `:` for apt's architecture suffix (`libc6:i386`), `~`
// for versions in `name=1.2~rc1`.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+:~@=-]{0,127}$/

export type PackageStepCheck = { ok: true } | { ok: false; reason: string }

export function checkPackageStep(
  manager: PackageManager,
  action: PackageAction,
  names: string[]
): PackageStepCheck {
  const clean = names.map((n) => n.trim()).filter((n) => n !== '')
  if (clean.length === 0) return { ok: false, reason: 'Name at least one package.' }
  if (clean.length > 25) {
    return { ok: false, reason: 'More than 25 packages in one job is a list nobody reads before confirming it.' }
  }
  for (const n of clean) {
    if (!NAME_RE.test(n)) {
      return {
        ok: false,
        reason: `"${n}" is not a package name. Letters, digits and . _ - + : ~ @ = only — this text is run as root on every server you picked.`
      }
    }
  }
  // Said as a refusal rather than silently doing nothing. "The job succeeded"
  // on a server where the pin was never applied is the worst of the three
  // possible answers: the operator now believes a version is held.
  if (action === 'hold' || action === 'unhold') {
    if (manager === 'apk') {
      return {
        ok: false,
        reason: 'apk has no way to hold a package at a version, so this cannot be done on an Alpine server. Nothing else on this job would tell you it had been skipped.'
      }
    }
    if (manager === 'pacman') {
      return {
        ok: false,
        reason: 'pacman holds a package by adding it to IgnorePkg in /etc/pacman.conf, which is a config-file edit rather than a command. OpsMaxx does not write that file yet, and appending to it blindly is how the same line ends up in it fourteen times.'
      }
    }
  }
  return { ok: true }
}

/** How each manager spells each action. A Record so a manager added to
 *  PACKAGE_MANAGERS is a compile error here rather than a silent gap. */
const VERBS: Record<PackageManager, Record<PackageAction, string | null>> = {
  apt: {
    // The same non-interactive frontend and config-file discipline patch.ts
    // uses, for the same reason: a prompt on a server nobody is looking at is
    // a job that hangs until its timeout.
    install: 'env DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install',
    // `remove`, never `purge`. Purge deletes configuration, which is not what
    // "remove this package" means to anybody who has not read the man page.
    remove: 'env DEBIAN_FRONTEND=noninteractive apt-get -y remove',
    hold: 'apt-mark hold',
    unhold: 'apt-mark unhold'
  },
  dnf: { install: 'dnf -y install', remove: 'dnf -y remove', hold: 'dnf versionlock add', unhold: 'dnf versionlock delete' },
  yum: { install: 'yum -y install', remove: 'yum -y remove', hold: 'yum versionlock add', unhold: 'yum versionlock delete' },
  zypper: { install: 'zypper -n install', remove: 'zypper -n remove', hold: 'zypper -n addlock', unhold: 'zypper -n removelock' },
  // pacman pins through `IgnorePkg` in /etc/pacman.conf rather than through a
  // command, so a hold here would be a config-file edit -- read, modify, write
  // back, with a marker so it can be found and undone. That is item 34c's
  // shape, not this one's, and doing it badly (a blind append) is how a
  // pacman.conf ends up with the same line fourteen times. Refused until 34c
  // exists, and refused OUT LOUD in checkPackageStep rather than by producing
  // a command that does nothing.
  pacman: {
    install: 'pacman -S --noconfirm',
    remove: 'pacman -R --noconfirm',
    hold: null,
    unhold: null
  },
  apk: { install: 'apk add', remove: 'apk del', hold: null, unhold: null }
}

export interface PackageStepOpts {
  sudo?: boolean
  skipVerify?: boolean
}

/** How each manager asks "is this installed, and at what version". The verify
 *  step, and the reason this is a typed kind: `apt-get install` exits 0 when it
 *  installed nothing because the name matched a virtual package. */
// Quoted here as well as validated in checkPackageStep. The check is the
// guard; this is the habit -- a name reaches these builders from one caller
// today, and an unquoted interpolation is a thing that stops being safe the
// moment somebody adds a second.
const QUERY: Record<PackageManager, (name: string) => string> = {
  apt: (n) => `dpkg-query -W -f='\${Package} \${Version} \${Status}\\n' '${n}'`,
  dnf: (n) => `rpm -q '${n}'`,
  yum: (n) => `rpm -q '${n}'`,
  zypper: (n) => `rpm -q '${n}'`,
  pacman: (n) => `pacman -Q '${n}'`,
  apk: (n) => `apk info -e '${n}'`
}

export function packageJobSpec(
  manager: PackageManager,
  action: PackageAction,
  names: string[],
  opts: PackageStepOpts = {}
): JobSpec {
  const clean = names.map((n) => n.trim()).filter((n) => n !== '')
  const verb = VERBS[manager][action]
  if (verb === null) {
    throw new Error(`refusing to build a ${action} for ${manager}, which has no command for it`)
  }
  const s = opts.sudo === false ? '' : 'sudo -n '
  const list = clean.map((n) => `'${n}'`).join(' ')
  const steps: JobStep[] = [{ command: `${s}${verb} ${list}` }]

  if (opts.skipVerify !== true && action !== 'hold' && action !== 'unhold') {
    // The state afterwards, in the manager's own words. For a remove this
    // SHOULD fail, so it is written as an assertion rather than a query whose
    // failure would be read as a broken job.
    const q = clean.map((n) => QUERY[manager](n)).join('; ')
    steps.push({
      command:
        action === 'remove'
          ? `if ${clean.map((n) => QUERY[manager](n)).join(' || ')} >/dev/null 2>&1; then echo "still installed" >&2; exit 1; else echo "removed"; fi`
          : q
    })
  }

  const what = clean.length === 1 ? clean[0] : `${clean.length} packages`
  return {
    kind: 'command',
    title: `${action[0].toUpperCase()}${action.slice(1)} ${what}`,
    steps
  }
}
