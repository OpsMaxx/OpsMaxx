import { useState } from 'react'
import {
  RefreshCw,
  Download,
  CheckCircle2,
  ExternalLink,
  AlertTriangle,
  Loader2,
  BellOff
} from 'lucide-react'
import { useUpdater } from '../../store/updater'
import { Modal } from '../common/Modal'
import {
  channelOfVersion,
  type CheckIntervalHours,
  type UpdateChannel,
  type UpdaterCapabilities
} from '../../../../shared/updater'
import { Switch } from '../common/Switch'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { Translate } from '../../../../shared/i18n'

// Marks an offered build as a prerelease. Being on the beta channel does not
// answer "what am I about to install": beta cascades, so the newest thing on
// offer there is often an ordinary stable release.
function OfferedTag({ version }: { version: string }): React.JSX.Element | null {
  const t = useT()
  return channelOfVersion(version) === 'beta' ? (
    <span className="build-tag">{t('settings.updatePanel.betaTag')}</span>
  ) : null
}

// The same switch Settings uses. Duplicated rather than imported because that
// one is a private helper of a page this panel is only a guest on, and because
// this one has to be able to sit there disabled with a reason attached — a
// toggle the platform cannot honour has to look unavailable, not just fail
// silently when pressed.
function SettingSwitch({
  label,
  desc,
  checked,
  disabled,
  onChange
}: {
  label: string
  desc: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{label}</div>
        <div className="s-desc">{desc}</div>
      </div>
      <Switch
        checked={checked && !disabled}
        disabled={disabled}
        label={label}
        onChange={onChange}
      />
    </div>
  )
}

