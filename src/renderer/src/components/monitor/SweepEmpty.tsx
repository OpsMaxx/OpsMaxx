import { RefreshCw, Settings2 } from 'lucide-react'
import { useApp } from '../../store/app'
import { useFleetStatus, sweepBlock } from '../../store/fleetStatus'
import { openSettings } from '../../store/nav'
import { UnlockVaultButton } from '../common/UnlockVaultButton'

/**
 * The empty state for a panel that shows what the background sweep collected.
 *
 * One component for all of them, because they were all wrong in the same way.
 * Each carried its own paragraph covering every reason the panel might be
 * empty — the sweep is hourly, the server might be new, the module might be
 * off, background checking might be off — and ended by telling the reader to
 * press Check now. Four maybes and an instruction, none of which is the answer
 * on any particular day, and on the day this was found none of which was even
 * true: the vault was locked, the sweep was collecting nothing, and Check now
 * ran the same sweep that was already failing.
 *
 * So this states ONE reason and offers ONE control, chosen by sweepBlock from
 * the sampler's own idleReason. The reassurance the old copy carried — nothing
 * is enabled, nothing is written — moved to the panel's `about` popover, which
 * is where a standing property of the probe belongs; it is not news every time
 * a table happens to be empty.
 */
export function SweepEmpty({
  subject,
  note,
  busy = false,
  onCheckNow
}: {
  /** What this panel collects, as a sentence: "No security posture has been collected yet." */
  subject: string
  /**
   * A panel-specific FACT to add, if it has one — "3 servers refused the
   * probe". Not reassurance and not a second instruction: those are what this
   * component exists to remove.
   */
  note?: React.ReactNode
  busy?: boolean
  /** Only called for the 'check-now' action; the other kinds cannot be fixed by sweeping. */
  onCheckNow: () => void
}): React.JSX.Element {
  const status = useFleetStatus((s) => s.status)
  const enabled = useApp((s) => s.settings.fleetSamplingEnabled)
  const block = sweepBlock(status, enabled)

  return (
    <div className="panel-empty">
      <p className="panel-empty-title">{subject}</p>
      <p className="panel-empty-body">
        {block.reason} {block.fix}
      </p>
      {note !== undefined && note !== null && note !== false && (
        <p className="panel-empty-body">{note}</p>
      )}
      <div className="panel-empty-actions">
        {/* Raises the app's own unlock dialog right here — Touch ID or Windows
            Hello where the machine has it, the passphrase otherwise — rather
            than sending the reader to Settings to do it and come back. That is
            what store/vaultPrompt.ts exists for, in its own words: so a caller
            can ask, "rather than the operation simply failing with advice the
            user then has to act on manually and retry by hand."

            The unlock resolves to a boolean, so a success sweeps immediately
            and the panel fills. Two clicks from a locked vault to data, and
            neither of them is a settings screen. */}
        {block.action === 'unlock-vault' && (
          <UnlockVaultButton
            className="btn primary sm"
            reason="Unlocking lets background checking resume, so this panel can fill."
            // Only on success — sweeping after a cancelled prompt runs the same
            // sweep that is still breaking on the same lock.
            onUnlocked={onCheckNow}
          />
        )}
        {block.action === 'open-settings' && (
          <button className="btn primary sm" onClick={() => openSettings('monitoring')}>
            <Settings2 size={13} /> Open Monitoring settings
          </button>
        )}
        {block.action === 'check-now' && (
          <button className="btn primary sm" disabled={busy} onClick={onCheckNow}>
            <RefreshCw size={13} className={busy ? 'spin' : undefined} /> Check now
          </button>
        )}
      </div>
    </div>
  )
}
