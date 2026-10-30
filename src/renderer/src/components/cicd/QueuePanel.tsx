import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import type { Translate } from '../../../../shared/i18n'
import { remoteText } from '../../../../shared/remoteText'
import { EmptyState } from '../common/EmptyState'
import { cicdBridgeHas } from './state'
import { Reading } from './Reading'
import type { CicdBridge, CicdCapacity, CicdConnection, CicdQueueItem } from '../../../../shared/cicd'

/**
 * Why nothing is running.
 *
 * The run feed answers "did it pass". This answers the question an operator
 * actually asks at 9am when a deploy has not appeared: is it queued, and if so
 * what is it waiting for. A queue of four against zero idle executors is a
 * different morning from an empty queue, and until now the only place to tell
 * them apart was the provider's own UI.
 *
 * Jenkins-only, and it says so rather than showing an empty table. An empty
 * table reads as "nothing is queued", which is a claim -- and for a provider
 * nothing has asked, it would be a claim nothing had checked.
 *
 * Read on demand rather than polled. The scheduler's budget is spent on runs,
 * which is what ages; a queue is only interesting while somebody is looking at
 * it, and the button says when it was last read.
 */
export function QueuePanel({
  connections,
  bridge,
  canTrigger = false
}: {
  connections: readonly CicdConnection[]
  bridge?: CicdBridge
  /** `cicdTrigger`. Decided at the mount point; this only renders it. */
  canTrigger?: boolean
}): React.JSX.Element {
  const t = useT()
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '')
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'reading' }
    | { kind: 'ok'; items: CicdQueueItem[]; capacity: CicdCapacity; at: number }
    | { kind: 'failed'; error: string }
  >({ kind: 'idle' })
  const [dropping, setDropping] = useState<number | null>(null)
  const can = cicdBridgeHas(bridge, 'queue')
  const canDrop = canTrigger && cicdBridgeHas(bridge, 'cancelQueueItem')

  const read = useCallback((): void => {
    if (!can || connectionId === '') return
    setState({ kind: 'reading' })
    void bridge!
      .queue(connectionId)
      .then((r) => setState({ kind: 'ok', ...r, at: Date.now() }))
      .catch((err: unknown) =>
        setState({ kind: 'failed', error: err instanceof Error ? err.message : String(err) })
      )
  }, [bridge, can, connectionId])

  useEffect(() => read(), [read])

  return (
    <div className="cicd-queue">
      <div className="row cicd-filters">
        {connections.length > 1 && (
          <select
            className="input"
            value={connectionId}
            aria-label={t('cicd.queue.account')}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn secondary size-28"
          disabled={!can || state.kind === 'reading'}
          title={
            can
              ? t('cicd.queue.readTitle')
              : t('cicd.queue.unavailableTitle')
          }
          onClick={read}
        >
          {state.kind === 'reading' ? (
            <Loader2 size={13} className="spin" aria-hidden />
          ) : (
            <RefreshCw size={13} />
          )}
          {state.kind === 'reading' ? t('cicd.common.reading') : t('cicd.common.readNow')}
        </button>
      </div>

      {state.kind === 'failed' && <p className="field-hint danger">{state.error}</p>}
      {/* A queue read is one HTTP call, but a Jenkins controller under load is
          exactly when somebody opens this tab — so "is it working or is it
          hung" is a real question here too, and a full stop cannot answer it. */}
      {state.kind === 'reading' && <Reading label={t('cicd.queue.reading')} />}

      {state.kind === 'ok' && (
        <>
          <Capacity capacity={state.capacity} queued={state.items.length} />

          <h4 className="ui-label">{t('cicd.queue.queueHeading')}</h4>
          {state.items.length === 0 ? (
            <EmptyState
              compact
              title={t('cicd.queue.emptyTitle')}
              message={t('cicd.queue.emptyMessage')}
            />
          ) : (
            <div className="cicd-rows">
              {state.items.map((i) => (
                <div key={i.id} className="cicd-queue-row">
                  {/* A word, not a colour: stuck and blocked are different, and
                      a reader who sees neither still has to be able to tell. */}
                  <span
                    className={clsx(
                      'cicd-status',
                      i.stuck ? 'state-alarm' : i.blocked ? 'state-watch' : 'state-unknown'
                    )}
                  >
                    <span
                      className={clsx(
                        'state-dot',
                        i.stuck ? 'is-alarm' : i.blocked ? 'is-watch' : 'is-unknown'
                      )}
                      aria-hidden="true"
                    />
                    {i.stuck
                      ? t('cicd.queue.stuck')
                      : i.blocked
                        ? t('cicd.queue.blocked')
                        : t('cicd.queue.waiting')}
                  </span>
                  <span className="ellipsis">{remoteText(i.name)}</span>
                  <span className="spacer" />
                  {i.since !== undefined && (
                    <span className="cicd-row-age">{waitingFor(i.since, t)}</span>
                  )}
                  {canDrop && (
                    <button
                      type="button"
                      className="btn secondary size-24"
                      disabled={dropping === i.id}
                      title={t('cicd.queue.dropTitle')}
                      onClick={() => {
                        setDropping(i.id)
                        void bridge!
                          .cancelQueueItem(connectionId, i.id)
                          .catch(() => undefined)
                          .finally(() => {
                            setDropping(null)
                            read()
                          })
                      }}
                    >
                      {dropping === i.id ? t('cicd.queue.dropping') : t('cicd.queue.drop')}
                    </button>
                  )}
                </div>
              ))}
              {/* The reason lives under the row it belongs to: it is a sentence,
                  not a field, and it is the most useful thing on the screen. */}
              {state.items.map((i) =>
                i.why === undefined ? null : (
                  <p key={`why-${i.id}`} className="cicd-queue-why">
                    {remoteText(i.name)}: {remoteText(i.why)}
                  </p>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Capacity({
  capacity,
  queued
}: {
  capacity: CicdCapacity
  queued: number
}): React.JSX.Element {
  const t = useT()
  const idle = Math.max(0, capacity.totalExecutors - capacity.busyExecutors)
  return (
    <>
      <div className="panel-stats">
        <span>
          {t('cicd.queue.executorsBusy', {
            busy: capacity.busyExecutors,
            count: capacity.totalExecutors
          })}
        </span>
        <span className="faint">
          {idle === 0 && queued > 0
            ? t('cicd.queue.noCapacity')
            : t('cicd.queue.idleFree', { idle })}
        </span>
      </div>

      <h4 className="ui-label">{t('cicd.queue.agentsHeading')}</h4>
      <div className="cicd-rows">
        {capacity.agents.map((a) => (
          <div key={a.name} className="cicd-queue-row">
            <span className={clsx('cicd-status', a.offline ? 'state-alarm' : 'state-ok')}>
              <span
                className={clsx('state-dot', a.offline ? 'is-alarm' : 'is-ok')}
                aria-hidden="true"
              />
              {a.offline
                ? a.temporarilyOffline
                  ? t('cicd.queue.takenOffline')
                  : t('cicd.queue.offline')
                : t('cicd.queue.online')}
            </span>
            <span className="ellipsis">{remoteText(a.name)}</span>
            <span className="ui-note">
              {!a.offline && a.idle
                ? t('cicd.queue.agentExecutorsIdle', { count: a.executors })
                : t('cicd.queue.agentExecutors', { count: a.executors })}
            </span>
            <span className="spacer" />
            {a.diskFreeBytes !== undefined && (
              <span className="cicd-row-age">
                {t('cicd.queue.diskFree', { size: gib(a.diskFreeBytes) })}
              </span>
            )}
          </div>
        ))}
        {capacity.agents.map((a) =>
          a.offlineReason === undefined ? null : (
            <p key={`why-${a.name}`} className="cicd-queue-why">
              {remoteText(a.name)}: {remoteText(a.offlineReason)}
            </p>
          )
        )}
      </div>
    </>
  )
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

function waitingFor(since: number, t: Translate): string {
  const mins = Math.max(0, Math.round((Date.now() - since) / 60_000))
  if (mins < 60) return t('cicd.queue.waitingMinutes', { mins })
  const hours = Math.round(mins / 60)
  return hours < 48
    ? t('cicd.queue.waitingHours', { hours })
    : t('cicd.queue.waitingDays', { days: Math.round(hours / 24) })
}
