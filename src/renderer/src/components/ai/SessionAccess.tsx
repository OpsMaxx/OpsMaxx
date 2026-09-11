import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react'
import { toast } from '../../store/toast'
import { openAi, openSettings } from '../../store/nav'
import { clsx } from '../../lib/format'
import type { AccessGroup, McpAgentSession } from '../../../../shared/mcp'

interface Explanation {
  capability: string
  label: string
  decision: 'allow' | 'ask' | 'deny'
  reason: string
  fromScope: 'allow' | 'ask' | 'deny'
  fromSession: 'allow' | 'ask' | 'deny' | null
  decidedBy: 'scope' | 'session' | 'both'
}

const VERDICT: Record<string, string> = { allow: 'ALLOW', ask: 'ASK', deny: 'DENY' }

// Answers the question the permission model actually raises — "what can this
// agent do, and which of the two layers decided that" — in the place the user
// is already looking. Until now nothing in the app could answer it: the only
// thing that computed effective permissions was the get_server_details MCP
// tool, so the agent could see the answer and the person could not.
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
  const [rows, setRows] = useState<Explanation[] | null>(null)

  // Fetched whether or not the table is open.
  //
  // It used to load only on expand, which meant the one fact that explains the
  // whole permission model -- that the ceiling is a CAP and the workspace or
  // server assignment is the GRANT -- was available exclusively to someone who
  // had already guessed there was something to look at. The reported symptom is
  // always the same: "I set the ceiling to Full Access and it still asks on
  // every command", or denies. It is a local call against data already in
  // memory, so there is nothing to save by waiting.
  useEffect(() => {
    void window.opsmaxx?.aiMcp
      .explainAccess?.(session.id, null)
      .then((r) => setRows((r as Explanation[] | null) ?? []))
  }, [session.id, session.groupId])

  /**
   * Capabilities the assignment holds BELOW the ceiling.
   *
   * `decidedBy: 'scope'` is precisely "the workspace's or server's own access
   * group was the narrower of the two", which is the case the ceiling control
   * cannot express and the user cannot see.
   */
  const narrowed = (rows ?? []).filter(
    (r) => r.decidedBy === 'scope' && r.decision !== 'allow' && r.fromSession !== r.decision
  )

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
    toast(`${session.agentName} can now do at most what ${name} allows.`, 'ok')
  }

  return (
    <div style={{ width: '100%' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
        <span className="s-desc">Ceiling</span>
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
        <button className="btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Effective access
        </button>
      </div>

      {/* The sentence that answers "but I granted Full Access".
          Raising the ceiling cannot widen what an assignment allows, and until
          this line existed the screen showed only the half the user had just
          changed. */}
      {!open && narrowed.length > 0 && (
        <div className="s-desc warn" style={{ marginTop: 6, lineHeight: 1.5 }}>
          Narrower than this ceiling:{' '}
          {narrowed.map((r) => `${r.label} = ${VERDICT[r.decision]}`).join(', ')}. That is set by the
          access group assigned to the workspace, not by this session — raising the ceiling cannot
          widen it.{' '}
          <button className="linklike" onClick={() => openAi('groups')}>
            Change the assignment
          </button>
        </div>
      )}

      {open && (
        <div style={{ marginTop: 8 }}>
          {rows === null && <div className="s-desc">Working it out…</div>}
          {rows?.length === 0 && <div className="s-desc">This session is scoped to no workspace.</div>}
          {rows && rows.length > 0 && (
            <table className="mini-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Workspace</th>
                  <th>This session</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.capability}>
                    <td>{r.label}</td>
                    <td className={clsx('mono', r.decidedBy === 'scope' && 'strong')}>{VERDICT[r.fromScope]}</td>
                    <td className={clsx('mono', r.decidedBy === 'session' && 'strong')}>
                      {r.fromSession ? VERDICT[r.fromSession] : '—'}
                    </td>
                    <td className="mono strong">{VERDICT[r.decision]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="s-desc" style={{ marginTop: 6 }}>
            The stricter of the two wins. The bolded column is the one that decided — if it is
            <b> This session</b>, change the ceiling above; if it is <b>Workspace</b>, the group
            assigned to the workspace is what has to change.
          </div>
          <button
            className="btn sm"
            style={{ marginTop: 8 }}
            onClick={() => openAi('groups', session.groupId)}
            title="Open the access group this session is capped by"
          >
            <ShieldCheck size={13} /> Edit access groups
          </button>
        </div>
      )}
    </div>
  )
}
