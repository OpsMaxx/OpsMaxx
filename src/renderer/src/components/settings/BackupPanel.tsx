import { useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, Loader2, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { useApp } from '../../store/app'
import { BackupDestinations } from './BackupDestinations'
import { toast } from '../../store/toast'
import { MIN_PASSPHRASE } from '../../../../shared/backup'
import type { BackupResult, BackupSummary } from '../../../../shared/backup'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { Translate } from '../../../../shared/i18n'

function when(t: Translate, iso: string | null): string {
  if (!iso) return t('settings.backupPanel.never')
  return new Date(iso).toLocaleString()
}

// A full path in a sentence is unreadable; the file's own name is the part
// someone recognises — and naming it is the difference between "that failed"
// and "that file failed", which is what tells them to pick a different one.
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** A failure, parked next to the control that caused it and carrying the way
 *  out. `where` is only about placement: an error about a backup file belongs
 *  beside the restore controls, not floating at the top of the panel where
 *  nothing can be done about it. */
interface PanelError {
  where: 'export' | 'import' | 'delete'
  text: string
  actions?: { label: string; run: () => void }[]
}

export function BackupPanel(): React.JSX.Element {
  const t = useT()
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)

  const [exportPw, setExportPw] = useState('')
  const [exportPw2, setExportPw2] = useState('')
  const [importPw, setImportPw] = useState('')
  const [busy, setBusy] = useState<'export' | 'inspect' | 'import' | 'delete' | null>(null)
  const [staged, setStaged] = useState<{ path: string; summary: BackupSummary } | null>(null)
  const [error, setError] = useState<PanelError | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteTyped, setDeleteTyped] = useState('')
  const exportPwRef = useRef<HTMLInputElement>(null)

  const exportReady = exportPw.length >= MIN_PASSPHRASE && exportPw === exportPw2

  /** Did this call succeed? A cancelled dialog is neither success nor failure —
   *  the user already knows what they did, so it says nothing. */
  const failed = (r: BackupResult | undefined): boolean => {
    if (!r || r.cancelled) return true
    if (r.ok) setError(null)
    return !r.ok
  }

  const runExport = async (): Promise<void> => {
    if (!exportReady || busy) return
    setBusy('export')
    const r = await window.opsmaxx?.backup.export(exportPw)
    setBusy(null)
    if (r?.cancelled) return
    if (failed(r)) {
      setError({
        where: 'export',
        text: t('settings.backupPanel.error.exportFailed', {
          error: r?.error ?? t('settings.backupPanel.error.exportFallback')
        }),
        actions: [{ label: t('settings.backupPanel.error.tryAgain'), run: () => void runExport() }]
      })
      return
    }
    setSettings({ backupDirty: false, lastBackupAt: new Date().toISOString(), lastBackupTo: null })
    setExportPw('')
    setExportPw2('')
    toast(t('settings.backupPanel.toast.saved', { path: r?.path ?? '' }), 'ok')
  }

  // `path` re-reads a file already chosen, which is what makes "try again after
  // fixing the passphrase" possible without walking back through the file
  // picker to select the very same file.
  const runInspect = async (path?: string): Promise<void> => {
    if (!importPw || busy) return
    setBusy('inspect')
    const r = await window.opsmaxx?.backup.inspect(importPw, path)
    setBusy(null)
    if (r?.cancelled) return
    if (failed(r)) {
      const file = r?.path
      setError({
        where: 'import',
        text: file
          ? t('settings.backupPanel.error.fileDidNotOpen', { file: fileName(file), error: r?.error ?? '' })
          : t('settings.backupPanel.error.backupDidNotOpen', { error: r?.error ?? '' }),
        actions: [
          ...(file
            ? [{ label: t('settings.backupPanel.error.tryThisFileAgain'), run: () => void runInspect(file) }]
            : []),
          { label: t('settings.backupPanel.error.chooseDifferentFile'), run: () => void runInspect() }
        ]
      })
      return
    }
    if (!r?.path || !r.summary) return
    setStaged({ path: r.path, summary: r.summary })
  }

  const runImport = async (): Promise<void> => {
    if (!staged || busy) return
    setBusy('import')
    const r = await window.opsmaxx?.backup.import(importPw, staged.path)
    setBusy(null)
    if (failed(r)) {
      setError({
        where: 'import',
        // Not "nothing happened": a restore can fail after it has already
        // written some files, so the wording must not promise otherwise.
        text: t('settings.backupPanel.error.notFullyRestored', {
          name: fileName(staged.path),
          error: r?.error ?? t('settings.backupPanel.error.restoreFallback')
        }),
        actions: [
          { label: t('settings.backupPanel.error.tryAgain'), run: () => void runImport() },
          { label: t('settings.backupPanel.error.chooseDifferentFile'), run: () => void runInspect() }
        ]
      })
      return
    }
    toast(t('settings.backupPanel.toast.restored'), 'ok')
    setTimeout(() => void window.opsmaxx?.backup.relaunch(), 700)
  }

  const runDeleteAll = async (): Promise<void> => {
    if (settings.backupDirty || deleteTyped !== 'DELETE' || busy) return
    setBusy('delete')
    const r = await window.opsmaxx?.backup.deleteAll()
    setBusy(null)
    if (failed(r)) {
      setError({
        where: 'delete',
        // deleteAllData isolates each step: it does not stop at the first
        // failure, it continues and reports which paths it could not remove.
        // So the wording names what is LEFT rather than claiming it gave up
        // part of the way through.
        text: t('settings.backupPanel.error.deletePartial', {
          error: r?.error ?? t('settings.backupPanel.error.deleteFallback')
        }),
        actions: [{ label: t('settings.backupPanel.error.tryAgain'), run: () => void runDeleteAll() }]
      })
      return
    }
    toast(t('settings.backupPanel.toast.deleted'), 'ok')
    setTimeout(() => void window.opsmaxx?.backup.relaunch(), 700)
  }

  const errorFor = (where: PanelError['where']): React.JSX.Element | null =>
    error?.where === where ? (
      <div className="vault-error">
        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <span className="grow">{error.text}</span>
          {error.actions?.map((a) => (
            <button key={a.label} className="btn sm" style={{ flexShrink: 0 }} onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    ) : null

  return (
    <div>
      <div className={settings.backupDirty ? 'backup-banner warn' : 'backup-banner ok'}>
        {settings.backupDirty ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
        <div>
          <div className="s-title">
            {settings.backupDirty
              ? t('settings.backupPanel.status.outOfDate')
              : t('settings.backupPanel.status.upToDate')}
          </div>
          <div className="s-desc">
            {settings.backupDirty
              ? t('settings.backupPanel.status.dirtyDesc')
              : settings.lastBackupTo
                ? // Named, because this one was not exported by hand: the user
                  // has no memory of choosing a folder for it, and the place it
                  // landed is what makes the reassurance something they can go
                  // and verify.
                  t('settings.backupPanel.status.lastBackedUpTo', {
                    when: when(t, settings.lastBackupAt),
                    to: settings.lastBackupTo
                  })
                : t('settings.backupPanel.status.lastExported', { when: when(t, settings.lastBackupAt) })}
          </div>
        </div>
      </div>

      <h3 className="backup-h">{t('settings.backupPanel.download.heading')}</h3>
      <p className="s-desc" style={{ marginBottom: 10 }}>
        {t('settings.backupPanel.download.desc')}
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input grow"
          ref={exportPwRef}
          type="password"
          placeholder={t('settings.backupPanel.download.passphrasePlaceholder', { min: MIN_PASSPHRASE })}
          value={exportPw}
          onChange={(e) => setExportPw(e.target.value)}
        />
        <input
          className="input grow"
          type="password"
          placeholder={t('settings.backupPanel.download.confirmPlaceholder')}
          value={exportPw2}
          onChange={(e) => setExportPw2(e.target.value)}
        />
        <button
          className="btn primary"
          disabled={!exportReady || busy !== null}
          title={
            exportReady
              ? t('settings.backupPanel.download.readyTitle')
              : exportPw.length < MIN_PASSPHRASE
                ? t('settings.backupPanel.download.tooShortTitle', { min: MIN_PASSPHRASE })
                : t('settings.backupPanel.download.mismatchTitle')
          }
          onClick={() => void runExport()}
        >
          {busy === 'export' ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
          {t('settings.backupPanel.download.button')}
        </button>
      </div>
      {exportPw2.length > 0 && exportPw !== exportPw2 && (
        <div className="s-desc" style={{ color: 'var(--danger)' }}>
          {t('settings.backupPanel.download.mismatch')}
        </div>
      )}
      <div className="s-desc" style={{ marginTop: 6 }}>
        <ShieldCheck size={12} /> {t('settings.backupPanel.download.passphraseNote')}
      </div>
      {errorFor('export')}

      <h3 className="backup-h">{t('settings.backupPanel.restore.heading')}</h3>
      <p className="s-desc" style={{ marginBottom: 10 }}>
        {t('settings.backupPanel.restore.desc')}
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input grow"
          type="password"
          placeholder={t('settings.backupPanel.restore.passphrasePlaceholder')}
          value={importPw}
          onChange={(e) => {
            setImportPw(e.target.value)
            setStaged(null)
            // The message named a file and a passphrase that no longer apply.
            if (error?.where === 'import') setError(null)
          }}
        />
        <button
          className="btn"
          disabled={!importPw || busy !== null}
          title={
            importPw
              ? t('settings.backupPanel.restore.chooseTitle')
              : t('settings.backupPanel.restore.needPassphraseTitle')
          }
          onClick={() => void runInspect()}
        >
          {busy === 'inspect' ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          {t('settings.backupPanel.restore.chooseFile')}
        </button>
      </div>
      {errorFor('import')}

      {staged && (
        <div className="backup-banner warn" style={{ marginTop: 12 }}>
          <AlertTriangle size={16} />
          <div style={{ flex: 1 }}>
            <div className="s-title">{t('settings.backupPanel.staged.title')}</div>
            <div className="s-desc">
              {staged.path}
              <br />
              {t('settings.backupPanel.staged.created', { when: when(t, staged.summary.createdAt) })} ·{' '}
              {t('settings.backupPanel.summary.workspaces', { count: staged.summary.workspaces })} ·{' '}
              {t('settings.backupPanel.summary.servers', { count: staged.summary.servers })} ·{' '}
              {t('settings.backupPanel.summary.databases', { count: staged.summary.databases })} ·{' '}
              {t('settings.backupPanel.summary.credentials', { count: staged.summary.secrets })}
              {staged.summary.hasVault ? ` · ${t('settings.backupPanel.summary.vaultIncluded')}` : ''}
            </div>
          </div>
          <button className="btn sm" onClick={() => setStaged(null)}>
            {t('common.cancel')}
          </button>
          <button className="btn sm danger fill" disabled={busy !== null} onClick={() => void runImport()}>
            {busy === 'import' ? <Loader2 size={13} className="spin" /> : null}
            {t('settings.backupPanel.staged.restoreAndRestart')}
          </button>
        </div>
      )}

      <BackupDestinations />

      <h3 className="backup-h" style={{ color: 'var(--danger)' }}>
        {t('settings.backupPanel.danger.heading')}
      </h3>
      <p className="s-desc" style={{ marginBottom: 10 }}>
        {t('settings.backupPanel.danger.desc')}
      </p>

      {settings.backupDirty ? (
        <div className="backup-banner warn">
          <AlertTriangle size={16} />
          <div style={{ flex: 1 }}>
            <div className="s-title">{t('settings.backupPanel.danger.backUpFirstTitle')}</div>
            <div className="s-desc">{t('settings.backupPanel.danger.backUpFirstDesc')}</div>
          </div>
          {/* "Above" is a direction, not a next step. This puts the cursor in
              the field that does it. */}
          <button
            className="btn sm"
            onClick={() => {
              exportPwRef.current?.scrollIntoView({ block: 'center' })
              exportPwRef.current?.focus()
            }}
          >
            {t('settings.backupPanel.backUpNow')}
          </button>
        </div>
      ) : !confirmDelete ? (
        <button className="btn danger outline" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} /> {t('settings.backupPanel.danger.deleteAll')}
        </button>
      ) : (
        <div className="backup-banner warn">
          <AlertTriangle size={16} />
          <div style={{ flex: 1 }}>
            <div className="s-title">{t('settings.backupPanel.danger.confirmTitle')}</div>
            <div className="s-desc" style={{ marginBottom: 8 }}>
              {/* The typed word is what runDeleteAll compares against, so it is
                  passed in rather than translated. */}
              <Trans
                i18nKey="settings.backupPanel.danger.confirmDesc"
                values={{ word: 'DELETE' }}
                components={{ strong: <strong /> }}
              />
            </div>
            <input
              className="input"
              style={{ maxWidth: 200 }}
              value={deleteTyped}
              onChange={(e) => setDeleteTyped(e.target.value)}
              placeholder="DELETE"
              autoFocus
            />
          </div>
          <button
            className="btn sm"
            onClick={() => {
              setConfirmDelete(false)
              setDeleteTyped('')
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            className="btn sm danger fill"
            disabled={deleteTyped !== 'DELETE' || busy !== null}
            onClick={() => void runDeleteAll()}
          >
            {busy === 'delete' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
            {t('settings.backupPanel.danger.deleteEverything')}
          </button>
        </div>
      )}
      {errorFor('delete')}
    </div>
  )
}
