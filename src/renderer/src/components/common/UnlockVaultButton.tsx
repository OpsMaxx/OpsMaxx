import { LockOpen } from 'lucide-react'
import { useVaultPrompt } from '../../store/vaultPrompt'

/**
 * "The vault is locked" — with the unlock attached to it.
 *
 * Several screens named a locked vault and stopped there: the monitoring
 * panels, the status-bar chip, the credential proxy's parked-calls note, the
 * S3 destination picker, the Docker env writer. Each told the reader to go and
 * unlock it, and none of them offered to. store/toast.ts already has the
 * argument written down — telling someone to unlock the vault and try again
 * "means: find the vault, work out what a vault is, unlock it, come back" —
 * and withVaultUnlock already applies it to operations that FAIL on a locked
 * vault. This is the same rule for the screens that never got as far as
 * failing, because they disable themselves first.
 *
 * The dialog it raises is the app's own: Touch ID or Windows Hello where the
 * machine has them and the user has opted in, the passphrase otherwise. This
 * component neither reads nor handles a credential — `request` resolves to a
 * boolean and nothing else crosses back.
 */
export function UnlockVaultButton({
  reason,
  label = 'Unlock vault',
  className = 'btn sm',
  onUnlocked
}: {
  /** Why this screen needs it, shown in the dialog. Written for the person reading it. */
  reason: string
  label?: string
  className?: string
  /** Run only on a successful unlock — never after a cancelled prompt. */
  onUnlocked?: () => void
}): React.JSX.Element {
  return (
    <button
      className={className}
      onClick={() => {
        void useVaultPrompt
          .getState()
          .request(reason)
          .then((unlocked) => {
            if (unlocked) onUnlocked?.()
          })
      }}
    >
      <LockOpen size={13} /> {label}
    </button>
  )
}
