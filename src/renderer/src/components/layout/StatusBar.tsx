import { useEffect, useState } from 'react'
import { GitBranch, Wifi, WifiOff, Bell, AlertTriangle, ShieldAlert } from 'lucide-react'
import { useApp } from '../../store/app'
import { offerUnlockForBackups, useBackupRuns } from '../../store/backupRuns'
import { LABEL, chipValue, useAlerts } from '../../store/alerts'
import { useFleetStatus, samplerWarning } from '../../store/fleetStatus'
import { useVaultPrompt } from '../../store/vaultPrompt'
import { openMonitor, openSettings } from '../../store/nav'
import { resumeApprovals, startApprovalQueue, useApprovalFuse, useApprovalQueue } from '../../store/approvalQueue'
import { colorVar } from './WorkspaceSwitcher'
import { UpdateIndicator } from './UpdateIndicator'
import { useT } from '../../lib/i18n'

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
  const t = useT()
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
      title={t('layout.status.approvalTitle', {
        agent: head.agentName,
        action: String(head.action),
        server: String(head.serverName)
      })}
      onClick={resumeApprovals}
    >
      <ShieldAlert size={12} />
      <span>
        {t('layout.status.approvalsWaiting', { count: pending.length })}
        {fuse.text !== null ? ` · ${fuse.text}` : ''}
      </span>
    </button>
  )
}

/**
 * Whether this machine has a network at all, from `navigator.onLine`.
 *
 * Read from the OS, never by reaching out to an endpoint: a probe would be
 * OpsMaxx phoning somewhere on a timer, and the only thing it could add is
 * "the internet is reachable", which says nothing about a server on the LAN.
 * So "Online" means an interface is up, and the tooltip says exactly that.
 * "Offline" is the reading worth having — every SSH session is about to fail,
 * and that is the chip telling you why before the terminals do.
 */
function NetworkChip(): React.JSX.Element {
  const t = useT()
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const up = (): void => setOnline(true)
    const down = (): void => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return (
    <div
      className={online ? 'item' : 'item state-alarm'}
      title={t(online ? 'layout.status.onlineTitle' : 'layout.status.offlineTitle')}
    >
      {/* Shape as well as colour: a disc for up, a square for down. */}
      <span className={online ? 'state-dot is-ok' : 'state-dot is-alarm'} aria-hidden="true" />
      {online ? <Wifi size={12} /> : <WifiOff size={12} />}
      <span>{t(online ? 'layout.status.online' : 'layout.status.offline')}</span>
    </div>
  )
}

export function StatusBar(): React.JSX.Element {
  const t = useT()
  const ws = useApp((s) => s.activeWorkspace())
  const tabs = useApp((s) => s.tabs)
  const backupDirty = useApp((s) => s.settings.backupDirty)
  const paused = useBackupRuns((s) => s.paused)
  /**
   * The only pause with a remedy this chip can perform.
   *
   * A missing passphrase needs the destination editor; a locked vault needs one
   * unlock, which `VaultUnlockModal` raises Touch ID for on its own. Read off a
   * code rather than the sentence, so the offer does not depend on wording.
   */
  const vaultPaused = paused.some((p) => p.code === 'vault-locked')
  const alerts = useAlerts((s) => s.active)
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
        <span>{t('layout.status.sessions', { count: tabs.length })}</span>
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
          title={t('layout.status.alertsTitle', {
            list: Object.values(alerts)
              // The store's own labels and the store's own units, not a ternary
              // and not a hard-coded percent sign here. A third kind made that
              // ternary label every disk alert "Memory", and a hard-coded `%`
              // showed a load average of 3.2 per core as "3%" — a wrong number
              // rather than an ugly one.
              .map((a) => `${a.serverName}: ${LABEL[a.kind]}${chipValue(a)}${a.detail ? ` — ${a.detail}` : ''}`)
              .join('\n')
          })}
          // The inbox, not merely the page it is on. The chip is the pointer to
          // it — a pointer that opened the Fleet Monitor on whatever tab was
          // last used would be a chip saying "it is in here somewhere", which
          // is the shape of the problem, not the fix.
          onClick={() => openMonitor('alerts')}
        >
          <AlertTriangle size={12} />
          <span>{t('layout.status.alerts', { count: Object.values(alerts).length })}</span>
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
            // Every vault-shaped warning unlocks from the chip, partial ones
            // included: the fix is the same dialog whether one server is
            // blocked or all of them.
            if (warning.kind.startsWith('vault')) {
              void useVaultPrompt
                .getState()
                .request(t('layout.status.unlockReason'))
              return
            }
            openSettings('monitoring')
          }}
        >
          <AlertTriangle size={12} />
          <span>{warning.label}</span>
        </button>
      )}
      {/* Before the staleness warning, and it replaces it while it is showing.
          "Backup out of date" says the last backup is old and asks for a new
          one; this says the thing that would have made a new one has stopped,
          and names the one action that restarts it. Showing both would be two
          chips about one problem, the more actionable of them second. */}
      {paused.length > 0 ? (
        <button
          className="item backup-warn"
          title={
            // The remedy in the sentence, and the click performs it. A chip
            // that says "backups have stopped" and then opens a page which
            // cannot restart them is a chip that has reported a problem and
            // moved on.
            vaultPaused
              ? t('layout.status.backupPausedVaultTitle', { name: paused[0].destinationName, reason: paused[0].reason })
              : paused.length === 1
                ? t('layout.status.backupPausedTitle', { name: paused[0].destinationName, reason: paused[0].reason })
                : t('layout.status.backupsPausedTitle', { count: paused.length, reason: paused[0].reason })
          }
          onClick={() => (vaultPaused ? void offerUnlockForBackups() : openSettings('backup'))}
        >
          <AlertTriangle size={12} />
          <span>{t(vaultPaused ? 'layout.status.backupsPausedUnlock' : 'layout.status.backupsPaused')}</span>
        </button>
      ) : (
      backupDirty && (
        <button
          className="item backup-warn"
          title={t('layout.status.backupDirtyTitle')}
          // The page, not just the activity. `setActivity('settings')` opened
          // Settings on whatever section was last selected, so the one chip
          // whose tooltip names its destination was the one that did not go
          // there. Same `openSettings` the sampler chip above uses.
          onClick={() => openSettings('backup')}
        >
          <AlertTriangle size={12} />
          <span>{t('layout.status.backupDirty')}</span>
        </button>
      )
      )}
      <UpdateIndicator />
      <NetworkChip />
      {/* The way into the alert inbox while nothing is alerting. The alert chip
          above is the way in while something is, so the two never show at
          once — two buttons to one page is one too many. */}
      {Object.values(alerts).length === 0 && (
        <button className="item" aria-label={t('layout.status.alertInbox')} title={t('layout.status.noAlertsTitle')} onClick={() => openMonitor('alerts')}>
          <Bell size={12} />
        </button>
      )}
    </div>
  )
}
