import { useRef, useState } from 'react'
import { EyeOff, Eye, Trash2, Plus, Lock, LockOpen, Check } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { rdpSecretId } from '../../../../shared/rdp'
// The one value wslock.ts enforces in main, imported rather than copied, so the
// form can refuse a short password itself instead of round-tripping to be told.
import { WS_MIN_PASSWORD } from '../../../../shared/workspace'
import { toast } from '../../store/toast'
import { colorVar } from '../layout/WorkspaceSwitcher'
import type { WorkspaceColor } from '../../types'
import { Switch } from '../common/Switch'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

const COLORS: WorkspaceColor[] = ['green', 'purple', 'blue', 'orange', 'red', 'cyan', 'pink']

export function WorkspaceManager(): React.JSX.Element {
  const t = useT()
  const setModal = useApp((s) => s.setModal)
  const workspaces = useApp((s) => s.workspaces)
  const toggleHidden = useApp((s) => s.toggleWorkspaceHidden)
  const addWorkspace = useApp((s) => s.addWorkspace)
  const setWorkspaceProtected = useApp((s) => s.setWorkspaceProtected)
  const lockWorkspace = useApp((s) => s.lockWorkspace)
  const setWorkspace = useApp((s) => s.setWorkspace)
  const unlockedWorkspaces = useApp((s) => s.unlockedWorkspaces)
  const deleteWorkspace = useApp((s) => s.deleteWorkspace)
  // Confirming a delete: holds the workspace id awaiting confirmation.
  const [confirming, setConfirming] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [color, setColor] = useState<WorkspaceColor>('cyan')
  const [withPassword, setWithPassword] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  // Workspace id whose password form is open.
  const [editing, setEditing] = useState<string | null>(null)

  const active = workspaces.filter((w) => !w.hidden)
  const hidden = workspaces.filter((w) => w.hidden)

  // Checked by the form rather than announced afterwards: a rule the form can
  // enforce before the click is not an error, and an error toast for one is a
  // telling-off with nothing to act on.
  const passwordTooShort = withPassword && newPassword.length > 0 && newPassword.length < WS_MIN_PASSWORD
  const canCreate = name.trim().length > 0 && (!withPassword || newPassword.length >= WS_MIN_PASSWORD)

  const create = async (): Promise<void> => {
    const wname = name.trim()
    if (!canCreate) return
    const id = addWorkspace(wname, color)
    const clearForm = (): void => {
      setName('')
      setNewPassword('')
      setWithPassword(false)
    }
    if (withPassword) {
      const r = await window.opsmaxx?.workspaceLock.set(id, newPassword)
      if (!r?.ok) {
        // The workspace itself was created, so "could not set the password"
        // alone would leave someone believing a workspace is protected when it
        // is wide open. Say what exists now, and open the form that finishes
        // the job.
        clearForm()
        toast(
          t('workspace.manager.createdWithoutPassword', {
            name: wname,
            reason: r?.error ?? t('workspace.manager.passwordNotSaved')
          }),
          'error',
          { label: t('workspace.manager.setPassword'), run: () => setEditing(id) }
        )
        return
      }
      setWorkspaceProtected(id, true)
    }
    clearForm()
    toast(t('workspace.manager.created', { name: wname }), 'ok')
  }

  const Row = ({
    id,
    wname,
    wcolor,
    isHidden,
    hasPassword
  }: {
    id: string
    wname: string
    wcolor: WorkspaceColor
    isHidden: boolean
    hasPassword: boolean
  }): React.JSX.Element => (
    <>
      <div className="list-row" style={{ padding: '10px 14px' }}>
        <span className="ws-dot" style={{ background: colorVar[wcolor], color: colorVar[wcolor] }} />
        <span className="r-title">{wname}</span>
        {hasPassword && (
          <span
            className="row"
            title={
              unlockedWorkspaces.includes(id)
                ? t('workspace.manager.protectedOpen')
                : t('workspace.manager.protectedLocked')
            }
          >
            <Lock size={13} className="faint" />
          </span>
        )}
        <span className="spacer" />
        {hasPassword &&
          (unlockedWorkspaces.includes(id) ? (
            <button
              className="icon-btn sm"
              title={t('workspace.manager.lockNow', { name: wname })}
              onClick={() => {
                lockWorkspace(id)
                toast(t('workspace.manager.toastLocked', { name: wname }))
              }}
            >
              <LockOpen size={14} />
            </button>
          ) : (
            // Reporting "locked" and leaving it there is the whole complaint.
            // setWorkspace routes through the same gate as the switcher, so
            // this opens the unlock dialog — with the manager out of the way so
            // there is only one thing on screen asking for something.
            <button
              className="btn sm"
              title={t('workspace.manager.unlockTitle', { name: wname })}
              onClick={() => {
                setModal(null)
                setWorkspace(id)
              }}
            >
              <Lock size={13} /> {t('workspace.unlock.unlock')}
            </button>
          ))}
        <button
          className="icon-btn sm"
          title={hasPassword ? t('workspace.manager.changePassword') : t('workspace.manager.setPassword')}
          onClick={() => setEditing(editing === id ? null : id)}
        >
          <Lock size={14} />
        </button>
        {/* No Duplicate or Export here: both only ever announced work that
            never happened ("Exported workspace.json"), and a message describing
            an imaginary file is worse than no button. Settings → Backup is the
            export that exists. */}
        <button
          className="icon-btn sm"
          title={isHidden ? t('workspace.manager.restore') : t('common.hide')}
          onClick={() => {
            toggleHidden(id)
            toast(
              isHidden
                ? t('workspace.manager.toastRestored', { name: wname })
                : t('workspace.manager.toastHidden', { name: wname })
            )
          }}
        >
          {isHidden ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button
          className="icon-btn sm"
          title={workspaces.length <= 1 ? t('workspace.manager.lastCannotDelete') : t('common.delete')}
          disabled={workspaces.length <= 1}
          onClick={() => setConfirming(id)}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {confirming === id && (
        <div className="vault-panel">
          <div className="row" style={{ gap: 8 }}>
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>
              <Trans i18nKey="workspace.manager.deleteConfirm" values={{ name: wname }} components={{ b: <b /> }} />
            </span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => setConfirming(null)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn sm danger"
              onClick={async () => {
                // Drop stored credentials for the servers and databases that
                // are about to disappear, so no orphan secrets are left.
                const doomed = [
                  ...useApp.getState().servers.filter((sv) => sv.workspaceId === id),
                  ...useApp.getState().databases.filter((d) => d.workspaceId === id)
                ]
                deleteWorkspace(id)
                // Both ids per server: the SSH credential and, where the
                // machine speaks RDP, the desktop's own password beside it.
                await Promise.all(
                  doomed.flatMap((d) => [
                    window.opsmaxx?.secrets.delete(d.id),
                    window.opsmaxx?.secrets.delete(rdpSecretId(d.id))
                  ])
                )
                await window.opsmaxx?.workspaceLock.delete(id)
                setConfirming(null)
                toast(t('workspace.manager.toastDeleted', { name: wname }))
              }}
            >
              {t('workspace.manager.deleteWorkspace')}
            </button>
          </div>
        </div>
      )}
      {editing === id && (
        <PasswordForm
          id={id}
          wname={wname}
          hasPassword={hasPassword}
          onDone={() => setEditing(null)}
        />
      )}
    </>
  )

  return (
    <Modal
      title={t('workspace.manager.title')}
      subtitle={t('workspace.manager.subtitle')}
      onClose={() => setModal(null)}
      size="lg"
    >
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="sidebar-title">{t('workspace.manager.newHeading')}</div>
        <div className="input-group">
          <input
            className="input grow"
            placeholder={t('workspace.manager.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn primary"
            onClick={() => void create()}
            disabled={!canCreate}
            title={
              canCreate
                ? t('workspace.manager.createTitle')
                : withPassword && name.trim()
                  ? t('workspace.manager.needPasswordFirst', { min: WS_MIN_PASSWORD })
                  : t('workspace.manager.needNameFirst')
            }
          >
            <Plus size={14} /> {t('workspace.manager.create')}
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className="row"
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: colorVar[c],
                justifyContent: 'center',
                boxShadow: color === c ? '0 0 0 2px var(--bg-card), 0 0 0 4px var(--accent)' : undefined
              }}
            >
              {color === c && <Check size={13} color="#000" />}
            </button>
          ))}
          <span className="spacer" />
          <label className="row" style={{ gap: 8 }}>
            <span className="muted">{t('workspace.manager.passwordProtect')}</span>
            <Switch checked={withPassword} onChange={setWithPassword} />
          </label>
        </div>
        {withPassword && (
          <>
            <input
              className="input"
              type="password"
              placeholder={t('workspace.manager.passwordPlaceholder', { min: WS_MIN_PASSWORD })}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
            />
            {passwordTooShort && (
              <div className="s-desc" style={{ color: 'var(--danger)' }}>
                {t('workspace.manager.tooShort', { min: WS_MIN_PASSWORD })}
              </div>
            )}
            <div className="faint" style={{ fontSize: 11 }}>
              {t('workspace.manager.passwordNote')}
            </div>
          </>
        )}
      </div>

      <div>
        <div className="sidebar-title" style={{ margin: '4px 0 8px' }}>
          {t('workspace.manager.activeHeading', { count: active.length })}
        </div>
        {active.map((w) => (
          <Row key={w.id} id={w.id} wname={w.name} wcolor={w.color} isHidden={false} hasPassword={w.hasPassword} />
        ))}
      </div>

      {hidden.length > 0 && (
        <div>
          <div className="sidebar-title" style={{ margin: '4px 0 8px' }}>
            {t('workspace.manager.hiddenHeading', { count: hidden.length })}
          </div>
          {hidden.map((w) => (
            <Row key={w.id} id={w.id} wname={w.name} wcolor={w.color} isHidden hasPassword={w.hasPassword} />
          ))}
        </div>
      )}
    </Modal>
  )
}

