import { useEffect, useState } from 'react'
import { englishT } from '../../../../shared/i18n'
import { Copy, Eye, EyeOff, TriangleAlert, Terminal, MonitorSmartphone, SquareTerminal } from 'lucide-react'
import { toast } from '../../store/toast'
import type { ToastAction } from '../../store/toast'
import { useApp } from '../../store/app'
import { openAi, openSettings } from '../../store/nav'
import type { AccessGroup, SessionMode } from '../../../../shared/mcp'
import { DEFAULT_SESSION_MODE, resolveDefaultSessionGroup, sessionModeLabel } from '../../../../shared/mcp'
import { ModePicker } from './ModePicker'
import { containsBearerToken, maskBearerTokens } from '../../../../shared/tokenDisplay'
import type { MessageKey } from '../../../../shared/i18n'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

type Target = 'claude-code' | 'claude-desktop' | 'codex'

interface Ready {
  target: Target
  command?: string
  path?: string
  backedUpTo?: string
}

// A failure carries the button that fixes it. Each step here fails for its own
// reason and each reason has its own next step, so the two travel together
// rather than the catch block guessing from the wording of a message.
class StepError extends Error {
  readonly action?: ToastAction
  constructor(message: string, action?: ToastAction) {
    super(message)
    this.action = action
  }
}

// Claude Desktop and Codex both launch MCP servers as stdio subprocesses and
// have nowhere to put a bearer token for a local URL, so both get the bridge
// entry written into their own config file. Only Claude Code speaks Streamable
// HTTP directly, which is why it gets a command to paste instead.
const FILE_CLIENTS: Record<'claude-desktop' | 'codex', string> = {
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex'
}

const TARGETS: { id: Target; labelKey: MessageKey; agentName: string; icon: React.JSX.Element }[] = [
  { id: 'claude-code', labelKey: 'ai.connect.claudeCode', agentName: 'Claude Code', icon: <Terminal size={13} /> },
  {
    id: 'claude-desktop',
    labelKey: 'ai.connect.claudeDesktop',
    agentName: 'Claude Desktop',
    icon: <MonitorSmartphone size={13} />
  },
  { id: 'codex', labelKey: 'ai.connect.codex', agentName: 'Codex', icon: <SquareTerminal size={13} /> }
]

