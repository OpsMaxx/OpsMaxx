import { useCallback, useEffect, useRef, useState } from 'react'
import { ListChecks, Plus, RefreshCw, Square, Undo2 } from 'lucide-react'
import type { JobComposerJump } from '../../store/nav'
import { clsx } from '../../lib/format'
import { sshHopsFor } from '../../lib/ssh'
import {
  assignWaves,
  checkJobDraft,
  composeJobSpec,
  draftFromTemplate,
  EMPTY_JOB_DRAFT,
  normaliseTemplateName,
  templateFromDraft,
  type JobDraft,
  type JobTemplate
} from '../../../../shared/jobCompose'
import {
  checkServiceStep,
  serviceJobSpec,
  SERVICE_ACTIONS,
  type ServiceAction
} from '../../../../shared/serviceStep'
import {
  checkPackageStep,
  packageJobSpec,
  PACKAGE_ACTIONS,
  type PackageAction
} from '../../../../shared/packageStep'
import { PACKAGE_MANAGERS, type PackageManager } from '../../../../shared/hostFacts'
import {
  checkUserStep,
  userJobSpec,
  USER_ACTIONS,
  type UserAction
} from '../../../../shared/userStep'
import { checkFilePush, filePushJobSpec } from '../../../../shared/fileStep'
import { jobApprovalFor, planJob } from '../../../../shared/jobs'
import { useFleet } from '../../store/fleet'
import type {
  JobDetail,
  JobHostResult,
  JobHostState,
  JobProgress,
  JobRecord,
  JobState
} from '../../../../shared/jobs'
import type { Server } from '../../types'
import { PanelShell } from './PanelShell'
import { Modal } from '../common/Modal'
import { VaultLockedHosts } from '../common/PanelError'
import { isVaultLocked } from '../../lib/withVaultUnlock'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'

// Roadmap item 33. The job engine shipped in full -- waves, health gate,
// reboot-and-verify, detached execution, approval record -- and NO RENDERER
// COMPOSED A JOB. `jobs.run` had one caller, PatchPanel, and `jobs.list` and
// `jobs.get` had none, so job history was visible only through the change log.
//
// That made "restart nginx on twelve servers", "install a package everywhere"
// and "push this config" the same missing thing wearing different clothes.
//
// WHAT THIS PANEL MUST NOT DO, and each has a reason older than this file:
//
//   - reach the bridge (tests/jobsNotExposed.test.ts). The composer is an
//     operator's surface. An agent gets nowhere near it.
//   - skip the dialog. `planJob` decides what confirmation this job needs and
//     this panel asks for exactly that -- it does not decide for itself that a
//     particular verb is safe. ComposePanel used to, and item 35 fixed it.
//   - re-run without re-minting the approval. A record is an answer to a
//     question about a specific target list, not a token to keep.

interface Props {
  servers: Server[]
  /** A prefilled service step. Fills the form; runs nothing. */
  jump?: JobComposerJump
}

const STATE_CLASS: Record<string, string> = {
  running: 'warn',
  queued: 'faint',
  done: 'ok',
  cancelled: 'faint',
  abandoned: 'danger',
  halted: 'danger'
}

const STATE_LABEL: Record<JobState, MessageKey> = {
  queued: 'monitor.jobs.state.queued',
  running: 'monitor.jobs.state.running',
  done: 'monitor.jobs.state.done',
  cancelled: 'monitor.jobs.state.cancelled',
  abandoned: 'monitor.jobs.state.abandoned',
  halted: 'monitor.jobs.state.halted'
}

const HOST_STATE_LABEL: Record<JobHostState, MessageKey> = {
  pending: 'monitor.jobs.hostState.pending',
  waiting: 'monitor.jobs.hostState.waiting',
  running: 'monitor.jobs.hostState.running',
  ok: 'monitor.jobs.hostState.ok',
  failed: 'monitor.jobs.hostState.failed',
  skipped: 'monitor.jobs.hostState.skipped',
  detached: 'monitor.jobs.hostState.detached',
  orphaned: 'monitor.jobs.hostState.orphaned',
  rebooting: 'monitor.jobs.hostState.rebooting',
  foreign: 'monitor.jobs.hostState.foreign'
}

