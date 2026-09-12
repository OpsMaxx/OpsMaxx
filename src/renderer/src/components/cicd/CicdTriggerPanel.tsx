import { useEffect, useState } from 'react'
import { Field, Modal } from '../common/Modal'
import { EmptyState } from '../common/EmptyState'
import { clsx, duration } from '../../lib/format'
import { StatusWord, RequestedWord } from './Status'
import { cicdBridge, cicdBridgeHas, pathLabel, triggerablePipelines, useCicdConnectionList, useCicdState } from './state'
import type {
  CicdBridge,
  CicdConnection,
  CicdParam,
  CicdPipeline,
  CicdTriggerResult
} from '../../../../shared/cicd'

/**
 * Start a run — the `cicdTrigger` operate surface.
 *
 * A separate module from `cicd` for the reason the rail names tabs by: the
 * consequence here is that a deploy goes out, on a server OpsMaxx does not
 * administer and cannot stop once the provider has accepted it.
 *
 * The list rows ARE the affordance, the way the search field is in
 * Fleet-wide search: there is no single button a first-time user presses,
 * because which pipeline to start is the question. The one primary control in
 * the flow is the confirm inside the dialog, which is also the only place the
 * blast radius is stated.
 *
 * Only `triggerable` pipelines are listed. GitHub is why that flag exists:
 * `workflow_dispatch` works only if the YAML declares it, and a Run button
 * that 422s on half the workflows is worse than one that is honestly absent.
 */
