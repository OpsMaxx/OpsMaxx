import { ArrowDown, ArrowUp, KeyRound, Plus, Shield, Trash2 } from 'lucide-react'
import { useWorkspaceServers } from '../../store/app'
import type { Hop } from '../../types'

let hopSeq = 0

interface Props {
  hops: Hop[]
  onChange: (hops: Hop[]) => void
  // The server being configured, so it cannot be its own jump host.
  excludeServerId?: string | null
}

// Shared jump-route editor. Used both inside the add/edit server dialog and by
// the standalone route editor, so the two can never drift apart.
export function RouteHops({ hops, onChange, excludeServerId }: Props): React.JSX.Element {
  const servers = useWorkspaceServers()

  const add = (): void =>
    onChange([
      ...hops,
      {
        id: `nh-${hopSeq++}`,
        label: `Jump ${hops.length + 1}`,
        host: '',
        port: 22,
        username: '',
        auth: 'key',
        serverId: null
      }
    ])

  const remove = (id: string): void => onChange(hops.filter((h) => h.id !== id))

  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= hops.length) return
    const next = [...hops]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  const patch = (id: string, k: keyof Hop, v: string | number): void =>
    onChange(hops.map((h) => (h.id === id ? { ...h, [k]: v } : h)))

  // Linking a hop to a saved server is what lets main reuse that server's
  // stored credentials for the hop.
  // Not `useSaved`: a `use` prefix declares a hook to every React reader and
  // to rules-of-hooks, and this is an ordinary change handler.
  const selectSavedServer = (id: string, pickedId: string): void => {
    const src = servers.find((s) => s.id === pickedId)
    onChange(
      hops.map((h) =>
        h.id !== id
          ? h
          : src
            ? {
                ...h,
                serverId: src.id,
                label: src.name,
                host: src.host,
                port: src.port,
                username: src.username,
                auth: src.auth,
                keyPath: undefined
              }
            : { ...h, serverId: null }
      )
    )
  }

  const pickKey = async (id: string): Promise<void> => {
    const p = await window.opsmaxx?.dialog.openKey()
    if (p) onChange(hops.map((h) => (h.id === id ? { ...h, keyPath: p, auth: 'key', serverId: null } : h)))
  }

  return (
    <div className="field">
      <div className="row" style={{ marginBottom: 6 }}>
        <label className="field-label" style={{ margin: 0 }}>
          Jump hosts {hops.length > 0 && `(${hops.length})`}
        </label>
        <span className="spacer" />
        <button className="btn sm" onClick={add}>
          <Plus size={13} /> Add jump host
        </button>
      </div>

      {hops.length === 0 && (
        <span className="field-hint">
          Connects directly. Add a jump host to reach a server that is only routable from a bastion.
        </span>
      )}

      {hops.map((h, i) => (
        <div key={h.id} className="hop-card">
          <div className="row" style={{ gap: 6 }}>
            <Shield size={14} style={{ color: 'var(--warn)' }} />
            <span className="faint" style={{ fontSize: 11 }}>
              Hop {i + 1}
            </span>
            <span className="spacer" />
            <button className="icon-btn sm" title="Move up" onClick={() => move(i, -1)}>
              <ArrowUp size={13} />
            </button>
            <button className="icon-btn sm" title="Move down" onClick={() => move(i, 1)}>
              <ArrowDown size={13} />
            </button>
            <button className="icon-btn sm" title="Remove" onClick={() => remove(h.id)}>
              <Trash2 size={13} />
            </button>
          </div>

          <select
            className="input"
            value={h.serverId ?? ''}
            onChange={(e) => selectSavedServer(h.id, e.target.value)}
            title="Reuse a saved server, including its stored credentials"
          >
            <option value="">Custom server — set details below</option>
            {servers
              .filter((s) => s.id !== excludeServerId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  Use saved: {s.name} ({s.username}@{s.host})
                </option>
              ))}
          </select>

          {/* Labelled, where this was four unlabelled boxes under a dropdown.
              A placeholder is not a label: it disappears the moment the field
              has a value, so the row a user comes back to is four anonymous
              strings, and there is nothing for a screen reader to announce
              either. The main host row a few lines up has always had real
              labels — this row simply never got them. */}
          {/* Reported from the running app: the Server / IP box was a few
              pixels wide — a stored host of 13.213.210.170 showed as "1" — and
              its header wrapped to three lines while Label, Port and Username
              sat at a comfortable width beside it.

              The data was never wrong; the row was. An <input> has an INTRINSIC
              width (the default size=20, about 172px), and a flex item's
              automatic minimum size is that intrinsic width — so `flex: 0 0
              76px` on the Port column was not 76px, it was ~172px, and the same
              for the other two. Those three claimed the whole row. This column
              was the only one carrying `min-width: 0`, so it was the only one
              allowed to shrink, and it absorbed the entire deficit: zero width,
              with its 90px input overflowing underneath the Port field.

              So the widths move to `.hop-fields` in the stylesheet, where every
              column gets `min-width: 0` — the declared basis then decides
              instead of the input's intrinsic width — and each column states
              the basis it actually needs, the host column enough for a full
              IPv4 address plus room to type. The row still wraps in a narrow
              dialog rather than overflowing it. */}
          <div className="hop-fields">
            <label className="hop-field hop-name">
              <span className="field-label">Label</span>
              <input
                className="input"
                placeholder="bastion"
                value={h.label}
                onChange={(e) => patch(h.id, 'label', e.target.value)}
              />
            </label>
            <label className="hop-field hop-host">
              <span className="field-label">Server / IP</span>
              <input
                className="input"
                placeholder="10.20.0.10"
                value={h.host}
                disabled={!!h.serverId}
                onChange={(e) => patch(h.id, 'host', e.target.value)}
              />
            </label>
            <label className="hop-field hop-port">
              <span className="field-label">Port</span>
              <input
                className="input"
                value={h.port}
                disabled={!!h.serverId}
                onChange={(e) => patch(h.id, 'port', Number(e.target.value) || 22)}
              />
            </label>
            <label className="hop-field hop-user">
              <span className="field-label">Username</span>
              <input
                className="input"
                value={h.username}
                disabled={!!h.serverId}
                onChange={(e) => patch(h.id, 'username', e.target.value)}
              />
            </label>
          </div>

          <div className="input-group">
            <input
              className="input"
              placeholder={h.serverId ? 'using the saved server’s credentials' : 'private key file'}
              value={h.serverId ? '' : h.keyPath ?? ''}
              disabled={!!h.serverId}
              onChange={(e) => patch(h.id, 'keyPath', e.target.value)}
            />
            <button
              className="btn"
              style={{ flex: '0 0 auto' }}
              disabled={!!h.serverId}
              onClick={() => void pickKey(h.id)}
            >
              <KeyRound size={13} /> Browse
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