export function JobsPanel({ servers, jump }: Props): React.JSX.Element {
  const t = useT()
  // `null` until asked, never `[]`. An empty list drawn before the question is
  // "you have never run a job", which is a different sentence.
  const [jobs, setJobs] = useState<JobRecord[] | null>(null)
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [output, setOutput] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState<JobDraft>(EMPTY_JOB_DRAFT)
  const [picked, setPicked] = useState<string[]>([])
  // A prefilled service step, from wherever the operator saw they needed one.
  //
  // It FILLS THE FORM AND STOPS. Nothing is planned, nothing is confirmed and
  // nothing runs: this is a write on somebody's server, and the confirmation is
  // the point of the composer rather than a step to skip by arriving with an
  // intention. Keyed on `nonce` so asking twice for the same unit re-fills.
  const lastJump = useRef(0)
  useEffect(() => {
    if (!jump || jump.nonce === lastJump.current) return
    lastJump.current = jump.nonce
    setMode(jump.mode)
    setAction(jump.action)
    setUnit(jump.unit)
    setPicked([jump.serverId])
  }, [jump])
  const [pending, setPending] = useState<{
    spec: ReturnType<typeof composeJobSpec>
    targets: { serverId: string; serverName: string; cohort: string }[]
    plan: ReturnType<typeof planJob>
  } | null>(null)
  const [phrase, setPhrase] = useState('')
  // Item 34a. A free-text step is a line somebody typed; a typed step is an
  // action and a unit, checked before the command exists.
  const [mode, setMode] = useState<'command' | 'service' | 'package' | 'user' | 'file'>('command')
  const [action, setAction] = useState<ServiceAction>('restart')
  const [unit, setUnit] = useState('')
  const [sudo, setSudo] = useState(true)
  // Item 34b. The manager is chosen ONCE for the job, not per server: a job is
  // one step list for every server in it, and `verifyApproval` compares that
  // text literally, so a command substituted per server could not be checked
  // against its own approval at all.
  const [manager, setManager] = useState<PackageManager>('apt')
  const [pkgAction, setPkgAction] = useState<PackageAction>('install')
  const [pkgNames, setPkgNames] = useState('')
  // Item 34d. No password field, and there is no action that would take one --
  // see the note at the top of userStep.ts about what a step's text becomes.
  const [userAction, setUserAction] = useState<UserAction>('lock')
  const [userName, setUserName] = useState('')
  const [userGroup, setUserGroup] = useState('')
  const [userExpiry, setUserExpiry] = useState('')
  const [removeHome, setRemoveHome] = useState(false)
  // Item 34c. The hash is computed here and travels in the command, so the
  // approval covers the bytes rather than a description of them.
  const [filePath, setFilePath] = useState('')
  const [fileBody, setFileBody] = useState('')
  const [fileMode, setFileMode] = useState('0644')
  const [fileAfter, setFileAfter] = useState('')
  const [fileSha, setFileSha] = useState('')

  useEffect(() => {
    let live = true
    if (fileBody === '') {
      setFileSha('')
      return
    }
    void crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(fileBody))
      .then((d) => {
        if (!live) return
        setFileSha(
          [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
        )
      })
    return () => {
      live = false
    }
  }, [fileBody])
  // Saved templates: steps, never servers. Loaded when the composer opens.
  // `problem` is the file main will not rewrite -- unreadable, from another
  // version, or holding rows this one refuses -- and saving waits on it.
  const [templates, setTemplates] = useState<JobTemplate[]>([])
  const [templateFile, setTemplateFile] = useState<{ problem: string; path: string } | null>(null)
  const [templateId, setTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [templateNote, setTemplateNote] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<JobTemplate | null>(null)
  const chosenTemplate = templates.find((x) => x.id === templateId)
  const loadTemplates = useCallback(async (): Promise<void> => {
    try {
      const read = await window.opsmaxx?.jobTemplates?.list()
      if (!read) return
      setTemplates(read.templates)
      setTemplateFile(read.problem ? { problem: read.problem, path: read.path } : null)
    } catch (e) {
      setTemplateNote(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => {
    if (composing) void loadTemplates()
  }, [composing, loadTemplates])

  /** One save path for "save as new" and "rename": main narrows the template,
   *  stamps it, and hands back what it stored -- or why it did not. */
  const storeTemplate = async (tpl: JobTemplate | null): Promise<void> => {
    const result = tpl
      ? await window.opsmaxx?.jobTemplates?.save(tpl)
      : { ok: false as const, reason: t('monitor.jobs.template.needsName') }
    if (!result?.ok) {
      setTemplateNote(result?.reason ?? t('monitor.jobs.template.notSaved'))
      return
    }
    const stored = result.template
    setTemplateNote(null)
    setTemplates((cur) => [...cur.filter((x) => x.id !== stored.id), stored])
    setTemplateId(stored.id)
    setTemplateName(stored.name)
  }

  const deleteTemplate = async (): Promise<void> => {
    if (!chosenTemplate) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    const result = await window.opsmaxx?.jobTemplates?.remove(chosenTemplate.id)
    if (!result?.ok) {
      setTemplateNote(result?.reason ?? t('monitor.jobs.template.notDeleted'))
      return
    }
    setTemplateNote(null)
    setTemplates((cur) => cur.filter((x) => x.id !== chosenTemplate.id))
    setTemplateId('')
    setTemplateName('')
  }

  /** The way out of a file main will not rewrite: move it aside, never delete
   *  it, and say where it went. */
  const setAsideTemplates = async (): Promise<void> => {
    const result = await window.opsmaxx?.jobTemplates?.setAside()
    setTemplateNote(
      result?.ok
        ? t('monitor.jobs.template.movedAside', { path: result.path })
        : result?.reason ?? null
    )
    if (result?.ok) await loadTemplates()
  }

  const openId = useRef<string | null>(null)
  const sampled = useFleet((s) => s.hosts)

  const bridge = (): NonNullable<typeof window.opsmaxx>['jobs'] | undefined =>
    window.opsmaxx?.jobs

  const refresh = useCallback(async (): Promise<void> => {
    const b = bridge()
    if (!b?.list) {
      setError(t('monitor.jobs.noPreload'))
      setJobs([])
      return
    }
    try {
      setJobs(await b.list(50))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [t])

  const open = useCallback(async (id: string): Promise<void> => {
    const b = bridge()
    if (!b?.get) return
    openId.current = id
    setOutput({})
    setDetail(await b.get(id))
  }, [])

  // Live, because a job the operator is watching is the only reason to be on
  // this panel while one is running. Both channels: progress carries state and
  // must never be dropped behind a burst of apt chatter, which is why output is
  // a separate one.
  useEffect(() => {
    const b = bridge()
    if (!b?.onProgress) return
    const offP = b.onProgress((p: JobProgress) => {
      if (p.job) {
        setJobs((cur) => (cur ? cur.map((j) => (j.id === p.job!.id ? p.job! : j)) : cur))
      }
      if (p.jobId !== openId.current) return
      setDetail((cur) => {
        if (!cur) return cur
        const next: JobDetail = { ...cur, ...(p.job ?? {}) }
        if (p.host) {
          const host = p.host as JobHostResult
          next.targets = cur.targets.map((x) => (x.serverId === host.serverId ? host : x))
        }
        return next
      })
    })
    const offO = b.onOutput?.((o) => {
      if (o.jobId !== openId.current) return
      setOutput((cur) => ({
        ...cur,
        // The dropped count is said out loud, never silently swallowed: a gap
        // nobody mentions is how somebody concludes the upgrade hung.
        [o.serverId]:
          (cur[o.serverId] ?? '') +
          (o.dropped ? `\n${t('monitor.jobs.outputDropped', { count: o.dropped })}\n` : '') +
          o.text
      }))
    })
    return () => {
      offP?.()
      offO?.()
    }
  }, [t])

  // The units the PICKED servers have actually reported, and `undefined` when
  // none of them has reported any. Absent is not empty: a server whose facts
  // have never been collected must not make every unit name look misspelt.
  const knownUnits = ((): string[] | undefined => {
    const names = new Set<string>()
    let anyKnown = false
    for (const id of picked) {
      // `null` is not `[]`. A server with no systemd, or one whose probe has
      // not run, reports null -- and treating that as "this server runs no
      // units" would make every correctly spelled unit name look misspelt.
      const units = sampled[id]?.services
      if (!units) continue
      anyKnown = true
      for (const u of units) names.add(u.name)
    }
    return anyKnown ? [...names] : undefined
  })()

  const serviceCheck = checkServiceStep(action, unit, knownUnits)
  const packageCheck = checkPackageStep(manager, pkgAction, pkgNames.split(/[\s,]+/))
  const userInput = {
    action: userAction,
    user: userName,
    group: userGroup,
    expiry: userExpiry,
    removeHome
  }
  const fileCheck = checkFilePush(filePath, fileBody)
  const typedCheck =
    mode === 'service'
      ? serviceCheck
      : mode === 'package'
        ? packageCheck
        : mode === 'file'
          ? fileSha === ''
            ? ({ ok: false, reason: t('monitor.jobs.check.checksumPending') } as const)
            : fileCheck
          : checkUserStep(userInput)
  const check =
    mode === 'command'
      ? checkJobDraft(draft, picked.length)
      : picked.length === 0
        ? ({ ok: false, reason: t('monitor.jobs.check.pickServer') } as const)
        : typedCheck

  const review = (): void => {
    if (!check.ok) return
    const chosen = servers.filter((s) => picked.includes(s.id))
    const targets = assignWaves(
      chosen.map((s) => ({ serverId: s.id, serverName: s.name })),
      draft.waveSize
    )
    const spec =
      mode === 'service'
        ? serviceJobSpec(action, unit, { sudo })
        : mode === 'package'
          ? packageJobSpec(manager, pkgAction, pkgNames.split(/[\s,]+/), { sudo })
          : mode === 'user'
            ? userJobSpec(userInput, { sudo })
            : mode === 'file'
              ? filePushJobSpec(filePath, fileBody, fileSha, {
                  sudo,
                  // Always a NEW file from this panel. Replacing one needs the
                  // sha256 of what is there, which needs a per-server read
                  // first -- and a job is one command for every server, so
                  // "what is there" is not one answer. That read is the rest
                  // of item 34c.
                  expectedBefore: null,
                  mode: fileMode,
                  after: fileAfter
                })
              : composeJobSpec(draft)
    setPhrase('')
    setPending({ spec, targets, plan: planJob(spec, targets) })
  }

  /**
   * Compose the rollback as its own job, and put it through the same dialog.
   *
   * NOT a resume and not a special execution path: it becomes an ordinary job
   * whose steps are the rollback steps, so `planJob` grades it on what it
   * actually does. Undoing a `start` with a `stop` is still a stop, and it gets
   * the confirmation a stop deserves rather than the one the forward job got.
   */
  const rollBack = (j: JobRecord): void => {
    if (!j.spec.rollback || j.spec.rollback.length === 0 || servers.length === 0) return
    const chosen = servers.filter((s) => picked.includes(s.id))
    const targets = assignWaves(
      (chosen.length > 0 ? chosen : servers).map((s) => ({ serverId: s.id, serverName: s.name })),
      0
    )
    const spec = {
      kind: 'command' as const,
      title: `Roll back — ${j.title}`,
      steps: j.spec.rollback
    }
    setPhrase('')
    setComposing(false)
    setPending({ spec, targets, plan: planJob(spec, targets) })
  }

  const start = async (): Promise<void> => {
    if (!pending) return
    const b = bridge()
    if (!b?.run) return
    const { spec, targets, plan } = pending
    // Minted at the moment the dialog is satisfied, over THIS spec and THIS
    // target list. Main re-derives the same plan and refuses the run if the
    // record disagrees.
    const approval = jobApprovalFor(spec, targets, {
      phrase: plan.confirmation.kind === 'type-to-confirm' ? phrase.trim() : null,
      confirmedAt: Date.now()
    })
    setPending(null)
    setComposing(false)
    try {
      const started = await b.run({
        jobId: crypto.randomUUID(),
        spec,
        approval,
        targets: targets.map((tg) => {
          const s = servers.find((x) => x.id === tg.serverId)!
          return {
            serverId: tg.serverId,
            serverName: tg.serverName,
            cohort: tg.cohort,
            cfg: {
              sessionId: `job-${tg.serverId}`,
              cols: 80,
              rows: 24,
              serverId: s.id,
              host: s.host,
              port: s.port,
              username: s.username,
              auth: s.auth === 'password' || s.auth === 'agent' ? s.auth : 'key',
              hops: sshHopsFor(s)
            }
          }
        })
      })
      setDraft(EMPTY_JOB_DRAFT)
      setPicked([])
      await refresh()
      if (started?.id) await open(started.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const canRun =
    pending !== null &&
    (pending.plan.confirmation.kind !== 'type-to-confirm' ||
      phrase.trim() === pending.plan.confirmation.phrase)

  return (
    // `.panel-title` over `.panel-subtitle` again — see ServicesPanel for what
    // that pair actually rendered. "New job" keeps the solid accent as this
    // view's one primary action; refresh drops to a ghost beside it.
    <PanelShell
      icon={<ListChecks size={14} />}
      title={t('monitor.jobs.title')}
      about={<p>{t('monitor.jobs.about')}</p>}
      actions={
        <>
          <button className="btn ghost sm" onClick={() => void refresh()}>
            <RefreshCw size={13} /> {jobs ? t('common.refresh') : t('monitor.jobs.readJobs')}
          </button>
          <button
            className="btn primary sm"
            disabled={servers.length === 0}
            onClick={() => {
              setComposing((c) => !c)
              setPending(null)
            }}
          >
            <Plus size={13} /> {t('monitor.jobs.newJob')}
          </button>
        </>
      }
    >

      {error && <div className="panel-note is-alarm">{error}</div>}
      {/* Named, not retried — a job carries an approval minted for ONE run and
          re-verified in main, so a second execution earns a second
          confirmation. See the note on VaultLockedHosts. */}
      <VaultLockedHosts
        names={(detail?.targets ?? [])
          .filter((x) => isVaultLocked(x.error))
          .map((x) => x.serverName)}
        reason={t('monitor.jobs.vaultLockedReason')}
      />

      {composing && pending === null && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          {/* Item 34a. A typed step is an action and a unit, checked before
              any command exists; a free-text step is a line somebody typed and
              says so. */}
          <div className="row-actions">
            <button
              className={clsx('btn sm', mode === 'command' && 'primary')}
              aria-pressed={mode === 'command'}
              onClick={() => setMode('command')}
            >
              {t('monitor.jobs.mode.command')}
            </button>
            <button
              className={clsx('btn sm', mode === 'service' && 'primary')}
              aria-pressed={mode === 'service'}
              onClick={() => setMode('service')}
            >
              {t('monitor.jobs.mode.service')}
            </button>
            <button
              className={clsx('btn sm', mode === 'package' && 'primary')}
              aria-pressed={mode === 'package'}
              onClick={() => setMode('package')}
            >
              {t('monitor.jobs.mode.package')}
            </button>
            <button
              className={clsx('btn sm', mode === 'user' && 'primary')}
              aria-pressed={mode === 'user'}
              onClick={() => setMode('user')}
            >
              {t('monitor.jobs.mode.user')}
            </button>
            <button
              className={clsx('btn sm', mode === 'file' && 'primary')}
              aria-pressed={mode === 'file'}
              onClick={() => setMode('file')}
            >
              {t('monitor.jobs.mode.file')}
            </button>
          </div>

          {mode === 'file' ? (
            <>
              <div className="row-actions" style={{ gap: 6 }}>
                <input
                  className="input mono"
                  aria-label={t('monitor.jobs.file.pathAria')}
                  placeholder="/etc/myapp/config.toml"
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                />
                <input
                  className="input mono"
                  aria-label={t('monitor.jobs.file.modeAria')}
                  style={{ width: 80 }}
                  value={fileMode}
                  onChange={(e) => setFileMode(e.target.value)}
                />
              </div>
              <textarea
                className="input mono"
                aria-label={t('monitor.jobs.file.contentsAria')}
                rows={6}
                placeholder={t('monitor.jobs.file.contentsPlaceholder')}
                value={fileBody}
                onChange={(e) => setFileBody(e.target.value)}
              />
              <input
                className="input mono"
                aria-label={t('monitor.jobs.file.afterAria')}
                placeholder={t('monitor.jobs.file.afterPlaceholder', {
                  example: 'nginx -t && systemctl reload nginx'
                })}
                value={fileAfter}
                onChange={(e) => setFileAfter(e.target.value)}
              />
              <label className="r-sub">
                <input
                  type="checkbox"
                  aria-label={t('monitor.jobs.sudoAria')}
                  checked={sudo}
                  onChange={(e) => setSudo(e.target.checked)}
                />{' '}
                <Trans i18nKey="monitor.jobs.sudoLabel" components={{ code: <code /> }} />
              </label>
              {/* The hash is shown because it is what the server checks the
                  arriving bytes against, and what the approval covers. */}
              <div className="r-sub faint mono">
                sha256 {fileSha === '' ? '…' : fileSha}
              </div>
              <div className="r-sub faint">{t('monitor.jobs.file.note')}</div>
            </>
          ) : mode === 'user' ? (
            <>
              <div className="row-actions" style={{ gap: 6 }}>
                <select
                  className="input"
                  aria-label={t('monitor.jobs.user.actionAria')}
                  value={userAction}
                  onChange={(e) => setUserAction(e.target.value as UserAction)}
                >
                  {USER_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <input
                  className="input mono"
                  aria-label={t('monitor.jobs.user.accountAria')}
                  placeholder="deploy"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                />
                {userAction === 'add-group' && (
                  <input
                    className="input mono"
                    aria-label={t('monitor.jobs.user.groupAria')}
                    placeholder="docker"
                    value={userGroup}
                    onChange={(e) => setUserGroup(e.target.value)}
                  />
                )}
                {userAction === 'set-expiry' && (
                  <input
                    className="input mono"
                    aria-label={t('monitor.jobs.user.expiryAria')}
                    placeholder={t('monitor.jobs.user.expiryPlaceholder')}
                    value={userExpiry}
                    onChange={(e) => setUserExpiry(e.target.value)}
                  />
                )}
              </div>
              {userAction === 'delete' && (
                <label className="r-sub">
                  <input
                    type="checkbox"
                    aria-label={t('monitor.jobs.user.removeHomeAria')}
                    checked={removeHome}
                    onChange={(e) => setRemoveHome(e.target.checked)}
                  />{' '}
                  {t('monitor.jobs.user.removeHome')}
                </label>
              )}
              <label className="r-sub">
                <input
                  type="checkbox"
                  aria-label={t('monitor.jobs.sudoAria')}
                  checked={sudo}
                  onChange={(e) => setSudo(e.target.checked)}
                />{' '}
                <Trans i18nKey="monitor.jobs.sudoLabel" components={{ code: <code /> }} />
              </label>
              {/* Said where somebody would go looking for the field. */}
              <div className="r-sub faint">{t('monitor.jobs.user.note')}</div>
            </>
          ) : mode === 'package' ? (
            <>
              <div className="row-actions" style={{ gap: 6 }}>
                <select
                  className="input"
                  aria-label={t('monitor.jobs.package.actionAria')}
                  value={pkgAction}
                  onChange={(e) => setPkgAction(e.target.value as PackageAction)}
                >
                  {PACKAGE_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  aria-label={t('monitor.jobs.package.managerAria')}
                  value={manager}
                  onChange={(e) => setManager(e.target.value as PackageManager)}
                >
                  {PACKAGE_MANAGERS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <input
                  className="input mono"
                  aria-label={t('monitor.jobs.package.namesAria')}
                  placeholder="nginx openssl"
                  value={pkgNames}
                  onChange={(e) => setPkgNames(e.target.value)}
                />
              </div>
              <label className="r-sub">
                <input
                  type="checkbox"
                  aria-label={t('monitor.jobs.sudoAria')}
                  checked={sudo}
                  onChange={(e) => setSudo(e.target.checked)}
                />{' '}
                <Trans i18nKey="monitor.jobs.sudoLabel" components={{ code: <code /> }} />
              </label>
              {/* Chosen once for the whole job, and said so: a server running a
                  different manager is not a target for this job, because the
                  approval covers this exact command text. */}
              <div className="r-sub faint">
                <Trans
                  i18nKey="monitor.jobs.package.note"
                  values={{ manager }}
                  components={{ b: <b /> }}
                />
              </div>
            </>
          ) : mode === 'service' ? (
            <>
              <div className="row-actions" style={{ gap: 6 }}>
                <select
                  className="input"
                  aria-label={t('monitor.jobs.service.actionAria')}
                  value={action}
                  onChange={(e) => setAction(e.target.value as ServiceAction)}
                >
                  {SERVICE_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <input
                  className="input mono"
                  aria-label={t('monitor.jobs.service.unitAria')}
                  placeholder="nginx"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                />
              </div>
              <label className="r-sub">
                <input
                  type="checkbox"
                  aria-label={t('monitor.jobs.sudoAria')}
                  checked={sudo}
                  onChange={(e) => setSudo(e.target.checked)}
                />{' '}
                <Trans i18nKey="monitor.jobs.sudoLabel" components={{ code: <code /> }} />
              </label>
              <div className="r-sub faint">
                {knownUnits === undefined
                  ? t('monitor.jobs.service.unitsUnknown')
                  : t('monitor.jobs.service.unitsChecked', { count: knownUnits.length })}
              </div>
            </>
          ) : (
            <>
              {/* Saved templates. Loading one fills the text below and stops:
                  the servers are still picked here, and the confirmation is
                  still whatever planJob asks for once they are. */}
              <div className="row-actions" style={{ gap: 6, flexWrap: 'wrap' }}>
                <select
                  className="input"
                  aria-label={t('monitor.jobs.template.pickerAria')}
                  value={templateId}
                  onChange={(e) => {
                    const tpl = templates.find((x) => x.id === e.target.value)
                    setTemplateId(tpl?.id ?? '')
                    setTemplateName(tpl?.name ?? '')
                    setConfirmDelete(false)
                    if (tpl) setDraft((d) => draftFromTemplate(tpl, d))
                  }}
                >
                  <option value="">{t('monitor.jobs.template.load')}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm"
                  onClick={() => {
                    // A second template under a name already in the list is
                    // two rows nobody can tell apart in the picker, so a taken
                    // name asks to replace that one instead. Declining leaves
                    // both as they were: pick a different title.
                    const name = normaliseTemplateName(draft.title)
                    const taken = templates.find((x) => x.name === name)
                    if (taken) setReplacing(taken)
                    else void storeTemplate(templateFromDraft(draft, crypto.randomUUID(), draft.title))
                  }}
                >
                  {t('monitor.jobs.template.save')}
                </button>
                {chosenTemplate && (
                  <>
                    <input
                      className="input"
                      aria-label={t('monitor.jobs.template.nameAria')}
                      style={{ width: 180 }}
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                    />
                    <button
                      className="btn sm"
                      disabled={templateName.trim() === chosenTemplate.name}
                      onClick={() => void storeTemplate({ ...chosenTemplate, name: templateName })}
                    >
                      {t('monitor.jobs.template.rename')}
                    </button>
                    <button className="btn sm" onClick={() => void deleteTemplate()}>
                      {confirmDelete ? t('monitor.jobs.template.confirmDelete') : t('common.delete')}
                    </button>
                  </>
                )}
              </div>
              {templateFile && (
                <div className="s-note state-unknown">
                  <Trans
                    i18nKey="monitor.jobs.template.fileProblem"
                    values={{ problem: templateFile.problem, path: templateFile.path }}
                    components={{ path: <span className="mono selectable" /> }}
                  />{' '}
                  <button className="btn sm" onClick={() => void setAsideTemplates()}>
                    {t('monitor.jobs.template.setAside')}
                  </button>
                </div>
              )}
              {templateNote && <div className="s-note state-unknown">{templateNote}</div>}
              {replacing && (
                <Modal
                  title={t('monitor.jobs.template.replaceTitle', { name: replacing.name })}
                  subtitle={t('monitor.jobs.template.replaceSubtitle')}
                  onClose={() => setReplacing(null)}
                  confirm={{
                    label: t('monitor.jobs.template.replace'),
                    onClick: () => {
                      // Same id: updated in place, so it stays one row.
                      void storeTemplate(templateFromDraft(draft, replacing.id, replacing.name))
                      setReplacing(null)
                    }
                  }}
                >
                  <p className="r-sub">{t('monitor.jobs.template.replaceBody')}</p>
                </Modal>
              )}
              <input
                className="input"
                aria-label={t('monitor.jobs.draft.titleAria')}
                placeholder={t('monitor.jobs.draft.titlePlaceholder')}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <textarea
                className="input mono"
                aria-label={t('monitor.jobs.draft.stepsAria')}
                rows={5}
                placeholder={t('monitor.jobs.draft.stepsPlaceholder')}
                value={draft.steps}
                onChange={(e) => setDraft({ ...draft, steps: e.target.value })}
              />
              {/* Item 44. Written down NOW, because now is the only moment
                  anybody knows how to undo this. It is approved with the job
                  -- it is inside the approval record -- and it never runs on
                  its own: not on a gate halt, not on a failure. */}
              <textarea
                className="input mono"
                aria-label={t('monitor.jobs.draft.rollbackAria')}
                rows={3}
                placeholder={t('monitor.jobs.draft.rollbackPlaceholder')}
                value={draft.rollback}
                onChange={(e) => setDraft({ ...draft, rollback: e.target.value })}
              />
            </>
          )}

          <div className="r-sub faint">
            {t('monitor.jobs.draft.serversPicked', { picked: picked.length, total: servers.length })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {servers.map((s) => (
              <button
                key={s.id}
                className={clsx('btn sm', picked.includes(s.id) && 'primary')}
                aria-pressed={picked.includes(s.id)}
                onClick={() =>
                  setPicked((cur) =>
                    cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id]
                  )
                }
              >
                {s.name}
              </button>
            ))}
          </div>

          <div className="row-actions" style={{ gap: 10, flexWrap: 'wrap' }}>
            <label className="r-sub">
              {t('monitor.jobs.draft.waveSize')}{' '}
              <input
                className="input"
                type="number"
                min={0}
                aria-label={t('monitor.jobs.draft.waveSize')}
                style={{ width: 70 }}
                value={draft.waveSize}
                onChange={(e) => setDraft({ ...draft, waveSize: Number(e.target.value) || 0 })}
              />
            </label>
            <label className="r-sub">
              <input
                type="checkbox"
                aria-label={t('monitor.jobs.draft.gateAria')}
                checked={draft.gate}
                onChange={(e) => setDraft({ ...draft, gate: e.target.checked })}
              />{' '}
              {t('monitor.jobs.draft.gate')}
            </label>
            <label className="r-sub">
              <input
                type="checkbox"
                aria-label={t('monitor.jobs.draft.rebootLast')}
                checked={draft.rebootLast}
                onChange={(e) => setDraft({ ...draft, rebootLast: e.target.checked })}
              />{' '}
              {t('monitor.jobs.draft.rebootLast')}
            </label>
          </div>

          {/* The reason, not a grey button. A control disabled without a
              sentence is a bug report. */}
          {!check.ok && <div className="s-note state-unknown">{check.reason}</div>}

          <div className="row-actions">
            <button className="btn primary" disabled={!check.ok} onClick={review}>
              {t('monitor.jobs.draft.review')}
            </button>
            <button className="btn" onClick={() => setComposing(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {pending !== null && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="r-title">{pending.spec.title}</div>
          <div className="r-sub">
            {t('monitor.jobs.review.scope', {
              count: pending.plan.totalHosts,
              blast: pending.plan.blastRadius
            })}{' '}
            {pending.spec.gate === 'health'
              ? t('monitor.jobs.review.gateHealth')
              : t('monitor.jobs.review.gateNone')}
          </div>
          {pending.plan.reasons.length > 0 && (
            <div className="s-note warn">
              {t('monitor.jobs.review.reasons', { reasons: pending.plan.reasons.join(', and ') })}
            </div>
          )}
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {pending.spec.steps
              .map((s) => `${s.command}${s.reboot ? `   ${t('monitor.jobs.review.rebootComment')}` : ''}`)
              .join('\n')}
          </pre>
          {pending.spec.rollback && (
            <div className="s-note">
              {t('monitor.jobs.review.rollback')}
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {pending.spec.rollback.map((st) => st.command).join('\n')}
              </pre>
            </div>
          )}
          <div className="r-sub faint mono">
            {pending.targets.map((tg) => `${tg.serverName} (${tg.cohort})`).join('  ')}
          </div>
          {pending.plan.confirmation.kind === 'type-to-confirm' && (
            <input
              className="input mono"
              aria-label={t('monitor.jobs.review.typeToConfirm', {
                phrase: pending.plan.confirmation.phrase
              })}
              placeholder={t('monitor.jobs.review.typeToConfirm', {
                phrase: pending.plan.confirmation.phrase
              })}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
          )}
          <div className="row-actions">
            <button className="btn primary" disabled={!canRun} onClick={() => void start()}>
              {t('monitor.jobs.review.run')}
            </button>
            <button className="btn" onClick={() => setPending(null)}>
              {t('common.back')}
            </button>
          </div>
        </div>
      )}

      {jobs === null ? (
        <div className="panel-empty">
          <p className="panel-empty-title">{t('monitor.jobs.empty.unreadTitle')}</p>
          <p className="panel-empty-body">
            <Trans
              i18nKey="monitor.jobs.empty.unreadBody"
              values={{ read: t('monitor.jobs.readJobs'), create: t('monitor.jobs.newJob') }}
              components={{ b: <b /> }}
            />
          </p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="panel-empty">
          <p className="panel-empty-title">{t('monitor.jobs.empty.noneTitle')}</p>
          <p className="panel-empty-body">{t('monitor.jobs.empty.noneBody')}</p>
        </div>
      ) : (
        jobs.map((j) => (
          <div key={j.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="cron-row">
              <button className="btn ghost sm" onClick={() => void open(j.id)}>
                {detail?.id === j.id ? '▾' : '▸'} {j.title}
              </button>
              <span className={clsx('faint cron-desc', STATE_CLASS[j.state])}>
                {t(STATE_LABEL[j.state])}
              </span>
              <span className="grow" />
              <span className="faint mono">
                {j.risk}
              </span>
              {(j.state === 'running' || j.state === 'queued') && (
                <button
                  className="icon-btn sm"
                  title={t('monitor.jobs.list.stopTitle')}
                  onClick={() => void bridge()?.cancel?.(j.id)}
                >
                  <Square size={12} />
                </button>
              )}
              {/* A SECOND blast radius, so a second confirmation, graded on
                  the rollback's own commands rather than on the job's. Offered
                  only once the job has stopped: rolling back underneath a run
                  that is still going is two jobs racing on one server. */}
              {j.spec.rollback && j.state !== 'running' && j.state !== 'queued' && (
                <button
                  className="btn ghost sm"
                  title={t('monitor.jobs.list.rollBackTitle', { title: j.title })}
                  onClick={() => rollBack(j)}
                >
                  <Undo2 size={12} /> {t('monitor.jobs.list.rollBack')}
                </button>
              )}
            </div>
            {detail?.id === j.id && (
              <div style={{ paddingLeft: 12 }}>
                <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>
                  {j.spec.steps.map((s) => s.command).join('\n')}
                </pre>
                {detail.targets.map((h) => (
                  <div key={h.serverId}>
                    <div className="r-sub">
                      <b>{h.serverName}</b>{' '}
                      <span className={clsx(h.state === 'failed' && 'danger')}>
                        {t(HOST_STATE_LABEL[h.state])}
                      </span>
                      {h.degraded && (
                        // Per host, and surfaced: an estate where one appliance
                        // cannot detach is an estate where fourteen servers
                        // survive the lid closing and one does not.
                        <span className="warn"> · {h.degraded}</span>
                      )}
                    </div>
                    {(output[h.serverId] || h.stdout || h.stderr) && (
                      <pre
                        className="mono"
                        style={{ whiteSpace: 'pre-wrap', margin: 0, opacity: 0.85 }}
                      >
                        {output[h.serverId] ?? `${h.stdout ?? ''}${h.stderr ?? ''}`}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </PanelShell>
  )
}
