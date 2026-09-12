import { useEffect, useState } from 'react'
import { Plus, Copy, Eye, EyeOff, Ban, Octagon, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { useApp } from '../../store/app'
import { openAi } from '../../store/nav'
import { SessionAccess } from './SessionAccess'
import type { McpAgentSession, AccessGroup } from '../../../../shared/mcp'
import { resolveDefaultSessionGroup } from '../../../../shared/mcp'
import { maskToken } from '../../../../shared/tokenDisplay'

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
        const how = r.state === 'unknown' ? 'state not reported' : r.state
        return `  • ${what} on ${r.connectionName} (${how})`
      })
      .join('\n')
    const more = runs.length > 5 ? `\n  • …and ${runs.length - 5} more` : ''
    return (
      `\n\nThis does NOT stop ${runs.length} build(s) an agent started:\n${lines}${more}` +
      '\nStop those on the run in CI/CD, or in the provider.'
    )
  } catch {
    // The dialog must open even if this cannot be answered.
    return ''
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return 'Never'
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
  const [ttl, setTtl] = useState(60)
  const [issued, setIssued] = useState<{ token: string; port: number | null } | null>(null)
  // Re-hidden whenever a new session is issued, so revealing one token does not
  // silently reveal the next.
  const [revealed, setRevealed] = useState(false)

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
  // a fresh IPC call and a fresh unhandled rejection for the life of the page.
  // No AI Access is the right thing to settle on when the config cannot be read
  // — it fails closed, and the picker next to it says so.
  useEffect(() => {
    if (groupId !== null || groups.length === 0) return
    void window.opsmaxx?.aiMcp
      .getConfig?.()
      .then((cfg) => setGroupId((prev) => prev ?? (resolveDefaultSessionGroup(cfg, groups).id ?? '')))
      .catch(() => setGroupId((prev) => prev ?? ''))
  }, [groups, groupId])

  const toggleWorkspace = (id: string): void => {
    setWorkspaceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const create = async (): Promise<void> => {
    const selected = workspaces.filter((w) => workspaceIds.includes(w.id))
    const group = groups.find((g) => g.id === groupId)
    if (selected.length === 0) {
      // Two different problems wore the same sentence: "you missed a checkbox"
      // and "there is nothing here to check".
      if (workspaces.length === 0) {
        toast('There are no workspaces yet, and a session has to be scoped to at least one.', 'error', {
          label: 'Open Connections',
          run: () => useApp.getState().setActivity('connections')
        })
        return
      }
      toast('Pick at least one workspace for this agent to see.', 'error')
      return
    }
    try {
      const result = await window.opsmaxx?.aiMcp.createSession({
        agentName: agentName.trim() || 'Unnamed agent',
        workspaces: selected.map((w) => ({ id: w.id, name: w.name })),
        groupId: group?.id ?? null,
        groupName: group?.name ?? 'No AI Access',
        ttlMinutes: ttl === 0 ? null : ttl
      })
      if (!result) throw new Error('OpsMaxx returned no session')
      const status = await window.opsmaxx?.aiMcp.status()
      setRevealed(false)
      setIssued({ token: result.token, port: status?.running ? status.port : null })
      onCreated()
    } catch (err) {
      // Before this the button simply did nothing when the call failed.
      toast(`The session was not created: ${err instanceof Error ? err.message : String(err)}`, 'error', {
        label: 'Try again',
        run: () => void create()
      })
    }
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
        <h3>Session created</h3>
        {issued.port === null && (
          // The snippet used to be emitted with "(disabled)" where the port
          // goes, which is a config file that cannot work and does not say why.
          <div className="setting-row" style={{ alignItems: 'flex-start' }}>
            <div className="s-info">
              <div className="s-title">
                <TriangleAlert size={13} /> Nothing can connect yet
              </div>
              <div className="s-desc">
                The token below is valid, but AI &amp; MCP access is switched off, so OpsMaxx is not
                listening for any agent.
              </div>
            </div>
            <button className="btn sm primary" onClick={() => openAi('security')}>
              Turn on AI access
            </button>
          </div>
        )}
        <div className="s-desc">
          OpsMaxx keeps only a hash of this token, so this is the only time it can show it to
          you — if you lose it, revoke the session and create a new one. It is hidden below
          until you ask for it. Copy the block below into an MCP client that speaks
          Streamable HTTP (e.g. Gemini CLI). <b>Claude Desktop cannot use it</b> — it ignores{' '}
          <code className="mono">url</code> and <code className="mono">headers</code> and only
          launches stdio servers; use <b>Overview → Connect Claude Desktop</b>, which writes the
          bridge entry it does understand. For Claude Code, <b>Overview → Connect Claude Code</b>
          gives you a one-line command; Codex has{' '}
          <code className="mono">opsmaxx codex</code>.
        </div>
        {issued.port !== null && (
          <div className="setting-row">
            <div className="s-info">
              <div className="s-title">mcp.json snippet</div>
              <div className="s-desc">For clients configured via a JSON file.</div>
            </div>
            <button
              className="btn sm"
              onClick={() => {
                navigator.clipboard.writeText(jsonConfig)
                toast('Config copied')
              }}
            >
              <Copy size={13} /> Copy JSON config
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
            <div className="s-desc">
              Raw token, if you need it on its own. Reveal only puts it on this screen — anyone who
              can see the screen can then read it.
            </div>
          </div>
          <button className="btn sm" aria-pressed={revealed} onClick={() => setRevealed((r) => !r)}>
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            {revealed ? 'Hide' : 'Reveal'}
          </button>
          <button
            className="btn sm"
            onClick={() => {
              navigator.clipboard.writeText(issued.token)
              toast('Token copied')
            }}
          >
            <Copy size={13} /> Copy token
          </button>
        </div>
        <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setIssued(null)}>
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="settings-section" id="ai-new-session" style={{ marginBottom: 24 }}>
      <h3>New AI agent session</h3>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">Agent name</div>
          <div className="s-desc">A label for the Active Sessions list — e.g. "Claude Code", "Codex".</div>
        </div>
        <input className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
      </div>
      <div className="setting-row" style={{ alignItems: 'flex-start' }}>
        <div className="s-info">
          <div className="s-title">Workspaces</div>
          <div className="s-desc">
            This session only ever sees servers inside the workspace(s) selected here — pick as
            many as this agent needs.
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          {workspaces.map((w) => (
            <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              {w.name}
              <span
                className={clsx('switch', workspaceIds.includes(w.id) && 'on')}
                onClick={() => toggleWorkspace(w.id)}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">Access group</div>
          <div className="s-desc">
            What this agent may do on the servers in those workspaces. This is the grant — there is
            nothing else to set. A server can still be held below it individually, and the session
            says so when one is.
          </div>
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
          <option value="">No AI Access</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">Expires after</div>
          <div className="s-desc">The session stops working once this elapses.</div>
        </div>
        <select className="input" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
          <option value={15}>15 minutes</option>
          <option value={60}>1 hour</option>
          <option value={480}>8 hours</option>
          <option value={10080}>7 days</option>
          <option value={0}>Never</option>
        </select>
      </div>
      <button className="btn sm primary" onClick={create}>
        <Plus size={13} /> Create session
      </button>
    </div>
  )
}

export function AiAgents({ sessionsOnly = false }: { sessionsOnly?: boolean }): React.JSX.Element {
  const [sessions, setSessions] = useState<McpAgentSession[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceOpt[]>([])
  const [groups, setGroups] = useState<AccessGroup[]>([])

  const load = (): void => {
    void window.opsmaxx?.aiMcp.listSessions().then((s) => setSessions(s ?? []))
    void window.opsmaxx?.aiPolicy.listWorkspaces().then((w) => setWorkspaces(w ?? []))
    void window.opsmaxx?.aiPolicy.listGroups().then((g) => setGroups(g ?? []))
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
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
      toast('AI access was not stopped — every session is still live.', 'error', {
        label: 'Try again',
        run: () => void killAll()
      })
      return
    }
    toast(
      `Stopped every agent: ${result.revoked} session(s) revoked, ${result.denied} waiting request(s) denied.` +
        (builds === ''
          ? ' No build an agent started is still in flight.'
          : builds.replace(/^\n\n/, ' ')),
      'ok'
    )
  }

  return (
    <div className="settings-section">
      <h2>{sessionsOnly ? 'Active Sessions' : 'AI Agents'}</h2>
      <div className="sub">
        {sessionsOnly
          ? 'Every agent currently authorized to talk to OpsMaxx, with its workspace(s) and access group.'
          : 'Create a scoped session for each AI client, then paste its token into that client\'s MCP configuration.'}
      </div>

      {!sessionsOnly && <CreateSessionForm workspaces={workspaces} groups={groups} onCreated={load} />}

      {sessions.length === 0 && <div className="s-desc">No sessions yet.</div>}

      {sessions.map((s) => {
        // Defensive: mcpAuth.ts migrates old single-workspace session
        // records on load, but never trust a render path on a field that
        // has changed shape once already — a missing/malformed array here
        // should render as empty, not crash the whole panel.
        const ws = Array.isArray(s.workspaces) ? s.workspaces : []
        return (
          <div className="list-row" key={s.id} style={{ flexWrap: 'wrap' }}>
            <div>
              <div className="r-title">{s.agentName}</div>
              <div className="r-sub">
                Workspace{ws.length > 1 ? 's' : ''}: {ws.map((w) => w.name).join(', ') || '—'} · Started{' '}
                {fmtTime(s.createdAt)}
                {s.expiresAt ? ` · Expires ${fmtTime(s.expiresAt)}` : ' · No expiration'}
              </div>
            </div>
            <div className="spacer" />
            <div className="r-stat">{isLive(s) ? 'Active' : s.revoked ? 'Revoked' : 'Expired'}</div>
            {isLive(s) ? (
              <button
                className="btn sm danger outline"
                onClick={async () => {
                  await window.opsmaxx?.aiMcp.revokeSession(s.id)
                  toast(`${s.agentName} can no longer reach OpsMaxx.`, 'ok')
                  load()
                }}
              >
                <Ban size={13} /> Revoke
              </button>
            ) : (
              // A revoked or expired row is otherwise a dead end: the client
              // still has a token that no longer works, and the form that
              // issues a replacement lives on another page.
              <button className="btn sm" onClick={newSession} title="Issue a replacement session">
                <Plus size={13} /> New session
              </button>
            )}
            <button
              className="btn sm"
              title="Remove this session from the list entirely — revokes it too, if it's still live"
              onClick={async () => {
                if (!confirm(`Delete the "${s.agentName}" session? This can't be undone.`)) return
                await window.opsmaxx?.aiMcp.deleteSession(s.id)
                toast(`Deleted ${s.agentName}`, 'ok')
                load()
              }}
            >
              <Trash2 size={13} /> Delete
            </button>
            {isLive(s) && <SessionAccess session={s} groups={groups} onChanged={load} />}
          </div>
        )
      })}

      {sessions.some(isLive) && (
        <button className="btn danger outline" style={{ marginTop: 18 }} onClick={killAll}>
          <Octagon size={14} /> Stop all AI access
        </button>
      )}
    </div>
  )
}
