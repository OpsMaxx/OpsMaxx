import { useState } from 'react'
import { Download, FileText, KeyRound, Layers, Pencil, Play, RotateCw, TriangleAlert } from 'lucide-react'
import { clsx } from '../../lib/format'
import { jobApprovalFor, planJob } from '../../../../shared/jobs'
import {
  COMPOSE_ENV_DISCLOSURE,
  COMPOSE_REFUSALS,
  lintComposeConfig,
  planComposeServiceRestart,
  type ComposeRestartPlan,
  COMPOSE_FAILURE_HELP,
  composeJobSpec,
  joinComposeState,
  planComposeImageEdit,
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

const STATE_WORD: Record<ComposeServiceRunState, string> = {
  running: 'running',
  partial: 'partly up',
  stopped: 'stopped',
  // The word this whole panel exists to be able to say. A stopped service has a
  // container in the list above; a missing one has nothing anywhere.
  missing: 'never created'
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

  if (!server) return null

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
        setRestartResult('This build cannot run container actions. Restart the app to rebuild it.')
        return
      }
      const r = await act(cfg, 'restart', plan.targets, { sudo })
      setRestartResult(
        r?.ok === true
          ? `Restarted ${plan.targets.join(', ')}.`
          : (r?.detail ?? 'The restart did not report success.')
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
    setEditDone(null)
    setLaunched(null)
    try {
      setList((await bridge()?.list?.(cfg, { sudo })) ?? null)
    } finally {
      setLoading(false)
    }
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
        else setEnvError(env ? env.detail : 'the env files could not be read')
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
    setLaunched(`${plan.spec.title} — running as a job. Watch it on the Jobs panel.`)
  }

  const view: ComposeProjectView | null =
    open !== null && config?.ok ? joinComposeState(open, config.config, containers) : null

  const startEdit = (service: string, from: string): void => {
    setEditError(null)
    setEditDone(null)
    setEditing({ service, from, to: from })
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
      setEditError(read?.error ?? 'the compose file could not be read')
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
      setEditError(result?.reason ?? 'the compose file was not written')
      return
    }
    setEditing(null)
    setEditDone(
      `${result.plan.service}: ${result.plan.from} → ${result.plan.to} on line ${result.plan.line}. ` +
        `The file it replaced is at ${result.backup}. Nothing is running the new image until you pull and bring it up.`
    )
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row muted" style={{ fontSize: 11, alignItems: 'center' }}>
        <Layers size={12} />
        <span className="grow">Compose projects</span>
        <button className="btn ghost sm" disabled={loading} onClick={() => void load()}>
          {list === null ? 'Find compose files' : 'Refresh'}
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
                  title={
                    open === p.name && picked.length > 0
                      ? `docker compose pull for ${picked.join(', ')} in ${p.name}. Fetches those images; nothing running changes.`
                      : `docker compose pull for ${p.name}. Fetches images; nothing running changes.`
                  }
                  onClick={() => runJob('pull', p.name)}
                >
                  <Download size={13} />
                </button>
                <button
                  className="icon-btn sm"
                  title={
                    open === p.name && picked.length > 0
                      ? `docker compose up -d for ${picked.join(', ')} in ${p.name}. Starts those; removes nothing.`
                      : `docker compose up -d for ${p.name}. Starts what is declared; removes nothing.`
                  }
                  onClick={() => runJob('up', p.name)}
                >
                  <Play size={13} />
                </button>
              </div>
              {open === p.name && (
                <div style={{ paddingLeft: 12 }}>
                  <div className="faint mono" style={{ fontSize: 11 }}>
                    {p.configFiles.join('  ')}
                  </div>
                  {configLoading && <div className="faint">Reading the file…</div>}
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
                      This engine would only give the service NAMES, so images, ports and
                      environment are unknown here rather than absent.
                    </div>
                  )}
                  {view?.services.map((s) => (
                    <div key={s.declared.name} className="cron-row">
                      <input
                        type="checkbox"
                        aria-label={`Include ${s.declared.name}`}
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
                      <span className={clsx('chip', STATE_TONE[s.state])}>{STATE_WORD[s.state]}</span>
                      <span className="faint cron-desc mono">
                        {s.declared.image ?? (s.declared.build ? 'built from source' : '—')}
                      </span>
                      <span className="grow" />
                      {s.containers.length > 0 && (
                        <button
                          className="icon-btn sm"
                          disabled={restarting}
                          title={`Restart ${s.declared.name}'s ${s.containers.length === 1 ? 'container' : `${s.containers.length} containers`}. Every connection they are serving is interrupted, and a change to the compose file is NOT applied by a restart.`}
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
                          title={`Change ${s.declared.name}'s image tag in the compose file. Nothing is pulled or restarted.`}
                          onClick={() => startEdit(s.declared.name, s.declared.image!)}
                        >
                          <Pencil size={13} />
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
                                  <span className="chip">after {s.declared.dependsOn.join(', ')}</span>
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
                                    profile {s.declared.profiles.join(', ')} — not started by a plain up
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
                      Declared but never created: {view.missing.join(', ')}. These have no container
                      at all, so they do not appear in the list above.
                    </div>
                  )}
                  {view !== null && view.undeclared.length > 0 && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      Running under this project but not declared in the file:{' '}
                      {view.undeclared.map((c) => c.name).join(', ')}.
                    </div>
                  )}

                  {/* Environment. NAMES, and the sentence saying why. */}
                  {config?.ok &&
                    config.config.services.some((s) => s.environment.length > 0) && (
                      <div style={{ marginTop: 6 }}>
                        <div className="row muted" style={{ fontSize: 11 }}>
                          <KeyRound size={12} />
                          <span>Environment</span>
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
                                      `${v.name}=${v.set ? '(set)' : v.origin === 'passthrough' ? '(from server)' : '(empty)'}`
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
                        <div key={f.path} className="cron-row">
                          <FileText size={12} className="faint" />
                          <span className="mono cron-when">{f.path}</span>
                          <span className="faint cron-desc mono">
                            {!f.readable
                              ? 'could not be read'
                              : f.names.length === 0
                                ? 'declares nothing'
                                : f.names
                                    .map((n) => `${n.name}=${n.set ? '(set)' : '(empty)'}`)
                                    .join('  ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {envError !== null && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      The env files could not be read: {envError}
                    </div>
                  )}
                  {(envFiles !== null ||
                    (config?.ok === true &&
                      config.config.services.some((s) => s.environment.length > 0))) && (
                    <div className="faint" style={{ fontSize: 11 }}>
                      {COMPOSE_ENV_DISCLOSURE}
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
                <span>Compose files on disk</span>
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
              Looked in {list.search.bound.roots.join(', ')}, {list.search.bound.maxDepth} levels
              deep, on this filesystem only, stopping at {list.search.bound.maxResults} files.
              Nothing outside those directories was read.
              {list.search.truncated &&
                ' That limit was reached, so this list is a prefix rather than an inventory.'}
            </div>
          )}
        </>
      )}

      {editing !== null && (
        <div className="s-desc" style={{ marginTop: 8 }}>
          <div>
            <b>{editing.service}</b> — change the image in the compose file. This writes one line and
            nothing else: no image is pulled and no container is restarted.
          </div>
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
              Write the file
            </button>
            <button className="btn ghost sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
          {editing.to !== editing.from && !validateImageRef(editing.to) && (
            <div className="faint" style={{ fontSize: 11 }}>
              That is not an image reference this will write into a file.
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
              This job {pending.reasons.join(', and ')}.
            </div>
          )}
          <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
            {pending.plan.spec.steps.map((st) => st.command).join('\n')}
          </pre>
          {pending.confirmation.kind === 'type-to-confirm' && (
            <input
              className="input mono"
              aria-label={`Type ${pending.confirmation.phrase} to confirm`}
              placeholder={`Type ${pending.confirmation.phrase} to confirm`}
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
              Run
            </button>
            <button className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {restart !== null && (
        <div className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="r-title">Restart {restart.service}</div>
          {restart.refusal !== null ? (
            <>
              <div className="s-note warn">{restart.refusal}</div>
              <div className="row-actions">
                <button className="btn" onClick={() => setRestart(null)}>
                  Close
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
                  ? 'This restarts one container:'
                  : `This restarts ${restart.targets.length} containers, all of them:`}
              </div>
              <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>
                {restart.targets.join('\n')}
              </pre>
              {restart.plan !== null && restart.plan.reasons.length > 0 && (
                <div className="s-note warn">This {restart.plan.reasons.join(', and ')}.</div>
              )}
              {restart.caveats.map((c) => (
                <div key={c} className="s-note state-unknown">
                  {c}
                </div>
              ))}
              {restart.plan?.confirmation.kind === 'type-to-confirm' && (
                <input
                  className="input mono"
                  aria-label={`Type ${restart.plan.confirmation.phrase} to confirm`}
                  placeholder={`Type ${restart.plan.confirmation.phrase} to confirm`}
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
                  Restart
                </button>
                <button className="btn" onClick={() => setRestart(null)}>
                  Cancel
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
