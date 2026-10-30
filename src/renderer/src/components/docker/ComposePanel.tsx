import { useState } from 'react'
import { Download, FileText, Hammer, KeyRound, Layers, Pencil, Play, RefreshCw, RotateCw, TriangleAlert, Undo2 } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'
import { jobApprovalFor, planJob } from '../../../../shared/jobs'
import {
  COMPOSE_REFUSALS,
  lintComposeConfig,
  planComposeServiceRestart,
  type ComposeRestartPlan,
  COMPOSE_FAILURE_HELP,
  composeJobSpec,
  joinComposeState,
  planComposeImageEdit,
  revertDescription,
  validateImageRef,
  type ComposeAction,
  type ComposeBridge,
  type ComposeConfigProbe,
  type ComposeEnvFileSummary,
  type ComposeListProbe,
  type ComposeProjectRef,
  type ComposeProjectView,
  type ComposeServiceRunState
} from '../../../../shared/compose'
import type { DockerContainer } from '../../../../shared/docker'
import { EnvValueWrite } from './EnvValueWrite'
import type { Server } from '../../types'

// Compose, the file half, sitting under the container list that already groups
// by project.
//
// The one thing this panel must never do is put an environment VALUE on screen.
// It cannot: no bridge method returns one. `compose:env-names` runs an awk
// program on the remote host that prints `S NAME` or `E NAME`, so the values
// are gone before the connection sees them, and the config read passes
// `--no-interpolate --no-env-resolution` so the model that comes back holds
// variable names in place of secrets. COMPOSE_ENV_DISCLOSURE is rendered
// verbatim next to the list, because an operator who does not know the
// withholding is deliberate will assume it is a bug and go looking for a
// setting that turns it off.
//
// `down` is not a button here and is not going to be one. COMPOSE_REFUSALS
// carries the reason in words and this panel prints it, which is the shape
// docker.ts already uses for prune: a refusal an operator can read and disagree
// with is better than a dialog that makes the same action feel more serious.
//
// `pull` and `up -d` go through the job engine — `composeJobSpec` produces a
// JobSpec, `jobApprovalFor` mints the record the runner re-checks. There is no
// compose execution path in this file; there is a compose SPEC, handed to the
// engine that already knows how to run one.

function bridge(): Partial<ComposeBridge> | undefined {
  return (window as unknown as { opsmaxx?: { compose?: Partial<ComposeBridge> } }).opsmaxx
    ?.compose
}

function jobsBridge():
  | { run: (req: unknown) => Promise<unknown> }
  | undefined {
  return (
    window as unknown as { opsmaxx?: { jobs?: { run: (req: unknown) => Promise<unknown> } } }
  ).opsmaxx?.jobs
}

const STATE_TONE: Record<ComposeServiceRunState, string> = {
  running: 'ok',
  partial: 'warn',
  stopped: 'warn',
  missing: 'danger'
}

const STATE_WORD: Record<ComposeServiceRunState, MessageKey> = {
  running: 'docker.compose.state.running',
  partial: 'docker.compose.state.partial',
  stopped: 'docker.compose.state.stopped',
  // The word this whole panel exists to be able to say. A stopped service has a
  // container in the list above; a missing one has nothing anywhere.
  missing: 'docker.compose.state.missing'
}

