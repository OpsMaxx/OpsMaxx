import { useEffect } from 'react'
import { useUpdater } from '../../store/updater'
import { openSettings } from '../../store/nav'
import { clsx } from '../../lib/format'
import type { UpdaterStatus } from '../../../../shared/updater'
import { useT } from '../../lib/i18n'
import type { Translate } from '../../../../shared/i18n'

// The running version, on screen at all times, plus an update chip whenever one
// is waiting.
//
// Version first because "which build am I actually running" is otherwise a trip
// into Settings, and on a prerelease build it is the difference between a bug
// worth reporting and a bug that is already known. A beta build says so next to
// its number so nobody is running one by accident.

// Colour and wording per state. The chip is deliberately quieter than
// `resource-alert` and `backup-warn`: an available update is news, not a
// problem, and it must not compete with a host that is falling over.
function chip(status: UpdaterStatus, t: Translate): { tone: string; label: string } | null {
  switch (status.state) {
    case 'available':
      return { tone: 'avail', label: t('layout.update.available') }
    case 'downloading':
      return { tone: 'busy', label: t('layout.update.downloading', { percent: Math.round(status.percent) }) }
    case 'downloaded':
      return { tone: 'ready', label: t('layout.update.restart') }
    case 'manual':
      // Nothing will happen on its own here, so the label names the action the
      // user has to take rather than repeating "available".
      return { tone: 'manual', label: t('layout.update.download', { version: status.version }) }
    default:
      return null
  }
}

function describe(status: UpdaterStatus, version: string | null, beta: boolean, t: Translate): string {
  const build = version
    ? t(beta ? 'layout.update.buildBeta' : 'layout.update.build', { version })
    : t('layout.update.buildUnknown')
  const detail = ((): string => {
    switch (status.state) {
      case 'checking':
        return t('layout.update.checking')
      case 'available':
        return t('layout.update.versionAvailable', { version: status.version })
      case 'downloading':
        return status.version != null
          ? t('layout.update.downloadingVersion', { version: status.version, percent: Math.round(status.percent) })
          : t('layout.update.downloadingUnknown', { percent: Math.round(status.percent) })
      case 'downloaded':
        return t('layout.update.downloaded', { version: status.version })
      case 'manual':
        return t('layout.update.manual', { version: status.version })
      case 'error':
        return t('layout.update.error', { message: status.message })
      case 'not-available':
        return t('layout.update.latest')
      default:
        return t('layout.update.none')
    }
  })()
  return t('layout.update.tooltip', { build, detail })
}

export function UpdateIndicator(): React.JSX.Element | null {
  const t = useT()
  const init = useUpdater((s) => s.init)
  const status = useUpdater((s) => s.status)
  const capabilities = useUpdater((s) => s.capabilities)
  // Re-evaluated on every store change, which is what keeps the chip in step
  // with both the status and a dismissal made in Settings.
  const notify = useUpdater((s) => s.shouldNotify())

  // The status bar is mounted for the life of the window, so this is the one
  // place guaranteed to run exactly once — and `init` is idempotent anyway.
  useEffect(() => init(), [init])

  // Before capabilities land there is no version to be honest about, and an
  // empty "v" would be worse than nothing for the one frame it lasts.
  if (!capabilities) return null

  const beta = capabilities.runningChannel === 'beta'
  const c = notify ? chip(status, t) : null

  return (
    <button
      className={clsx('item update-indicator', c && `pending ${c.tone}`)}
      title={describe(status, capabilities.currentVersion, beta, t)}
      onClick={() => openSettings('general')}
    >
      <span>v{capabilities.currentVersion}</span>
      {beta && <span className="build-tag">{t('layout.update.betaTag')}</span>}
      {c && (
        <>
          <span className="update-dot" />
          <span>{c.label}</span>
        </>
      )}
    </button>
  )
}
