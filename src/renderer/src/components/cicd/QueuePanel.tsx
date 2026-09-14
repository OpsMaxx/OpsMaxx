import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { clsx } from '../../lib/format'
import { remoteText } from '../../../../shared/remoteText'
import { EmptyState } from '../common/EmptyState'
import { cicdBridgeHas } from './state'
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
  bridge
}: {
  connections: readonly CicdConnection[]
  bridge?: CicdBridge
}): React.JSX.Element {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '')
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'reading' }
    | { kind: 'ok'; items: CicdQueueItem[]; capacity: CicdCapacity; at: number }
    | { kind: 'failed'; error: string }
  >({ kind: 'idle' })
  const can = cicdBridgeHas(bridge, 'queue')

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
            aria-label="Account"
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
              ? 'Read the queue and the executors now.'
              : 'This build cannot read a queue. Restart the app to rebuild the bridge.'
          }
          onClick={read}
        >
          <RefreshCw size={13} />
          {state.kind === 'reading' ? 'Reading...' : 'Read now'}
        </button>
      </div>

      {state.kind === 'failed' && <p className="field-hint danger">{state.error}</p>}
      {state.kind === 'reading' && <p className="ui-note">Reading...</p>}

      {state.kind === 'ok' && (
        <>
          <Capacity capacity={state.capacity} queued={state.items.length} />

          <h4 className="ui-label">Queue</h4>
          {state.items.length === 0 ? (
            <EmptyState
              compact
              title="Nothing is queued"
              message="Every build this account can see has either started or finished."
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
                    {i.stuck ? 'STUCK' : i.blocked ? 'BLOCKED' : 'WAITING'}
                  </span>
                  <span className="ellipsis">{remoteText(i.name)}</span>
                  <span className="spacer" />
                  {i.since !== undefined && (
                    <span className="cicd-row-age">{waitingFor(i.since)}</span>
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
  const idle = Math.max(0, capacity.totalExecutors - capacity.busyExecutors)
  return (
    <>
      <div className="panel-stats">
        <span>
          {capacity.busyExecutors} of {capacity.totalExecutors} executor
          {capacity.totalExecutors === 1 ? '' : 's'} busy
        </span>
        <span className="faint">
          {idle === 0 && queued > 0
            ? 'Nothing is free, so the queue is waiting on capacity rather than on a fault.'
            : `${idle} free`}
        </span>
      </div>

      <h4 className="ui-label">Agents</h4>
      <div className="cicd-rows">
        {capacity.agents.map((a) => (
          <div key={a.name} className="cicd-queue-row">
            <span className={clsx('cicd-status', a.offline ? 'state-alarm' : 'state-ok')}>
              <span
                className={clsx('state-dot', a.offline ? 'is-alarm' : 'is-ok')}
                aria-hidden="true"
              />
              {a.offline ? (a.temporarilyOffline ? 'TAKEN OFFLINE' : 'OFFLINE') : 'ONLINE'}
            </span>
            <span className="ellipsis">{remoteText(a.name)}</span>
            <span className="ui-note">
              {a.executors} executor{a.executors === 1 ? '' : 's'}
              {!a.offline && a.idle ? ', idle' : ''}
            </span>
            <span className="spacer" />
            {a.diskFreeBytes !== undefined && (
              <span className="cicd-row-age">{gib(a.diskFreeBytes)} free</span>
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

function waitingFor(since: number): string {
  const mins = Math.max(0, Math.round((Date.now() - since) / 60_000))
  if (mins < 60) return `waiting ${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `waiting ${hours}h` : `waiting ${Math.round(hours / 24)}d`
}
