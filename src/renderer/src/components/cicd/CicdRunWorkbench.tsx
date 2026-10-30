import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, X } from 'lucide-react'
import { clsx, duration } from '../../lib/format'
import { useApp } from '../../store/app'
import { t as tNow, useT } from '../../lib/i18n'
import type { MessageKey } from '../../../../shared/i18n'
import { useDragSize } from '../../hooks/useDragSize'
import { EmptyState } from '../common/EmptyState'
import { remoteText } from '../../../../shared/remoteText'
import { StatusWord } from './Status'
import { cicdBridgeHas, pathLabel } from './state'
import type {
  CicdBridge,
  CicdConnection,
  CicdLogChunk,
  CicdLogMode,
  CicdPipeline,
  CicdRun,
  CicdStep
} from '../../../../shared/cicd'

/**
 * One run, as a workbench rather than a form.
 *
 * The lesson of 357071f5, applied for the same reason it was learned there: a
 * stack trace too long to read must not sit in a fixed box. Three panes, two
 * dividers, both clamped so neither pane can be dragged away, both persisted
 * to settings so an arrangement survives a restart — having to redo a layout
 * every launch is what makes somebody stop arranging it.
 *
 * The log is the pane that takes the slack, because the log is the thing
 * somebody opened this for.
 */
