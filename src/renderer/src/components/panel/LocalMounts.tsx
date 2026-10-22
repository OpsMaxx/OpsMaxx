import { forwardRef, useEffect, useState } from 'react'
import { AlertTriangle, FolderOpen, HardDrive, Loader2, Plus, X } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { bridgeOn } from '../../lib/bridge'
import type { Server } from '../../types'
import {
  defaultMountpoint,
  mountpointProblem,
  type LocalShare,
  type MountStatus
} from '../../../../shared/localMounts'

/**
 * Folders on this computer, mounted on a server (reverse sshfs).
 *
 * Shaped like `docker -v host:path:ro`: a share is part of the server's
 * connection settings (`FolderSharesSection`, in the server editor), and it
 * mounts when an SSH session to the server opens and unmounts when the last one
 * closes. Main does that on its own; nothing here has to run after connecting.
 * `FolderSharesIndicator` is the secondary half, on the tab's view bar: what is
 * mounted, what failed and why, and a way back to the editor.
 */

/** Why these shares cannot be saved, or null. */
export function sharesProblem(shares: LocalShare[]): string | null {
  const seen = new Set<string>()
  for (const s of shares) {
    const p = mountpointProblem(s.mountpoint)
    if (p) return p
    if (seen.has(s.mountpoint)) return `Two folders are shared at ${s.mountpoint}.`
    seen.add(s.mountpoint)
  }
  return null
}

/**
 * Bring the live mounts in line with an edit, when a terminal is open.
 *
 * A share that was removed, or whose folder, mount point or access changed, is
 * unmounted; a new or changed share set to mount on connect is mounted. With no
 * terminal open, main answers "open a terminal first" without recording a
 * failure, and the share simply mounts on the next connect.
 */
export async function applyShareChanges(serverId: string, before: LocalShare[], after: LocalShare[]): Promise<void> {
  const api = window.opsmaxx?.mounts
  if (!api) return
  const same = (a: LocalShare, b: LocalShare): boolean =>
    a.localDir === b.localDir && a.mountpoint === b.mountpoint && a.readOnly === b.readOnly
  const changed = (s: LocalShare): boolean => {
    const was = before.find((b) => b.id === s.id)
    return !was || !same(was, s)
  }
  for (const was of before) {
    const now = after.find((a) => a.id === was.id)
    if (!now || !same(was, now)) await api.unmount(serverId, was.mountpoint)
  }
  for (const s of after) if (s.autoMount && changed(s)) await api.mount(serverId, s)
}

// ------------------------------------------------------------- the editor

export const FolderSharesSection = forwardRef<
  HTMLDivElement,
  { shares: LocalShare[]; onChange: (next: LocalShare[]) => void; username: string; unavailable?: string }
