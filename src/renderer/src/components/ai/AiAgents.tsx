import { useEffect, useState } from 'react'
import { englishT } from '../../../../shared/i18n'
import { Plus, Copy, Eye, EyeOff, Ban, Octagon, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from '../../store/toast'
import { useApp } from '../../store/app'
import { openAi, useNav } from '../../store/nav'
import { SessionAccess } from './SessionAccess'
import type { McpAgentSession, AccessGroup, McpGlobalConfig, SessionMode } from '../../../../shared/mcp'
import { DEFAULT_SESSION_MODE, resolveDefaultSessionGroup, sessionModeLabel, sessionModeOf } from '../../../../shared/mcp'
import { ModePicker } from './ModePicker'
import { maskToken } from '../../../../shared/tokenDisplay'
import { Switch } from '../common/Switch'
import { t as tr, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

interface WorkspaceOpt {
  id: string
  name: string
}


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

function fmtTime(iso: string | null): string {
  if (!iso) return tr('common.never')
  return new Date(iso).toLocaleString()
}

function isLive(s: McpAgentSession): boolean {
  return !s.revoked && (!s.expiresAt || new Date(s.expiresAt) > new Date())
}

function CreateSessionForm({
  workspaces,
  groups,
  onCreated
}: {
  workspaces: WorkspaceOpt[]
  groups: AccessGroup[]
  onCreated: () => void
}): React.JSX.Element {
  const [agentName, setAgentName] = useState('Claude Code')
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(workspaces[0] ? [workspaces[0].id] : [])
  // Whatever resolveDefaultSessionGroup() says, preselected in the picker below
  // so the grant is on screen before Create is pressed. `null` means "not
  // resolved yet" and `''` means "resolved to No AI Access" — two states that a
  // single empty string cannot tell apart, which matters because No AI Access is
  // now a legitimate resolved answer and has to stop the effect below from
  // asking again on every 5-second poll of `groups`.
  const [groupId, setGroupId] = useState<string | null>(null)
  // `null` means "nobody picked one": main then applies the configured default
  // itself. Same "prev ??" rule as groupId, so a slow getConfig cannot
  // overwrite a mode the user picked.
  const [mode, setMode] = useState<SessionMode | null>(null)
  // Read once on mount, whether or not any group exists yet. `undefined` while
  // in flight, `null` when it could not be read.
  const [cfg, setCfg] = useState<McpGlobalConfig | null | undefined>(undefined)
  const [ttl, setTtl] = useState(60)
  const [issued, setIssued] = useState<{ token: string; port: number | null } | null>(null)
  // Re-hidden whenever a new session is issued, so revealing one token does not
  // silently reveal the next.
  const [revealed, setRevealed] = useState(false)
  const t = useT()

  // workspaces/groups arrive async (an IPC round-trip after this form has
  // already mounted with empty props), so the useState initializers above
  // usually capture '' and never get a second chance — the controls then
  // *look* selected but the state backing them is empty, and Create fails
  // with "select at least one workspace" even though one exists. Backfill
  // once real data shows up, but only while the user hasn't picked anything.
  useEffect(() => {
    if (workspaceIds.length === 0 && workspaces.length > 0) setWorkspaceIds([workspaces[0].id])
  }, [workspaces, workspaceIds])
  // The group is the grant, so the only thing allowed to choose it for the user
  // is the setting that exists for that decision. It used to fall back to
  // `groups[0]`, which made the most permissive group in the list the default
  // for every new agent on some installs, purely because of where it sat in the
  // array — a picker in front of it makes that milder than it was at pairing
  // time, not different in kind. No fallback group is passed here either: with
  // nothing configured this preselects No AI Access, and a user who wants more
  // says which, in the control right next to it.
  //
  // `prev ?? …`, not a bare set, for the reason ConnectAgent.tsx uses the same
  // form: `groups` is refetched every 5 seconds into a NEW array, so this effect
  // re-runs on every poll until it settles, and a resolve that lands while
  // `getConfig()` was in flight would otherwise overwrite a group the user had
  // already picked in the control — silently, and usually downwards, to the
  // configured default or to No AI Access. Create then mints the session on a
  // grant nobody chose. Settling in the `.catch` too is what ends the loop: a
  // rejected getConfig used to leave `groupId` null forever, so every poll fired
  // a fresh IPC call and a fresh unhandled rejection for the life of the page;
  // the config is now read exactly once. No AI Access is the right thing to
  // settle on when it cannot be read — it fails closed, and the picker next to
  // it says so.
  useEffect(() => {
    const read = window.opsmaxx?.aiMcp.getConfig?.()
    if (!read) return setCfg(null)
    read.then((c) => setCfg(c ?? null)).catch(() => setCfg(null))
  }, [])
  useEffect(() => {
    if (cfg === undefined) return
    setMode((prev) => prev ?? cfg?.defaultSessionMode ?? null)
  }, [cfg])
  useEffect(() => {
    if (groupId !== null || groups.length === 0 || cfg === undefined) return
    setGroupId((prev) => prev ?? (cfg ? (resolveDefaultSessionGroup(cfg, groups).id ?? '') : ''))
  }, [groups, groupId, cfg])

  const toggleWorkspace = (id: string): void => {
    setWorkspaceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const chosen = mode ?? DEFAULT_SESSION_MODE
  const custom = chosen === 'custom'

  const create = async (): Promise<void> => {
    const selected = workspaces.filter((w) => workspaceIds.includes(w.id))
    const group = groups.find((g) => g.id === groupId)
    if (selected.length === 0) {
      // Two different problems wore the same sentence: "you missed a checkbox"
      // and "there is nothing here to check".
      if (workspaces.length === 0) {
        toast(t('ai.authorizations.noWorkspaces'), 'error', {
          label: t('ai.connect.openConnections'),
          run: () => useApp.getState().setActivity('connections')
        })
        return
      }
      toast(t('ai.agents.pickWorkspace'), 'error')
      return
    }
    try {
      const result = await window.opsmaxx?.aiMcp.createSession({
        agentName: agentName.trim() || 'Unnamed agent',
        workspaces: selected.map((w) => ({ id: w.id, name: w.name })),
        // A predefined profile uses no group; only Custom is given one.
        groupId: custom ? (group?.id ?? null) : null,
        groupName: custom ? (group?.name ?? 'No AI Access') : sessionModeLabel(chosen, undefined, englishT),
        ttlMinutes: ttl === 0 ? null : ttl,
        mode: chosen
      })
      if (!result) throw new Error(t('ai.agents.noSessionReturned'))
      const status = await window.opsmaxx?.aiMcp.status()
      setRevealed(false)
      setIssued({ token: result.token, port: status?.running ? status.port : null })
      onCreated()
    } catch (err) {
      // Before this the button simply did nothing when the call failed.
      toast(t('ai.agents.notCreated', { error: err instanceof Error ? err.message : String(err) }), 'error', {
        label: t('ai.security.tryAgain'),
        run: () => void create()
      })
    }
  }

  // Does what it says: turns the bridge on, then says whether it is listening.
  // It used to open the Security page and leave the switch to be found there.
  const turnOn = async (): Promise<void> => {
    const result = await window.opsmaxx?.aiMcp.setConfig({ enabled: true })
    const status = await window.opsmaxx?.aiMcp.status()
    if (status?.running && status.port) {
      const port = status.port
      setIssued((i) => (i ? { ...i, port } : i))
      toast(t('ai.agents.turnedOn', { address: `127.0.0.1:${port}` }), 'ok')
      return
    }
    toast(
      result?.error ? t('ai.agents.didNotStartError', { error: result.error }) : t('ai.agents.didNotStart'),
      'error',
      { label: t('ai.agents.openSecurity'), run: () => openAi('security') }
    )
  }

  if (issued) {
    const url = `http://127.0.0.1:${issued.port}/mcp`
    const jsonConfig = JSON.stringify(
      { mcpServers: { opsmaxx: { url, headers: { Authorization: `Bearer ${issued.token}` } } } },
      null,
      2
    )
    return (
      <div className="settings-section" style={{ marginBottom: 24 }}>
        <h3>{t('ai.agents.created')}</h3>
        {issued.port === null && (
          // The snippet used to be emitted with "(disabled)" where the port
          // goes, which is a config file that cannot work and does not say why.
          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="s-info">
              <div className="s-title">
                <TriangleAlert size={13} /> {t('ai.agents.nothingCanConnect')}
              </div>
              <div className="s-desc">{t('ai.agents.switchedOff')}</div>
            </div>
            <button className="btn sm primary" onClick={() => void turnOn()}>
              {t('ai.agents.turnOn')}
            </button>
          </div>
        )}
        <div className="s-desc">
          <Trans
            i18nKey="ai.agents.tokenExplain"
            components={{
              b: <b />,
              url: <code className="mono">url</code>,
              headers: <code className="mono">headers</code>,
              codex: <code className="mono">opsmaxx codex</code>
            }}
          />
        </div>
        {issued.port !== null && (
          <div className="setting-row">
            <div className="s-info">
              <div className="s-title">{t('ai.agents.snippet', { file: 'mcp.json' })}</div>
              <div className="s-desc">{t('ai.agents.snippetDesc')}</div>
            </div>
            <button
              className="btn sm"
              onClick={() => {
                navigator.clipboard.writeText(jsonConfig)
                toast(t('ai.agents.configCopied'))
              }}
            >
              <Copy size={13} /> {t('ai.agents.copyConfig')}
            </button>
          </div>
        )}
        {/* Hidden by default. This page is one users screenshot to hand to a
            colleague, and the token grants whatever its access group grants on
            every server in the workspace. Copy does not need it visible. */}
        <div className="setting-row">
          <div className="s-info">
            <div className="s-title mono" style={{ wordBreak: 'break-all' }}>
              {revealed ? issued.token : maskToken(issued.token)}
            </div>
            <div className="s-desc">{t('ai.agents.rawToken')}</div>
          </div>
          <button className="btn sm" aria-pressed={revealed} onClick={() => setRevealed((r) => !r)}>
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            {revealed ? t('common.hide') : t('ai.connect.reveal')}
          </button>
          <button
            className="btn sm"
            onClick={() => {
              navigator.clipboard.writeText(issued.token)
              toast(t('ai.agents.tokenCopied'))
            }}
          >
            <Copy size={13} /> {t('ai.agents.copyToken')}
          </button>
        </div>
        <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setIssued(null)}>
          {t('common.done')}
        </button>
      </div>
    )
  }

  return (
    <div className="settings-section" id="ai-new-session" style={{ marginBottom: 24 }}>
      <h3>{t('ai.agents.newSession')}</h3>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.agents.agentName')}</div>
          <div className="s-desc">{t('ai.agents.agentNameDesc')}</div>
        </div>
        <input className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
      </div>
      <div className="setting-row" style={{ alignItems: 'flex-start' }}>
        <div className="s-info">
          <div className="s-title">{t('layout.workspaces.heading')}</div>
          <div className="s-desc">{t('ai.agents.workspacesDesc')}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          {workspaces.map((w) => (
            <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              {w.name}
              <Switch checked={workspaceIds.includes(w.id)} onChange={() => toggleWorkspace(w.id)} />
            </label>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.modePicker.sectionProfile')}</div>
          <div className="s-desc">{t('ai.agents.profileDesc')}</div>
        </div>
        <ModePicker value={chosen} onChange={setMode} />
      </div>
      {custom && (
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.connect.accessGroup')}</div>
          <div className="s-desc">{t('ai.agents.accessGroupDesc')}</div>
        </div>
        <select
          className="input"
          data-testid="new-session-group"
          value={groupId ?? ''}
          onChange={(e) => setGroupId(e.target.value)}
        >
          {/* Present as an option because it is a real resolved answer, not
              only a user's choice: with no default configured the picker lands
              here, and a <select> whose value matches no option renders blank —
              which reads as "the first group", the very thing this is not.
              FIRST for the same reason, and that position is load-bearing: React
              sets `selected` per option, so a value matching none leaves the
              browser's selectedness reset to pick option ZERO. `groupId` can stop
              matching at any moment — `groups` is refetched every 5 seconds and an
              admin can delete the picked group mid-form — and this is what makes
              that land on the same answer `create()` then submits, rather than on
              whatever group happened to be listed first.
              defaultSessionGroup.test.tsx pins it; move this line and it goes red. */}
          <option value="">{t('ai.connect.noAccess')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      )}
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.agents.expiresAfter')}</div>
          <div className="s-desc">{t('ai.agents.expiresAfterDesc')}</div>
        </div>
        <select className="input" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          <option value={15}>{t('ai.security.minutes', { count: 15 })}</option>
          <option value={60}>{t('ai.agents.hours', { count: 1 })}</option>
          <option value={480}>{t('ai.agents.hours', { count: 8 })}</option>
          <option value={10080}>{t('ai.agents.days', { count: 7 })}</option>
          <option value={0}>{t('common.never')}</option>
        </select>
      </div>
      <button className="btn sm primary" onClick={create}>
        <Plus size={13} /> {t('ai.agents.createSession')}
      </button>
    </div>
  )
}

export function AiAgents({ sessionsOnly = false }: { sessionsOnly?: boolean }): React.JSX.Element {
  const [sessions, setSessions] = useState<McpAgentSession[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceOpt[]>([])
  const [groups, setGroups] = useState<AccessGroup[]>([])
  const focusSessionId = useNav((s) => s.aiSessionId)
  const t = useT()

  // Sent here to look at one session (from the approval dialog): scroll to it
  // once the list has it, then forget the request.
  useEffect(() => {
    if (!focusSessionId || !sessions.some((s) => s.id === focusSessionId)) return
    document.getElementById(`ai-session-${focusSessionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    useNav.getState().clearAiSession()
  }, [focusSessionId, sessions])

  const load = (): void => {
    void window.opsmaxx?.aiMcp.listSessions().then((s) => setSessions(s ?? []))
    void window.opsmaxx?.aiPolicy.listWorkspaces().then((w) => setWorkspaces(w ?? []))
    void window.opsmaxx?.aiPolicy.listGroups().then((g) => setGroups(g ?? []))
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  // Takes the user to the form that issues a session and puts it on screen —
  // the AI Agents page can be long, and landing above the fold of it is not the
  // same as being shown the thing you asked for.
  const newSession = (): void => {
    openAi('agents')
    requestAnimationFrame(() =>
      document.getElementById('ai-new-session')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    )
  }

  const killAll = async (): Promise<void> => {
    // Read BEFORE the revocation, so the ledger is reported as it stood when
    // the operator pressed the button rather than after anything raced it.
    const builds = await buildsClause()
    const result = await window.opsmaxx?.aiMcp.killAllSessions()
    load()
    if (!result) {
      // "Failed" on a safety control is the least useful word available: the
      // user needs to know access is still live, and be able to try again.
      toast(t('ai.security.stopFailed'), 'error', {
        label: t('ai.security.tryAgain'),
        run: () => void killAll()
      })
      return
    }
    toast(
      builds === ''
        ? t('ai.agents.stoppedNoBuilds', { revoked: result.revoked, denied: result.denied })
        : t('ai.agents.stoppedWithBuilds', {
            revoked: result.revoked,
            denied: result.denied,
            builds: builds.replace(/^\n\n/, '')
          }),
      'ok'
    )
  }

  return (
    <div className="settings-section">
      <h2>{sessionsOnly ? t('nav.ai.sessions') : t('nav.ai.agents')}</h2>
      <div className="sub">{sessionsOnly ? t('ai.agents.sessionsIntro') : t('ai.agents.agentsIntro')}</div>

      {!sessionsOnly && <CreateSessionForm workspaces={workspaces} groups={groups} onCreated={load} />}

      {sessions.length === 0 && <div className="s-desc">{t('ai.agents.noSessions')}</div>}

      {sessions.map((s) => {
        // Defensive: mcpAuth.ts migrates old single-workspace session
        // records on load, but never trust a render path on a field that
        // has changed shape once already — a missing/malformed array here
        // should render as empty, not crash the whole panel.
        const ws = Array.isArray(s.workspaces) ? s.workspaces : []
        return (
          <div className="list-row" key={s.id} id={`ai-session-${s.id}`} style={{ flexWrap: 'wrap' }}>
            <div>
              <div className="r-title">
                {s.agentName}
                {/* A live session shows its picker below instead. */}
                {!isLive(s) && (
                  <>
                    {' '}
                    <span className="chip" data-testid="session-mode-chip" title={t('ai.modePicker.sectionProfile')}>
                      {sessionModeLabel(sessionModeOf(s), s.groupName)}
                    </span>
                  </>
                )}
              </div>
              <div className="r-sub">
                {t(ws.length > 1 ? 'ai.agents.workspacesLine' : 'ai.agents.workspaceLine', {
                  names: ws.map((w) => w.name).join(', ') || '—',
                  started: fmtTime(s.createdAt)
                })}
                {s.expiresAt ? t('ai.agents.expires', { time: fmtTime(s.expiresAt) }) : t('ai.agents.noExpiry')}
              </div>
            </div>
            <div className="spacer" />
            <div className="r-stat">
              {isLive(s) ? t('ai.agents.active') : s.revoked ? t('ai.agents.revoked') : t('ai.agents.expired')}
            </div>
            {isLive(s) ? (
              <button
                className="btn sm danger outline"
                onClick={async () => {
                  await window.opsmaxx?.aiMcp.revokeSession(s.id)
                  toast(t('ai.agents.revokedToast', { agent: s.agentName }), 'ok')
                  load()
                }}
              >
                <Ban size={13} /> {t('ai.agents.revoke')}
              </button>
            ) : (
              // A revoked or expired row is otherwise a dead end: the client
              // still has a token that no longer works, and the form that
              // issues a replacement lives on another page.
              <button className="btn sm" onClick={newSession} title={t('ai.agents.replacementTitle')}>
                <Plus size={13} /> {t('ai.agents.newSessionButton')}
              </button>
            )}
            <button
              className="btn sm"
              title={t('ai.agents.deleteTitle')}
              onClick={async () => {
                if (!confirm(t('ai.agents.deleteConfirm', { agent: s.agentName }))) return
                await window.opsmaxx?.aiMcp.deleteSession(s.id)
                toast(t('ai.agents.deleted', { agent: s.agentName }), 'ok')
                load()
              }}
            >
              <Trash2 size={13} /> {t('common.delete')}
            </button>
            {isLive(s) && <SessionAccess session={s} groups={groups} onChanged={load} />}
          </div>
        )
      })}

      {sessions.some(isLive) && (
        <button className="btn danger outline" style={{ marginTop: 18 }} onClick={killAll}>
          <Octagon size={14} /> {t('ai.security.stopAll')}
        </button>
      )}
    </div>
  )
}
