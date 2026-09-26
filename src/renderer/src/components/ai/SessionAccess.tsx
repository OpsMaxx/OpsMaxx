import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, X } from 'lucide-react'
import { toast } from '../../store/toast'
import { openAi, openSettings } from '../../store/nav'
import { DEFAULT_SESSION_MODE, sessionModeLabel } from '../../../../shared/mcp'
import type {
  AccessGroup,
  CapabilityExplanation,
  McpAgentSession,
  PermissionValue,
  SessionMode
} from '../../../../shared/mcp'
import { ModePicker } from './ModePicker'

const VERDICT: Record<PermissionValue, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' }

/** Protected targets inside this session's workspaces: each protected
 *  workspace once, plus each protected server whose workspace is not. */
async function protectedCountFor(session: McpAgentSession): Promise<number> {
  const api = window.opsmaxx?.aiPolicy
  const [scopes, servers] = await Promise.all([api?.listProtected?.(), api?.listServers?.()])
  const mine = new Set(session.workspaces.map((w) => w.id))
  const workspaceOf = new Map((servers ?? []).map((s) => [s.id, s.workspaceId]))
  const list = scopes ?? []
  const shieldedWs = new Set(list.flatMap((s) => (s.level === 'workspace' ? [s.workspaceId] : [])))
  return list.filter((s) => {
    if (s.level === 'workspace') return mine.has(s.workspaceId)
    const ws = workspaceOf.get(s.serverId) ?? ''
    return mine.has(ws) && !shieldedWs.has(ws)
  }).length
}

/** A workspace or server in this session's reach that carries an assignment. */
interface Restriction {
  id: string
  where: string
  groupId: string | null
  groupName: string
}

/**
 * Every assignment inside the session's workspaces, as the thing it is: a
 * restriction someone set on a target, separately from any agent. Listed on
 * its own rather than inferred from which rows it happened to narrow, so one
 * that narrows nothing today -- or that Bypass is lifting -- is still visible
 * and removable. Older versions of Connect an agent wrote these on their own.
 */
async function restrictionsFor(session: McpAgentSession, groups: AccessGroup[]): Promise<Restriction[]> {
  const api = window.opsmaxx?.aiPolicy
  const [assignments, servers] = await Promise.all([api?.listAssignments?.(), api?.listServers?.()])
  const mine = new Map(session.workspaces.map((w) => [w.id, w.name]))
  const serverById = new Map((servers ?? []).map((s) => [s.id, s]))
  const out: Restriction[] = []
  for (const a of assignments ?? []) {
    let where: string | null = null
    if (a.scope.level === 'workspace') {
      const name = mine.get(a.scope.workspaceId)
      if (name !== undefined) where = `the ${name} workspace`
    } else {
      const server = serverById.get(a.scope.serverId)
      if (server && mine.has(server.workspaceId)) where = server.name
    }
    if (!where) continue
    const group = groups.find((g) => g.id === a.groupId)
    out.push({ id: a.id, where, groupId: a.groupId, groupName: group?.name ?? 'No AI Access' })
  }
  return out
}

/** The outcome buckets, in the order a person reads them. */
const BUCKETS: { key: string; title: string; tone: string; test: (r: CapabilityExplanation) => boolean }[] = [
  { key: 'allow', title: 'Runs without asking', tone: 'ok', test: (r) => r.decision === 'allow' && !r.partlyAsks },
  {
    key: 'partly',
    title: 'Runs — but risky actions ask',
    tone: 'info',
    test: (r) => r.decision === 'allow' && r.partlyAsks
  },
  { key: 'ask', title: 'Asks you first', tone: 'warn', test: (r) => r.decision === 'ask' },
  { key: 'deny', title: 'Blocked', tone: 'danger', test: (r) => r.decision === 'deny' }
]

/** What the whole mode means for this session, in one sentence. */
function modeSummary(mode: SessionMode, groupName: string): string {
  switch (mode) {
    case 'bypass':
      return 'Bypass: everything runs without asking, whatever the access group or any restriction says. Only Protected targets and No AI Access still hold.'
    case 'readOnly':
      return `Read only: it can look wherever ${groupName} lets it, and every change is refused.`
    case 'ask':
      return `Ask first: every change ${groupName} allows is asked for before it runs.`
    default:
      return `Auto: exactly what ${groupName} says, narrowed by any restriction below.`
  }
}