>(function FolderSharesSection({ shares, onChange, username, unavailable }, ref) {
  const pickFolder = async (): Promise<string | null> => (await window.opsmaxx?.mounts?.pickFolder()) ?? null
  const update = (id: string, patch: Partial<LocalShare>): void =>
    onChange(shares.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const add = async (): Promise<void> => {
    const dir = await pickFolder()
    if (!dir) return
    onChange([
      ...shares,
      { id: crypto.randomUUID(), localDir: dir, mountpoint: defaultMountpoint(dir), readOnly: true, autoMount: true }
    ])
  }
  const problem = sharesProblem(shares)
  const anyRw = shares.some((s) => !s.readOnly)
  const who = username || 'this account'

  return (
    <div className="field" ref={ref} data-testid="folder-shares">
      <label className="field-label">Folder shares</label>
      <span className="field-hint" style={{ marginBottom: 6 }}>
        Folders on this computer, mounted on the server while an SSH session to it is open, like{' '}
        <span className="mono">docker -v</span>. The server needs sshfs and a usable /dev/fuse; most containers have
        neither. Read-only is enforced by OpsMaxx, whatever the server does.
      </span>
      {unavailable ? (
        <span className="field-hint">{unavailable}</span>
      ) : (
        <>
          {shares.map((s) => (
            <div key={s.id} className="row" style={{ gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <button
                className="btn sm mono"
                style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={`${s.localDir} — click to choose another folder`}
                onClick={async () => {
                  const dir = await pickFolder()
                  if (dir) update(s.id, { localDir: dir })
                }}
              >
                <FolderOpen size={12} /> {s.localDir}
              </button>
              <span className="faint">→</span>
              <input
                className="input mono grow"
                style={{ height: 28 }}
                aria-label="Mount point on the server"
                value={s.mountpoint}
                onChange={(e) => update(s.id, { mountpoint: e.target.value })}
              />
              <select
                className="input"
                style={{ height: 28, width: 'auto' }}
                aria-label="Access"
                value={s.readOnly ? 'ro' : 'rw'}
                onChange={(e) => update(s.id, { readOnly: e.target.value === 'ro' })}
              >
                <option value="ro">Read-only</option>
                <option value="rw">Read-write</option>
              </select>
              <label className="row faint" style={{ gap: 4, cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 'var(--fs-caption)' }}>
                <input
                  type="checkbox"
                  checked={s.autoMount}
                  onChange={(e) => update(s.id, { autoMount: e.target.checked })}
                />
                Mount on connect
              </label>
              <button
                className="icon-btn"
                aria-label={`Remove the share of ${s.localDir}`}
                onClick={() => onChange(shares.filter((o) => o.id !== s.id))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {problem && <span className="field-hint danger">{problem}</span>}
          {anyRw && (
            <span className="field-hint danger">
              Anyone who can act as {who} or as root on the server can change and delete files in a read-write share.
            </span>
          )}
          {shares.length > 0 && !anyRw && (
            <span className="field-hint">
              Anyone who can act as {who} or as root on the server can read every file in these folders.
            </span>
          )}
          <div>
            <button className="btn sm" onClick={() => void add()}>
              <Plus size={13} /> Add folder share
            </button>
          </div>
        </>
      )}
    </div>
  )
})

// ---------------------------------------------------------- the indicator

function stateText(s: MountStatus | undefined, share?: LocalShare): string {
  if (!s) return share?.autoMount === false ? 'Not mounted (mounts on request)' : 'Not mounted'
  if (s.state === 'mounting') return 'Mounting…'
  if (s.state === 'mounted') return 'Mounted'
  return 'Failed'
}

/**
 * On the tab's view bar, so it is there whichever view the tab is on. Owns the
 * `mounts:changed` subscription so the count stays live while closed.
 */
export function FolderSharesIndicator({ server }: { server: Server }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [statuses, setStatuses] = useState<MountStatus[]>([])

  useEffect(() => {
    let alive = true
    void window.opsmaxx?.mounts?.list(server.id).then((l) => alive && setStatuses(l))
    const off = bridgeOn('mounts.onChanged', window.opsmaxx?.mounts?.onChanged, (serverId, list) => {
      if (serverId === server.id) setStatuses(list)
    })
    return () => {
      alive = false
      off()
    }
  }, [server.id])

  const mounted = statuses.filter((s) => s.state === 'mounted').length
  const failed = statuses.some((s) => s.state === 'failed')
  const title = failed
    ? 'A folder share failed to mount — click for the reason'
    : mounted
      ? `${mounted} folder${mounted === 1 ? '' : 's'} from this computer mounted`
      : 'Folder shares: folders from this computer, mounted on this server'
  return (
    <>
      <button
        className={clsx('icon-btn', mounted > 0 && 'active')}
        title={title}
        aria-label="Folder shares"
        onClick={() => setOpen(true)}
      >
        {failed ? <AlertTriangle size={15} style={{ color: 'var(--warn)' }} /> : <HardDrive size={15} />}
        {mounted > 0 && <span style={{ fontSize: 'var(--fs-xs)', marginLeft: 2 }}>{mounted}</span>}
      </button>
      {open && <FolderSharesDialog server={server} statuses={statuses} onClose={() => setOpen(false)} />}
    </>
  )
}

function FolderSharesDialog({
  server,
  statuses,
  onClose
}: {
  server: Server
  statuses: MountStatus[]
  onClose: () => void
}): React.JSX.Element {
  const shares = useApp((s) => s.servers.find((sv) => sv.id === server.id)?.shares) ?? []
  const openServerEditor = useApp((s) => s.openServerEditor)
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ shareId: string; error: string; fix?: string } | null>(null)
  const api = window.opsmaxx?.mounts
  const byShare = new Map(statuses.map((s) => [s.shareId, s]))
  const orphans = statuses.filter((s) => !shares.some((sh) => sh.id === s.shareId))

  const mount = async (share: LocalShare): Promise<void> => {
    if (!api) return
    setBusy(share.id)
    setRefused(null)
    const reply = await api.mount(server.id, share)
    // A failure main recorded is on the row already. A refusal before anything
    // started — no terminal open — has no row state, so it is shown here.
    if (!reply.ok && !statuses.some((s) => s.shareId === share.id && s.state === 'failed'))
      setRefused({ shareId: share.id, error: reply.error ?? 'Could not mount it.', fix: reply.fix })
    setBusy(null)
  }
  const unmount = async (mp: string, id: string): Promise<void> => {
    setBusy(id)
    await api?.unmount(server.id, mp)
    setBusy(null)
  }

  return (
    <Modal
      title="Folder shares"
      subtitle={`Folders from this computer, mounted on ${server.name}`}
      size="lg"
      onClose={onClose}
      cancelLabel="Close"
      footerNote="Mounted while an SSH session to this server is open."
      footer={
        <button
          className="btn"
          onClick={() => {
            onClose()
            openServerEditor(server.id, 'shares')
          }}
        >
          {shares.length ? 'Edit shares…' : 'Add a share…'}
        </button>
      }
    >
      {shares.length === 0 && orphans.length === 0 && (
        <p className="faint" style={{ marginTop: 0 }}>
          No folders are shared with this server. Add one in the server&apos;s connection settings: it mounts every
          time an SSH session to the server opens.
        </p>
      )}
      {(shares.length > 0 || orphans.length > 0) && (
        <table className="table">
          <thead>
            <tr>
              <th>Folder on this computer</th>
              <th>On the server</th>
              <th>Access</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shares.map((share) => {
              const st = byShare.get(share.id)
              const live = st && st.state !== 'failed'
              const err = st?.state === 'failed' ? st : refused?.shareId === share.id ? refused : null
              return (
                <tr key={share.id}>
                  <td className="mono selectable" style={{ wordBreak: 'break-all' }}>
                    {share.localDir}
                  </td>
                  <td className="mono selectable" style={{ wordBreak: 'break-all' }}>
                    {share.mountpoint}
                  </td>
                  <td>{share.readOnly ? 'Read-only' : 'Read-write'}</td>
                  <td>
                    {st?.state === 'mounting' && <Loader2 size={12} className="spin" />} {stateText(st, share)}
                    {err && (
                      <div className="field-hint danger selectable" role="alert">
                        {err.error}
                        {err.fix && <div className="faint">{err.fix}</div>}
                      </div>
                    )}
                  </td>
                  <td>
                    {live ? (
                      <button
                        className="btn sm"
                        disabled={busy === share.id || st.state === 'mounting'}
                        onClick={() => void unmount(share.mountpoint, share.id)}
                      >
                        Unmount
                      </button>
                    ) : (
                      <button className="btn sm" disabled={busy === share.id} onClick={() => void mount(share)}>
                        {st?.state === 'failed' ? 'Retry' : 'Mount'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {orphans.map((st) => (
              <tr key={st.shareId}>
                <td className="mono selectable">{st.localDir}</td>
                <td className="mono selectable">{st.mountpoint}</td>
                <td>{st.readOnly ? 'Read-only' : 'Read-write'}</td>
                <td>{stateText(st)} (no longer saved)</td>
                <td>
                  <button className="btn sm" onClick={() => void unmount(st.mountpoint, st.shareId)}>
                    Unmount
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