function PasswordForm({
  id,
  wname,
  hasPassword,
  onDone
}: {
  id: string
  wname: string
  hasPassword: boolean
  onDone: () => void
}): React.JSX.Element {
  const t = useT()
  const setWorkspaceProtected = useApp((s) => s.setWorkspaceProtected)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  // Shown in the form rather than thrown at the corner of the screen: every
  // failure here is "one of these two fields is wrong", and the fields are here.
  const [error, setError] = useState<string | null>(null)
  const currentRef = useRef<HTMLInputElement>(null)

  const canSave = !busy && next.length >= WS_MIN_PASSWORD && (!hasPassword || current.length > 0)

  // Only the current password can be wrong in a way the user can correct on the
  // spot, so that is where the cursor goes back to.
  const blame = (message: string): void => {
    setError(message)
    if (hasPassword) {
      currentRef.current?.select()
      currentRef.current?.focus()
    }
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    const r = await window.opsmaxx?.workspaceLock.set(id, next, current)
    setBusy(false)
    if (!r?.ok) {
      blame(r?.error ?? t('workspace.password.saveFailed'))
      return
    }
    setWorkspaceProtected(id, true)
    toast(
      hasPassword
        ? t('workspace.password.toastChanged', { name: wname })
        : t('workspace.password.toastProtected', { name: wname }),
      'ok'
    )
    onDone()
  }

  const clear = async (): Promise<void> => {
    if (busy || !current) return
    setBusy(true)
    const r = await window.opsmaxx?.workspaceLock.remove(id, current)
    setBusy(false)
    if (!r?.ok) {
      blame(r?.error ?? t('workspace.password.removeFailed'))
      return
    }
    setWorkspaceProtected(id, false)
    toast(t('workspace.password.toastRemoved', { name: wname }), 'ok')
    onDone()
  }

  return (
    <div className="vault-panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        {hasPassword && (
          <input
            className="input grow"
            ref={currentRef}
            type="password"
            autoFocus
            placeholder={t('workspace.password.current')}
            value={current}
            onChange={(e) => {
              setError(null)
              setCurrent(e.target.value)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
        )}
        <input
          className="input grow"
          type="password"
          placeholder={
            hasPassword
              ? t('workspace.password.newPlaceholder', { min: WS_MIN_PASSWORD })
              : t('workspace.password.placeholder', { min: WS_MIN_PASSWORD })
          }
          value={next}
          onChange={(e) => {
            setError(null)
            setNext(e.target.value)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <button
          className="btn primary sm"
          disabled={!canSave}
          title={
            canSave
              ? undefined
              : hasPassword && !current
                ? t('workspace.password.currentFirst')
                : t('workspace.password.newTooShort', { min: WS_MIN_PASSWORD })
          }
          onClick={() => void save()}
        >
          {hasPassword ? t('workspace.password.change') : t('workspace.password.set')}
        </button>
        {hasPassword && (
          <button
            className="btn sm danger"
            disabled={busy || !current}
            title={
              current
                ? t('workspace.password.removeTitle', { name: wname })
                : t('workspace.password.currentFirst')
            }
            onClick={() => void clear()}
          >
            {t('common.remove')}
          </button>
        )}
        <button className="btn sm" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
      {error && <div className="vault-error">{error}</div>}
      <div className="faint" style={{ fontSize: 11 }}>
        {t('workspace.password.note')}
      </div>
    </div>
  )
}