// Everything under "How it works" — enable the bridge, pick an access group
// and a mode, mint a session, hand the token to the client — collapsed into one
// button per client. Done by hand it spans three tabs.
export function ConnectAgent({ onConnected }: { onConnected?: () => void }): React.JSX.Element {
  const [groups, setGroups] = useState<AccessGroup[]>([])
  // `null` until resolved, `''` once resolved to No AI Access — see the same
  // distinction in AiAgents.tsx. Without it a resolved No AI Access is
  // indistinguishable from "still loading" and gets overwritten.
  const [groupId, setGroupId] = useState<string | null>(null)
  const [mode, setMode] = useState<SessionMode | null>(null)
  const [busy, setBusy] = useState<Target | null>(null)
  const [ready, setReady] = useState<Ready | null>(null)
  const [error, setError] = useState<{ text: string; action?: ToastAction } | null>(null)
  // Hidden until asked for, and re-hidden whenever a new command is issued —
  // revealing one token must not silently reveal the next one.
  const [revealed, setRevealed] = useState(false)
  const t = useT()

  useEffect(() => {
    void Promise.all([window.opsmaxx?.aiPolicy.listGroups(), window.opsmaxx?.aiMcp.getConfig?.()]).then(
      ([g, cfg]) => {
        const list = g ?? []
        setGroups(list)
        // A configured `defaultSessionGroupId` wins, because it is the setting
        // that exists for this exact decision and the user set it deliberately.
        // Read & Write is this flow's own considered default for when nothing is
        // configured, and it stays: Read Only cannot add a server, so the
        // one-click path could never use add_server. Nothing here is granted
        // silently: every mutating capability in Read & Write is ASK, so writes,
        // uploads, tunnels and adding a server each still raise an approval
        // prompt in Auto mode. The picker is right there for anyone who wants
        // narrower, and a live session's group can be changed later.
        //
        // `list[0]` is gone. It was the one fallback nobody chose — not this
        // flow and not the user — and it resolved to whichever group sat first
        // in the policy file. A configured default that has since been deleted
        // does not reach Read & Write either: resolveDefaultSessionGroup()
        // consults the fallback only when nothing is configured at all.
        setGroupId((prev) => prev ?? resolveDefaultSessionGroup(cfg, list, 'grp-read-write').id ?? '')
        setMode((prev) => prev ?? cfg?.defaultSessionMode ?? null)
      }
    )
  }, [])

  const chosen = mode ?? DEFAULT_SESSION_MODE

  const connect = async (target: Target, agentName: string): Promise<void> => {
    const api = window.opsmaxx
    if (!api) return
    setBusy(target)
    setError(null)
    setReady(null)
    setRevealed(false)
    try {
      const config = await api.aiMcp.getConfig()
      if (!config.enabled) {
        const result = await api.aiMcp.setConfig({ enabled: true })
        if (result.error) {
          throw new StepError(
            t('ai.security.bindFailed', { port: config.port, error: result.error }),
            { label: t('ai.connect.changePort'), run: () => openAi('security') }
          )
        }
      }

      const status = await api.aiMcp.status()
      if (!status?.running || !status.port) {
        throw new StepError(t('ai.connect.didNotStart'), {
          label: t('ai.connect.openAiSettings'),
          run: () => openAi('security')
        })
      }

      const workspaces = (await api.aiPolicy.listWorkspaces()) ?? []
      if (workspaces.length === 0) {
        throw new StepError(t('ai.connect.noWorkspaces'), {
          label: t('ai.connect.openConnections'),
          run: () => useApp.getState().setActivity('connections')
        })
      }

      const group = groups.find((g) => g.id === groupId) ?? null

      // Connecting writes NO workspace assignment. It used to pin every
      // unassigned workspace to the chosen group -- a leftover from when an
      // assignment was the grant. Now the session's own group is the grant and
      // an assignment is a restriction, so that pin silently held every LATER
      // session in those workspaces to this group: widen an agent to Full
      // Access and it still read "Held below this group".
      const created = await api.aiMcp.createSession({
        agentName,
        workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
        // A predefined profile uses no group; only Custom is given one.
        groupId: chosen === 'custom' ? (group?.id ?? null) : null,
        groupName: chosen === 'custom' ? (group?.name ?? 'No AI Access') : sessionModeLabel(chosen, undefined, englishT),
        // A config-file client has no way to re-pair when a token lapses — it
        // would just stop working silently. Revoke under Active Sessions
        // instead, which is visible and deliberate.
        ttlMinutes: null,
        mode: chosen
      })
      if (!created) {
        throw new StepError(t('ai.connect.noSession'), {
          label: t('ai.connect.createByHand'),
          run: () => openAi('agents')
        })
      }

      if (target === 'claude-code') {
        const command = await api.aiMcp.claudeCodeCommand(created.token, status.port)
        await navigator.clipboard.writeText(command)
        setReady({ target, command })
        toast(t('ai.connect.commandCopiedPaste'))
      } else {
        const label = FILE_CLIENTS[target]
        const write = target === 'codex' ? api.aiMcp.writeCodexConfig : api.aiMcp.writeClaudeDesktopConfig
        if (typeof write !== 'function') {
          throw new StepError(t('ai.connect.cannotConfigure', { client: label }), {
            label: t('ai.connect.checkUpdates'),
            run: () => openSettings('general')
          })
        }
        const result = await write(created.token, status.port)
        // Nothing in the app can fix a config file it is not allowed to write,
        // so this one says what happened and stops there rather than offering a
        // button that would do nothing.
        if (!result.ok) throw new StepError(result.error ?? t('ai.connect.writeFailed', { client: label }))
        setReady({ target, path: result.path, backedUpTo: result.backedUpTo })
        toast(t('ai.connect.configured', { client: label }), 'ok')
      }
      onConnected?.()
    } catch (err) {
      setError({
        text: err instanceof Error ? err.message : String(err),
        action: err instanceof StepError ? err.action : undefined
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h3>{t('ai.connect.title')}</h3>
      <div className="s-desc" style={{ marginBottom: 12 }}>
        {t('ai.connect.intro')}
      </div>

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.modePicker.sectionProfile')}</div>
          <div className="s-desc">{t('ai.connect.profileDesc')}</div>
        </div>
        <ModePicker value={chosen} onChange={setMode} />
      </div>

      {chosen === 'custom' && (
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.connect.accessGroup')}</div>
          <div className="s-desc">{t('ai.connect.accessGroupDesc')}</div>
        </div>
        <select
          className="input"
          data-testid="connect-group"
          value={groupId ?? ''}
          onChange={(e) => setGroupId(e.target.value)}
        >
          {/* A real resolved answer, so it is on the list: a <select> whose
              value matches no option renders blank, which reads as the first
              group rather than as no access. */}
          <option value="">{t('ai.connect.noAccess')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        {TARGETS.map((target) => (
          <button
            key={target.id}
            className="btn sm primary"
            disabled={busy !== null}
            onClick={() => void connect(target.id, target.agentName)}
          >
            {target.icon} {busy === target.id ? t('ai.connect.connecting') : t(target.labelKey)}
          </button>
        ))}
      </div>

      {error && (
        <div className="setting-row" style={{ marginTop: 12, alignItems: 'flex-start' }}>
          <div className="s-info">
            <div className="s-title">
              <TriangleAlert size={13} /> {t('ai.connect.couldNotConnect')}
            </div>
            <div className="s-desc">{error.text}</div>
          </div>
          {error.action && (
            <button className="btn sm primary" onClick={error.action.run}>
              {error.action.label}
            </button>
          )}
        </div>
      )}

      {ready?.target === 'claude-code' && ready.command && (
        <div className="settings-section" style={{ marginTop: 12 }}>
          <h3>Claude Code</h3>
          {/* The old copy read "the token is in that command and is shown only
              once here" — beside a Copy again button, above the full 64-character
              token in plain selectable text. The claim was defensible (only the
              hash is stored, so this is the only time it CAN be shown) but it
              reads as "already hidden", and it was not. A page users screenshot
              for their team should not need the reader to know which half of
              that sentence to believe, so the token is now actually hidden and
              the sentence says what is true. */}
          <div className="s-desc">{t('ai.connect.copiedExplain')}</div>
          <div className="setting-row">
            <div className="s-info">
              <div className="s-title mono" style={{ wordBreak: 'break-all' }}>
                {revealed ? ready.command : maskBearerTokens(ready.command)}
              </div>
            </div>
            {containsBearerToken(ready.command) && (
              <button
                className="btn sm"
                aria-pressed={revealed}
                onClick={() => setRevealed((r) => !r)}
                title={
                  revealed
                    ? t('ai.connect.hideTokenTitle')
                    : t('ai.connect.revealTokenTitle')
                }
              >
                {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                {revealed ? t('common.hide') : t('ai.connect.reveal')}
              </button>
            )}
            {/* Copies the real command whatever the field is showing: the
                clipboard is the intended way to move the token, and making the
                user reveal it first would only put it on screen for no reason. */}
            <button
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(ready.command ?? '')
                toast(t('ai.connect.commandCopied'))
              }}
            >
              <Copy size={13} /> {t('ai.connect.copyAgain')}
            </button>
          </div>
        </div>
      )}

      {ready && ready.target !== 'claude-code' && ready.path && (
        <div className="settings-section" style={{ marginTop: 12 }}>
          <h3>{FILE_CLIENTS[ready.target]}</h3>
          <div className="s-desc">
            <Trans i18nKey="ai.connect.written" components={{ path: <code className="mono">{ready.path}</code> }} />
            {ready.backedUpTo ? (
              <>
                {' '}
                <Trans
                  i18nKey="ai.connect.backedUp"
                  components={{ path: <code className="mono">{ready.backedUpTo}</code> }}
                />
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