export function CicdRunWorkbench({
  connection,
  pipeline,
  run,
  steps = [],
  bridge,
  onClose
}: {
  connection: CicdConnection
  pipeline: CicdPipeline
  run: CicdRun
  /**
   * The run's jobs, when a caller already has them.
   *
   * Optional because the workbench fetches its own through `getRun` when it is
   * not given any — a test can hand them over, the panel does not have to.
   * Empty is handled honestly everywhere below rather than rendered as "this
   * run had no jobs": a `startup_failure` genuinely has zero, and the two must
   * not look alike.
   */
  steps?: CicdStep[]
  bridge?: CicdBridge
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [fetched, setFetched] = useState<CicdStep[] | null>(null)
  // Given steps win; otherwise ask. `null` is "not asked yet or failed", which
  // the pane below renders as "no job list was read" rather than "no jobs".
  const shown = steps.length > 0 ? steps : (fetched ?? [])

  useEffect(() => {
    if (steps.length > 0 || !cicdBridgeHas(bridge, 'getRun')) return
    let live = true
    void bridge
      ?.getRun(connection.id, pipeline.ref, run.id, run.attempt)
      .then((r) => {
        if (live) setFetched((r.steps as CicdStep[]) ?? [])
      })
      // A failed read leaves `fetched` null, so the pane says the list was not
      // read rather than claiming the run had no jobs.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [bridge, connection.id, pipeline.ref, run.id, run.attempt, steps.length])

  const [stopping, setStopping] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [stopNote, setStopNote] = useState<string | null>(null)
  // Only a run that could still be going gets the button. `queued` counts: a
  // Jenkins queue item can be cancelled before it ever becomes a build, which
  // is the cheapest moment to stop one.
  const running = run.outcome.status === 'running' || run.outcome.status === 'queued'
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)

  const stepPane = useDragSize(settings.cicdStepsWidth ?? 240, {
    min: 160,
    max: 480,
    onCommit: (cicdStepsWidth) => setSettings({ cicdStepsWidth })
  })
  const detailPane = useDragSize(settings.cicdDetailHeight ?? 140, {
    min: 72,
    max: 480,
    axis: 'y',
    onCommit: (cicdDetailHeight) => setSettings({ cicdDetailHeight })
  })

  const [stepName, setStepName] = useState<string | undefined>(undefined)

  return (
    <div className="cicd-workbench">
      <div className="cicd-workbench-head">
        {/* A back button, not only the ×.
            This view REPLACES the list it was opened from -- it is not a modal
            over it -- so the only way out was a 16px glyph in the far corner
            that reads as "close this thing" rather than "go back to the runs".
            Labelled with the destination, because a bare arrow beside a job
            name is ambiguous about which of the two lists it returns to. The ×
            stays: it is the same action, and people reach for both. */}
        <button
          type="button"
          className="btn secondary size-24"
          data-testid="cicd-run-back"
          onClick={onClose}
        >
          <ChevronLeft size={14} />
          {t('cicd.run.backToRuns')}
        </button>
        <StatusWord outcome={run.outcome} />
        <b className="grow ellipsis">
          {pipeline.name} · {run.label}
          {run.attempt > 1 && (
            <span className="faint"> {t('cicd.run.attempt', { attempt: run.attempt })}</span>
          )}
        </b>
        <button className="icon-btn close" aria-label={t('cicd.run.close')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="cicd-workbench-body">
        <div className="cicd-steps" style={{ width: stepPane.size }}>
          <div className="ui-label cicd-pane-label">{t('cicd.run.jobs')}</div>
          {shown.length === 0 ? (
            /* Not "no jobs". A run whose YAML failed to parse has zero jobs and
               a run whose steps we could not read has none either, and calling
               both of them empty is the reassuring fiction this module exists
               to avoid. */
            <div className="ui-note cicd-pane-note">
              {t('cicd.run.noJobList')}
            </div>
          ) : (
            <div className="cicd-step-list">
              <button
                className={clsx('cicd-step', stepName === undefined && 'active')}
                onClick={() => setStepName(undefined)}
              >
                <span className="grow ellipsis">{t('cicd.run.wholeRun')}</span>
              </button>
              {shown.map((s) => (
                <button
                  key={s.name}
                  className={clsx('cicd-step', stepName === s.name && 'active')}
                  onClick={() => setStepName(s.name)}
                >
                  <StatusWord outcome={s.outcome} />
                  <span className="grow ellipsis" title={s.name}>
                    {s.name}
                  </span>
                  {s.durationMs !== undefined && (
                    <span className="faint">
                      {t('cicd.common.seconds', { secs: Math.round(s.durationMs / 1000) })}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          className={clsx('resizer static', stepPane.dragging && 'dragging')}
          onMouseDown={stepPane.onMouseDown}
          role="separator"
          aria-label={t('cicd.run.resizeJobs')}
        />

        <div className="cicd-log-column">
          <LogPane
            bridge={bridge}
            connectionId={connection.id}
            pipelineRef={pipeline.ref}
            run={run}
            stepName={stepName}
            steps={steps}
          />

          <div
            className={clsx('resizer-h', detailPane.dragging && 'dragging')}
            onMouseDown={detailPane.onMouseDown}
            role="separator"
            aria-label={t('cicd.run.resizeDetail')}
          />

          <div className="cicd-detail" style={{ height: detailPane.size }}>
            <div className="ui-label cicd-pane-label">{t('cicd.run.thisRun')}</div>
            <dl className="cicd-detail-grid">
              <dt>{t('cicd.run.pipeline')}</dt>
              <dd className="ellipsis">
                {pathLabel(pipeline)}
                {pathLabel(pipeline) && ' / '}
                {pipeline.name}
              </dd>
              <dt>{t('cicd.run.connection')}</dt>
              <dd className="ellipsis">{connection.name}</dd>
              {run.branch !== undefined && (
                <>
                  <dt>{t('cicd.run.branch')}</dt>
                  <dd className="mono ellipsis">{remoteText(run.branch)}</dd>
                </>
              )}
              {run.actor !== undefined && (
                <>
                  <dt>{t('cicd.run.startedBy')}</dt>
                  {/* remoteText, always. Anyone who can open a pull request
                      writes this field. */}
                  <dd className="ellipsis">{remoteText(run.actor)}</dd>
                </>
              )}
              {run.title !== undefined && (
                <>
                  <dt>{t('cicd.run.title')}</dt>
                  <dd className="ellipsis">{remoteText(run.title)}</dd>
                </>
              )}
              <dt>{t('cicd.run.started')}</dt>
              <dd>
                {run.startedAt === undefined
                  ? t('cicd.run.notReported')
                  : t('cicd.common.ago', { duration: duration(run.startedAt) })}
              </dd>
              {run.durationMs !== undefined && (
                <>
                  <dt>{t('cicd.run.took')}</dt>
                  <dd>{t('cicd.common.seconds', { secs: Math.round(run.durationMs / 1000) })}</dd>
                </>
              )}
              {!running && (
                <>
                  <dt>{t('cicd.run.finished')}</dt>
                  <dd>
                    {/* Disabled with the reason on the control, never hidden —
                        an option that vanishes teaches the user the product
                        cannot do something. Re-running a finished run is a
                        GitHub concept: Jenkins starts a new build from the job
                        and GitLab retries a pipeline, and pretending those are
                        one verb would be the shared abstraction this module
                        deliberately refuses. */}
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={rerunning || connection.provider !== 'github'}
                      title={
                        connection.provider === 'github'
                          ? undefined
                          : t('cicd.run.rerunUnsupported', { provider: connection.provider })
                      }
                      onClick={() => {
                        setRerunning(true)
                        setStopNote(null)
                        void bridge
                          ?.rerun(connection.id, pipeline.ref, run.id)
                          .then((r) => setStopNote(r.note))
                          .catch((e: Error) => setStopNote(e.message))
                          .finally(() => setRerunning(false))
                      }}
                    >
                      {rerunning ? t('cicd.run.rerunning') : t('cicd.run.rerun')}
                    </button>
                  </dd>
                </>
              )}
              {running && (
                <>
                  <dt>{t('cicd.run.running')}</dt>
                  <dd>
                    {/* The operator's stop button.
                        `cancel_run` existed as an MCP tool and as a bridge
                        method before this did, which meant the only party who
                        could stop a run from inside OpsMaxx was the agent —
                        and the kill switch revokes the agent's session, so
                        pressing it guaranteed the run finished. A human needs
                        the same verb, and it is not gated by the AI policy
                        because it is not the AI doing it. */}
                    <button
                      type="button"
                      className="btn-sm"
                      disabled={stopping || !cicdBridgeHas(bridge, 'cancel')}
                      title={
                        cicdBridgeHas(bridge, 'cancel')
                          ? undefined
                          : t('cicd.run.cannotStop')
                      }
                      onClick={() => {
                        setStopping(true)
                        setStopNote(null)
                        void bridge
                          ?.cancel(connection.id, pipeline.ref, run.id)
                          .then((r) => setStopNote(r.note))
                          .catch((e: Error) => setStopNote(e.message))
                          .finally(() => setStopping(false))
                      }}
                    >
                      {stopping ? t('cicd.run.stopping') : t('cicd.run.stop')}
                    </button>
                  </dd>
                </>
              )}
              {stopNote !== null && (
                <>
                  <dt>{t('cicd.run.lastAction')}</dt>
                  <dd>
                    {/* Verbatim from the adapter, because the three providers
                        genuinely differ about what a stop means: Jenkins will
                        not say whether the build was still running, GitLab
                        reports cancelling rather than cancelled, and GitHub
                        answers 202 to a request it has accepted but not acted
                        on. Summarising those into "Cancelled" would be the one
                        claim none of them actually made. Its own row, so a
                        re-run's answer has somewhere to land too. */}
                    <span className="ui-note">{stopNote}</span>
                  </dd>
                </>
              )}
              {run.webUrl !== undefined && (
                <>
                  <dt>{t('cicd.run.inProvider')}</dt>
                  <dd className="ellipsis">
                    <a href={run.webUrl} target="_blank" rel="noreferrer">
                      {run.webUrl}
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The log pane: one implementation, four honest modes
// ---------------------------------------------------------------------------

/**
 * What the pane header says, permanently, for each mode.
 *
 * Permanently rather than on demand, because the three providers genuinely
 * differ and a shared "Tail" affordance would be a lie. `follow` is null where
 * the provider cannot tail, and the string is the REASON, shown on the
 * disabled control — an option that vanishes teaches the user the product
 * cannot do something, when the truth is that this provider cannot.
 */
const MODE_LABEL: Record<CicdLogMode, MessageKey> = {
  live: 'cicd.log.modeLive',
  reread: 'cicd.log.modeReread',
  snapshot: 'cicd.log.modeSnapshot',
  pending: 'cicd.log.modePending'
}

const NO_FOLLOW: Partial<Record<CicdLogMode, MessageKey>> = {
  snapshot: 'cicd.log.noFollowSnapshot',
  pending: 'cicd.log.noFollowPending'
}

const REREAD_MS = 5000

export function LogPane({
  bridge,
  connectionId,
  pipelineRef,
  run,
  stepName,
  steps
}: {
  bridge?: CicdBridge
  connectionId: string
  pipelineRef: string
  run: CicdRun
  stepName?: string
  steps: CicdStep[]
}): React.JSX.Element {
  const t = useT()
  const [chunk, setChunk] = useState<CicdLogChunk | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const cursor = useRef<string | undefined>(undefined)

  const read = useCallback(
    async (resume: boolean): Promise<void> => {
      if (!bridge) {
        setError(tNow('cicd.log.noBridge'))
        return
      }
      try {
        const next = await bridge.getLog(
          connectionId,
          pipelineRef,
          run.id,
          stepName,
          resume ? cursor.current : undefined
        )
        setError(null)
        setChunk(next)
        cursor.current = next.cursor
        // `live` is a real incremental tail and appends; `reread` hands back
        // the whole trace every time and must replace, or the pane shows the
        // same output five times over.
        setText((prev) => (resume && next.mode === 'live' ? prev + next.text : next.text))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [bridge, connectionId, pipelineRef, run.id, stepName]
  )

  // A step change is a different log, not more of the same one.
  useEffect(() => {
    cursor.current = undefined
    setText('')
    setChunk(null)
    void read(false)
  }, [read])

  useEffect(() => {
    if (!following) return
    const mode = chunk?.mode
    if (mode !== 'live' && mode !== 'reread') return
    const t = setInterval(() => void read(mode === 'live'), REREAD_MS)
    return () => clearInterval(t)
  }, [following, chunk?.mode, read])

  const mode: CicdLogMode = chunk?.mode ?? 'pending'
  const cannotFollowKey = NO_FOLLOW[mode]
  const cannotFollow = cannotFollowKey === undefined ? undefined : t(cannotFollowKey)

  return (
    <div className="cicd-log">
      <div className="cicd-log-head">
        <span className="ui-label">{t(MODE_LABEL[mode])}</span>
        <span className="grow" />
        <button
          className="btn secondary size-24"
          disabled={cannotFollow !== undefined}
          // The reason is on the control in both senses: the title carries it
          // for a pointer, and the sentence below carries it for everyone else.
          title={cannotFollow}
          onClick={() => setFollowing((v) => !v)}
        >
          {following ? t('cicd.log.stopFollowing') : t('cicd.log.follow')}
        </button>
        <button className="btn secondary size-24" onClick={() => void read(false)}>
          {t('common.refresh')}
        </button>
      </div>

      {cannotFollow !== undefined && <div className="ui-note cicd-pane-note">{cannotFollow}</div>}

      {error !== null && <div className="panel-note is-alarm">{error}</div>}

      {mode === 'pending' ? (
        <div className="cicd-log-body">
          {/* Not an error, and the poller must not back off on it. The step
              statuses ARE available; the log is not. Saying "no logs" without
              saying why reads as a failure. */}
          <EmptyState
            compact
            title={t('cicd.log.noLogsTitle')}
            message={t('cicd.log.noLogsMessage')}
          />
          {steps.length > 0 && (
            <div className="cicd-step-list">
              {steps.map((s) => (
                <div key={s.name} className="cicd-step">
                  <StatusWord outcome={s.outcome} />
                  <span className="grow ellipsis">{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : text === '' ? (
        <div className="cicd-log-body">
          <EmptyState compact title={t('cicd.log.emptyTitle')} message={t('cicd.log.emptyMessage')} />
        </div>
      ) : (
        <pre className="cicd-log-body mono">{text}</pre>
      )}

      {chunk?.withheldBytes !== undefined && chunk.withheldBytes > 0 && (
        <div className="panel-note is-watch">
          {t('cicd.log.withheld', { bytes: chunk.withheldBytes.toLocaleString() })}
        </div>
      )}
    </div>
  )
}
