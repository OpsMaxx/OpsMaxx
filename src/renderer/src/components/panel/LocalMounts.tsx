import { useEffect, useState } from 'react'
import { AlertTriangle, FolderOpen, HardDrive, Loader2 } from 'lucide-react'
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
 * Folders on this computer, mounted on the server (reverse sshfs).
 *
 * The toolbar button lives in the Files view, and owns the subscription so its
 * count stays live while the dialog is closed. Every share is saved on the
 * server record; mounting is a separate act that main performs over the
 * terminal's connection and reports back through `mounts:changed`.
 */
export function LocalMountsButton({ server }: { server: Server }): React.JSX.Element {
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
  return (
    <>
      <button
        className={clsx('btn sm', mounted > 0 && 'active')}
        title="Mount a folder from this computer on the server"
        onClick={() => setOpen(true)}
      >
        {failed ? <AlertTriangle size={13} style={{ color: 'var(--warn)' }} /> : <HardDrive size={13} />}
        {mounted > 0 ? `Local folders · ${mounted}` : 'Local folders'}
      </button>
      {open && <LocalMountsDialog server={server} statuses={statuses} onClose={() => setOpen(false)} />}
    </>
  )
}

function stateText(s: MountStatus | undefined): string {
  if (!s) return 'Not mounted'
  if (s.state === 'mounting') return 'Mounting…'
  if (s.state === 'mounted') return 'Mounted'
  return 'Failed'
}