/**
 * Why one capability came out the way it did, in a few words. Built from the
 * structured fields rather than the policy engine's sentence, which is written
 * for an approval card and an audit row and reads as a paragraph in a table.
 */
function why(r: CapabilityExplanation, groupName: string): string {
  if (r.bypassed) {
    const source =
      r.decidedBy === 'scope' ? `${r.scopeWorkspaceName ?? 'the target'}’s restriction` : groupName
    return `${source} says ${VERDICT[r.beforeMode]} — Bypass lifts it`
  }
  if (r.protectedTarget && r.decision === 'ask') return 'Protected target — held at Ask first'
  if (r.decision !== r.beforeMode) return `${sessionModeLabel(r.mode)} mode`
  if (r.decidedBy === 'scope') {
    return r.scopeGroupName
      ? `Restricted: ${r.scopeWorkspaceName ?? 'this target'} is limited to ${r.scopeGroupName}`
      : 'Target is set to No AI Access'
  }
  if (r.partlyAsks) return `${groupName} allows it; risky actions still ask`
  return `${groupName}: ${VERDICT[r.decision]}`
}

// Answers the question the permission model actually raises — "what can this
// agent do, and which layer decided that" — in the place the user is already
// looking: grouped by outcome, restrictions named as the separate thing they
// are, and the per-capability reasons one click further down.
export function SessionAccess({
  session,
  groups,
  onChanged
}: {
  session: McpAgentSession
  groups: AccessGroup[]
  onChanged: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState(false)
  const [rows, setRows] = useState<CapabilityExplanation[] | null>(null)
  const [protectedCount, setProtectedCount] = useState(0)
  const [restrictions, setRestrictions] = useState<Restriction[]>([])
  const mode: SessionMode = session.mode ?? DEFAULT_SESSION_MODE
  const groupName = session.groupName

  const refetch = (): void => {
    void window.opsmaxx?.aiMcp
      .explainAccess?.(session.id, null)
      .then((r) => setRows(r ?? []))
      .catch(() => setRows([]))
  }
  useEffect(refetch, [session.id, session.groupId, mode])

  const loadRestrictions = (): void => {
    restrictionsFor(session, groups)
      .then(setRestrictions)
      .catch(() => setRestrictions([]))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadRestrictions, [session.id, groups])

  useEffect(() => {
    protectedCountFor(session)
      .then(setProtectedCount)
      .catch(() => setProtectedCount(0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  const changeGroup = async (groupId: string): Promise<void> => {
    const group = groups.find((g) => g.id === groupId) ?? null
    const name = group?.name ?? 'No AI Access'
    const api = window.opsmaxx?.aiMcp
    if (typeof api?.setSessionGroup !== 'function') {
      toast('This build of OpsMaxx cannot change what a running session is allowed to do.', 'error', {
        label: 'Check for updates',
        run: () => openSettings('general')
      })
      return
    }
    const updated = await api.setSessionGroup(session.id, group?.id ?? null, name)
    setRows(null)
    onChanged()
    if (!updated) {
      // The select has already moved to the new value, so silence here would
      // show a limit that is not actually in force.
      toast(`${session.agentName} was not changed — it can still do what ${session.groupName} allows.`, 'error', {
        label: 'Try again',
        run: () => void changeGroup(groupId)
      })
      return
    }
    toast(`${session.agentName} now uses ${name}.`, 'ok')
  }

  const changeMode = async (next: SessionMode): Promise<void> => {
    const updated = await window.opsmaxx?.aiMcp.setSessionMode?.(session.id, next).catch(() => null)
    if (!updated) {
      // The table keeps showing what is still in force.
      toast(`${session.agentName} was not changed — it is still in ${sessionModeLabel(mode)}.`, 'error', {
        label: 'Try again',
        run: () => void changeMode(next)
      })
      return
    }
    setRows(null)
    refetch()
    onChanged()
    toast(`${session.agentName} is now in ${sessionModeLabel(next)}.`, 'ok')
  }

  const removeRestriction = async (r: Restriction): Promise<void> => {
    try {
      await window.opsmaxx?.aiPolicy.removeAssignment?.(r.id)
    } catch {
      toast(`The restriction on ${r.where} was not removed.`, 'error')
      return
    }
    loadRestrictions()
    setRows(null)
    refetch()
    onChanged()
    toast(`${r.where} is no longer restricted.`, 'ok')
  }

  // Restrictions that are actually holding this session lower right now. In
  // Bypass only No AI Access holds; everything else is listed but lifted.
  const holding = restrictions.filter((r) => mode !== 'bypass' || r.groupId === null)
  const shielded = (mode === 'auto' || mode === 'bypass') && protectedCount > 0

  return (
    <div style={{ width: '100%' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <span className="s-desc">Access group</span>
        <select
          className="input"
          style={{ maxWidth: 180 }}
          value={session.groupId ?? ''}
          onChange={(e) => void changeGroup(e.target.value)}
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <span className="s-desc">Mode</span>
        <ModePicker value={mode} onChange={changeMode} protectedCount={protectedCount} size="sm" />
        <button className="btn sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Effective access
        </button>
      </div>

      {/* Shown whether or not the panel is open: a restriction is the one thing
          that makes "I picked Full Access and it still asks" true, and it is
          set somewhere else entirely. */}
      {holding.length > 0 && (
        <div className="s-desc warn" style={{ marginTop: 6, lineHeight: 1.5 }} data-testid="restriction-note">
          {holding.length === 1
            ? `${cap(holding[0].where)} is restricted to ${holding[0].groupName}, so this agent gets at most that there.`
            : `${holding.length} targets are restricted below this agent’s group.`}{' '}
          <button className="linklike" onClick={() => setOpen(true)}>
            Review
          </button>
        </div>
      )}

      {open && (
        <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
          <div className="s-desc" style={{ lineHeight: 1.5 }}>
            {modeSummary(mode, groupName)}
            {shielded && (
              <>
                {' '}
                <span className="chip warn">Protected</span> {protectedCount} protected target
                {protectedCount === 1 ? '' : 's'} in its workspaces {protectedCount === 1 ? 'holds' : 'hold'} it at
                Ask first there.
              </>
            )}
          </div>

          {rows === null && <div className="s-desc">Working it out…</div>}
          {rows?.length === 0 && <div className="s-desc">This session is scoped to no workspace.</div>}

          {rows && rows.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              {BUCKETS.map((b) => {
                const inBucket = rows.filter(b.test)
                if (inBucket.length === 0) return null
                return (
                  <div key={b.key} data-testid={`bucket-${b.key}`}>
                    <div className="s-title" style={{ fontSize: 'var(--fs-sm)', marginBottom: 4 }}>
                      {b.title} <span className="s-desc">({inBucket.length})</span>
                    </div>
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {inBucket.map((r) => (
                        <span key={r.capability} className={`chip ${b.tone}`} title={why(r, groupName)}>
                          {r.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {restrictions.length > 0 && (
            <div data-testid="restrictions">
              <div className="s-title" style={{ fontSize: 'var(--fs-sm)', marginBottom: 4 }}>
                Restrictions on targets
              </div>
              {restrictions.map((r) => {
                const lifted = mode === 'bypass' && r.groupId !== null
                return (
                  <div key={r.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="s-desc">
                      {cap(r.where)} → <b>{r.groupName}</b>
                      {lifted
                        ? ' — lifted while this agent is in Bypass.'
                        : r.groupId === null
                          ? ' — no agent can reach it, in any mode.'
                          : ' — agents there get at most this, whatever their own group.'}
                    </span>
                    {r.groupId && (
                      <button className="linklike" onClick={() => openAi('groups', r.groupId)}>
                        Edit {r.groupName}
                      </button>
                    )}
                    <button className="btn sm" onClick={() => void removeRestriction(r)}>
                      <X size={12} /> Remove restriction
                    </button>
                  </div>
                )
              })}
              <div className="s-desc" style={{ marginTop: 4 }}>
                A restriction belongs to the workspace or server, not to this agent. Earlier versions of Connect an
                agent added them on their own; removing one lets each agent’s own group decide there.
              </div>
            </div>
          )}

          {rows && rows.length > 0 && (
            <div>
              <button className="linklike" onClick={() => setDetail((v) => !v)} aria-expanded={detail}>
                {detail ? 'Hide' : 'Show'} why, per capability
              </button>
              {detail && (
                <table className="mini-table" style={{ width: '100%', marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>Capability</th>
                      <th>Result</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.capability}>
                        <td>{r.label}</td>
                        <td className="mono strong">
                          {VERDICT[r.decision]}
                          {r.partlyAsks && '*'}
                        </td>
                        <td className="s-desc" title={r.reason}>
                          {why(r, groupName)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div>
            <button className="btn sm" onClick={() => openAi('groups', session.groupId)}>
              <ShieldCheck size={13} /> Edit {groupName}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
