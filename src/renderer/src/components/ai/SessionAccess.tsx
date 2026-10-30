import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, X } from 'lucide-react'
import { toast } from '../../store/toast'
import { openAi, openSettings } from '../../store/nav'
import { sessionModeLabel, sessionModeOf } from '../../../../shared/mcp'
import type {
  AccessGroup,
  CapabilityExplanation,
  McpAgentSession,
  PermissionValue,
  SessionMode
} from '../../../../shared/mcp'
import { ModePicker } from './ModePicker'
import type { MessageKey } from '../../../../shared/i18n'
import { t as tr, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

const VERDICT_KEYS: Record<PermissionValue, MessageKey> = {
  allow: 'ai.sessionAccess.verdict.allow',
  ask: 'ai.sessionAccess.verdict.ask',
  deny: 'ai.sessionAccess.verdict.deny'
}
const verdict = (v: PermissionValue): string => tr(VERDICT_KEYS[v])

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
  /** A workspace is named as one; a server by its name alone. */
  kind: 'workspace' | 'server'
  name: string
  groupId: string | null
  /** Null when the assignment names no group that exists: No AI Access. */
  groupName: string | null
}

const whereOf = (r: Restriction): string =>
  r.kind === 'workspace' ? tr('ai.sessionAccess.workspaceTarget', { name: r.name }) : r.name

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
    let where: Pick<Restriction, 'kind' | 'name'> | null = null
    if (a.scope.level === 'workspace') {
      const name = mine.get(a.scope.workspaceId)
      if (name !== undefined) where = { kind: 'workspace', name }
    } else {
      const server = serverById.get(a.scope.serverId)
      if (server && mine.has(server.workspaceId)) where = { kind: 'server', name: server.name }
    }
    if (!where) continue
    const group = groups.find((g) => g.id === a.groupId)
    out.push({ id: a.id, ...where, groupId: a.groupId, groupName: group?.name ?? null })
  }
  return out
}

/** The outcome buckets, in the order a person reads them. */
const BUCKETS: { key: string; titleKey: MessageKey; tone: string; test: (r: CapabilityExplanation) => boolean }[] = [
  {
    key: 'allow',
    titleKey: 'ai.sessionAccess.bucket.allow',
    tone: 'ok',
    test: (r) => r.decision === 'allow' && !r.partlyAsks
  },
  {
    key: 'partly',
    titleKey: 'ai.sessionAccess.bucket.partly',
    tone: 'info',
    test: (r) => r.decision === 'allow' && r.partlyAsks
  },
  { key: 'ask', titleKey: 'ai.sessionAccess.bucket.ask', tone: 'warn', test: (r) => r.decision === 'ask' },
  { key: 'deny', titleKey: 'ai.sessionAccess.bucket.deny', tone: 'danger', test: (r) => r.decision === 'deny' }
]

/** What the whole profile means for this session, in one sentence. */
function modeSummary(mode: SessionMode, groupName: string): string {
  switch (mode) {
    case 'bypass':
      return tr('ai.sessionAccess.summary.bypass')
    case 'readOnly':
      return tr('ai.sessionAccess.summary.readOnly')
    case 'ask':
      return tr('ai.sessionAccess.summary.ask')
    case 'auto':
      return tr('ai.sessionAccess.summary.auto')
    default:
      return tr('ai.sessionAccess.summary.custom', { group: groupName })
  }
}

/**
 * Why one capability came out the way it did, in a few words. Built from the
 * structured fields rather than the policy engine's sentence, which is written
 * for an approval card and an audit row and reads as a paragraph in a table.
 */
