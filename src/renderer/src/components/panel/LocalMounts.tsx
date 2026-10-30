import { forwardRef, useEffect, useState } from 'react'
import { AlertTriangle, FolderOpen, HardDrive, Loader2, Plus, X } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { bridgeOn } from '../../lib/bridge'
import { t as tr, useT } from '../../lib/i18n'
import type { Server } from '../../types'
import {
  defaultMountpoint,
  sharesProblem,
  type LocalShare,
  type MountStatus,
  type MountsView,
  type ShareView
} from '../../../../shared/localMounts'

/**
 * Folder shares: folders on this computer, mounted on a server (reverse sshfs).
 *
 * A share is part of the server's connection settings (`FolderSharesSection`, in the server editor), mounted
 * when a terminal to the server connects and unmounted when the last one
 * closes. Main does that on its own. `FolderSharesIndicator`, on the tab's view
 * bar, is the secondary half: state, Unmount and Retry, and the way back to the
 * editor.
 *
 * The shares themselves are main's, in a per-machine file: never on the server
 * record, which syncs and is backed up. See services/reverseMount.ts.
 */

const folderName = (dir: string): string => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir

// ------------------------------------------------------------- the editor

export const FolderSharesSection = forwardRef<
  HTMLDivElement,
  { shares: LocalShare[]; onChange: (next: LocalShare[]) => void; username: string; unavailable?: string }
