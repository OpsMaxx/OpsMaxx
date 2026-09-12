import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../store/app'
import { bridgeHas } from '../../lib/bridge'
import type {
  CicdBridge,
  CicdConnection,
  CicdPanelState,
  CicdOutcome,
  CicdPipeline,
  CicdRun
} from '../../../../shared/cicd'

/**
 * The renderer half of the CI/CD module: shared state, and nothing that talks
 * to a provider.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CONNECTION LIST LIVES
 * ---------------------------------------------------------------------------
 *
 * In `store/app`, beside servers, databases and API collections, because two
 * panels on two different rails show the same accounts — the read panel in
 * Fleet Monitor and the trigger panel in Operations — and a list held by either
 * of them is a list the other disagrees with. Both panels still take a
 * `connections` prop so a test can render one without a store.
 *
 * NO TOKEN IS EVER HELD HERE. `CicdConnection.vaultEntryId` is a pointer and
 * main merges the secret at request time — see `src/shared/cicd.ts`. This
 * module is also forbidden from importing `store/vault` or the `vault` and
 * `secrets` bridge namespaces (`MODULE_FORBIDDEN_IMPORTS`), so it could not
 * hold one even by accident.
 */

/**
 * The connected accounts for the workspace that is open.
 *
 * Workspace-scoped like every other collection in `store/app`, and filtered
 * here rather than in the store because no other screen wants the list — a
 * selector added to `store/app` for one module is a selector the next reader
 * has to work out the owner of.
 */
export function useCicdConnectionList(): CicdConnection[] {
  return useApp(
    useShallow((s) => s.cicdConnections.filter((c) => c.workspaceId === s.activeWorkspaceId))
  )
}

/**
 * The preload bridge, or undefined in a build where it is not wired.
 *
 * Cast rather than read off `OpsMaxxApi`: `CicdBridge` in `src/shared/cicd.ts`
 * is the declaration all three sides import, and it is what this module codes
 * against. Every call site here is written to survive the namespace being
 * absent — the same rule `lib/bridge.ts` states for the rest of the app.
 */
export function cicdBridge(): CicdBridge | undefined {
  return (window as unknown as { opsmaxx?: { cicd?: CicdBridge } }).opsmaxx?.cicd
}

/**
 * Whether the wired bridge carries one member of the contract.
 *
 * `lib/bridge.ts`'s check, narrowed to `CicdBridge` so a typo in a member name
 * is a compile error rather than a control that is permanently grey. The
 * preload half is a separate file and can be older than this panel; a control
 * backed by a method that is not there must go grey WITH THE REASON on it,
 * which is the rule everywhere else in this app — a button that throws
 * `is not a function` into the console is the same silence, louder.
 */
export function cicdBridgeHas(bridge: CicdBridge | undefined, member: keyof CicdBridge): boolean {
  return bridgeHas(bridge as unknown as Record<string, unknown> | undefined, member)
}

/**
 * Everything main knows, keyed by connection.
 *
 * `snapshot()` first so a panel that mounts mid-outage is not blank until the
 * next tick, then `onState` for the updates. A state that arrives with `error`
 * set REPLACES nothing: `CicdPanelState` carries the last good pipelines
 * beside the failure, so an ageing row is the poller's own report rather than
 * something this hook reconstructs.
 */
export function useCicdState(bridge: CicdBridge | undefined): Map<string, CicdPanelState> {
  const [states, setStates] = useState<Map<string, CicdPanelState>>(new Map())

  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge
      .snapshot()
      .then((all) => {
        if (live) setStates(new Map(all.map((s) => [s.connectionId, s])))
      })
      .catch(() => undefined)
    const off = bridge.onState((s) => setStates((prev) => new Map(prev).set(s.connectionId, s)))
    return () => {
      live = false
      off()
    }
  }, [bridge])

  return states
}

/** A clock that makes "read 34s ago" count up instead of freezing at mount. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** Past this multiple of the interval the timestamp stops being current. */
export const STALE_INTERVALS = 3

/**
 * Whether the last successful read is old enough that the number beside it is
 * no longer a claim about now.
 *
 * Three intervals rather than one: a single missed tick is normal jitter, and
 * a panel that shouts at every one of them teaches the reader to ignore it.
 */