function why(r: CapabilityExplanation, groupName: string): string {
  if (r.bypassed) {
    return r.decidedBy === 'scope'
      ? tr('ai.sessionAccess.why.bypassScope', {
          target: r.scopeWorkspaceName ?? tr('ai.sessionAccess.why.theTarget'),
          verdict: verdict(r.beforeMode)
        })
      : tr('ai.sessionAccess.why.bypassGroup', { group: groupName, verdict: verdict(r.beforeMode) })
  }
  if (r.protectedTarget && r.decision === 'ask') return tr('ai.sessionAccess.why.protected')
  if (r.decision !== r.beforeMode) return tr('ai.sessionAccess.why.mode', { mode: sessionModeLabel(r.mode) })
  if (r.decidedBy === 'scope') {
    return r.scopeGroupName
      ? tr('ai.sessionAccess.why.restricted', {
          target: r.scopeWorkspaceName ?? tr('ai.sessionAccess.why.thisTarget'),
          group: r.scopeGroupName
        })
      : tr('ai.sessionAccess.why.noAccess')
  }
  if (r.partlyAsks) return tr('ai.sessionAccess.why.partly', { group: groupName })
  return tr('ai.sessionAccess.why.group', { group: groupName, verdict: verdict(r.decision) })
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
  const t = useT()
  const mode: SessionMode = sessionModeOf(session)
  const groupName = session.groupName
  // What the "why" column names as the source: the group for Custom, else the
  // profile itself, which stands on no group the user picked.
  const baseName = mode === 'custom' ? groupName : sessionModeLabel(mode)

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

  const changeGroup = async (groupId: string, quiet = false): Promise<void> => {
    const group = groups.find((g) => g.id === groupId) ?? null
    const name = group?.name ?? 'No AI Access'
    const api = window.opsmaxx?.aiMcp
    if (typeof api?.setSessionGroup !== 'function') {
      toast(t('ai.sessionAccess.cannotChange'), 'error', {
        label: t('ai.connect.checkUpdates'),
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
      toast(t('ai.sessionAccess.groupNotChanged', { agent: session.agentName, group: session.groupName }), 'error', {
        label: t('ai.security.tryAgain'),
        run: () => void changeGroup(groupId)
      })
      return
    }
    if (!quiet) {
      toast(t('ai.sessionAccess.nowUses', { agent: session.agentName, group: group?.name ?? t('ai.connect.noAccess') }), 'ok')
    }
  }

  const changeMode = async (next: SessionMode): Promise<void> => {
    // Custom needs a group, and a session started on a predefined profile may
    // have none: give it the widest one, which the select beside the picker
    // then shows and can change.
    if (next === 'custom' && !groups.some((g) => g.id === session.groupId)) {
      const first = groups.find((g) => g.id === 'grp-full') ?? groups[0]
      if (first) await changeGroup(first.id, true)
    }
    const updated = await window.opsmaxx?.aiMcp.setSessionMode?.(session.id, next).catch(() => null)
    if (!updated) {
      // The table keeps showing what is still in force.
      toast(t('ai.sessionAccess.modeNotChanged', { agent: session.agentName, profile: sessionModeLabel(mode) }), 'error', {
        label: t('ai.security.tryAgain'),
        run: () => void changeMode(next)
      })
      return
    }
    setRows(null)
    refetch()
    onChanged()
    toast(t('ai.sessionAccess.nowOn', { agent: session.agentName, profile: sessionModeLabel(next) }), 'ok')
  }

  const removeRestriction = async (r: Restriction): Promise<void> => {
    try {
      await window.opsmaxx?.aiPolicy.removeAssignment?.(r.id)
    } catch {
      toast(t('ai.sessionAccess.removeFailed', { target: whereOf(r) }), 'error')
      return
    }
    loadRestrictions()
    setRows(null)
    refetch()
    onChanged()
    toast(t('ai.sessionAccess.removed', { target: whereOf(r) }), 'ok')
  }

  // Restrictions that are actually holding this session lower right now. In
  // Bypass only No AI Access holds; everything else is listed but lifted.
  const holding = restrictions.filter((r) => mode !== 'bypass' || r.groupId === null)
  const shielded = mode !== 'readOnly' && mode !== 'ask' && protectedCount > 0

  return (
    <div style={{ width: '100%' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <span className="s-desc">{t('ai.modePicker.sectionProfile')}</span>
        <ModePicker
          value={mode}
          onChange={changeMode}
          groups={groups}
          groupId={session.groupId}
          onGroupChange={(id) => changeGroup(id)}
          protectedCount={protectedCount}
          size="sm"
        />
        <button className="btn sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('ai.sessionAccess.effectiveAccess')}
        </button>
      </div>

      {/* Shown whether or not the panel is open: a restriction is the one thing
          that makes "I picked Full Access and it still asks" true, and it is
          set somewhere else entirely. */}
      {holding.length > 0 && (
        <div className="s-desc warn" style={{ marginTop: 6, lineHeight: 1.5 }} data-testid="restriction-note">
          {holding.length === 1
            ? t('ai.sessionAccess.restrictedOne', {
                target: cap(whereOf(holding[0])),
                group: holding[0].groupName ?? t('ai.connect.noAccess')
              })
            : t('ai.sessionAccess.restrictedMany', { count: holding.length })}{' '}
          <button className="linklike" onClick={() => setOpen(true)}>
            {t('ai.sessionAccess.review')}
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
                <span className="chip warn">{t('ai.approval.protected')}</span>{' '}
                {t('ai.sessionAccess.protectedHold', { count: protectedCount })}
              </>
            )}
          </div>

          {rows === null && <div className="s-desc">{t('ai.sessionAccess.working')}</div>}
          {rows?.length === 0 && <div className="s-desc">{t('ai.sessionAccess.noWorkspace')}</div>}

          {rows && rows.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              {BUCKETS.map((b) => {
                const inBucket = rows.filter(b.test)
                if (inBucket.length === 0) return null
                return (
                  <div key={b.key} data-testid={`bucket-${b.key}`}>
                    <div className="s-title" style={{ fontSize: 'var(--fs-sm)', marginBottom: 4 }}>
                      {t(b.titleKey)} <span className="s-desc">({inBucket.length})</span>
                    </div>
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {inBucket.map((r) => (
                        <span key={r.capability} className={`chip ${b.tone}`} title={why(r, baseName)}>
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
                {t('ai.sessionAccess.restrictionsTitle')}
              </div>
              {restrictions.map((r) => {
                const lifted = mode === 'bypass' && r.groupId !== null
                return (
                  <div key={r.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="s-desc">
                      {/* Self-closing tags: the names are the user's, never parsed for markup. */}
                      <Trans
                        i18nKey={
                          lifted
                            ? 'ai.sessionAccess.restrictionLifted'
                            : r.groupId === null
                              ? 'ai.sessionAccess.restrictionNoAccess'
                              : 'ai.sessionAccess.restrictionAtMost'
                        }
                        components={{
                          target: <>{cap(whereOf(r))}</>,
                          group: <b>{r.groupName ?? t('ai.connect.noAccess')}</b>
                        }}
                      />
                    </span>
                    {r.groupId && (
                      <button className="linklike" onClick={() => openAi('groups', r.groupId)}>
                        {t('ai.sessionAccess.editGroup', { group: r.groupName ?? t('ai.connect.noAccess') })}
                      </button>
                    )}
                    <button className="btn sm" onClick={() => void removeRestriction(r)}>
                      <X size={12} /> {t('ai.sessionAccess.removeRestriction')}
                    </button>
                  </div>
                )
              })}
              <div className="s-desc" style={{ marginTop: 4 }}>
                {t('ai.sessionAccess.restrictionsExplain')}
              </div>
            </div>
          )}

          {rows && rows.length > 0 && (
            <div>
              <button className="linklike" onClick={() => setDetail((v) => !v)} aria-expanded={detail}>
                {detail ? t('ai.sessionAccess.hideWhy') : t('ai.sessionAccess.showWhy')}
              </button>
              {detail && (
                <table className="mini-table" style={{ width: '100%', marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>{t('ai.sessionAccess.colCapability')}</th>
                      <th>{t('ai.sessionAccess.colResult')}</th>
                      <th>{t('ai.sessionAccess.colWhy')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.capability}>
                        <td>{r.label}</td>
                        <td className="mono strong">
                          {verdict(r.decision)}
                          {r.partlyAsks && '*'}
                        </td>
                        <td className="s-desc" title={r.reason}>
                          {why(r, baseName)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {mode === 'custom' && (
            <div>
              <button className="btn sm" onClick={() => openAi('groups', session.groupId)}>
                <ShieldCheck size={13} /> {t('ai.sessionAccess.editGroup', { group: groupName })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
