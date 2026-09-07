import type { JobSpec, JobStep } from './jobs'

// Item 34d: the fourth typed step kind.
//
// NO PASSWORD EVER REACHES A STEP. Not from the vault, not redacted, not piped.
// The roadmap's line is that a password "must come from the vault and never
// appear in a step string (pattern redaction is not enough)", and the honest
// version of that constraint is that this builder has no action that sets one.
//
// The reason is the approval record rather than the terminal. A step's text is
// stored, hashed, compared and shown -- `verifyApproval` needs the literal
// bytes, the dialog renders them, and the approval log keeps them. Redaction
// happens at the writer, which is exactly one of those four places. A password
// in a step is a password in a record that outlives the job.
//
// So accounts are created WITHOUT a password and locked, which is what
// `useradd` does by default anyway, and access arrives as a key through item
// 36's gate -- the path that has a rollback.

export const USER_ACTIONS = ['create', 'lock', 'unlock', 'add-group', 'set-expiry', 'delete'] as const
export type UserAction = (typeof USER_ACTIONS)[number]

/** Same discipline as the unit and package names: an enumerated set, because
 *  this is interpolated into a command that runs as root. POSIX portable user
 *  names are lower-case, digits, underscore and hyphen, not starting with a
 *  hyphen; `$` is allowed at the end on Samba machine accounts and is left out
 *  deliberately. */
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
const GROUP_RE = USER_RE

/** Accounts this refuses to touch at all. Locking `root` locks the way back in
 *  on a server whose only other access is a key this app may itself have
 *  installed; deleting a system account removes files nothing will put back. */
export const PROTECTED_USERS = ['root', 'daemon', 'bin', 'sys', 'sync', 'nobody']

export type UserStepCheck = { ok: true } | { ok: false; reason: string }

export interface UserStepInput {
  action: UserAction
  user: string
  /** For `add-group`. */
  group?: string
  /** For `set-expiry`: `YYYY-MM-DD`, or empty to clear the expiry. */
  expiry?: string
  /** For `delete`: also remove the home directory. Its own decision, because
   *  it is the irreversible half. */
  removeHome?: boolean
}

export function checkUserStep(i: UserStepInput): UserStepCheck {
  const user = i.user.trim()
  if (user === '') return { ok: false, reason: 'Name the account.' }
  if (!USER_RE.test(user)) {
    return {
      ok: false,
      reason: 'A user name may only be lower-case letters, digits, underscore and hyphen, and may not start with a digit or hyphen. This text runs as root.'
    }
  }
  if (PROTECTED_USERS.includes(user)) {
    return {
      ok: false,
      reason: `ShellPilot will not change ${user}. Locking or deleting it can take away the only way back into a server, and no confirmation makes that recoverable from here.`
    }
  }
  if (i.action === 'add-group') {
    const g = (i.group ?? '').trim()
    if (!GROUP_RE.test(g)) return { ok: false, reason: 'Name the group, in the same character set as a user name.' }
  }
  if (i.action === 'set-expiry') {
    const e = (i.expiry ?? '').trim()
    // Empty clears it, which is a real thing to want. Anything else has to be
    // the one format `chage -E` takes without ambiguity.
    if (e !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
      return { ok: false, reason: 'The expiry date must be YYYY-MM-DD, or empty to remove the expiry.' }
    }
  }
  return { ok: true }
}

/**
 * The commands, per action.
 *
 * `create` makes a LOCKED account with no password, which is what `useradd`
 * does on its own -- said explicitly here so nobody adds `-p` later thinking
 * the omission was an oversight. Access arrives afterwards as a key, through
 * item 36's gate, which is the path with a rollback.
 */
export function userJobSpec(i: UserStepInput, opts: { sudo?: boolean } = {}): JobSpec {
  const check = checkUserStep(i)
  if (!check.ok) throw new Error(`refusing to build a user step: ${check.reason}`)
  const s = opts.sudo === false ? '' : 'sudo -n '
  const u = `'${i.user.trim()}'`
  const steps: JobStep[] = []

  switch (i.action) {
    case 'create':
      // No `-p`, and no password on the command line under any circumstances.
      // `-m` so the home directory exists; `-s /bin/bash` is NOT set, because
      // guessing a login shell for somebody else's estate is how a service
      // account ends up with one.
      steps.push({ command: `${s}useradd -m ${u}` })
      steps.push({ command: `${s}passwd -S ${u}` })
      break
    case 'lock':
      // `usermod -L` locks the password, and on its own it does NOT stop a key
      // login. `-e 1` expires the account, which does. Both, or the operator
      // believes an account is closed that is not.
      steps.push({ command: `${s}usermod -L -e 1 ${u}` })
      steps.push({ command: `${s}passwd -S ${u}` })
      break
    case 'unlock':
      steps.push({ command: `${s}usermod -U -e '' ${u}` })
      steps.push({ command: `${s}passwd -S ${u}` })
      break
    case 'add-group':
      steps.push({ command: `${s}usermod -aG '${(i.group ?? '').trim()}' ${u}` })
      steps.push({ command: `id -nG ${u}` })
      break
    case 'set-expiry': {
      const e = (i.expiry ?? '').trim()
      steps.push({ command: `${s}chage -E '${e === '' ? -1 : e}' ${u}` })
      steps.push({ command: `${s}chage -l ${u}` })
      break
    }
    case 'delete':
      // `-r` removes the home directory and mail spool. Its own decision, and
      // the title says which was chosen, because the two are not the same act.
      steps.push({ command: `${s}userdel${i.removeHome === true ? ' -r' : ''} ${u}` })
      steps.push({
        command: `if id ${u} >/dev/null 2>&1; then echo "still present" >&2; exit 1; else echo "removed"; fi`
      })
      break
  }

  const titles: Record<UserAction, string> = {
    create: `Create ${i.user} (locked, no password)`,
    lock: `Lock ${i.user}`,
    unlock: `Unlock ${i.user}`,
    'add-group': `Add ${i.user} to ${i.group}`,
    'set-expiry': (i.expiry ?? '').trim() === '' ? `Clear ${i.user}'s expiry` : `Expire ${i.user} on ${i.expiry}`,
    delete: i.removeHome === true ? `Delete ${i.user} AND its home directory` : `Delete ${i.user} (home kept)`
  }
  return { kind: 'command', title: titles[i.action], steps }
}