export function ComposePanel({
  server,
  cfg,
  containers,
  sudo
}: {
  server: Server | undefined
  cfg: unknown
  containers: DockerContainer[]
  sudo: boolean
}): React.JSX.Element | null {
  const t = useT()
  const [list, setList] = useState<ComposeListProbe | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [config, setConfig] = useState<ComposeConfigProbe | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [envFiles, setEnvFiles] = useState<ComposeEnvFileSummary[] | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ service: string; from: string; to: string } | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editDone, setEditDone] = useState<string | null>(null)
  // What a revert is about to do, in the app's own words. Held beside the edit
  // form rather than replacing it, because a revert IS an edit here: the same
  // form, the same confirm and the same write, pre-filled with the previous
  // tag. A second write path in the UI would be a second set of rules.
  const [revertNote, setRevertNote] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)
  const [launched, setLaunched] = useState<string | null>(null)
  // A job that asks for confirmation gets asked. Held here between the plan
  // and the run, because those were one step and the phrase was filled in by
  // the panel on the operator's behalf.
  const [pending, setPending] = useState<{
    plan: ReturnType<typeof composeJobSpec>
    targets: { serverId: string; serverName: string }[]
    confirmation: ReturnType<typeof planJob>['confirmation']
    reasons: string[]
  } | null>(null)
  const [phrase, setPhrase] = useState('')
  // Which services the next pull/up applies to, for the project that is open.
  //
  // The builder has accepted and validated a `services` list since it was
  // written and nothing ever passed one, so `pull` on a twelve-service project
  // pulled twelve images to update one. Empty means every service, which is
  // what compose itself means by no argument.
  const [picked, setPicked] = useState<string[]>([])
  // Restarting ONE service, which is a container action and not a compose verb.
  // See planComposeServiceRestart: `docker compose restart` does not apply an
  // edited file, and the containers are what actually get restarted, so they
  // are what the dialog names.
  const [restart, setRestart] = useState<ComposeRestartPlan | null>(null)
  const [restartPhrase, setRestartPhrase] = useState('')
  const [restartResult, setRestartResult] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  // The panel used to bail here, which hid compose entirely on a target that
  // is not a saved server — even though every READ below runs off `cfg`, which
  // main resolves to this machine perfectly well. The reads stay; only the
  // job-backed actions need a server, and they say so where they are drawn.
  //
  // `cfg` is always present: the parent passes its resolved target.
  const serverBacked = server !== undefined
  /** Why pull/up/build are off when the target is not a saved server. */
  const jobsNeedServer = t('docker.compose.jobsNeedServer')


  /**
   * The container lifecycle bridge, the same one the container panel uses.
   *
   * NOT a compose call. `docker compose restart <svc>` would restart the same
   * containers and name none of them, and it would leave the operator thinking
   * their edited file had been applied. See `planComposeServiceRestart`.
   */
  const runRestart = async (plan: ComposeRestartPlan): Promise<void> => {
    setRestarting(true)
    setRestartResult(null)
    try {
      const act = (
        window.opsmaxx as
          | {
              docker?: {
                act?: (
                  t: unknown,
                  a: string,
                  refs: string[],
                  o: { sudo: boolean }
                ) => Promise<{ ok: boolean; detail?: string }>
              }
            }
          | undefined
      )?.docker?.act
      if (typeof act !== 'function') {
        setRestartResult(t('docker.compose.noActBridge'))
        return
      }
      const r = await act(cfg, 'restart', plan.targets, { sudo })
      setRestartResult(
        r?.ok === true
          ? t('docker.compose.restarted', { targets: plan.targets.join(', ') })
          : (r?.detail ?? t('docker.compose.restartNoSuccess'))
      )
    } catch (e) {
      setRestartResult(e instanceof Error ? e.message : String(e))
    } finally {
      setRestarting(false)
      setRestart(null)
      setRestartPhrase('')
    }
  }

  const projectFor = (name: string): ComposeProjectRef | null => {
    const found = list?.ok ? list.projects.find((p) => p.name === name) : undefined
    if (found && found.configFiles.length > 0) return { name, files: found.configFiles }
    // A project found on disk rather than by the daemon. The directory's
    // basename is what compose itself would call it, but the NAME is passed
    // explicitly all the same — see buildComposeActionCommand.
    const hit = list?.ok ? list.search?.files.find((f) => f.directory.endsWith(`/${name}`)) : undefined
    return hit ? { name, files: [hit.path] } : null
  }

  const load = async (): Promise<void> => {
    setLoading(true)
    setOpen(null)
    setConfig(null)
    setEnvFiles(null)
    setEditing(null)
    setRevertNote(null)
    setEditDone(null)
    setLaunched(null)
    try {
      const r = await bridge()?.list?.(cfg, { sudo })
      // `?? null` swallowed an unwired bridge into "state unchanged": the label
      // stayed on "Find compose files" and not one pixel moved, which is
      // indistinguishable from a dead button. Every sibling read in this panel
      // substitutes a visible sentence instead — see DockerPanel's `loadDisk`.
      setList(
        r ?? {
          ok: false,
          reason: 'unknown',
          detail: t('docker.compose.listNotWired')
        }
      )
    } catch (e) {
      // There was no catch at all, and the handler is `onClick={() => void
      // load()}` — so a rejected invoke became an unhandled rejection while
      // `finally` re-enabled the button, leaving it looking untouched. This
      // read is budgeted at 60 seconds, so "nothing happened" was also what a
      // timeout looked like.
      setList({
        ok: false,
        reason: 'unknown',
        detail: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setLoading(false)
    }
  }

  /** Re-read the env summaries for the paths already on screen.
   *
   *  NAMES ONLY, through the same `envNames` channel as the first read -- a
   *  write does not earn a different, looser read afterwards. What it refreshes
   *  is the `(set)` / `(empty)` marker, which is the only thing about a
   *  variable this panel is ever allowed to know. */
  const reloadEnvNames = async (): Promise<void> => {
    const paths = (envFiles ?? []).map((f) => f.path)
    if (paths.length === 0) return
    const env = await bridge()?.envNames?.(cfg, paths, { sudo })
    if (env?.ok) {
      setEnvFiles(env.files)
      setEnvError(null)
    } else setEnvError(env ? env.detail : t('docker.compose.envUnreadable'))
  }

  const openProject = async (name: string): Promise<void> => {
    if (open === name) {
      setOpen(null)
      setPicked([])
      return
    }
    const ref = projectFor(name)
    setOpen(name)
    // Cleared with the project. A selection carried across would silently name
    // another project's services on the next run.
    setPicked([])
    setConfig(null)
    setEnvFiles(null)
    setEnvError(null)
    setEditing(null)
    setEditDone(null)
    if (ref === null) return
    setConfigLoading(true)
    try {
      const probe = (await bridge()?.config?.(cfg, ref, { sudo })) ?? null
      setConfig(probe)
      // The env files a service declares, by NAME only. Asked for separately so
      // a project with none costs no round trip, and so a refused read here
      // does not take the service list with it.
      const paths = probe?.ok
        ? [...new Set(probe.config.services.flatMap((s) => s.envFiles))].filter((p) =>
            p.startsWith('/')
          )
        : []
      if (paths.length > 0) {
        const env = await bridge()?.envNames?.(cfg, paths, { sudo })
        if (env?.ok) setEnvFiles(env.files)
        else setEnvError(env ? env.detail : t('docker.compose.envUnreadable'))
      }
    } finally {
      setConfigLoading(false)
    }
  }

  // THE PANEL USED TO FILL IN ITS OWN CONFIRMATION. It read the phrase the
  // plan asked for straight off the plan, stamped `confirmedAt: Date.now()`
  // and ran -- an approval record that says a human confirmed this, written
  // by the code that wanted to proceed.
  //
  // That was harmless exactly while `confirmationFor(ordinary, 1)` is `none`,
  // which is the case for a plain `compose pull` on one server and is NOT the
  // case with the sudo toggle on: `sudo docker compose up -d` is elevated, and
  // an elevated job on one server asks. It was answering that question itself.
  //
  // Now the plan decides, and anything but `none` stops here and asks. Every
  // compose verb added after this inherits that, because the check is on the
  // plan's own answer rather than on a list of verbs somebody has to remember
  // to extend.
  const runJob = (action: ComposeAction, name: string): void => {
    const ref = projectFor(name)
    if (ref === null || !server) return
    // Only for the project that is open: the picks belong to that list, and
    // sending them with a different project's job would name services it does
    // not have. The builder would refuse, but far too late to be useful.
    const services = open === name ? picked : []
    const plan = composeJobSpec(action, ref, { sudo, services })
    const targets = [{ serverId: server.id, serverName: server.name }]
    const jobPlan = planJob(plan.spec, targets)
    if (jobPlan.confirmation.kind !== 'none') {
      setPhrase('')
      setLaunched(null)
      setPending({ plan, targets, confirmation: jobPlan.confirmation, reasons: jobPlan.reasons })
      return
    }
    void launch(plan, targets, null)
  }

  const launch = async (
    plan: ReturnType<typeof composeJobSpec>,
    targets: { serverId: string; serverName: string }[],
    typed: string | null
  ): Promise<void> => {
    if (!server) return
    // The engine re-derives this same plan from the same spec and refuses the
    // run if the record disagrees, so the phrase carried here has to be the
    // one the operator actually typed.
    const approval = jobApprovalFor(plan.spec, targets, { phrase: typed, confirmedAt: Date.now() })
    setPending(null)
    await jobsBridge()?.run({
      jobId: crypto.randomUUID(),
      spec: plan.spec,
      approval,
      targets: [{ serverId: server.id, serverName: server.name, cfg }]
    })
    setLaunched(t('docker.compose.launched', { title: plan.spec.title }))
  }

  const view: ComposeProjectView | null =
    open !== null && config?.ok ? joinComposeState(open, config.config, containers) : null

  const startEdit = (service: string, from: string): void => {
    setEditError(null)
    setEditDone(null)
    setRevertNote(null)
    setEditing({ service, from, to: from })
  }

  /**
   * Ask the host what this service was pinned to before OpsMaxx last wrote
   * the file, and pre-fill the ordinary edit form with it.
   *
   * The plan comes from main, which reads the backup beside the file. Every
   * refusal is shown as itself: "there is no backup" and "the server did not
   * answer" are different sentences, and only one of them means there is
   * nothing to go back to.
   */
  const startRevert = async (service: string): Promise<void> => {
    if (open === null) return
    const path = projectFor(open)?.files[0]
    if (path === undefined) return
    setEditError(null)
    setEditDone(null)
    setRevertNote(null)
    setReverting(true)
    try {
      const r = await bridge()?.planRevert?.(cfg, { path, service }, { sudo })
      if (r === undefined) {
        setEditError(t('docker.compose.noRevertBridge'))
        return
      }
      if (!r.ok) {
        setEditError(r.reason)
        return
      }
      setEditing({ service, from: r.from, to: r.to })
      setRevertNote(revertDescription(r))
    } finally {
      setReverting(false)
    }
  }

  const commitEdit = async (): Promise<void> => {
    if (editing === null || open === null) return
    const ref = projectFor(open)
    // The tag is edited in the FIRST file, which is the base compose file. An
    // override file that also sets the image would win, and this panel says so
    // rather than editing a line that has no effect.
    const path = ref?.files[0]
    if (path === undefined) return
    setEditError(null)
    const read = await bridge()?.readFile?.(cfg, path, { sudo })
    if (!read?.ok || read.text === undefined) {
      setEditError(read?.error ?? t('docker.compose.fileUnreadable'))
      return
    }
    const plan = planComposeImageEdit(read.text, editing.service, editing.to)
    if (!plan.ok) {
      setEditError(plan.reason)
      return
    }
    const result = await bridge()?.writeImageTag?.(
      cfg,
      {
        path,
        service: editing.service,
        image: editing.to,
        // What the operator is agreeing to, sent so main can refuse if the file
        // moved. Main re-reads and re-plans; this is the comparison, not the edit.
        expect: { line: plan.line, before: plan.before }
      },
      { sudo }
    )
    if (!result?.ok) {
      setEditError(result?.reason ?? t('docker.compose.fileNotWritten'))
      return
    }
    setEditing(null)
    setEditDone(
      t('docker.compose.editDone', {
        service: result.plan.service,
        from: result.plan.from,
        to: result.plan.to,
        line: result.plan.line,
        backup: result.backup
      })
    )
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row muted" style={{ fontSize: 11, alignItems: 'center' }}>
        <Layers size={12} />
        <span className="grow">{t('docker.compose.heading')}</span>
        {/* A spinner, like every other read in this surface. This one searches
            a bounded set of roots with `find` and is budgeted at 60 seconds —
            the longest read in the panel and the only one that gave no sign it
            had started. */}
        <button className="btn ghost sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={12} className={clsx(loading && 'spin')} />{' '}
          {loading ? t('docker.compose.searching') : list === null ? t('docker.compose.find') : t('common.refresh')}
        </button>
      </div>

      {list && !list.ok && (
        <div className="s-desc danger">
          <TriangleAlert size={12} /> {COMPOSE_FAILURE_HELP[list.reason]}
          <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
            {list.detail}
          </div>
        </div>
      )}

      {list?.ok && (
        <>
          {/* "This host runs no compose projects" and "this host could not be
              asked" are different statements, and only one of them is ever
              true. */}
          {list.projectsFrom === 'unavailable' && (
            <div className="s-desc">{COMPOSE_FAILURE_HELP['compose-unavailable']}</div>
          )}

          {list.projects.map((p) => (
            <div key={p.name}>
              <div className="cron-row">
                <button className="btn ghost sm" onClick={() => void openProject(p.name)}>
                  {open === p.name ? '▾' : '▸'} {p.name}
                </button>
                <span className="faint cron-desc mono">{p.status}</span>
                <span className="grow" />
                <button
                  className="icon-btn sm"
                  disabled={!serverBacked}
                  title={
                    !serverBacked
                      ? jobsNeedServer
                      : open === p.name && picked.length > 0
                      ? t('docker.compose.pullPicked', { services: picked.join(', '), project: p.name })
                      : t('docker.compose.pull', { project: p.name })
                  }
                  onClick={() => runJob('pull', p.name)}
                >
                  <Download size={13} />
                </button>
                <button
                  className="icon-btn sm"
                  disabled={!serverBacked}
                  title={
                    !serverBacked
                      ? jobsNeedServer
                      : open === p.name && picked.length > 0
                      ? t('docker.compose.upPicked', { services: picked.join(', '), project: p.name })
                      : t('docker.compose.up', { project: p.name })
                  }
                  onClick={() => runJob('up', p.name)}
                >
                  <Play size={13} />
                </button>
                {/* Only where the file declares something built from source.
                    A build button on a project of pulled images is a button
                    that does nothing, and one that runs a Dockerfile is not a
                    thing to offer on the chance it applies. */}
                {open === p.name && config?.ok === true && config.config.services.some((sv) => sv.build) && (
                  <button
                    className="icon-btn sm"
                    disabled={!serverBacked}
                  title={
                      !serverBacked
                        ? jobsNeedServer
                        : picked.length > 0
                        ? t('docker.compose.buildPicked', { services: picked.join(', '), project: p.name })
                        : t('docker.compose.build', { project: p.name })
                    }
                    onClick={() => runJob('build', p.name)}
                  >
                    <Hammer size={13} />
                  </button>
                )}
              </div>
              {open === p.name && (
                <div style={{ paddingLeft: 12 }}>
                  <div className="faint mono" style={{ fontSize: 11 }}>
                    {p.configFiles.join('  ')}
                  </div>
                  {configLoading && <div className="faint">{t('docker.compose.readingFile')}</div>}
                  {config && !config.ok && (
                    <div className="s-desc danger">
                      <TriangleAlert size={12} /> {COMPOSE_FAILURE_HELP[config.reason]}
                      <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
                        {config.detail}
                      </div>
                    </div>
                  )}
                  {/* Item 42's lint. Only over a model compose ACCEPTED -- an
                      invalid file is reported with compose's own line above and
                      never reaches here, because a second opinion on a settled
                      question is noise.

                      A names-only model is refused by `lintComposeConfig`
                      itself, not here: every field on it is empty because
                      nothing was read, and linting that would claim every
                      service has no tag and no restart policy.

                      `no-restart` is filtered for the same reason: the table
                      below already carries a warn chip reading "restart: no
                      (default)" on every service that has none, and a second
                      sentence per service would be twelve paragraphs on a
                      twelve-service project saying what twelve chips say. The
                      rule stays in `lintCompose` -- it is a real finding and
                      other callers have no table. */}
                  {config?.ok &&
                    lintComposeConfig(config.config)
                      .filter((f) => f.rule !== 'no-restart')
                      .map((f) => (
                      <div key={`${f.rule} ${f.service}`} className="s-note state-unknown">
                        {f.because}
                      </div>
                    ))}
                  {config?.ok && config.config.namesOnly && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {t('docker.compose.namesOnly')}
                    </div>
                  )}
                  {view?.services.map((s) => (
                    <div key={s.declared.name} className="cron-row">
                      <input
                        type="checkbox"
                        aria-label={t('docker.compose.include', { name: s.declared.name })}
                        checked={picked.includes(s.declared.name)}
                        onChange={() =>
                          setPicked((cur) =>
                            cur.includes(s.declared.name)
                              ? cur.filter((x) => x !== s.declared.name)
                              : [...cur, s.declared.name]
                          )
                        }
                      />
                      <span className="mono cron-when">{s.declared.name}</span>
                      <span className={clsx('chip', STATE_TONE[s.state])}>{t(STATE_WORD[s.state])}</span>
                      <span className="faint cron-desc mono">
                        {s.declared.image ?? (s.declared.build ? t('docker.compose.builtFromSource') : '—')}
                      </span>
                      <span className="grow" />
                      {s.containers.length > 0 && (
                        <button
                          className="icon-btn sm"
                          disabled={restarting}
                          title={
                            s.containers.length === 1
                              ? t('docker.compose.restartOneTitle', { name: s.declared.name })
                              : t('docker.compose.restartManyTitle', {
                                  name: s.declared.name,
                                  count: s.containers.length
                                })
                          }
                          onClick={() => {
                            setRestartResult(null)
                            setRestartPhrase('')
                            setRestart(planComposeServiceRestart(s))
                          }}
                        >
                          <RotateCw size={13} />
                        </button>
                      )}
                      {s.declared.image !== null && (
                        <button
                          className="icon-btn sm"
                          title={t('docker.compose.editTitle', { name: s.declared.name })}
                          onClick={() => startEdit(s.declared.name, s.declared.image!)}
                        >
                          <Pencil size={13} />
                        </button>
                      )}
                      {s.declared.image !== null && (
                        <button
                          className="icon-btn sm"
                          disabled={reverting}
                          title={t('docker.compose.revertTitle', { name: s.declared.name })}
                          onClick={() => void startRevert(s.declared.name)}
                        >
                          <Undo2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}

                  {/* Item 42. `depends_on`, `restart:`, ports and profiles have
                      been parsed since the parser was written and none of them
                      reached the screen, so the panel showed a name, a state
                      and an image and nothing about what the file actually
                      says. Rendered under the row rather than in it: these are
                      the answers to "why did that not start" and they are read
                      once, not scanned. */}
                  {/* EVERY service, not only the ones with something set. A
                      service with no `restart:` is the finding rather than the
                      blank row: compose defaults to `no`, so it does not come
                      back after a reboot and nothing else on this screen says
                      so.

                      `view.services` holds every DECLARED service, carrying
                      state `missing` when it has no container -- `view.missing`
                      is only the names of those, not a separate set. So a
                      service in a profile, which has no container by design, is
                      in here and gets its explanation. */}
                  {view !== null && view.services.length > 0 && (
                    <table className="mini-table">
                      <tbody>
                        {view.services
                          .map((s) => (
                            <tr key={`d-${s.declared.name}`}>
                              <td className="mono">{s.declared.name}</td>
                              <td>
                                {/* No `restart:` at all is the finding, not a
                                    blank: compose defaults to `no`, so a
                                    service without one does not come back
                                    after a reboot. */}
                                <span className={clsx('chip', s.declared.restart === null && 'warn')}>
                                  restart: {s.declared.restart ?? 'no (default)'}
                                </span>
                                {s.declared.dependsOn.length > 0 && (
                                  <span className="chip">
                                    {t('docker.compose.dependsOn', { services: s.declared.dependsOn.join(', ') })}
                                  </span>
                                )}
                                {s.declared.ports.map((port) => (
                                  <span key={port} className="chip mono">
                                    {port}
                                  </span>
                                ))}
                                {s.declared.profiles.length > 0 && (
                                  <span className="chip">
                                    {/* A service in a profile does NOT start
                                        with a plain `up`, which is the
                                        commonest reason one is "missing". */}
                                    {t('docker.compose.profile', { profiles: s.declared.profiles.join(', ') })}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  )}

                  {view !== null && view.missing.length > 0 && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {t('docker.compose.missing', { names: view.missing.join(', ') })}
                    </div>
                  )}
                  {view !== null && view.undeclared.length > 0 && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {t('docker.compose.undeclared', { names: view.undeclared.map((c) => c.name).join(', ') })}
                    </div>
                  )}

                  {/* Environment. NAMES, and the sentence saying why. */}
                  {config?.ok &&
                    config.config.services.some((s) => s.environment.length > 0) && (
                      <div style={{ marginTop: 6 }}>
                        <div className="row muted" style={{ fontSize: 11 }}>
                          <KeyRound size={12} />
                          <span>{t('docker.compose.environment')}</span>
                        </div>
                        {config.config.services
                          .filter((s) => s.environment.length > 0)
                          .map((s) => (
                            <div key={s.name} className="cron-row">
                              <span className="mono cron-when">{s.name}</span>
                              <span className="faint cron-desc mono">
                                {s.environment
                                  .map(
                                    (v) =>
                                      `${v.name}=${v.set ? t('docker.compose.envSet') : v.origin === 'passthrough' ? t('docker.compose.envFromServer') : t('docker.compose.envEmpty')}`
                                  )
                                  .join('  ')}
                              </span>
                            </div>
                          ))}
                      </div>
                    )}

                  {envFiles !== null && (
                    <div style={{ marginTop: 6 }}>
                      {envFiles.map((f) => (
                        <div key={f.path} className="col" style={{ gap: 2 }}>
                          <div className="cron-row">
                            <FileText size={12} className="faint" />
                            <span className="mono cron-when">{f.path}</span>
                            <span className="faint cron-desc mono">
                              {!f.readable
                                ? t('docker.compose.envFileUnreadable')
                                : f.names.length === 0
                                  ? t('docker.compose.envFileEmpty')
                                  : ''}
                            </span>
                          </div>
                          {/* One row per variable rather than one joined line,
                              so each name can carry its own write button. The
                              marker is still all this panel knows: `(set)` says
                              the right-hand side is non-empty and nothing
                              anywhere here says what it is. */}
                          {f.readable &&
                            f.names.map((n) => (
                              <div
                                key={n.name}
                                className="row"
                                style={{ gap: 8, paddingLeft: 20, flexWrap: 'wrap' }}
                              >
                                <span className="mono faint" style={{ fontSize: 11 }}>
                                  {n.name}={n.set ? t('docker.compose.envSet') : t('docker.compose.envEmpty')}
                                </span>
                                {server !== undefined && (
                                  <EnvValueWrite
                                    cfg={cfg}
                                    serverId={server.id}
                                    path={f.path}
                                    name={n.name}
                                    sudo={sudo}
                                    onWritten={() => void reloadEnvNames()}
                                  />
                                )}
                              </div>
                            ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {envError !== null && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {t('docker.compose.envError', { error: envError })}
                    </div>
                  )}
                  {(envFiles !== null ||
                    (config?.ok === true &&
                      config.config.services.some((s) => s.environment.length > 0))) && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {t('shared.compose.envDisclosure')}
                    </div>
                  )}

                  {/* The refusal, in words, where the button would have been. */}
                  <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
                    {COMPOSE_REFUSALS.down}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Files on disk the daemon did not account for. */}
          {list.search !== null && list.search.files.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="row muted" style={{ fontSize: 11 }}>
                <FileText size={12} />
                <span>{t('docker.compose.filesOnDisk')}</span>
              </div>
              {list.search.files.map((f) => (
                <div key={f.path} className="cron-row">
                  <span className="mono cron-when">{f.path}</span>
                </div>
              ))}
            </div>
          )}
          {list.search !== null && (
            /* The bounds are printed, not implied. An empty result from a
               search whose limits are invisible cannot be interpreted: it
               might mean there is nothing, or it might mean nobody looked
               where the files are. */
            <div className="faint" style={{ fontSize: 11 }}>
              {t('docker.compose.searchBound', {
                roots: list.search.bound.roots.join(', '),
                depth: list.search.bound.maxDepth,
                max: list.search.bound.maxResults
              })}
              {list.search.truncated && ` ${t('docker.compose.searchTruncated')}`}
            </div>
          )}
        </>
      )}

      {editing !== null && (
        <div className="s-desc" style={{ marginTop: 8 }}>
          <div>
            <Trans
              i18nKey="docker.compose.editIntro"
              values={{ service: editing.service }}
              components={{ b: <b /> }}
            />
          </div>
          {revertNote !== null && (
            <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>{revertNote}</div>
          )}
          <input
            className="input"
            value={editing.to}
            onChange={(e) => setEditing({ ...editing, to: e.target.value })}
          />
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button
              className="btn sm"
              disabled={editing.to === editing.from || !validateImageRef(editing.to)}
              onClick={() => void commitEdit()}
            >
              {t('docker.compose.writeFile')}
            </button>
            <button className="btn ghost sm" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
          </div>
          {editing.to !== editing.from && !validateImageRef(editing.to) && (
            <div className="faint" style={{ fontSize: 11 }}>
              {t('docker.compose.badImageRef')}
            </div>
          )}
          {editError !== null && (
            <div className="danger" style={{ fontSize: 11 }}>
              {editError}
            </div>
          )}
        </div>
      )}

      {editDone !== null && <div className="s-desc">{editDone}</div>}
      {pending !== null && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="r-title">{pending.plan.spec.title}</div>
          <div className="r-sub">{pending.plan.detail}</div>
          {pending.reasons.length > 0 && (
            <div className="s-note warn">
              {t('docker.compose.jobReasons', { reasons: pending.reasons.join(', and ') })}
            </div>
          )}
          <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
            {pending.plan.spec.steps.map((st) => st.command).join('\n')}
          </pre>
          {pending.confirmation.kind === 'type-to-confirm' && (
            <input
              className="input mono"
              aria-label={t('docker.common.typeToConfirm', { phrase: pending.confirmation.phrase })}
              placeholder={t('docker.common.typeToConfirm', { phrase: pending.confirmation.phrase })}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
            />
          )}
          <div className="row-actions">
            <button
              className="btn primary"
              disabled={
                pending.confirmation.kind === 'type-to-confirm' &&
                phrase.trim() !== pending.confirmation.phrase
              }
              onClick={() =>
                void launch(
                  pending.plan,
                  pending.targets,
                  pending.confirmation.kind === 'type-to-confirm' ? phrase.trim() : null
                )
              }
            >
              {t('docker.compose.run')}
            </button>
            <button className="btn" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      {restart !== null && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="r-title">{t('docker.compose.restartTitle', { service: restart.service })}</div>
          {restart.refusal !== null ? (
            <>
              <div className="s-note warn">{restart.refusal}</div>
              <div className="row-actions">
                <button className="btn" onClick={() => setRestart(null)}>
                  {t('common.close')}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* The CONTAINERS, named. This is the reason the restart goes
                  through the container path rather than a compose verb: a
                  service is one row and can be several containers, and all of
                  them go down. */}
              <div className="r-sub">
                {restart.targets.length === 1
                  ? t('docker.compose.restartsOne')
                  : t('docker.compose.restartsMany', { count: restart.targets.length })}
              </div>
              <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
                {restart.targets.join('\n')}
              </pre>
              {restart.plan !== null && restart.plan.reasons.length > 0 && (
                <div className="s-note warn">
                  {t('docker.compose.restartReasons', { reasons: restart.plan.reasons.join(', and ') })}
                </div>
              )}
              {restart.caveats.map((c) => (
                <div key={c} className="s-note state-unknown">
                  {c}
                </div>
              ))}
              {restart.plan?.confirmation.kind === 'type-to-confirm' && (
                <input
                  className="input mono"
                  aria-label={t('docker.common.typeToConfirm', { phrase: restart.plan.confirmation.phrase })}
                  placeholder={t('docker.common.typeToConfirm', { phrase: restart.plan.confirmation.phrase })}
                  value={restartPhrase}
                  onChange={(e) => setRestartPhrase(e.target.value)}
                />
              )}
              <div className="row-actions">
                <button
                  className="btn primary"
                  disabled={
                    restarting ||
                    (restart.plan?.confirmation.kind === 'type-to-confirm' &&
                      restartPhrase.trim() !== restart.plan.confirmation.phrase)
                  }
                  onClick={() => void runRestart(restart)}
                >
                  {t('docker.compose.restart')}
                </button>
                <button className="btn" onClick={() => setRestart(null)}>
                  {t('common.cancel')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {restartResult !== null && <div className="s-desc mono">{restartResult}</div>}
      {launched !== null && <div className="s-desc">{launched}</div>}
    </div>
  )
}
