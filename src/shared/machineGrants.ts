/**
 * Standing machine grants: the secrets this machine can read without the
 * master password, so that work with nobody present still happens.
 *
 * `MACHINE_ONLY_SECRET_PREFIX` (main/services/secrets.ts) puts a secret in the
 * OS keychain instead of the vault. That is what lets a 03:00 backup run after
 * an overnight reboot, and the trade only holds because such a secret is
 * excluded from `exportSecrets` and refused by `importSecrets` — it cannot
 * leave in a bundle.
 *
 * What was missing is the other half of an authorisation: a way to see it and
 * take it back. Two of these ship on users' machines already and no screen
 * listed either. A standing authorisation nothing enumerates cannot be
 * withdrawn.
 *
 * NOTHING HERE IS A SECRET VALUE. A grant is an id, a subject and a date. The
 * enumerator deliberately does not decrypt, so no value crosses IPC to reach
 * this list — the list is about WHO IS AUTHORISED, and showing the secret would
 * be the one thing keeping it in the keychain is meant to prevent.
 */

/** What a grant is for, worked out from its id by the module that owns the id
 *  scheme. `other` is honest rather than a fallback: a future kind shows up as
 *  its raw id instead of being described wrongly. */
export type MachineGrantSubject =
  | { kind: 'backup-passphrase'; destinationId: string }
  | { kind: 'addy'; secretKind: string; accountId: string }
  | { kind: 'other' }

export interface MachineGrant {
  /** The secret's id — never its value. */
  id: string
  subject: MachineGrantSubject
  /**
   * ISO 8601, when the grant was first recorded.
   *
   * Absent for every grant made before OpsMaxx started recording it, which is
   * every grant that already exists on a user's machine. The list says so
   * rather than showing a blank, because "granted at some unknown time" and
   * "granted just now" are not the same fact.
   */
  grantedAt?: string
}

/** The slice of a backup destination this list needs. Structural rather than
 *  `BackupDestination`, so the row can be built from whatever the panel has. */
export interface GrantDestination {
  id: string
  name: string
  passphraseSource?: 'vault' | 'machine'
}

export interface MachineGrantView {
  id: string
  /** What it is for, in words a person recognises — or an honest description of
   *  the id when it cannot be resolved to one. No invented friendly names. */
  title: string
  /** What stops working after revoking. Shown BEFORE the button, never after:
   *  the whole failure mode here is finding out at 03:00. */
  consequence: string
  grantedAt?: string
  /** The thing this was granted for no longer exists. */
  orphaned: boolean
  /** A hazard specific to this row, when there is one. */
  note?: string
}

/** Every row says this, once, at the top of the section. */
export const MACHINE_GRANT_MEANING =
  'Each of these is readable by anything running as you on this machine, without your ' +
  'master password. That is exactly what lets the work below happen while you are not here, ' +
  'and it is the reason to check the list.'

const BACKUP_BUNDLE_WARNING =
  'Bundles already written with it can only be opened with it, so keep a copy somewhere this machine is not.'

export function machineGrantView(
  grant: MachineGrant,
  destinations: readonly GrantDestination[]
): MachineGrantView {
  const { id, subject, grantedAt } = grant

  if (subject.kind === 'backup-passphrase') {
    const dest = destinations.find((d) => d.id === subject.destinationId)
    if (!dest) {
      return {
        id,
        grantedAt,
        orphaned: true,
        title: `Backup passphrase for a destination that no longer exists (${subject.destinationId})`,
        consequence: `Nothing runs with this any more — the destination it was made for is gone. Revoking removes it from this machine. ${BACKUP_BUNDLE_WARNING}`
      }
    }
    return {
      id,
      grantedAt,
      orphaned: false,
      title: `Backup passphrase for “${dest.name}”`,
      consequence: `Revoke this and the next scheduled run of “${dest.name}” stops, reporting that no passphrase is stored, until you store another one or move the destination back to a vault entry — which means unlocking the vault after every restart. ${BACKUP_BUNDLE_WARNING}`,
      // Not an orphan — the destination is live — but the grant is idle, and an
      // idle authorisation is still an authorisation.
      note:
        dest.passphraseSource === 'machine'
          ? undefined
          : `“${dest.name}” is set to take its passphrase from the vault, so this one is not being used by anything.`
    }
  }

  if (subject.kind === 'addy') {
    // No list of addy accounts is kept on disk — the session holds one in
    // memory once a device attaches — so this row cannot say whether the
    // account still exists, and does not pretend to.
    const what =
      subject.secretKind === 'account'
        ? 'account key'
        : subject.secretKind === 'root'
          ? 'root key'
          : 'device key'
    return {
      id,
      grantedAt,
      orphaned: false,
      title: `addy ${what} for account ${subject.accountId || 'unknown'}`,
      consequence:
        subject.secretKind === 'device'
          ? 'Revoke this and this device is no longer the device that account knows. A device key deliberately cannot be restored — the machine has to pair again and gets a new entry in the device list.'
          : subject.secretKind === 'account'
            ? 'Revoke this and this device can no longer read what the account has synced until it pairs again, which re-delivers the key.'
            : 'Revoke this and this device can no longer authorise an epoch change. The twelve-word recovery phrase brings it back.'
    }
  }

  return {
    id,
    grantedAt,
    orphaned: false,
    title: id,
    consequence:
      'OpsMaxx cannot say what holds this id, so it cannot say what stops. Revoke it only if you know what put it here.'
  }
}