function LocalMountsDialog({
  server,
  statuses,
  onClose
}: {
  server: Server
  statuses: MountStatus[]
  onClose: () => void
}): React.JSX.Element {
  const shares = useApp((s) => s.servers.find((sv) => sv.id === server.id)?.shares) ?? []
  const setServerShares = useApp((s) => s.setServerShares)
  const [busy, setBusy] = useState<string | null>(null)
  const [replyError, setReplyError] = useState<{ shareId: string; error: string; fix?: string } | null>(null)

  // The add form.
  const [localDir, setLocalDir] = useState('')
  const [mountpoint, setMountpoint] = useState('')
  const [mountpointEdited, setMountpointEdited] = useState(false)
  const [readOnly, setReadOnly] = useState(true)
  const [autoMount, setAutoMount] = useState(true)

  const api = window.opsmaxx?.mounts
  const byShare = new Map(statuses.map((s) => [s.shareId, s]))
  const orphans = statuses.filter((s) => !shares.some((sh) => sh.id === s.shareId))
  const mpProblem = localDir ? mountpointProblem(mountpoint) : null
  const taken = shares.some((s) => s.mountpoint === mountpoint)

  const save = (next: LocalShare[]): void => setServerShares(server.id, next)

  const mount = async (share: LocalShare): Promise<void> => {
    if (!api) return
    setBusy(share.id)
    setReplyError(null)
    const reply = await api.mount(server.id, share)
    // A failure that main recorded shows on the row already; a refusal before
    // anything started (no terminal open) has no row state, so it shows here.
    if (!reply.ok && !statuses.some((s) => s.shareId === share.id && s.state === 'failed'))
      setReplyError({ shareId: share.id, error: reply.error ?? 'Could not mount it.', fix: reply.fix })
    setBusy(null)
  }

  const unmount = async (mp: string, id: string): Promise<void> => {
    setBusy(id)
    await api?.unmount(server.id, mp)
    setBusy(null)
  }

  const remove = async (share: LocalShare): Promise<void> => {
    if (byShare.get(share.id)) await unmount(share.mountpoint, share.id)
    save(shares.filter((s) => s.id !== share.id))
  }

  const pick = async (): Promise<void> => {
    const dir = await api?.pickFolder()
    if (!dir) return
    setLocalDir(dir)
    if (!mountpointEdited) setMountpoint(defaultMountpoint(dir))
  }

  const add = async (): Promise<void> => {
    const share: LocalShare = { id: crypto.randomUUID(), localDir, mountpoint, readOnly, autoMount }
    save([...shares, share])
    setLocalDir('')
    setMountpoint('')
    setMountpointEdited(false)
    setReadOnly(true)
    await mount(share)
  }

  return (
    <Modal
      title="Folders from this computer"
      subtitle={`Mounted on ${server.name} with sshfs`}
      size="lg"
      onClose={onClose}
      cancelLabel="Close"
      footerNote="Mounted while a terminal to this server is open. Closing the last one unmounts them."
    >
      <p className="faint" style={{ marginTop: 0 }}>
        The server needs sshfs and a usable /dev/fuse. Most containers have neither. Read-only is enforced by
        OpsMaxx: it refuses every change the server asks for, whatever the server does.
      </p>

      {shares.length === 0 && orphans.length === 0 && <p className="faint">No folders shared with this server yet.</p>}

      {(shares.length > 0 || orphans.length > 0) && (
        <table className="table" style={{ marginBottom: 16 }}>
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
              const err = st?.state === 'failed' ? st : replyError?.shareId === share.id ? replyError : null
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
                    {st?.state === 'mounting' && <Loader2 size={12} className="spin" />} {stateText(st)}
                    {err && (
                      <div className="field-hint danger selectable" role="alert">
                        {err.error}
                        {err.fix && <div className="faint">{err.fix}</div>}
                      </div>
                    )}
                    <label className="field-hint row" style={{ gap: 6, cursor: 'pointer', marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={share.autoMount}
                        onChange={(e) =>
                          save(shares.map((s) => (s.id === share.id ? { ...s, autoMount: e.target.checked } : s)))
                        }
                      />
                      Mount automatically on connect
                    </label>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
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
                          {st?.state === 'failed' ? 'Try again' : 'Mount'}
                        </button>
                      )}
                      <button className="btn ghost sm" disabled={busy === share.id} onClick={() => void remove(share)}>
                        Remove
                      </button>
                    </div>
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

      <h4 style={{ margin: '8px 0' }}>Share a folder</h4>
      <div className="field">
        <label className="field-label">Folder on this computer</label>
        <div className="row" style={{ gap: 6 }}>
          <input className="input mono grow" readOnly value={localDir} placeholder="Choose a folder" />
          <button className="btn" onClick={() => void pick()}>
            <FolderOpen size={14} /> Choose…
          </button>
        </div>
      </div>
      <div className="field">
        <label className="field-label">Mount point on the server</label>
        <input
          className="input mono"
          value={mountpoint}
          placeholder="~/opsmaxx/folder"
          disabled={!localDir}
          onChange={(e) => {
            setMountpoint(e.target.value)
            setMountpointEdited(true)
          }}
        />
        {mpProblem && <span className="field-hint danger">{mpProblem}</span>}
        {!mpProblem && taken && <span className="field-hint danger">Another folder is already shared there.</span>}
        {!mpProblem && !taken && (
          <span className="field-hint">Created if it does not exist. It must be empty: mounting over files hides them.</span>
        )}
      </div>
      <div className="field">
        <label className="field-label">Access</label>
        <div className="row" style={{ gap: 16 }}>
          <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
            <input type="radio" name="share-access" checked={readOnly} onChange={() => setReadOnly(true)} />
            Read-only
          </label>
          <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
            <input type="radio" name="share-access" checked={!readOnly} onChange={() => setReadOnly(false)} />
            Read-write
          </label>
        </div>
        <span className={clsx('field-hint', !readOnly && 'danger')}>
          {readOnly
            ? `Anyone who can act as ${server.username || 'this account'} or as root on the server can read every file in this folder.`
            : `Anyone who can act as ${server.username || 'this account'} or as root on the server can change and delete files in this folder.`}
        </span>
      </div>
      <label className="field-hint row" style={{ gap: 6, cursor: 'pointer', marginBottom: 12 }}>
        <input type="checkbox" checked={autoMount} onChange={(e) => setAutoMount(e.target.checked)} />
        Mount automatically when a terminal to this server connects
      </label>
      <button className="btn primary" disabled={!localDir || !!mpProblem || taken} onClick={() => void add()}>
        Share and mount
      </button>
    </Modal>
  )
}
