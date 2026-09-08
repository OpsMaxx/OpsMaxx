import { isVaultLocked } from '../../lib/withVaultUnlock'
import { UnlockVaultButton } from './UnlockVaultButton'

/**
 * A failed on-demand read, with the unlock attached when that is what failed.
 *
 * ===========================================================================
 * WHY
 * ===========================================================================
 *
 * A locked vault stops two different things, and only one of them had an
 * answer.
 *
 *  1. THE BACKGROUND SWEEP. `fleetSampler` breaks out of its target loop, the
 *     status bar says "Checks paused", and every panel fed by the sweep is
 *     empty. SweepEmpty covers this: it asks the sampler what is stopping it
 *     and raises the unlock prompt in place.
 *
 *  2. AN ON-DEMAND READ. "Read services", "Read containers", "Read
 *     filesystems", a log tail — each opens its own connection, so each fails
 *     on its own, and each failure arrived as a raw rejection printed straight
 *     into a red note:
 *
 *       Error invoking remote method 'services:collect':
 *       OPSMAXX_VAULT_LOCKED: this server authenticates with a vault
 *       credential, and the vault is locked.
 *
 *     An internal token, an IPC channel name, and no way to act. The whole
 *     `withVaultUnlock` / `UnlockVaultButton` apparatus already existed for
 *     exactly this and had reached the connection surfaces — SFTP, tunnels,
 *     VPN, databases, the terminal transport — and none of the monitor panels.
 *
 * So this is the display half of the same rule UnlockVaultButton states: never
 * name a locked vault without offering to unlock it. `withVaultUnlock` around
 * the read is the other half, and handles the common case before anyone sees a
 * message at all — this is what is left when someone dismisses that prompt and
 * later changes their mind, which otherwise stranded them on the raw token
 * with no second chance.
 *
 * Deliberately NOT a general error prettifier. Every other failure is passed
 * through exactly as it arrived: a read that failed because sudo was refused
 * or a binary is missing must keep saying so, and a component that started
 * rewording those would be hiding the diagnosis this app spends its effort on.
 */
export function PanelError({
  error,
  reason,
  onRetry
}: {
  /** The failure as it arrived. Null renders nothing. */
  error: string | null
  /** Why this screen needs the vault, shown in the unlock dialog. */
  reason: string
  /**
   * Re-run the read. Called only after a SUCCESSFUL unlock — a cancelled
   * prompt leaves the message exactly where it was, because re-running against
   * the same locked vault would replace it with an identical one.
   */
  onRetry?: () => void
}): React.JSX.Element | null {
  if (error === null || error === '') return null

  if (!isVaultLocked(error)) {
    return <div className="panel-note is-alarm">{error}</div>
  }

  return (
    <div className="panel-note is-alarm">
      {/* The reader's words, not the resolver's. What they need to know is
          which of their credentials is out of reach and that one action fixes
          it — the marker and the IPC channel name are neither. */}
      <span className="grow">
        This server signs in with a credential from the vault, and the vault is locked.
      </span>
      <UnlockVaultButton reason={reason} onUnlocked={onRetry} />
    </div>
  )
}

/**
 * Hosts a WRITE did not reach, because their credential is in a locked vault.
 *
 * ===========================================================================
 * WHY THIS DOES NOT RETRY, WHEN PanelError ABOVE DOES
 * ===========================================================================
 *
 * A read is idempotent and a write is not. `withVaultUnlock` retries the same
 * closure once, which is exactly right for "read the containers" and exactly
 * wrong for "run this command on fifteen servers": a broadcast, a job and a key
 * revoke each fail PER HOST, so a run where twelve hosts succeeded and three
 * hit a locked vault would, on a blanket retry, run the command a second time
 * on the twelve that already did it. That is a duplicate execution nobody
 * asked for, on hosts nobody was told about.
 *
 * The safety argument that makes the READ retry sound does not extend here
 * either. A locked vault throws inside `resolveChainSecrets`, which is
 * evaluated as an argument before `sshExec` is entered, so a host that failed
 * this way certainly ran nothing — but that is a statement about the hosts that
 * FAILED, not about the ones that succeeded beside them.
 *
 * There is a second reason, and it is the stronger one. Every write in this app
 * is authorised per run, by a human, at the moment of running: `planJob` sizes
 * the confirmation by risk and blast radius, `jobApprovalFor` mints the record
 * when the dialog is answered, and `verifyApproval` re-derives and compares it
 * in main. Re-running after an unlock would be a second execution off one
 * confirmation. So this offers the unlock and stops there; the operator presses
 * Run again, and that press goes through the whole approval path exactly as the
 * first one did.
 */
export function VaultLockedHosts({
  names,
  reason
}: {
  /** Hosts skipped this way. Empty renders nothing. */
  names: string[]
  reason: string
}): React.JSX.Element | null {
  if (names.length === 0) return null
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  return (
    <div className="panel-note is-watch">
      <span className="grow">
        {/* "did not run" rather than "failed": nothing was attempted on these
            hosts, and an operator deciding what to do next needs that
            distinction more than they need the word failed. */}
        {list} did not run — {names.length === 1 ? 'its' : 'their'} credential is in the vault, and
        the vault is locked. Unlock it and run again.
      </span>
      {/* No onUnlocked, deliberately. See the note above: a write gets a fresh
          confirmation, not an automatic second execution. */}
      <UnlockVaultButton reason={reason} />
    </div>
  )
}
