import { useEffect, useState } from 'react'
import { Field, Modal } from '../common/Modal'
import { EmptyState } from '../common/EmptyState'
import { clsx, duration } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { StatusWord, RequestedWord } from './Status'
import { Reading } from './Reading'
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
  const t = useT()
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
          placeholder={t('cicd.trigger.filterPlaceholder')}
          aria-label={t('cicd.trigger.filterLabel')}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="spacer" />
        <button
          className="btn secondary size-28"
          disabled={!canRefresh}
          title={canRefresh ? undefined : t('cicd.common.cannotReadOnDemand')}
          onClick={() => void bridge?.refresh().catch(() => undefined)}
        >
          {t('common.refresh')}
        </button>
      </div>

      <div className="panel-stats" data-testid="cicd-trigger-counts">
        <span>{t('cicd.trigger.counts', { shown: shown.length, count: all.length })}</span>
      </div>

      {requested.length > 0 && (
        <div className="cicd-rows">
          <div className="ui-label cicd-bucket">
            {t('cicd.trigger.askedThisSession', { count: requested.length })}
          </div>
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
              <span className="faint">{t('cicd.common.ago', { duration: duration(r.at) })}</span>
              {r.result.webUrl !== undefined && (
                <a href={r.result.webUrl} target="_blank" rel="noreferrer">
                  {t('cicd.common.openInProvider')}
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
          title={t('cicd.common.noAccount')}
          message={t('cicd.trigger.noAccountMessage')}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          compact
          title={all.length === 0 ? t('cicd.trigger.noneStartableTitle') : t('cicd.trigger.noMatchTitle')}
          message={
            all.length === 0 ? t('cicd.trigger.noneStartableMessage') : t('cicd.trigger.noMatchMessage')
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
              <span className="ui-label">{t('cicd.trigger.startEllipsis')}</span>
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
  const t = useT()
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
  /**
   * Jenkins has no ref.
   *
   * `triggerJenkins` sends `/build` or `/buildWithParameters` and passes no such
   * field, because a Jenkins job's branch is part of its SCM configuration (or,
   * for a multibranch project, part of which child job you picked) rather than
   * something a trigger names. Demanding one here made every Jenkins build
   * impossible to start from this dialog: the confirm stayed disabled behind
   * "Name the branch, tag or commit to run against" for a value that was going
   * to be dropped on the floor. GitLab and GitHub both genuinely need it.
   */
  const needsRef = connection.provider !== 'jenkins'
  const blocked =
    needsRef && ref.trim() === ''
      ? t('cicd.trigger.needsRef')
      : missingRequired
        ? t('cicd.trigger.paramRequired', { label: missingRequired.label })
        : !bridge
          ? t('cicd.trigger.noBridge')
          : null

  const start = async (): Promise<void> => {
    if (blocked || !bridge || starting) return
    setStarting(true)
    try {
      const result = await bridge.trigger(connection.id, pipeline.ref, needsRef ? ref.trim() : '', values)
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
      title={t('cicd.trigger.modalTitle', { name: pipeline.name })}
      subtitle={
        where
          ? t('cicd.trigger.modalSubtitleAt', { name: connection.name, where })
          : t('cicd.trigger.modalSubtitle', { name: connection.name })
      }
      onClose={onClose}
      footerNote={
        error !== null ? (
          <span className="field-hint danger">{error}</span>
        ) : blocked !== null ? (
          <span className="field-hint danger">{blocked}</span>
        ) : null
      }
      confirm={{
        label: starting ? t('cicd.trigger.starting') : t('cicd.trigger.startRun'),
        disabled: blocked !== null || starting,
        onClick: () => void start()
      }}
    >
      {/* The blast radius, in the user's terms rather than the API's. */}
      <div className="panel-note is-watch">{t('cicd.trigger.blastRadius', { name: connection.name })}</div>

      {/* Absent for Jenkins rather than disabled: there is no Jenkins field this
          would set, so a greyed box would be claiming one exists. */}
      {needsRef && (
        <Field
          label={t('cicd.trigger.refLabel')}
          required
          hint={t('cicd.trigger.refHint')}
        >
          <input className="input" value={ref} autoFocus onChange={(e) => setRef(e.target.value)} />
        </Field>
      )}

      {params === null ? (
        <Reading label={t('cicd.trigger.readingParams')} />
      ) : params.length === 0 ? (
        /* No manufactured empty form. */
        <div className="ui-note">{t('cicd.trigger.noParams')}</div>
      ) : (
        params.map((p) => (
          <Field
            key={p.key}
            label={p.label}
            required={p.required}
            // The provider's own caveat about this field, where there is one.
            // See `CicdParam.unsupportedNote`: the box is rendered and will be
            // submitted either way, so the honest thing is to say which of them
            // is not the control Jenkins would have given you.
            hint={p.unsupportedNote}
          >
            {p.type === 'text' ? (
              <textarea
                className="input cicd-param-text"
                rows={4}
                value={values[p.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
              />
            ) : p.type === 'boolean' ? (
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
                <option value="">{t('cicd.trigger.choose')}</option>
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