export function isStale(readAt: number | undefined, intervalSec: number, now: number): boolean {
  if (readAt === undefined) return true
  return now - readAt > intervalSec * STALE_INTERVALS * 1000
}

// ---------------------------------------------------------------------------
// What needs me
// ---------------------------------------------------------------------------

/**
 * The landing view is not a list of every pipeline.
 *
 * Buckets in priority order. `newly-failed` is separated from `failing` on the
 * only evidence the contract carries — a run that STARTED after the panel was
 * last looked at — because `CicdPipeline` holds one run and no history, so
 * "failed while you were away and has since recovered" is not derivable and is
 * not claimed.
 */
export type CicdBucket = 'failing' | 'newly-failed' | 'running' | 'queued' | 'succeeded' | 'other'

export const BUCKET_ORDER: CicdBucket[] = [
  'failing',
  'newly-failed',
  'running',
  'queued',
  'succeeded',
  'other'
]

export const BUCKET_LABEL: Record<CicdBucket, string> = {
  failing: 'Failing now',
  'newly-failed': 'Failed since you last looked',
  running: 'Running',
  queued: 'Queued',
  succeeded: 'Succeeded recently',
  other: 'Everything else'
}

export interface CicdRow {
  connectionId: string
  connectionName: string
  pipeline: CicdPipeline
  run: CicdRun
  bucket: CicdBucket
  /** True while the connection's last read attempt failed: this row is the
   *  last good answer, not a current one. */
  stale: boolean
}

export function bucketOf(outcome: CicdOutcome, startedAt: number | undefined, seenAt: number): CicdBucket {
  switch (outcome.status) {
    case 'failed':
      return startedAt !== undefined && startedAt > seenAt ? 'newly-failed' : 'failing'
    case 'running':
      return 'running'
    case 'queued':
      return 'queued'
    case 'success':
      return 'succeeded'
    default:
      return 'other'
  }
}

export const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Ranked rows, plus the pipelines the 24h window left out.
 *
 * The count of what fell outside is returned rather than dropped: a panel that
 * silently shows twelve of forty pipelines has told the reader it has forty.
 */
export function rankRows(
  connections: CicdConnection[],
  states: Map<string, CicdPanelState>,
  seenAt: number,
  now: number
): { rows: CicdRow[]; olderThanWindow: number; neverRun: number } {
  const rows: CicdRow[] = []
  let olderThanWindow = 0
  let neverRun = 0

  for (const conn of connections) {
    const state = states.get(conn.id)
    if (!state) continue
    const stale = state.error !== undefined
    for (const pipeline of state.pipelines) {
      const run = pipeline.last
      if (!run) {
        neverRun++
        continue
      }
      // A run with no start time is kept: `startedAt` is optional on the
      // contract and an absent one is not evidence the run is old.
      if (run.startedAt !== undefined && now - run.startedAt > WINDOW_MS) {
        olderThanWindow++
        continue
      }
      rows.push({
        connectionId: conn.id,
        connectionName: conn.name,
        pipeline,
        run,
        bucket: bucketOf(run.outcome, run.startedAt, seenAt),
        stale
      })
    }
  }

  rows.sort((a, b) => {
    const byBucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
    if (byBucket !== 0) return byBucket
    return (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0)
  })

  return { rows, olderThanWindow, neverRun }
}

/** Pipelines a trigger could actually reach, across every enabled connection. */
export function triggerablePipelines(
  connections: CicdConnection[],
  states: Map<string, CicdPanelState>
): { connection: CicdConnection; pipeline: CicdPipeline }[] {
  const out: { connection: CicdConnection; pipeline: CicdPipeline }[] = []
  for (const connection of connections) {
    const state = states.get(connection.id)
    if (!state) continue
    for (const pipeline of state.pipelines) {
      if (pipeline.triggerable) out.push({ connection, pipeline })
    }
  }
  return out
}

/** The one place the group path becomes a string, so the tree reads the same
 *  in the list, the workbench and the trigger confirm. */
export function pathLabel(pipeline: CicdPipeline): string {
  return pipeline.groupPath.map((s) => s.label).join(' / ')
}

