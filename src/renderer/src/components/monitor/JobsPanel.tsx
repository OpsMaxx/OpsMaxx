import { useCallback, useEffect, useRef, useState } from 'react'
import { ListChecks, Plus, RefreshCw, Square, Undo2 } from 'lucide-react'
import { clsx } from '../../lib/format'
import { sshHopsFor } from '../../lib/ssh'
import {
  assignWaves,
  checkJobDraft,
  composeJobSpec,
  EMPTY_JOB_DRAFT,
  type JobDraft
} from '../../../../shared/jobCompose'
import {
  checkServiceStep,
  serviceJobSpec,
  SERVICE_ACTIONS,
  type ServiceAction
} from '../../../../shared/serviceStep'
import { jobApprovalFor, planJob } from '../../../../shared/jobs'
import { useFleet } from '../../store/fleet'
import type { JobDetail, JobHostResult, JobProgress, JobRecord } from '../../../../shared/jobs'
import type { Server } from '../../types'

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
}

const STATE_CLASS: Record<string, string> = {
  running: 'warn',
  queued: 'faint',
  done: 'ok',
  cancelled: 'faint',
  abandoned: 'danger',
  halted: 'danger'
}

export function JobsPanel({ servers }: Props): React.JSX.Element {
  // `null` until asked, never `[]`. An empty list drawn before the question is
  // "you have never run a job", which is a different sentence.
  const [jobs, setJobs] = useState<JobRecord[] | null>(null)
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [output, setOutput] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState<JobDraft>(EMPTY_JOB_DRAFT)
  const [picked, setPicked] = useState<string[]>([])
  const [pending, setPending] = useState<{
    spec: ReturnType<typeof composeJobSpec>
    targets: { serverId: string; serverName: string; cohort: string }[]
    plan: ReturnType<typeof planJob>
  } | null>(null)
  const [phrase, setPhrase] = useState('')
  // Item 34a. A free-text step is a line somebody typed; a typed step is an
  // action and a unit, checked before the command exists.
  const [mode, setMode] = useState<'command' | 'service'>('command')
  const [action, setAction] = useState<ServiceAction>('restart')
  const [unit, setUnit] = useState('')
  const [sudo, setSudo] = useState(true)
  const openId = useRef<string | null>(null)
  const sampled = useFleet((s) => s.hosts)

  const bridge = (): NonNullable<typeof window.opsmaxx>['jobs'] | undefined =>
    window.opsmaxx?.jobs

  const refresh = useCallback(async (): Promise<void> => {
    const b = bridge()
    if (!b?.list) {
      setError('This build’s preload does not expose jobs yet. Restart the app to rebuild it.')
      setJobs([])
      return
    }
    try {
      setJobs(await b.list(50))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

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
          next.targets = cur.targets.map((t) => (t.serverId === host.serverId ? host : t))
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
          (o.dropped ? `\n… ${o.dropped} chunk(s) dropped by the rate limiter …\n` : '') +
          o.text
      }))
    })
    return () => {
      offP?.()
      offO?.()
    }
  }, [])

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
  const check =
    mode === 'service'
      ? picked.length === 0
        ? ({ ok: false, reason: 'Pick at least one server.' } as const)
        : serviceCheck
      : checkJobDraft(draft, picked.length)

  const review = (): void => {
    if (!check.ok) return
    const chosen = servers.filter((s) => picked.includes(s.id))
    const targets = assignWaves(
      chosen.map((s) => ({ serverId: s.id, serverName: s.name })),
      draft.waveSize
    )
    const spec = mode === 'service' ? serviceJobSpec(action, unit, { sudo }) : composeJobSpec(draft)
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
        targets: targets.map((t) => {
          const s = servers.find((x) => x.id === t.serverId)!
          return {
            serverId: t.serverId,
            serverName: t.serverName,
            cohort: t.cohort,
            cfg: {
              sessionId: `job-${t.serverId}`,
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
    <div className="panel-body">
      <div className="panel-head">
        <div>
          <div className="panel-title">
            <ListChecks size={14} /> Jobs
          </div>
          <div className="panel-subtitle">
            A job is a list of commands, a list of servers, and the confirmation its own risk
            demands — asked before anything runs and recorded with the answer.
          </div>
        </div>
        <button className="btn" onClick={() => void refresh()}>
          <RefreshCw size={13} /> {jobs ? 'Refresh' : 'Read jobs'}
        </button>
        <button
          className="btn primary"
          disabled={servers.length === 0}
          onClick={() => {
            setComposing((c) => !c)
            setPending(null)
          }}
        >
          <Plus size={13} /> New job
        </button>
      </div>

      {error && <div className="panel-note is-alarm">{error}</div>}

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
              Commands
            </button>
            <button
              className={clsx('btn sm', mode === 'service' && 'primary')}
              aria-pressed={mode === 'service'}
              onClick={() => setMode('service')}
            >
              Service action
            </button>
          </div>

          {mode === 'service' ? (
            <>
              <div className="row-actions" style={{ gap: 6 }}>
                <select
                  className="input"
                  aria-label="Service action"
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
                  aria-label="Unit"
                  placeholder="nginx"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                />
              </div>
              <label className="r-sub">
                <input
                  type="checkbox"
                  aria-label="Run as root with sudo"
                  checked={sudo}
                  onChange={(e) => setSudo(e.target.checked)}
                />{' '}
                Run as root (<code>sudo -n</code>)
              </label>
              <div className="r-sub faint">
                {knownUnits === undefined
                  ? 'No server in this selection has reported its units, so the name is not checked against anything.'
                  : `Checked against the ${knownUnits.length} unit(s) these servers have reported.`}
              </div>
            </>
          ) : (
            <>
              <input
                className="input"
                aria-label="Job title"
                placeholder="What this job is, in a few words"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <textarea
                className="input mono"
                aria-label="Steps"
                rows={5}
                placeholder={'One command per line.\n# Lines starting with # are notes and are not run.'}
                value={draft.steps}
                onChange={(e) => setDraft({ ...draft, steps: e.target.value })}
              />
              {/* Item 44. Written down NOW, because now is the only moment
                  anybody knows how to undo this. It is approved with the job
                  -- it is inside the approval record -- and it never runs on
                  its own: not on a gate halt, not on a failure. */}
              <textarea
                className="input mono"
                aria-label="Rollback"
                rows={3}
                placeholder={'How to undo this, one command per line. Optional.\nIt is never run automatically — only when you press Roll back and confirm again.'}
                value={draft.rollback}
                onChange={(e) => setDraft({ ...draft, rollback: e.target.value })}
              />
            </>
          )}

          <div className="r-sub faint">Servers ({picked.length} of {servers.length})</div>
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
              Servers per wave{' '}
              <input
                className="input"
                type="number"
                min={0}
                aria-label="Servers per wave"
                style={{ width: 70 }}
                value={draft.waveSize}
                onChange={(e) => setDraft({ ...draft, waveSize: Number(e.target.value) || 0 })}
              />
            </label>
            <label className="r-sub">
              <input
                type="checkbox"
                aria-label="Hold each wave until the previous one is healthy"
                checked={draft.gate}
                onChange={(e) => setDraft({ ...draft, gate: e.target.checked })}
              />{' '}
              Hold each wave until the last one is healthy
            </label>
            <label className="r-sub">
              <input
                type="checkbox"
                aria-label="The last step restarts the machine"
                checked={draft.rebootLast}
                onChange={(e) => setDraft({ ...draft, rebootLast: e.target.checked })}
              />{' '}
              The last step restarts the machine
            </label>
          </div>

          {/* The reason, not a grey button. A control disabled without a
              sentence is a bug report. */}
          {!check.ok && <div className="s-note state-unknown">{check.reason}</div>}

          <div className="row-actions">
            <button className="btn primary" disabled={!check.ok} onClick={review}>
              Review
            </button>
            <button className="btn" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending !== null && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="r-title">{pending.spec.title}</div>
          <div className="r-sub">
            {pending.plan.totalHosts} server(s), {pending.plan.blastRadius} at once.{' '}
            {pending.spec.gate === 'health'
              ? 'Each wave waits for the last one to report healthy.'
              : 'Waves run in order and nothing is checked between them.'}
          </div>
          {pending.plan.reasons.length > 0 && (
            <div className="s-note warn">This job {pending.plan.reasons.join(', and ')}.</div>
          )}
          <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
            {pending.spec.steps
              .map((s) => `${s.command}${s.reboot ? '   # declared: restarts the machine' : ''}`)
              .join('\n')}
          </pre>
          {pending.spec.rollback && (
            <div className="s-note">
              Rollback, approved with this job and run only if you ask for it:
              <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
                {pending.spec.rollback.map((st) => st.command).join('\n')}
              </pre>
            </div>
          )}
          <div className="r-sub faint mono">
            {pending.targets.map((t) => `${t.serverName} (${t.cohort})`).join('  ')}
          </div>
          {pending.plan.confirmation.kind === 'type-to-confirm' && (
            <input
              className="input mono"
              aria-label={`Type ${pending.plan.confirmation.phrase} to confirm`}
              placeholder={`Type ${pending.plan.confirmation.phrase} to confirm`}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
          )}
          <div className="row-actions">
            <button className="btn primary" disabled={!canRun} onClick={() => void start()}>
              Run
            </button>
            <button className="btn" onClick={() => setPending(null)}>
              Back
            </button>
          </div>
        </div>
      )}

      {jobs === null ? (
        <div className="panel-empty">
          <p className="panel-empty-title">Nothing read yet.</p>
          <p className="panel-empty-body">
            Press <b>Read jobs</b> to list what has run, or <b>New job</b> to compose one.
          </p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="panel-empty">
          <p className="panel-empty-title">No jobs have run.</p>
          <p className="panel-empty-body">
            A job is a list of commands run across servers you pick, in waves, with the answer to
            its confirmation recorded before anything starts.
          </p>
        </div>
      ) : (
        jobs.map((j) => (
          <div key={j.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="cron-row">
              <button className="btn ghost sm" onClick={() => void open(j.id)}>
                {detail?.id === j.id ? '▾' : '▸'} {j.title}
              </button>
              <span className={clsx('faint cron-desc', STATE_CLASS[j.state])}>{j.state}</span>
              <span className="grow" />
              <span className="faint mono" style={{ fontSize: 11 }}>
                {j.risk}
              </span>
              {(j.state === 'running' || j.state === 'queued') && (
                <button
                  className="icon-btn sm"
                  title="Stop this job. Servers that have not started will not start."
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
                  title={`Run the rollback that was approved with ${j.title}. It asks again.`}
                  onClick={() => rollBack(j)}
                >
                  <Undo2 size={12} /> Roll back
                </button>
              )}
            </div>
            {detail?.id === j.id && (
              <div style={{ paddingLeft: 12 }}>
                <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0' }}>
                  {j.spec.steps.map((s) => s.command).join('\n')}
                </pre>
                {detail.targets.map((t) => (
                  <div key={t.serverId}>
                    <div className="r-sub">
                      <b>{t.serverName}</b>{' '}
                      <span className={clsx(t.state === 'failed' && 'danger')}>{t.state}</span>
                      {t.degraded && (
                        // Per host, and surfaced: an estate where one appliance
                        // cannot detach is an estate where fourteen servers
                        // survive the lid closing and one does not.
                        <span className="warn"> · {t.degraded}</span>
                      )}
                    </div>
                    {(output[t.serverId] || t.stdout || t.stderr) && (
                      <pre
                        className="mono"
                        style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0, opacity: 0.85 }}
                      >
                        {output[t.serverId] ?? `${t.stdout ?? ''}${t.stderr ?? ''}`}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
