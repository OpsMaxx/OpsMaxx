import { useEffect } from 'react'
import { GitBranch, Wifi, Bell, Cpu, AlertTriangle, ShieldAlert } from 'lucide-react'
import { useApp } from '../../store/app'
import { LABEL, chipValue, useAlerts } from '../../store/alerts'
import { useFleetStatus, samplerWarning } from '../../store/fleetStatus'
import { useVaultPrompt } from '../../store/vaultPrompt'
import { openMonitor, openSettings } from '../../store/nav'
import { resumeApprovals, startApprovalQueue, useApprovalFuse, useApprovalQueue } from '../../store/approvalQueue'
import { colorVar } from './WorkspaceSwitcher'
import { UpdateIndicator } from './UpdateIndicator'

/**
 * "1 AI action waiting · 1:43", and the way back to a dialog that was put away.
 *
 * Separated into its own component only so its once-a-second tick re-renders a
 * chip and not the whole status bar — the alert counts and the sampler warning
 * beside it have no business recomputing every second.
 *
 * The countdown half disappears when the configured approval timeout could not
 * be read, and the chip still shows the count. "Something is waiting" is true
 * whether or not OpsMaxx knows for how long; inventing a deadline to keep
 * the chip's shape consistent would be inventing the one number here an
 * operator would actually plan around.
 */
function ApprovalChip(): React.JSX.Element | null {
  const pending = useApprovalQueue((s) => s.pending)
  const head = pending[0]
  const fuse = useApprovalFuse(head)

  // Starts the queue subscription itself rather than relying on ApprovalWatcher
  // having been mounted first. The call is idempotent — the store owns a
  // `started` flag and the second caller gets a no-op teardown — and the
  // alternative is a chip whose silence depends on a sibling component that
  // happens to be somewhere else in the tree. A chip that shows nothing when
  // something IS waiting is the failure this whole chip exists to fix.
  useEffect(() => startApprovalQueue(), [])

  if (!head) return null

  return (
    <button
      className="item"
      style={{ color: 'var(--danger)', fontWeight: 600 }}
      title={`${head.agentName} is blocked on "${head.action}" (${head.serverName}) and cannot continue until you answer. Click to bring the decision back up.`}
      onClick={resumeApprovals}
    >
      <ShieldAlert size={12} />
      <span>
        {pending.length} AI action{pending.length === 1 ? '' : 's'} waiting
        {fuse.text !== null ? ` · ${fuse.text}` : ''}
      </span>
    </button>
  )
}

export function StatusBar(): React.JSX.Element {
  const ws = useApp((s) => s.activeWorkspace())
  const tabs = useApp((s) => s.tabs)
  const backupDirty = useApp((s) => s.settings.backupDirty)
  const alerts = useAlerts((s) => s.active)
  const setActivity = useApp((s) => s.setActivity)
  // Whether the thing that raises those alerts is actually running. An alert
  // count of zero means nothing if nobody is checking.
  const samplerStatus = useFleetStatus((s) => s.status)
  const samplingEnabled = useApp((s) => s.settings.fleetSamplingEnabled)
  const warning = samplerWarning(samplerStatus, samplingEnabled)

  return (
    <div className="statusbar">
      <div className="item">
        <span className="ws-dot" style={{ background: colorVar[ws.color], color: colorVar[ws.color] }} />
        <span>{ws.name}</span>
      </div>
      <div className="item">
        <GitBranch size={12} />
        <span>
          {tabs.length} session{tabs.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="spacer" />
      {/* First of the warning chips, ahead of the alert count and the backup
          warning, because it is the only one with a deadline on it. A host at
          98% CPU will still be at 98% CPU in two minutes; an agent blocked on
          an approval will have been denied by then, and the operator will never
          learn that it was waiting. */}
      <ApprovalChip />
      {/* Rendered in the status bar rather than as a floating overlay, so an
          alert can never cover terminal output. */}
      {Object.values(alerts).length > 0 && (
        // A button, not a div. It sits beside the backup warning, which is the
        // same shape and does navigate — one of the two being inert made the
        // bar teach that a chip here may or may not be worth clicking. The
        // tooltip names the hosts; the click takes you to where they are.
        <button
          className="item resource-alert"
          title={`${Object.values(alerts)
            // The store's own labels and the store's own units, not a ternary
            // and not a hard-coded percent sign here. A third kind made that
            // ternary label every disk alert "Memory", and a hard-coded `%`
            // showed a load average of 3.2 per core as "3%" — a wrong number
            // rather than an ugly one.
            .map((a) => `${a.serverName}: ${LABEL[a.kind]}${chipValue(a)}${a.detail ? ` — ${a.detail}` : ''}`)
            .join('\n')}\n\nClick to open the alert inbox.`}
          // The inbox, not merely the page it is on. The chip is the pointer to
          // it — a pointer that opened the Fleet Monitor on whatever tab was
          // last used would be a chip saying "it is in here somewhere", which
          // is the shape of the problem, not the fix.
          onClick={() => openMonitor('alerts')}
        >
          <AlertTriangle size={12} />
          <span>
            {Object.values(alerts).length} alert{Object.values(alerts).length === 1 ? '' : 's'}
          </span>
        </button>
      )}
      {/* Sits before the backup warning because it is worse: a stale export
          costs you a restore, background checking being silently stopped costs
          you the incident. Deliberately shown even when the alert count is
          zero — that zero is precisely what is not trustworthy while this is
          up. */}
      {/* A locked vault unlocks from the chip. Every other warning here is a
          setting to change, but this one is a dialog to answer — and routing it
          to Settings made the single most visible "something is wrong" control
          in the app a signpost to a screen with another button on it. */}
      {warning && (
        <button
          className="item resource-alert"
          title={warning.detail}
          onClick={() => {
            if (warning.kind === 'vault-locked') {
              void useVaultPrompt
                .getState()
                .request('Unlocking resumes background checking, so alerts can be raised again.')
              return
            }
            openSettings('monitoring')
          }}
        >
          <AlertTriangle size={12} />
          <span>{warning.label}</span>
        </button>
      )}
      {backupDirty && (
        <button
          className="item backup-warn"
          title="Stored connections have changed since the last export. Click to open Backup & Restore."
          onClick={() => setActivity('settings')}
        >
          <AlertTriangle size={12} />
          <span>Backup out of date</span>
        </button>
      )}
      <UpdateIndicator />
      <div className="item metric">
        <Cpu size={12} />
        <span>
          local <b>ok</b>
        </span>
      </div>
      <div className="item">
        <Wifi size={12} />
        <span>Online</span>
      </div>
      <div className="item">
        <Bell size={12} />
      </div>
    </div>
  )
}