// An age, not a wall-clock time: "12 minutes ago" answers "is this stale"
// without the user working out what time it is now. A clock that has moved
// backwards since the check would otherwise print a negative age, which reads
// as a bug, so anything in the future is simply "just now".
function checkedAgo(t: Translate, iso: string | null): string {
  if (!iso) return t('settings.updatePanel.checked.never')
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return t('settings.updatePanel.checked.never')
  const mins = Math.floor(Math.max(0, Date.now() - at) / 60000)
  if (mins < 1) return t('settings.updatePanel.checked.justNow')
  if (mins < 60) return t('settings.updatePanel.checked.minutes', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('settings.updatePanel.checked.hours', { count: hours })
  const days = Math.floor(hours / 24)
  return t('settings.updatePanel.checked.days', { count: days })
}

// Why this build cannot replace itself. Taken from the capabilities the main
// process sent, never from anything the renderer can sniff for itself — the
// renderer has no business re-deriving a rule that decides whether an installer
// will run.
function noSelfInstallReason(t: Translate, caps: UpdaterCapabilities): string {
  if (caps.platform === 'darwin') return t('settings.updatePanel.noSelfInstall.mac')
  if (caps.isPortable) return t('settings.updatePanel.noSelfInstall.portable')
  return t('settings.updatePanel.noSelfInstall.other')
}

export function UpdatePanel(): React.JSX.Element {
  const t = useT()
  const status = useUpdater((s) => s.status)
  const prefs = useUpdater((s) => s.prefs)
  const caps = useUpdater((s) => s.capabilities)
  const dismissedVersion = useUpdater((s) => s.dismissedVersion)
  const check = useUpdater((s) => s.check)
  const download = useUpdater((s) => s.download)
  const install = useUpdater((s) => s.install)
  const setPrefs = useUpdater((s) => s.setPrefs)
  const dismiss = useUpdater((s) => s.dismiss)
  const undismiss = useUpdater((s) => s.undismiss)

  // Two confirmations, both for things the user cannot take back on their own:
  // a restart that ends every open session, and a channel change that can move
  // the app down a version.
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [confirmDowngrade, setConfirmDowngrade] = useState(false)

  const checking = status.state === 'checking'
  // Assume the app cannot install itself until told otherwise. Offering a
  // restart that silently does nothing is worse than the half-second the
  // capabilities call takes to arrive.
  const canAutoInstall = caps?.canAutoInstall ?? false

  const selectChannel = (channel: UpdateChannel): void => {
    if (channel === prefs.channel) return
    // Leaving beta while actually running a beta build means the next update is
    // very likely to be an older version than the one on screen. Nobody expects
    // an update to go backwards, so it gets said out loud first.
    if (channel === 'stable' && caps?.runningChannel === 'beta') {
      setConfirmDowngrade(true)
      return
    }
    setPrefs({ channel })
  }

  return (
    <div className="settings-section">
      <h2>{t('settings.updatePanel.heading')}</h2>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">
            OpsMaxx {caps ? `v${caps.currentVersion}` : ''}
            {caps?.runningChannel === 'beta' && (
              <span className="build-tag">{t('settings.updatePanel.betaTag')}</span>
            )}
          </div>
          <div className="s-desc">
            {status.state === 'idle' && checkedAgo(t, prefs.lastCheckedAt)}
            {status.state === 'checking' && t('settings.updatePanel.status.checking')}
            {status.state === 'not-available' &&
              t('settings.updatePanel.status.latest', { checked: checkedAgo(t, prefs.lastCheckedAt) })}
            {status.state === 'available' &&
              (prefs.autoDownload
                ? t('settings.updatePanel.status.foundDownloading', { version: status.version })
                : t('settings.updatePanel.status.available', { version: status.version }))}
            {status.state === 'downloading' &&
              t('settings.updatePanel.status.downloading', { percent: Math.round(status.percent) })}
            {status.state === 'downloaded' &&
              t('settings.updatePanel.status.ready', { version: status.version })}
            {status.state === 'manual' &&
              t('settings.updatePanel.status.available', { version: status.version })}
            {status.state === 'error' &&
              t('settings.updatePanel.status.error', { message: status.message })}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {status.state === 'available' && !prefs.autoDownload && (
            <button className="btn sm primary" onClick={download}>
              <Download size={13} /> {t('settings.updatePanel.download')}
            </button>
          )}
          <button className="btn sm" disabled={checking} onClick={check}>
            {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {t('settings.updatePanel.checkNow')}
          </button>
        </div>
      </div>

      {status.state === 'downloaded' && (
        <div className="backup-banner ok">
          <CheckCircle2 size={16} />
          <div style={{ flex: 1 }}>
            <div className="s-title">
              {t('settings.updatePanel.ready.title')} <OfferedTag version={status.version} />
            </div>
            <div className="s-desc">
              {canAutoInstall
                ? t('settings.updatePanel.ready.willRestart', { version: status.version })
                : t('settings.updatePanel.ready.cannotInstall', { version: status.version })}
            </div>
          </div>
          {canAutoInstall ? (
            <button className="btn sm primary" onClick={() => setConfirmRestart(true)}>
              {t('settings.updatePanel.restartAndUpdate')}
            </button>
          ) : (
            <button className="btn sm" onClick={() => void window.opsmaxx?.updater.openReleasePage()}>
              <ExternalLink size={13} /> {t('settings.updatePanel.releasesPage')}
            </button>
          )}
        </div>
      )}

      {status.state === 'manual' && caps && (
        <div className="backup-banner warn">
          <AlertTriangle size={16} />
          <div style={{ flex: 1 }}>
            <div className="s-title">
              {t('settings.updatePanel.manual.title', { version: status.version })}{' '}
              <OfferedTag version={status.version} />
            </div>
            <div className="s-desc">{noSelfInstallReason(t, caps)}</div>
          </div>
          <button className="btn sm" onClick={() => void window.opsmaxx?.updater.openReleasePage()}>
            <ExternalLink size={13} /> {t('settings.updatePanel.download')}
          </button>
        </div>
      )}

      {status.state === 'error' && (
        <div className="backup-banner warn">
          <AlertTriangle size={16} />
          <div style={{ flex: 1 }}>
            <div className="s-title">{t('settings.updatePanel.error.title')}</div>
            <div className="s-desc">
              {t('settings.updatePanel.error.desc', { message: status.message })}
            </div>
          </div>
          <button className="btn sm" onClick={() => void window.opsmaxx?.updater.openReleasePage()}>
            <Download size={13} /> {t('settings.updatePanel.releasesPage')}
          </button>
        </div>
      )}

      <div className="backup-h">{t('settings.updatePanel.channel.heading')}</div>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.updatePanel.channel.title')}</div>
          <div className="s-desc">{t('settings.updatePanel.channel.desc')}</div>
        </div>
        <select
          className="input"
          style={{ maxWidth: 160 }}
          value={prefs.channel}
          onChange={(e) => selectChannel(e.target.value as UpdateChannel)}
        >
          <option value="stable">{t('settings.updatePanel.channel.stable')}</option>
          <option value="beta">{t('settings.updatePanel.channel.beta')}</option>
        </select>
      </div>

      <div className="backup-h">{t('settings.updatePanel.auto.heading')}</div>
      <SettingSwitch
        label={t('settings.updatePanel.auto.checkLabel')}
        desc={t('settings.updatePanel.auto.checkDesc')}
        checked={prefs.autoCheck}
        onChange={(autoCheck) => setPrefs({ autoCheck })}
      />
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.updatePanel.auto.intervalTitle')}</div>
          <div className="s-desc">{t('settings.updatePanel.auto.intervalDesc')}</div>
        </div>
        <select
          className="input"
          style={{ maxWidth: 180 }}
          disabled={!prefs.autoCheck}
          value={prefs.checkIntervalHours}
          onChange={(e) =>
            setPrefs({ checkIntervalHours: Number(e.target.value) as CheckIntervalHours })
          }
        >
          <option value={0}>{t('settings.updatePanel.auto.intervalLaunchOnly')}</option>
          <option value={6}>{t('settings.updatePanel.auto.intervalEvery', { count: 6 })}</option>
          <option value={24}>{t('settings.updatePanel.auto.intervalEvery', { count: 24 })}</option>
        </select>
      </div>
      <SettingSwitch
        label={t('settings.updatePanel.auto.downloadLabel')}
        desc={t('settings.updatePanel.auto.downloadDesc')}
        checked={prefs.autoDownload}
        onChange={(autoDownload) => setPrefs({ autoDownload })}
      />
      <SettingSwitch
        label={t('settings.updatePanel.auto.installLabel')}
        desc={
          canAutoInstall
            ? t('settings.updatePanel.auto.installDesc')
            : caps
              ? t('settings.updatePanel.auto.installUnavailable', { reason: noSelfInstallReason(t, caps) })
              : t('settings.updatePanel.auto.installUnknown')
        }
        checked={prefs.autoInstallOnQuit}
        disabled={!canAutoInstall}
        onChange={(autoInstallOnQuit) => setPrefs({ autoInstallOnQuit })}
      />

      {dismissedVersion !== null ? (
        <div className="setting-row">
          <div className="s-info">
            <div className="s-title">
              {t('settings.updatePanel.ignore.ignoringTitle', { version: dismissedVersion })}
            </div>
            <div className="s-desc">{t('settings.updatePanel.ignore.ignoringDesc')}</div>
          </div>
          <button className="btn sm" onClick={undismiss}>
            {t('settings.updatePanel.ignore.stop')}
          </button>
        </div>
      ) : (
        (status.state === 'available' || status.state === 'downloaded' || status.state === 'manual') && (
          <div className="setting-row">
            <div className="s-info">
              <div className="s-title">{t('settings.updatePanel.notNow')}</div>
              <div className="s-desc">
                {t('settings.updatePanel.ignore.desc', { version: status.version })}
              </div>
            </div>
            <button className="btn sm" onClick={dismiss}>
              <BellOff size={13} /> {t('settings.updatePanel.ignore.button')}
            </button>
          </div>
        )
      )}

      {confirmRestart && (
        <Modal
          title={t('settings.updatePanel.restartModal.title')}
          subtitle={t('settings.updatePanel.restartModal.subtitle')}
          onClose={() => setConfirmRestart(false)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setConfirmRestart(false)}>
                {t('settings.updatePanel.notNow')}
              </button>
              <button className="btn primary" onClick={install}>
                {t('settings.updatePanel.restartAndUpdate')}
              </button>
            </>
          }
        >
          <p>{t('settings.updatePanel.restartModal.body')}</p>
        </Modal>
      )}

      {confirmDowngrade && (
        <Modal
          title={t('settings.updatePanel.downgradeModal.title')}
          subtitle={
            caps
              ? t('settings.updatePanel.downgradeModal.subtitle', { version: caps.currentVersion })
              : undefined
          }
          onClose={() => setConfirmDowngrade(false)}
          footer={
            <>
              <span className="spacer" />
              <button className="btn" onClick={() => setConfirmDowngrade(false)}>
                {t('settings.updatePanel.downgradeModal.stay')}
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setPrefs({ channel: 'stable' })
                  setConfirmDowngrade(false)
                }}
              >
                {t('settings.updatePanel.downgradeModal.switch')}
              </button>
            </>
          }
        >
          <p>
            <Trans i18nKey="settings.updatePanel.downgradeModal.body" components={{ b: <b /> }} />
          </p>
          <p>{t('settings.updatePanel.downgradeModal.note')}</p>
        </Modal>
      )}
    </div>
  )
}
