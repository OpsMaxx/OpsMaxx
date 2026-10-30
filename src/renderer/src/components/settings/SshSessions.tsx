import { useEffect, useState } from 'react'
import { Link2, Unlink } from 'lucide-react'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import type { MessageKey } from '../../../../shared/i18n'
import { retentionOverrideNotice } from './connectionRetention'

interface PoolEntry {
  key: string
  host: string
  username: string
  sessions: number
}

// Retention choices for the authenticated master connection. Longer means a
// two-factor code is requested less often; shorter means it is dropped sooner
// after you stop using the server.
const CHOICES: { minutes: number; labelKey: MessageKey }[] = [
  { minutes: 0, labelKey: 'settings.sshSessions.choice.immediately' },
  { minutes: 5, labelKey: 'settings.sshSessions.choice.fiveMinutes' },
  { minutes: 15, labelKey: 'settings.sshSessions.choice.fifteenMinutes' },
  { minutes: 60, labelKey: 'settings.sshSessions.choice.oneHour' },
  { minutes: -1, labelKey: 'settings.sshSessions.choice.untilExit' }
]

export function SshSessions(): React.JSX.Element {
  const t = useT()
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const [pool, setPool] = useState<PoolEntry[]>([])
  const override = retentionOverrideNotice(
    settings.fleetSamplingEnabled,
    settings.fleetSamplingIntervalMs
  )

  const load = (): void => {
    void window.opsmaxx?.ssh.poolList().then((p) => setPool(p ?? []))
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 4000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.sshSessions.keep.title')}</div>
          <div className="s-desc">{t('settings.sshSessions.keep.desc')}</div>
          {/* This row promises how often a two-factor code is requested.
              Background checking keeps every watched server's connection alive
              continuously, which makes the promise false — so the row that
              makes it has to say so, not only the row that breaks it. */}
          {override && <div className="s-desc warn">{override}</div>}
        </div>
        <div className="segment">
          {CHOICES.map((c) => (
            <button
              key={c.minutes}
              className={clsx('seg-btn', settings.sshMasterIdleMinutes === c.minutes && 'active')}
              onClick={() => setSettings({ sshMasterIdleMinutes: c.minutes })}
            >
              {t(c.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.sshSessions.shared.title')}</div>
          <div className="s-desc">
            {pool.length ? t('settings.sshSessions.shared.some') : t('settings.sshSessions.shared.none')}
          </div>
        </div>
        <button className="btn sm" onClick={load}>
          {t('common.refresh')}
        </button>
      </div>

      {pool.map((p) => (
        <div className="setting-row" key={p.key}>
          <div className="s-info">
            <div className="s-title mono">
              <Link2 size={12} /> {p.username}@{p.host}
            </div>
            <div className="s-desc">
              {p.sessions === 0
                ? t('settings.sshSessions.idle')
                : t('settings.sshSessions.active', { count: p.sessions })}
            </div>
          </div>
          <button
            className="btn sm danger"
            onClick={async () => {
              const close = async (): Promise<void> => {
                try {
                  await window.opsmaxx?.ssh.poolClose(p.key)
                  toast(
                    t('settings.sshSessions.disconnected', { target: `${p.username}@${p.host}` }),
                    'ok'
                  )
                } catch (err) {
                  // The row stays on screen either way, so without this the
                  // button would look like it simply did not work.
                  toast(
                    t('settings.sshSessions.stillConnected', {
                      target: `${p.username}@${p.host}`,
                      error: err instanceof Error ? err.message : String(err)
                    }),
                    'error',
                    { label: t('settings.sshSessions.tryAgain'), run: () => void close() }
                  )
                }
                load()
              }
              await close()
            }}
          >
            <Unlink size={13} /> {t('settings.sshSessions.disconnect')}
          </button>
        </div>
      ))}
    </div>
  )
}
