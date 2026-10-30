import { useEffect, useRef, useState } from 'react'
import { Copy, Octagon, Plus } from 'lucide-react'
import { clsx } from '../../lib/format'
import { dismissToast, toast } from '../../store/toast'
import { openAi } from '../../store/nav'
import type { AccessGroup, McpGlobalConfig } from '../../../../shared/mcp'
import { PICKERLESS_MODE } from '../../../../shared/mcp'
import { Switch } from '../common/Switch'
import { ModePicker } from './ModePicker'
import { t as tr, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'


/**
 * What the kill switch cannot stop, in the operator's words.
 *
 * The confirm above already argues that a count is what makes the dialog
 * honest rather than a speed bump. A build an agent started is the part of the
 * answer the switch has no power over, so it is the part most worth saying
 * before somebody commits — an operator at 2am has no other way to learn a
 * deploy is in flight. `list_runs` is the agent's tool, not a notification.
 */
async function buildsClause(): Promise<string> {
  try {
    const runs = (await window.opsmaxx?.cicd?.agentRuns?.()) ?? []
    if (runs.length === 0) return ''
    const lines = runs
      .slice(0, 5)
      .map((r) => {
        const what = r.run ? `${r.pipeline} ${r.run}` : r.pipeline
        // "not reported" rather than "running": a provider that returned no run
        // id has told us nothing since, and guessing would be the one claim
        // nobody checked.
        const how = r.state === 'unknown' ? tr('ai.security.buildStateUnknown') : r.state
        return `  • ${tr('ai.security.buildLine', { run: what, connection: r.connectionName, state: how })}`
      })
      .join('\n')
    const more = runs.length > 5 ? `\n  • ${tr('ai.security.buildsMore', { count: runs.length - 5 })}` : ''
    return (
      `\n\n${tr('ai.security.buildsNotStopped', { count: runs.length })}\n${lines}${more}` +
      `\n${tr('ai.security.buildsStopThose')}`
    )
  } catch {
    // The dialog must open even if this cannot be answered.
    return ''
  }
}

/** The one "could not listen" toast; see `update`. */
const BIND_FAILED = 'mcp-bind-failed'

function copy(text: string): void {
  navigator.clipboard.writeText(text)
  toast(tr('common.copied'))
}

export function AiSecurity(): React.JSX.Element {
  const [config, setConfig] = useState<McpGlobalConfig | null>(null)
  // For the Custom default profile's group.
  const [groups, setGroups] = useState<AccessGroup[]>([])
  useEffect(() => {
    window.opsmaxx?.aiPolicy
      ?.listGroups?.()
      .then((g) => setGroups(g ?? []))
      .catch(() => setGroups([]))
  }, [])
  const [status, setStatus] = useState<{ running: boolean; port: number | null }>({ running: false, port: null })
  const [liveCount, setLiveCount] = useState<{ sessions: number; pending: number } | null>(null)
  // "Pick a different port" is the fix for almost every start failure, so the
  // message hands the user the field instead of naming it.
  const portRef = useRef<HTMLInputElement>(null)
  const t = useT()

  const load = (): void => {
    void window.opsmaxx?.aiMcp.getConfig().then((c) => c && setConfig(c))
    void window.opsmaxx?.aiMcp.status().then((s) => {
      if (!s) return
      setStatus(s)
      // However it came to be listening — this page, Connect an agent, or a
      // restart — a failure to listen is no longer true once it is.
      if (s.running) dismissToast(BIND_FAILED)
    })
    // Read, not assumed. `null` stays null when either call fails, and the
    // confirmation then says it could not tell rather than printing a zero
    // nobody measured — a "0 sessions" on an emergency stop is the one number
    // that must never be a guess.
    void Promise.all([
      window.opsmaxx?.aiMcp.listSessions(),
      window.opsmaxx?.aiMcp.listApprovals()
    ])
      .then(([sessions, approvals]) => {
        if (!sessions || !approvals) {
          setLiveCount(null)
          return
        }
        setLiveCount({
          sessions: sessions.filter((x) => !x.revoked).length,
          pending: approvals.filter((a) => a.status === 'pending').length
        })
      })
      .catch(() => setLiveCount(null))
  }
  useEffect(load, [])

  const update = async (patch: Partial<McpGlobalConfig>): Promise<void> => {
    const result = await window.opsmaxx?.aiMcp.setConfig(patch).catch(() => null)
    if (!result) {
      // The control already shows the new value; say that nothing changed.
      toast(t('ai.security.notSaved'), 'error')
      load()
      return
    }
    setConfig(result.config)
    if (result.error) {
      // Keyed, so a second failed attempt (every keystroke in the port field
      // retries while the bridge is meant to be on) replaces this rather than
      // stacking a copy per port number.
      toast(
        t('ai.security.bindFailed', { port: result.config.port, error: result.error }),
        'error',
        {
          label: t('ai.security.pickAnotherPort'),
          run: () => {
            portRef.current?.focus()
            portRef.current?.select()
          }
        },
        { key: BIND_FAILED }
      )
    } else {
      // Listening now, or deliberately off: either way the failure it reported
      // is no longer true, and a sticky error left up says it still is.
      dismissToast(BIND_FAILED)
    }
    load()
  }

  const killAll = async (): Promise<void> => {
    // Confirmed, and the confirmation NAMES what is about to be killed.
    //
    // This is an unconfirmed one-click revoke-everything sitting directly below
    // the local-port field, so it was reachable by an accidental click while
    // adjusting the setting above it. It is also the emergency stop, which
    // means the confirmation has to stay cheap: a typed word here would be a
    // toll on the one action somebody presses when something is going wrong.
    //
    // The count is what makes it honest rather than a speed bump. "Stop all AI
    // access?" tells the reader nothing they did not already know; "revoke 1
    // session and deny 0 pending requests" tells them whether they are stopping
    // an incident or clicking a button that does nothing.
    const live = liveCount
    const builds = await buildsClause()
    const ok = window.confirm(
      (live === null
        ? t('ai.security.confirmUnknown')
        : t('ai.security.confirmCounts', { sessions: live.sessions, pending: live.pending })) +
        builds
    )
    if (!ok) return
    const result = await window.opsmaxx?.aiMcp.killAllSessions()
    load()
    if (!result) {
      toast(t('ai.security.stopFailed'), 'error', {
        label: t('ai.security.tryAgain'),
        run: () => void killAll()
      })
      return
    }
    toast(
      t('ai.security.stopped', { revoked: result.revoked, denied: result.denied }),
      'ok'
    )
  }

  if (!config) return <div className="settings-section" />

  const port = status.port ?? config.port
  const cliCommand = `claude mcp add --transport http opsmaxx http://127.0.0.1:${port}/mcp --header "Authorization: Bearer <token>"`
  const jsonConfig = JSON.stringify(
    {
      mcpServers: {
        opsmaxx: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: 'Bearer <token>' }
        }
      }
    },
    null,
    2
  )

  return (
    <div className="settings-section">
      <h2>{t('nav.ai.security')}</h2>
      <div className="sub">{t('ai.security.intro')}</div>

      {/* The switch shows whether the bridge is LISTENING, not whether it is
          meant to be. With the port taken it was drawn on beside text saying
          Off, and pressing it then turned the setting off rather than trying
          again. Now a press from off always asks main to start it. */}
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.security.enable')}</div>
          <div className={clsx('s-desc', config.enabled && !status.running && 'state-alarm')}>
            {status.running
              ? t('ai.security.listening', { address: `127.0.0.1:${port}` })
              : config.enabled
                ? t('ai.security.notListening', { address: `127.0.0.1:${config.port}` })
                : t('ai.security.off')}
          </div>
        </div>
        <Switch
          checked={status.running}
          label={t('ai.security.enable')}
          onChange={(v) => update({ enabled: v })}
        />
      </div>

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.security.localPort')}</div>
          <div className="s-desc">{t('ai.security.localPortDesc')}</div>
        </div>
        <input
          className="input"
          ref={portRef}
          style={{ width: 100 }}
          type="number"
          value={config.port}
          onChange={(e) => update({ port: Number(e.target.value) || config.port })}
        />
      </div>

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.security.approvalTimeout')}</div>
          <div className="s-desc">{t('ai.security.approvalTimeoutDesc')}</div>
        </div>
        <select
          className="input"
          value={config.approvalTimeoutSeconds}
          onChange={(e) => update({ approvalTimeoutSeconds: Number(e.target.value) })}
        >
          {[1, 2, 5, 10].map((m) => (
            <option key={m} value={m * 60}>
              {t('ai.security.minutes', { count: m })}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.security.defaultProfile')}</div>
          <div className="s-desc">{t('ai.security.defaultProfileDesc')}</div>
        </div>
        <ModePicker
          value={config.defaultSessionMode ?? PICKERLESS_MODE}
          onChange={(defaultSessionMode) => update({ defaultSessionMode })}
          groups={groups}
          groupId={config.defaultSessionGroupId ?? null}
          onGroupChange={(defaultSessionGroupId) => update({ defaultSessionGroupId })}
          defaultScope
        />
      </div>

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">🚨 {t('ai.security.stopAll')}</div>
          <div className="s-desc">
            {t('ai.security.stopAllDesc')}
            {/* Says what it would actually do, before it is pressed. An
                emergency stop that cannot tell you whether anything is running
                is one you press to find out. */}
            {liveCount !== null && (
              <>
                {' '}
                {t('ai.security.rightNow', { sessions: liveCount.sessions, pending: liveCount.pending })}
              </>
            )}
          </div>
        </div>
        <button className="btn danger outline" onClick={killAll}>
          <Octagon size={14} /> {t('ai.security.stopAll')}
        </button>
      </div>

      <h3 style={{ marginTop: 24 }}>{t('ai.security.claudeTitle')}</h3>
      <div className="setting-row" style={{ alignItems: 'flex-start' }}>
        <div className="s-info">
          <div className="s-desc">
            <Trans
              i18nKey="ai.security.claudeDesc"
              components={{ token: <code className="mono">&lt;token&gt;</code> }}
            />
          </div>
        </div>
        <button className="btn sm" onClick={() => openAi('agents')}>
          <Plus size={13} /> {t('ai.security.createSession')}
        </button>
      </div>
      <div className="setting-row">
        <code className="mono" style={{ flex: 1, wordBreak: 'break-all' }}>
          {cliCommand}
        </code>
        <button className="btn sm" onClick={() => copy(cliCommand)}>
          <Copy size={13} />
        </button>
      </div>

      <h3 style={{ marginTop: 18 }}>{t('ai.security.otherTitle')}</h3>
      <div className="s-desc">{t('ai.security.otherDesc')}</div>
      <div className="setting-row">
        <pre className="mono" style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{jsonConfig}</pre>
        <button className="btn sm" onClick={() => copy(jsonConfig)}>
          <Copy size={13} />
        </button>
      </div>
      <div className="s-desc">{t('ai.security.portable')}</div>

      <h3 style={{ marginTop: 18 }}>{t('ai.security.cliTitle')}</h3>
      <div className="s-desc">
        <Trans
          i18nKey="ai.security.cliDesc"
          components={{
            install: <code className="mono">npm install -g opsmaxx</code>,
            installLocal: <code className="mono">npm install -g .</code>,
            claude: <code className="mono">opsmaxx claude</code>,
            codex: <code className="mono">opsmaxx codex</code>,
            run: <code className="mono">opsmaxx run -- &lt;command&gt;</code>
          }}
        />
      </div>
    </div>
  )
}