>(function FolderSharesSection({ shares, onChange, username, unavailable }, ref) {
  const t = useT()
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
  const who = username || t('panel.shares.thisAccount')

  return (
    <div className="field" ref={ref} data-testid="folder-shares">
      <label className="field-label">{t('panel.shares.title')}</label>
      <span className="field-hint" style={{ marginBottom: 6 }}>
        {t('panel.shares.sectionHint')}
      </span>
      {unavailable ? (
        <span className="field-hint">{unavailable}</span>
      ) : (
        <>
          {shares.map((s) => {
            const name = folderName(s.localDir)
            const bad = problem?.shareId === s.id
            return (
              <div key={s.id} className="row" style={{ gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <button
                  className="btn sm mono"
                  style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  aria-label={t('panel.shares.changeFolderLabel', { name, dir: s.localDir })}
                  title={t('panel.shares.changeFolderTitle', { dir: s.localDir })}
                  onClick={async () => {
                    const dir = await pickFolder()
                    if (dir) update(s.id, { localDir: dir })
                  }}
                >
                  <FolderOpen size={12} /> {s.localDir}
                </button>
                <span className="faint" aria-hidden>
                  →
                </span>
                <input
                  className="input mono grow"
                  style={{ height: 28 }}
                  aria-label={t('panel.shares.mountpointLabel', { name })}
                  aria-invalid={bad || undefined}
                  aria-describedby={bad ? 'folder-shares-problem' : undefined}
                  value={s.mountpoint}
                  onChange={(e) => update(s.id, { mountpoint: e.target.value })}
                />
                <select
                  className="input"
                  style={{ height: 28, width: 'auto' }}
                  aria-label={t('panel.shares.accessLabel', { name })}
                  value={s.readOnly ? 'ro' : 'rw'}
                  onChange={(e) => update(s.id, { readOnly: e.target.value === 'ro' })}
                >
                  <option value="ro">{t('panel.shares.readOnly')}</option>
                  <option value="rw">{t('panel.shares.readWrite')}</option>
                </select>
                <label
                  className="row faint"
                  style={{ gap: 4, cursor: 'pointer', whiteSpace: 'nowrap', fontSize: 'var(--fs-caption)' }}
                >
                  <input
                    type="checkbox"
                    aria-label={t('panel.shares.autoMountLabel', { name })}
                    checked={s.autoMount}
                    onChange={(e) => update(s.id, { autoMount: e.target.checked })}
                  />
                  {t('panel.shares.mountOnConnect')}
                </label>
                <button
                  className="icon-btn"
                  aria-label={t('panel.shares.removeLabel', { name })}
                  onClick={() => onChange(shares.filter((o) => o.id !== s.id))}
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
          {problem && (
            <span className="field-hint danger" id="folder-shares-problem">
              {problem.message}
            </span>
          )}
          {anyRw && (
            <span className="field-hint danger">
              {t('panel.shares.rwWarning', { who })}
            </span>
          )}
          {shares.length > 0 && !anyRw && (
            <span className="field-hint">
              {t('panel.shares.roWarning', { who })}
            </span>
          )}
          <div>
            <button className="btn sm" onClick={() => void add()}>
              <Plus size={13} /> {t('panel.shares.add')}
            </button>
          </div>
        </>
      )}
    </div>
  )
})

// ---------------------------------------------------------- the indicator

const EMPTY: MountsView = { connected: false, shares: [], mounts: [] }

/**
 * On the tab's view bar, so it is there whichever view the tab is on. Owns the
 * `mounts:changed` subscription so the count stays live while closed.
 */
export function FolderSharesIndicator({ server }: { server: Server }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<MountsView>(EMPTY)

  useEffect(() => {
    let alive = true
    void window.opsmaxx?.mounts?.view(server.id).then((v) => alive && setView(v))
    const off = bridgeOn('mounts.onChanged', window.opsmaxx?.mounts?.onChanged, (serverId, v) => {
      if (serverId === server.id) setView(v)
    })
    return () => {
      alive = false
      off()
    }
  }, [server.id])

  const mounted = view.mounts.filter((s) => s.state === 'mounted').length
  // A failed mount of a share that is also paused reads as paused, as its row
  // in the dialog does. One whose share is no longer saved still counts: a
  // failed unmount can leave it mounted on the server.
  const failedCount = view.mounts.filter(
    (m) => m.state === 'failed' && !view.shares.find((s) => s.id === m.shareId)?.stale
  ).length
  const stale = view.shares.some((s) => s.stale)
  // Auto-mount fails without a toast, so a failure has to be readable here:
  // an icon alone went unnoticed by the first person it happened to.
  const warning = failedCount
    ? failedCount === 1
      ? t('panel.shares.oneFailed')
      : t('panel.shares.manyFailed', { count: failedCount })
    : stale
      ? t('panel.shares.paused')
      : null
  const title = failedCount
    ? t('panel.shares.titleFailed', { warning: warning ?? '' })
    : stale
      ? t('panel.shares.titleStale', { warning: warning ?? '' })
      : mounted
        ? t('panel.shares.titleMounted', { count: mounted })
        : t('panel.shares.titleIdle')
  const label = warning ?? (mounted > 0 ? String(mounted) : null)
  return (
    <>
      <button
        className={clsx('icon-btn', mounted > 0 && !warning && 'active')}
        // .icon-btn is a 26px grid: with a label beside the icon it has to be
        // a row as wide as its text, or the text overflows onto the address.
        style={label ? { width: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 6px' } : undefined}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {warning ? <AlertTriangle size={15} style={{ color: 'var(--warn)' }} /> : <HardDrive size={15} />}
        {label && (
          <span
            aria-hidden
            style={{ fontSize: 'var(--fs-caption)', whiteSpace: 'nowrap', color: warning ? 'var(--warn)' : undefined }}
          >
            {label}
          </span>
        )}
      </button>
      {open && <FolderSharesDialog server={server} view={view} onClose={() => setOpen(false)} />}
    </>
  )
}

function stateText(st: MountStatus | undefined, share: ShareView, connected: boolean): string {
  if (share.stale) return tr('panel.shares.state.paused')
  if (!st) {
    if (!connected) return tr('panel.shares.state.noTerminal')
    return share.autoMount ? tr('panel.shares.state.notMounted') : tr('panel.shares.state.notMountedManual')
  }
  return mountStateText(st.state)
}

function mountStateText(state: MountStatus['state']): string {
  if (state === 'mounting') return tr('panel.shares.state.mounting')
  if (state === 'mounted') return tr('panel.shares.state.mounted')
  if (state === 'unmounting') return tr('panel.shares.state.unmounting')
  return tr('panel.shares.state.failed')
}

function FolderSharesDialog({
  server,
  view,
  onClose
}: {
  server: Server
  view: MountsView
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const openServerEditor = useApp((s) => s.openServerEditor)
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ shareId: string; error: string; fix?: string } | null>(null)
  const api = window.opsmaxx?.mounts
  const byShare = new Map(view.mounts.map((s) => [s.shareId, s]))
  const orphans = view.mounts.filter((s) => !view.shares.some((sh) => sh.id === s.shareId))
  const noTerminal = t('panel.shares.noTerminal')
  const working = t('panel.shares.working')

  const mount = async (share: ShareView): Promise<void> => {
    if (!api) return
    setBusy(share.id)
    setRefused(null)
    const reply = await api.mount(server.id, share.id)
    // A failure main recorded is on the row already. A refusal before anything
    // started has no row state, so it is shown here.
    if (!reply.ok && !view.mounts.some((s) => s.shareId === share.id && s.state === 'failed'))
      setRefused({ shareId: share.id, error: reply.error ?? t('panel.shares.mountFailed'), fix: reply.fix })
    setBusy(null)
  }
  const unmount = async (mp: string, id: string): Promise<void> => {
    setBusy(id)
    await api?.unmount(server.id, mp)
    setBusy(null)
  }

  return (
    <Modal
      title={t('panel.shares.title')}
      subtitle={t('panel.shares.dialogSubtitle', { server: server.name })}
      size="lg"
      onClose={onClose}
      cancelLabel={t('common.close')}
      footerNote={t('panel.shares.footerNote')}
      footer={
        <>
          {view.shares.some((s) => s.stale) && (
            <button className="btn" onClick={() => void api?.reenable(server.id)}>
              {t('panel.shares.reenable')}
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              onClose()
              openServerEditor(server.id, 'shares')
            }}
          >
            {view.shares.length ? t('panel.shares.editShares') : t('panel.shares.addShare')}
          </button>
        </>
      }
    >
      {view.shares.length === 0 && orphans.length === 0 && (
        <p className="faint" style={{ marginTop: 0 }}>
          {t('panel.shares.empty')}
        </p>
      )}
      {view.shares.some((s) => s.stale) && (
        <p className="field-hint danger" role="status">
          {t('panel.shares.staleNotice')}
        </p>
      )}
      {(view.shares.length > 0 || orphans.length > 0) && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('panel.shares.col.local')}</th>
              <th>{t('panel.shares.col.remote')}</th>
              <th>{t('panel.shares.col.access')}</th>
              <th>{t('panel.shares.col.state')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {view.shares.map((share) => {
              const st = byShare.get(share.id)
              const live = st && st.state !== 'failed'
              const stepping = busy === share.id || st?.state === 'mounting' || st?.state === 'unmounting'
              const err = st?.state === 'failed' ? st : refused?.shareId === share.id ? refused : null
              const blocked = !live && (!view.connected || share.stale)
              const why = stepping
                ? working
                : !view.connected
                  ? noTerminal
                  : share.stale
                    ? t('panel.shares.reenableFirst')
                    : ''
              return (
                <tr key={share.id}>
                  <td className="mono selectable" style={{ wordBreak: 'break-all' }}>
                    {share.localDir}
                  </td>
                  <td className="mono selectable" style={{ wordBreak: 'break-all' }}>
                    {share.mountpoint}
                  </td>
                  <td>{share.readOnly ? t('panel.shares.readOnly') : t('panel.shares.readWrite')}</td>
                  <td>
                    {stepping && <Loader2 size={12} className="spin" />} {stateText(st, share, view.connected)}
                    {err && (
                      <div className="field-hint danger selectable" role="alert">
                        {err.error}
                        {err.fix && <div className="faint">{err.fix}</div>}
                      </div>
                    )}
                  </td>
                  <td>
                    {/* aria-disabled rather than disabled, as in the Files view:
                        a disabled button swallows the click and the reason. */}
                    {live ? (
                      <button
                        className="btn sm"
                        style={stepping ? { opacity: 0.45 } : undefined}
                        aria-disabled={stepping}
                        aria-label={t('panel.shares.unmountLabel', { name: folderName(share.localDir) })}
                        onClick={() => (stepping ? toast(working, 'info') : void unmount(share.mountpoint, share.id))}
                      >
                        {t('panel.shares.unmount')}
                      </button>
                    ) : (
                      <button
                        className="btn sm"
                        style={blocked || stepping ? { opacity: 0.45 } : undefined}
                        aria-disabled={blocked || stepping}
                        aria-label={
                          st?.state === 'failed'
                            ? t('panel.shares.retryLabel', { name: folderName(share.localDir) })
                            : t('panel.shares.mountLabel', { name: folderName(share.localDir) })
                        }
                        title={why || undefined}
                        onClick={() => (blocked || stepping ? toast(why, 'error') : void mount(share))}
                      >
                        {st?.state === 'failed' ? t('common.retry') : t('panel.shares.mount')}
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
                <td>{st.readOnly ? t('panel.shares.readOnly') : t('panel.shares.readWrite')}</td>
                <td>
                  {t('panel.shares.orphanState', { state: mountStateText(st.state) })}
                  {st.error && (
                    <div className="field-hint danger selectable" role="alert">
                      {st.error}
                      {st.fix && <div className="faint">{st.fix}</div>}
                    </div>
                  )}
                </td>
                <td>
                  <button className="btn sm" onClick={() => void unmount(st.mountpoint, st.shareId)}>
                    {t('panel.shares.unmount')}
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
