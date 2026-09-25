import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { AccessGroup } from '../../../../shared/mcp'
import { Switch } from '../common/Switch'
import { StartsInMode } from './ModePicker'

interface PendingAuthorization {
  id: string
  clientName: string
  redirectUri: string
  createdAt: number
}

interface WorkspaceOpt {
  id: string
  name: string
}

/**
 * A client asking, over OAuth, to be allowed to use this machine's servers.
 *
 * The browser is deliberately NOT where this is decided. /authorize serves a
 * holding page that waits for whatever happens here: a page any local process
 * can open is a bad place to hand out access to infrastructure, and the app
 * the user already trusts with these credentials is a good one. It is the same
 * reasoning as the CLI pairing code, which is shown only in this window.
 */
export function AiAuthorizations(): React.JSX.Element {
  // `null` until the first read returns, never `[]`.
  //
  // The same rule as the Approvals panel, for the same reason: "No client is
  // waiting" is a sentence somebody walks away on, and said before the read
  // came back it is a claim about a client that is blocked right now.
  const [pending, setPending] = useState<PendingAuthorization[] | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceOpt[]>([])
  const [groups, setGroups] = useState<AccessGroup[]>([])

  // Per request, because two clients may be waiting and they are not the same
  // decision. Keyed by consent id; an entry appears once the user touches it.
  const [choice, setChoice] = useState<Record<string, { groupId: string; workspaceIds: string[] }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = (): void => {
    void window.opsmaxx?.aiMcp
      .listAuthorizations()
      .then((a) => {
        setPending(a ?? [])
        setUnreadable(false)
      })
      .catch(() => setUnreadable(true))
    void window.opsmaxx?.aiPolicy.listWorkspaces().then((w) => setWorkspaces(w ?? []))
    void window.opsmaxx?.aiPolicy.listGroups().then((g) => setGroups(g ?? []))
  }

  useEffect(() => {
    load()
    // An authorization expires on its own after a few minutes, so this list
    // has to stop showing one that can no longer be granted.
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [])

  const current = (id: string): { groupId: string; workspaceIds: string[] } =>
    choice[id] ?? { groupId: '', workspaceIds: [] }

  const setFor = (id: string, patch: Partial<{ groupId: string; workspaceIds: string[] }>): void =>
    setChoice((prev) => ({ ...prev, [id]: { ...current(id), ...patch } }))

  const toggleWorkspace = (id: string, workspaceId: string): void => {
    const selected = current(id).workspaceIds
    setFor(id, {
      workspaceIds: selected.includes(workspaceId)
        ? selected.filter((w) => w !== workspaceId)
        : [...selected, workspaceId]
    })
  }

  const approve = async (id: string): Promise<void> => {
    const picked = current(id)
    const group = groups.find((g) => g.id === picked.groupId)
    const chosen = workspaces.filter((w) => picked.workspaceIds.includes(w.id))
    if (!group || chosen.length === 0) return
    setBusy(id)
    setError(null)
    try {
      const result = await window.opsmaxx?.aiMcp.approveAuthorization(id, {
        groupId: group.id,
        groupName: group.name,
        workspaces: chosen.map((w) => ({ id: w.id, name: w.name }))
      })
      // An expired or already-answered request comes back as a refusal rather
      // than a throw, and silently doing nothing would look like a dead button.
      if (result && !result.ok) setError(result.error)
    } catch {
      setError('That approval could not be recorded. The request may have expired.')
    } finally {
      setBusy(null)
      load()
    }
  }

  const deny = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await window.opsmaxx?.aiMcp.denyAuthorization(id)
    } finally {
      setBusy(null)
      load()
    }
  }

  return (
    <div className="settings-section">
      <h2>Authorization requests</h2>
      <div className="sub">
        A client that asked to connect over OAuth waits here. Nothing is granted until you choose
        what it may do — there is no default, and the client cannot choose for itself. Approving
        creates a session exactly as if you had made one by hand.
      </div>

      {unreadable ? (
        <div className="s-desc state-unknown">
          The list of authorization requests could not be read, so this is not a statement that none
          are waiting.
        </div>
      ) : pending === null ? (
        <div className="s-desc state-unknown">Checking for anything waiting…</div>
      ) : pending.length === 0 ? (
        <div className="s-desc">No client is waiting to be authorized.</div>
      ) : null}

      {error ? <div className="s-desc state-unknown">{error}</div> : null}

      {(pending ?? []).map((request) => {
        const picked = current(request.id)
        const ready = picked.groupId !== '' && picked.workspaceIds.length > 0
        return (
          <div className="list-row" key={request.id} style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              {/* The client chose this string. It is shown because it is the
                  only thing identifying who is asking, and it is stripped of
                  control characters in main before it ever reaches here. */}
              <div className="r-title">{request.clientName}</div>
              <div className="r-sub">
                asked to connect · returns to <span className="mono">{request.redirectUri}</span>
              </div>

              <div className="r-sub" style={{ marginTop: 10 }}>
                Workspaces it may see
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
                {workspaces.length === 0 ? (
                  <div className="s-desc">
                    There are no workspaces yet, and a session has to be scoped to at least one.
                  </div>
                ) : (
                  workspaces.map((w) => (
                    // The click target is the whole label, not just the switch.
                    // The switch is this <label>'s control, so a click on the
                    // workspace name presses it too — the name is what most
                    // people aim at.
                    <label
                      key={w.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                    >
                      {w.name}
                      <Switch
                        checked={picked.workspaceIds.includes(w.id)}
                        onChange={() => toggleWorkspace(request.id, w.id)}
                      />
                    </label>
                  ))
                )}
              </div>

              <div className="r-sub" style={{ marginTop: 10 }}>
                What it may do
              </div>
              {/* No preselection, deliberately. Everywhere else in this app a
                  group picker lands on a configured default; here the whole
                  point of the screen is that a person chose, so Approve stays
                  disabled until one is picked. */}
              <select
                className="input"
                data-testid="authorization-group"
                style={{ marginTop: 6, maxWidth: 320 }}
                value={picked.groupId}
                onChange={(e) => setFor(request.id, { groupId: e.target.value })}
              >
                <option value="">Choose an access group…</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <div style={{ marginTop: 8 }}>
                <StartsInMode />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn sm danger"
                disabled={busy === request.id}
                onClick={() => deny(request.id)}
              >
                <X size={13} /> Deny
              </button>
              <button
                className="btn sm primary"
                disabled={!ready || busy === request.id}
                title={ready ? undefined : 'Choose a workspace and an access group first'}
                onClick={() => approve(request.id)}
              >
                <Check size={13} /> Approve
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
