import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Database,
  FolderOpen,
  Loader2,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2
} from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import {
  BACKUP_DESTINATION_EXPOSURE,
  BACKUP_DESTINATION_KINDS,
  BACKUP_DESTINATION_LABEL,
  BACKUP_STAGE_LABEL,
  destinationProblem,
  MIN_PASSPHRASE
} from '../../../../shared/backup'
import type {
  BackupDestination,
  BackupDestinationKind,
  BackupGeneration,
  BackupRunReport,
  BackupSummary,
  BackupTargetsFile,
  DumpEngine
} from '../../../../shared/backup'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { Translate } from '../../../../shared/i18n'


function uid(): string {
  return `bd-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function blank(kind: BackupDestinationKind): BackupDestination {
  const base = { id: uid(), name: '', keep: 0, everyHours: 0, restoreTest: true }
  if (kind === 'local') return { ...base, kind: 'local', directory: '' }
  if (kind === 'sftp') return { ...base, kind: 'sftp', serverId: '', directory: '' }
  // Nothing to configure. The relay, the account and the TLS pin are the
  // enrolment this device already has — asking for them again would be asking
  // the user to retype something they cannot get wrong twice.
  if (kind === 'addy') return { ...base, kind: 'addy' }
  return {
    ...base,
    kind: 's3',
    endpoint: '',
    region: '',
    bucket: '',
    prefix: '',
    vaultEntryId: '',
    pathStyle: true
  }
}

function when(t: Translate, ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString() : t('settings.backupPanel.never')
}

/** What the last run actually proved, in the words of what was checked. Never
 *  "backed up" for a run that was not read back — see describeRun in shared. */
function outcome(
  t: Translate,
  report: BackupRunReport | undefined
): { ok: boolean; text: string } | null {
  if (!report) return null
  if (!report.ok) {
    const stage = report.failedStage
      ? BACKUP_STAGE_LABEL[report.failedStage]
      : t('settings.backupDest.status.stageRunning')
    return {
      ok: false,
      text: t('settings.backupDest.status.failed', {
        stage,
        error: report.error ?? t('settings.backupDest.noReason')
      })
    }
  }
  const name = report.name ?? ''
  const count = report.removed.length
  if (report.restoreTested) {
    return {
      ok: true,
      text: count
        ? t('settings.backupDest.status.testRestoredRemoved', { name, count })
        : t('settings.backupDest.status.testRestored', { name })
    }
  }
  return {
    ok: true,
    text: count
      ? t('settings.backupDest.status.matchedRemoved', { name, count })
      : t('settings.backupDest.status.matched', { name })
  }
}

export function BackupDestinations(): React.JSX.Element {
  const t = useT()
  const servers = useApp((s) => s.servers)
  const vaultUnlocked = useVault((s) => s.unlocked)
  const vaultEntries = useVault((s) => s.entries)

  const [file, setFile] = useState<BackupTargetsFile | null>(null)
  const [editing, setEditing] = useState<BackupDestination | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [runPw, setRunPw] = useState<Record<string, string>>({})
  const [browsing, setBrowsing] = useState<string | null>(null)
  const [generations, setGenerations] = useState<BackupGeneration[]>([])
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [staged, setStaged] = useState<{ path: string; summary: BackupSummary; name: string } | null>(
    null
  )
  const [databases, setDatabases] = useState<{ id: string; name: string; engine: DumpEngine }[]>([])
  const [dumpChoice, setDumpChoice] = useState<Record<string, string>>({})
  const [dumpResult, setDumpResult] = useState<Record<string, string>>({})

  const load = useCallback(async (): Promise<void> => {
    const f = await window.opsmaxx?.backup.destinations?.()
    if (f) setFile(f)
  }, [])

  useEffect(() => {
    void load()
    void window.opsmaxx?.backup.dumpableDatabases?.().then((d) => setDatabases(d ?? []))
  }, [load])

  const destinations = file?.destinations ?? []

  const persist = async (next: BackupDestination[]): Promise<void> => {
    const saved = await window.opsmaxx?.backup.saveDestinations?.(next)
    if (saved) setFile(saved)
  }

  const runNow = async (dest: BackupDestination): Promise<void> => {
    const password = runPw[dest.id] ?? ''
    if (password.length < MIN_PASSPHRASE) return
    setBusy(dest.id)
    const report = await window.opsmaxx?.backup.runDestination?.(dest.id, password)
    setBusy(null)
    await load()
    if (!report) return
    if (report.ok) {
      setRunPw((p) => ({ ...p, [dest.id]: '' }))
      toast(t('settings.backupDest.toast.written', { dest: dest.name, file: report.name ?? '' }), 'ok')
    } else {
      // Deliberately not a toast that says "check the panel": the reason is
      // already on the card, and the toast that hides it is how a failing
      // backup becomes a backup nobody thinks about.
      toast(
        t('settings.backupDest.toast.failed', {
          name: dest.name,
          error: report.error ?? t('settings.backupDest.noReason')
        }),
        'error'
      )
    }
  }

  const browse = async (dest: BackupDestination): Promise<void> => {
    setBusy(dest.id)
    setBrowseError(null)
    setStaged(null)
    const r = await window.opsmaxx?.backup.listRemote?.(dest.id)
    setBusy(null)
    if (!r?.ok) {
      setBrowsing(dest.id)
      setGenerations([])
      setBrowseError(r?.error ?? t('settings.backupDest.browse.unreadable'))
      return
    }
    setBrowsing(dest.id)
    setGenerations(r.generations ?? [])
  }

  const inspect = async (dest: BackupDestination, name: string): Promise<void> => {
    const password = runPw[dest.id] ?? ''
    if (!password) return
    setBusy(dest.id)
    const r = await window.opsmaxx?.backup.inspectRemote?.(dest.id, name, password)
    setBusy(null)
    if (!r?.ok || !r.path || !r.summary) {
      setBrowseError(r?.error ?? t('settings.backupDest.browse.didNotOpen'))
      setStaged(null)
      return
    }
    setBrowseError(null)
    setStaged({ path: r.path, summary: r.summary, name })
  }

  const restore = async (): Promise<void> => {
    if (!staged) return
    setBusy('restore')
    const r = await window.opsmaxx?.backup.import(
      runPw[browsing ?? ''] ?? '',
      staged.path
    )
    setBusy(null)
    if (!r?.ok) {
      setBrowseError(
        t('settings.backupPanel.error.notFullyRestored', { name: staged.name, error: r?.error ?? '' })
      )
      return
    }
    toast(t('settings.backupPanel.toast.restored'), 'ok')
    setTimeout(() => void window.opsmaxx?.backup.relaunch(), 700)
  }

  const dump = async (dest: BackupDestination): Promise<void> => {
    const databaseId = dumpChoice[dest.id]
    if (!databaseId) return
    setBusy(dest.id)
    const r = await window.opsmaxx?.backup.dumpDatabase?.(dest.id, databaseId)
    setBusy(null)
    setDumpResult((p) => ({
      ...p,
      [dest.id]: r?.ok
        ? t('settings.backupDest.dump.written', { name: r.name ?? '', count: r.bytes ?? 0 })
        : t('settings.backupDest.dump.failed', {
            error: r?.error ?? t('settings.backupDest.dump.fallback')
          })
    }))
  }

  const cancelStaged = (): void => {
    if (staged) void window.opsmaxx?.backup.discardStaged?.(staged.path)
    setStaged(null)
  }

  return (
    <div>
      <h3 className="backup-h">{t('settings.backupDest.heading')}</h3>
      <p className="s-desc" style={{ marginBottom: 10 }}>
        {t('settings.backupDest.intro')}
      </p>

      <div className="backup-banner warn" style={{ marginBottom: 12 }}>
        <ShieldAlert size={16} />
        <div>
          <div className="s-title">{t('settings.backupDest.exposure.title')}</div>
          <div className="s-desc">{t('settings.backupDest.exposure.desc')}</div>
        </div>
      </div>

      {file?.corrupt && (
        <div className="backup-banner warn" style={{ marginBottom: 12 }}>
          <AlertTriangle size={16} />
          <div>
            <div className="s-title">{t('settings.backupDest.corrupt.title')}</div>
            <div className="s-desc">
              {t('settings.backupDest.corrupt.desc', { reason: file.corrupt })}
            </div>
          </div>
        </div>
      )}

      {file === null && !editing && (
        // `destinations` is `file?.destinations ?? []`, so before the read it
        // is empty for the same reason it is empty when there are none. Saying
        // "no destinations yet" then is a claim about where the backups are
        // going, made before anyone looked.
        <p className="s-desc state-unknown" style={{ marginBottom: 10 }}>
          {t('settings.backupDest.reading')}
        </p>
      )}

      {file !== null && destinations.length === 0 && !editing && (
        // The same three parts every other empty state in the app has, rather
        // than a loose sentence with a row of "+ Local folder / + SFTP / + S3"
        // underneath it standing in for a call to action. Those three buttons
        // are still below — they are a choice of kind, and a choice of kind is
        // not a title.
        <EmptyState
          compact
          title={t('settings.backupDest.empty.title')}
          message={t('settings.backupDest.empty.message')}
        />
      )}

      {destinations.map((dest) => {
        const report = file?.lastReport[dest.id]
        const status = outcome(t, report)
        const problem = destinationProblem(dest)
        const password = runPw[dest.id] ?? ''
        return (
          <div key={dest.id} className="backup-banner ok" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
            {status ? (
              status.ok ? (
                <CheckCircle2 size={16} />
              ) : (
                <AlertTriangle size={16} />
              )
            ) : (
              <CloudUpload size={16} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="s-title">
                {t('settings.backupDest.card.title', {
                  name: dest.name || t('settings.backupDest.card.unnamed'),
                  kind: BACKUP_DESTINATION_LABEL[dest.kind]
                })}
              </div>
              <div className="s-desc">
                {dest.kind === 'local' && dest.directory}
                {dest.kind === 'sftp' &&
                  `${servers.find((s) => s.id === dest.serverId)?.name ?? t('settings.backupDest.card.missingServer')}:${dest.directory}`}
                {dest.kind === 's3' &&
                  t('settings.backupDest.card.s3Location', {
                    bucket: dest.bucket,
                    prefix: dest.prefix,
                    endpoint: dest.endpoint
                  })}
                {dest.kind === 'addy' && t('settings.backupDest.card.addyLocation')}
              </div>
              <div className="s-desc">
                {dest.everyHours > 0
                  ? t('settings.backupDest.card.everyHours', { hours: dest.everyHours })
                  : t('settings.backupDest.card.manualOnly')}{' '}
                ·{' '}
                {dest.keep > 0
                  ? t('settings.backupDest.card.keeps', { count: dest.keep })
                  : t('settings.backupDest.card.keepsAll')}{' '}
                ·{' '}
                {dest.restoreTest
                  ? t('settings.backupDest.card.restoreTests')
                  : t('settings.backupDest.card.noRestoreTest')}{' '}
                ·{' '}
                {t('settings.backupDest.card.lastAttempt', { when: when(t, file?.lastRunAt[dest.id]) })}
              </div>
              {problem && (
                <div className="s-desc" style={{ color: 'var(--danger)' }}>
                  {problem}
                </div>
              )}
              {status && (
                <div
                  className="s-desc"
                  style={{ color: status.ok ? undefined : 'var(--danger)', marginTop: 4 }}
                >
                  {status.text}
                </div>
              )}
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <input
                  className="input grow"
                  type="password"
                  placeholder={t('settings.backupDest.card.passphrasePlaceholder', { min: MIN_PASSPHRASE })}
                  value={password}
                  onChange={(e) => setRunPw((p) => ({ ...p, [dest.id]: e.target.value }))}
                />
                <button
                  className="btn primary size-28"
                  disabled={password.length < MIN_PASSPHRASE || busy !== null || problem !== null}
                  title={
                    problem ??
                    (password.length < MIN_PASSPHRASE
                      ? t('settings.backupDest.card.needPassphraseTitle')
                      : t('settings.backupDest.card.backUpNowTitle'))
                  }
                  onClick={() => void runNow(dest)}
                >
                  {busy === dest.id ? <Loader2 size={13} className="spin" /> : <CloudUpload size={13} />}
                  {t('settings.backupPanel.backUpNow')}
                </button>
                <button className="btn secondary size-28" disabled={busy !== null} onClick={() => void browse(dest)}>
                  <RotateCcw size={13} /> {t('settings.backupDest.card.restoreFromHere')}
                </button>
                <button className="btn secondary size-28" onClick={() => setEditing(dest)}>
                  {t('common.edit')}
                </button>
                <button
                  className="btn danger outline size-28"
                  title={t('settings.backupDest.card.removeTitle')}
                  onClick={() => void persist(destinations.filter((d) => d.id !== dest.id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {databases.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <select
                      className="input"
                      value={dumpChoice[dest.id] ?? ''}
                      onChange={(e) => setDumpChoice((p) => ({ ...p, [dest.id]: e.target.value }))}
                    >
                      <option value="">{t('settings.backupDest.dump.choose')}</option>
                      {databases.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.engine})
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn secondary size-28"
                      disabled={!dumpChoice[dest.id] || busy !== null}
                      onClick={() => void dump(dest)}
                    >
                      <Database size={13} /> {t('settings.backupDest.dump.button')}
                    </button>
                  </div>
                  {/* Said at the button, not in documentation: a dump is not a
                      OpsMaxx bundle and nothing encrypts it. Somebody who
                      assumed otherwise has just put a database in a bucket in
                      the clear. */}
                  <div className="s-desc">{t('settings.backupDest.dump.note')}</div>
                  {dumpResult[dest.id] && (
                    <div className="s-desc" style={{ marginTop: 4 }}>{dumpResult[dest.id]}</div>
                  )}
                </div>
              )}

              {browsing === dest.id && (
                <div style={{ marginTop: 10 }}>
                  {browseError && (
                    <div className="vault-error">{browseError}</div>
                  )}
                  {!browseError && generations.length === 0 && (
                    <div className="s-desc">{t('settings.backupDest.browse.empty')}</div>
                  )}
                  {generations.map((g) => (
                    <div key={g.name} className="row" style={{ gap: 8, marginTop: 4 }}>
                      <span className="grow s-desc">
                        {g.name} · {new Date(g.modified).toLocaleString()} ·{' '}
                        {t('settings.backupDest.browse.size', { count: g.size })}
                      </span>
                      <button
                        className="btn secondary size-24"
                        disabled={!password || busy !== null}
                        title={
                          password
                            ? t('settings.backupDest.browse.openTitle')
                            : t('settings.backupDest.browse.needPassphraseTitle')
                        }
                        onClick={() => void inspect(dest, g.name)}
                      >
                        {t('common.open')}
                      </button>
                    </div>
                  ))}
                  {staged && (
                    <div className="backup-banner warn" style={{ marginTop: 10 }}>
                      <AlertTriangle size={16} />
                      <div style={{ flex: 1 }}>
                        <div className="s-title">{t('settings.backupPanel.staged.title')}</div>
                        <div className="s-desc">
                          {staged.name} ·{' '}
                          {t('settings.backupDest.staged.created', {
                            when: new Date(staged.summary.createdAt).toLocaleString()
                          })}{' '}
                          ·{' '}
                          {t('settings.backupPanel.summary.workspaces', { count: staged.summary.workspaces })} ·{' '}
                          {t('settings.backupPanel.summary.servers', { count: staged.summary.servers })} ·{' '}
                          {t('settings.backupPanel.summary.databases', { count: staged.summary.databases })} ·{' '}
                          {t('settings.backupPanel.summary.credentials', { count: staged.summary.secrets })}
                          {staged.summary.hasVault ? ` · ${t('settings.backupPanel.summary.vaultIncluded')}` : ''}
                        </div>
                      </div>
                      <button className="btn secondary size-28" onClick={cancelStaged}>
                        {t('common.cancel')}
                      </button>
                      {/* Filled rather than outlined: this replaces every
                          workspace, server, credential and vault entry on the
                          machine with what is in that file, and there is no way
                          back from it. */}
                      <button
                        className="btn danger fill size-28"
                        disabled={busy !== null}
                        onClick={() => void restore()}
                      >
                        {t('settings.backupPanel.staged.restoreAndRestart')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {editing ? (
        <DestinationEditor
          value={editing}
          servers={servers.map((s) => ({ id: s.id, name: s.name }))}
          vaultUnlocked={vaultUnlocked}
          vaultEntries={vaultEntries.map((e) => ({ id: e.id, name: e.name }))}
          onCancel={() => setEditing(null)}
          onSave={(next) => {
            const others = destinations.filter((d) => d.id !== next.id)
            void persist([...others, next])
            setEditing(null)
          }}
        />
      ) : (
        <div className="row" style={{ gap: 8 }}>
          {BACKUP_DESTINATION_KINDS.map((kind) => (
            <button key={kind} className="btn secondary size-28" onClick={() => setEditing(blank(kind))}>
              <Plus size={13} /> {BACKUP_DESTINATION_LABEL[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface EditorProps {
  value: BackupDestination
  servers: { id: string; name: string }[]
  vaultUnlocked: boolean
  vaultEntries: { id: string; name: string }[]
  onCancel: () => void
  onSave: (dest: BackupDestination) => void
}

function DestinationEditor(props: EditorProps): React.JSX.Element {
  const t = useT()
  const [dest, setDest] = useState<BackupDestination>(props.value)
  /**
   * Whether a machine-held passphrase exists — never what it is.
   *
   * The bridge is write-only by design, so this asks a yes/no question and the
   * field shows "Stored on this machine" rather than a row of dots that might
   * be a real secret or might be a placeholder. That ambiguity is the one the
   * password fields elsewhere in this app were changed to avoid.
   */
  const [machineSet, setMachineSet] = useState(false)
  const [machinePw, setMachinePw] = useState('')
  useEffect(() => {
    let live = true
    void window.opsmaxx?.backup
      ?.hasMachinePassphrase?.(props.value.id)
      .then((yes) => {
        if (live) setMachineSet(yes === true)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [props.value.id])

  const saveMachinePw = async (): Promise<void> => {
    const r = await window.opsmaxx?.backup?.setMachinePassphrase?.(dest.id, machinePw)
    if (r?.ok) {
      setMachineSet(true)
      setMachinePw('')
      toast(t('settings.backupDest.editor.machineStored'), 'ok')
      return
    }
    toast(r?.error ?? t('settings.backupDest.editor.machineRefused'), 'error')
  }
  const patch = (p: Partial<BackupDestination>): void =>
    setDest((d) => ({ ...d, ...p }) as BackupDestination)
  const problem = destinationProblem(dest)

  return (
    <div className="backup-banner warn" style={{ alignItems: 'flex-start', marginTop: 10 }}>
      <ShieldAlert size={16} />
      <div style={{ flex: 1 }}>
        <div className="s-title">{BACKUP_DESTINATION_LABEL[dest.kind]}</div>

        {/* The security statement sits here, above the fields, because this is
            the moment the decision is made. A footnote further down the page
            is a footnote nobody read before they typed a bucket name. */}
        <div className="s-desc" style={{ marginBottom: 8 }}>
          {BACKUP_DESTINATION_EXPOSURE[dest.kind]}
        </div>

        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <input
            className="input grow"
            placeholder={t('settings.backupDest.editor.namePlaceholder')}
            value={dest.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>

        {dest.kind === 'local' && (
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <input
              className="input grow"
              placeholder={t('settings.backupDest.editor.folderPlaceholder')}
              value={dest.directory}
              onChange={(e) => patch({ directory: e.target.value })}
            />
            <button
              className="btn secondary size-28"
              onClick={() => {
                void window.opsmaxx?.backup.chooseDirectory?.().then((dir) => {
                  if (dir) patch({ directory: dir })
                })
              }}
            >
              <FolderOpen size={13} /> {t('settings.backupDest.editor.chooseFolder')}
            </button>
          </div>
        )}

        {dest.kind === 'sftp' && (
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <select
              className="input"
              value={dest.serverId}
              onChange={(e) => patch({ serverId: e.target.value })}
            >
              <option value="">{t('settings.backupDest.editor.chooseServer')}</option>
              {props.servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input
              className="input grow"
              placeholder={t('settings.backupDest.editor.remoteDirPlaceholder')}
              value={dest.directory}
              onChange={(e) => patch({ directory: e.target.value })}
            />
          </div>
        )}

        {dest.kind === 'sftp' && (
          <div className="s-desc" style={{ marginBottom: 6 }}>
            {t('settings.backupDest.editor.sftpNote')}
          </div>
        )}

        {dest.kind === 'addy' && (
          <div className="s-desc" style={{ marginBottom: 6 }}>
            <Trans i18nKey="settings.backupDest.editor.addyNote" components={{ br: <br /> }} />
          </div>
        )}

        {dest.kind === 's3' && (
          <>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <input
                className="input grow"
                placeholder={t('settings.backupDest.editor.endpointPlaceholder')}
                value={dest.endpoint}
                onChange={(e) => patch({ endpoint: e.target.value })}
              />
              <input
                className="input"
                style={{ maxWidth: 140 }}
                placeholder={t('settings.backupDest.editor.regionPlaceholder')}
                value={dest.region}
                onChange={(e) => patch({ region: e.target.value })}
              />
            </div>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <input
                className="input grow"
                placeholder={t('settings.backupDest.editor.bucketPlaceholder')}
                value={dest.bucket}
                onChange={(e) => patch({ bucket: e.target.value })}
              />
              <input
                className="input grow"
                placeholder={t('settings.backupDest.editor.prefixPlaceholder')}
                value={dest.prefix}
                onChange={(e) => patch({ prefix: e.target.value })}
              />
              <label className="s-desc" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={dest.pathStyle}
                  onChange={(e) => patch({ pathStyle: e.target.checked })}
                />
                {t('settings.backupDest.editor.pathStyle')}
              </label>
            </div>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <select
                className="input grow"
                value={dest.vaultEntryId}
                disabled={!props.vaultUnlocked}
                onChange={(e) => patch({ vaultEntryId: e.target.value })}
              >
                <option value="">{t('settings.backupDest.editor.accessKeyEntry')}</option>
                {props.vaultEntries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="s-desc" style={{ marginBottom: 6 }}>
              {t('settings.backupDest.editor.accessKeyNote')}
              {!props.vaultUnlocked && (
                <>
                  {' '}
                  <UnlockVaultButton reason={t('settings.backupDest.editor.unlockReason')} />
                </>
              )}
            </div>
          </>
        )}

        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <label className="s-desc" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Trans
              i18nKey="settings.backupDest.editor.runEvery"
              components={{
                hours: (
                  <input
                    className="input"
                    style={{ width: 70 }}
                    type="number"
                    min={0}
                    value={dest.everyHours}
                    onChange={(e) => patch({ everyHours: Math.max(0, Number(e.target.value) || 0) })}
                  />
                )
              }}
            />
          </label>
          <label className="s-desc" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Trans
              i18nKey="settings.backupDest.editor.keep"
              components={{
                keep: (
                  <input
                    className="input"
                    style={{ width: 70 }}
                    type="number"
                    min={0}
                    value={dest.keep}
                    onChange={(e) => patch({ keep: Math.max(0, Number(e.target.value) || 0) })}
                  />
                )
              }}
            />
          </label>
          <label className="s-desc" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={dest.restoreTest}
              onChange={(e) => patch({ restoreTest: e.target.checked })}
            />
            {t('settings.backupDest.editor.restoreTest')}
          </label>
        </div>

        {dest.everyHours > 0 && (
          <>
            {/* The choice, stated as the trade it is. Neither option is the
                right one for everybody, and the previous version simply did
                not offer the second — so a schedule that stopped after every
                restart was the only shape available. */}
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <label className="s-desc" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="radio"
                  checked={(dest.passphraseSource ?? 'vault') === 'vault'}
                  onChange={() => patch({ passphraseSource: 'vault' })}
                />
                {t('settings.backupDest.editor.passphraseFromVault')}
              </label>
              <label className="s-desc" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="radio"
                  checked={dest.passphraseSource === 'machine'}
                  onChange={() => patch({ passphraseSource: 'machine' })}
                />
                {t('settings.backupDest.editor.passphraseOnMachine')}
              </label>
            </div>

            {(dest.passphraseSource ?? 'vault') === 'vault' ? (
              <>
                <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                  <select
                    className="input grow"
                    value={dest.passphraseVaultEntryId ?? ''}
                    disabled={!props.vaultUnlocked}
                    onChange={(e) => patch({ passphraseVaultEntryId: e.target.value || undefined })}
                  >
                    <option value="">{t('settings.backupDest.editor.passphraseEntry')}</option>
                    {props.vaultEntries.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="s-desc" style={{ marginBottom: 6 }}>
                  {t('settings.backupDest.editor.vaultNote')}
                </div>
              </>
            ) : (
              <>
                <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                  <input
                    className="input grow"
                    type="password"
                    placeholder={
                      machineSet
                        ? t('settings.backupDest.editor.machineStoredPlaceholder')
                        : t('settings.backupDest.editor.machinePlaceholder')
                    }
                    value={machinePw}
                    onChange={(e) => setMachinePw(e.target.value)}
                  />
                  <button
                    className="btn secondary size-28"
                    disabled={machinePw.length < 8}
                    onClick={() => void saveMachinePw()}
                  >
                    {machineSet
                      ? t('settings.backupDest.editor.replace')
                      : t('settings.backupDest.editor.store')}
                  </button>
                </div>
                {/* Said here, where the choice is made, and not in a document
                    nobody opens. Both sentences are consequences the operator
                    cannot discover later by looking at the panel. */}
                <div className="s-desc" style={{ marginBottom: 6 }}>
                  <Trans
                    i18nKey="settings.backupDest.editor.machineNote"
                    components={{ strong: <strong /> }}
                  />
                </div>
              </>
            )}
          </>
        )}

        {/* The footer, and it is INSIDE this column on purpose. Cancel and Save
            used to be flex siblings of the column, in a banner with
            `align-items: flex-start` — so they rendered at the top-right of the
            panel, above every field they commit. On an S3 destination with a
            schedule the form is tall enough to run past the bottom of the
            window, which put the primary action off-screen behind the user as
            they scrolled down to finish typing. */}
        <div className="inline-panel-footer">
          {problem && <span className="footer-note field-error">{problem}</span>}
          <button className="btn secondary size-28" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary size-28"
            disabled={problem !== null}
            onClick={() => props.onSave(dest)}
          >
            {t('settings.backupDest.editor.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