export function CicdTriggerPanel({
  connections: seed,
  bridge = cicdBridge()
}: {
  connections?: CicdConnection[]
  bridge?: CicdBridge
}): React.JSX.Element {
  const stored = useCicdConnectionList()
  const connections = seed ?? stored
  const canRefresh = cicdBridgeHas(bridge, 'refresh')
  const states = useCicdState(bridge)
  const [filter, setFilter] = useState('')
  const [asking, setAsking] = useState<{ connection: CicdConnection; pipeline: CicdPipeline } | null>(null)
  /** Runs this session asked for. Kept here because a provider that returns no
   *  run id gives the poller nothing to find, so the only record that the
   *  request happened is the one the request made. */
  const [requested, setRequested] = useState<
    { key: string; label: string; at: number; result: CicdTriggerResult }[]
  >([])

  const all = triggerablePipelines(connections, states)
  const needle = filter.trim().toLowerCase()
  const shown = all.filter(
    (p) =>
      needle === '' ||
      p.pipeline.name.toLowerCase().includes(needle) ||
      p.connection.name.toLowerCase().includes(needle) ||
      pathLabel(p.pipeline).toLowerCase().includes(needle)
  )

  return (
    <div className="cicd-trigger" data-testid="cicd-trigger-panel">
      <div className="row cicd-filters">
        <input
          className="input"
          value={filter}
          placeholder="Filter pipelines…"
          aria-label="Filter pipelines"
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="spacer" />
        <button
          className="btn secondary size-28"
          disabled={!canRefresh}
          title={canRefresh ? undefined : 'This build cannot read on demand.'}
          onClick={() => void bridge?.refresh().catch(() => undefined)}
        >
          Refresh
        </button>
      </div>

      <div className="panel-stats" data-testid="cicd-trigger-counts">
        <span>
          {shown.length} of {all.length} {all.length === 1 ? 'pipeline' : 'pipelines'} can be
          started
        </span>
      </div>

      {requested.length > 0 && (
        <div className="cicd-rows">
          <div className="ui-label cicd-bucket">Asked for this session · {requested.length}</div>
          {requested.map((r) => (
            <div key={r.key} className="cicd-row">
              {/* Never green, and never a fabricated run number. Jenkins hands
                  back a queue item that may never become a build. */}
              {r.result.run ? (
                <StatusWord outcome={{ status: 'queued' }} />
              ) : (
                <RequestedWord note={r.result.note} />
              )}
              <span className="grow ellipsis">{r.label}</span>
              {r.result.run && <span className="mono">#{r.result.run.id}</span>}
              <span className="faint">{duration(r.at)} ago</span>
              {r.result.webUrl !== undefined && (
                <a href={r.result.webUrl} target="_blank" rel="noreferrer">
                  Open in the provider
                </a>
              )}
            </div>
          ))}
          {requested.map((r) => (
            <div key={`${r.key}-note`} className="ui-note cicd-pane-note">
              {r.result.note}
            </div>
          ))}
        </div>
      )}

      {connections.length === 0 ? (
        <EmptyState
          compact
          title="No CI account is connected"
          message="Connect one on the CI/CD panel first. Nothing here can reach a CI server until then."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          compact
          title={all.length === 0 ? 'No pipeline can be started' : 'Nothing matched'}
          message={
            all.length === 0
              ? 'None of the pipelines read so far declares a way to be started by hand. A GitHub workflow needs workflow_dispatch in its YAML.'
              : 'No startable pipeline matches that filter.'
          }
        />
      ) : (
        <div className="cicd-rows">
          {shown.map(({ connection, pipeline }) => (
            <button
              key={`${connection.id}:${pipeline.ref}`}
              className="cicd-row"
              onClick={() => setAsking({ connection, pipeline })}
            >
              {pipeline.last ? (
                <StatusWord outcome={pipeline.last.outcome} />
              ) : (
                <StatusWord outcome={{ status: 'unknown' }} />
              )}
              <span className="grow ellipsis">
                {pathLabel(pipeline) && <span className="faint">{pathLabel(pipeline)} / </span>}
                {pipeline.name}
              </span>
              <span className="faint ellipsis">{connection.name}</span>
              <span className="ui-label">Start…</span>
            </button>
          ))}
        </div>
      )}

      {asking && (
        <TriggerModal
          bridge={bridge}
          connection={asking.connection}
          pipeline={asking.pipeline}
          onClose={() => setAsking(null)}
          onStarted={(result) =>
            setRequested((prev) => [
              {
                key: `${asking.connection.id}:${asking.pipeline.ref}:${Date.now()}`,
                label: `${asking.pipeline.name} · ${asking.connection.name}`,
                at: Date.now(),
                result
              },
              ...prev
            ])
          }
        />
      )}
    </div>
  )
}

/**
 * The confirm, naming the blast radius in the user's terms.
 *
 * A pipeline with no parameters gets a short confirm and NO manufactured empty
 * form: an empty fieldset with a heading is a question the user has to read
 * before discovering it was not a question.
 */
export function TriggerModal({
  bridge,
  connection,
  pipeline,
  onClose,
  onStarted
}: {
  bridge?: CicdBridge
  connection: CicdConnection
  pipeline: CicdPipeline
  onClose: () => void
  onStarted: (result: CicdTriggerResult) => void
}): React.JSX.Element {
  const [params, setParams] = useState<CicdParam[] | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [ref, setRef] = useState(pipeline.last?.branch ?? '')
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!bridge) {
      setParams([])
      return
    }
    let live = true
    void bridge
      .listParams(connection.id, pipeline.ref)
      .then((p) => {
        if (!live) return
        setParams(p)
        setValues(Object.fromEntries(p.filter((x) => x.default !== undefined).map((x) => [x.key, x.default as string])))
      })
      .catch((e: unknown) => {
        if (!live) return
        setParams([])
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [bridge, connection.id, pipeline.ref])

  const missingRequired = (params ?? []).find(
    (p) => p.required && (values[p.key] ?? '') === '' && p.type !== 'boolean'
  )
  const blocked =
    ref.trim() === ''
      ? 'Name the branch, tag or commit to run against.'
      : missingRequired
        ? `${missingRequired.label} is required by this pipeline.`
        : !bridge
          ? 'This build cannot reach a CI server. Restart the app to rebuild the bridge.'
          : null

  const start = async (): Promise<void> => {
    if (blocked || !bridge || starting) return
    setStarting(true)
    try {
      const result = await bridge.trigger(connection.id, pipeline.ref, ref.trim(), values)
      onStarted(result)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStarting(false)
    }
  }

  const where = pathLabel(pipeline)

  return (
    <Modal
      title={`Start ${pipeline.name}`}
      subtitle={`On ${connection.name}${where ? ` · ${where}` : ''}`}
      onClose={onClose}
      footerNote={
        error !== null ? (
          <span className="field-hint danger">{error}</span>
        ) : blocked !== null ? (
          <span className="field-hint danger">{blocked}</span>
        ) : null
      }
      confirm={{
        label: starting ? 'Starting…' : 'Start the run',
        disabled: blocked !== null || starting,
        onClick: () => void start()
      }}
    >
      {/* The blast radius, in the user's terms rather than the API's. */}
      <div className="panel-note is-watch">
        This starts a real run on {connection.name}. OpsMaxx does not administer that server and
        cannot stop the run once it has been accepted — whatever the pipeline deploys, deploys.
      </div>

      <Field
        label="Run against"
        required
        hint="The branch, tag or commit the pipeline runs on."
      >
        <input className="input" value={ref} autoFocus onChange={(e) => setRef(e.target.value)} />
      </Field>

      {params === null ? (
        <div className="ui-note">Reading what this pipeline accepts…</div>
      ) : params.length === 0 ? (
        /* No manufactured empty form. */
        <div className="ui-note">This pipeline takes no parameters.</div>
      ) : (
        params.map((p) => (
          <Field key={p.key} label={p.label} required={p.required}>
            {p.type === 'boolean' ? (
              <label className="row cicd-check">
                <input
                  type="checkbox"
                  checked={values[p.key] === 'true'}
                  onChange={(e) => setValues((v) => ({ ...v, [p.key]: String(e.target.checked) }))}
                />
                <span className="grow">{p.key}</span>
              </label>
            ) : p.type === 'choice' ? (
              <select
                className="input"
                value={values[p.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              >
                <option value="">Choose…</option>
                {(p.choices ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={clsx('input')}
                type={p.type === 'password' ? 'password' : 'text'}
                value={values[p.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              />
            )}
          </Field>
        ))
      )}
    </Modal>
  )
}
