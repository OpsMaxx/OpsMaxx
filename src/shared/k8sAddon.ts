// Item 39's add-on verification view: for a label selector, is the thing that
// was just installed or upgraded actually running everywhere it should be.
//
// This is the buildable half of "upgrade the CNI", and everything in it comes
// from one measurement on k3s v1.31.5 running two DaemonSets side by side --
// one healthy, one whose container exits immediately.
//
//   NAME           DESIRED  CURRENT  READY  UP-TO-DATE  AVAIL   UNAVAIL
//   broken-addon   1        1        0      1           <none>  1
//   cni-like       1        1        1      1           1       <none>
//
// THREE THINGS IN THAT TABLE DECIDE THE WHOLE MODULE.
//
//  1. `broken-addon` IS FULLY ROLLED OUT. UP-TO-DATE equals DESIRED, which is
//     the column every "did the rollout finish" check reads, and its container
//     has never once started. Rollout completion and the add-on working are
//     different questions, and only the second one is why anybody upgrades a
//     CNI. AVAILABLE is the column that answers it.
//
//  2. `numberAvailable` AND `numberUnavailable` ARE BOTH `omitempty`, so each
//     one is ABSENT when it is zero -- see the `<none>` in a different column
//     on each row above. `numberReady` is not optional and is always printed.
//     So absent means zero HERE, specifically, for these two fields, and the
//     house rule that an unmeasured number is not zero does not apply to them.
//     Treating them as unknown would refuse to report a dead add-on.
//
//  3. A `rollout status` with no `--timeout` BLOCKS FOREVER on exactly the case
//     this view exists to catch. It is only usable one-shot with a deadline,
//     so the command builder below will not produce one without.

export const ADDON_DS_COLS =
  'custom-columns=NS:.metadata.namespace,NAME:.metadata.name,' +
  'DESIRED:.status.desiredNumberScheduled,CURRENT:.status.currentNumberScheduled,' +
  'READY:.status.numberReady,UPTODATE:.status.updatedNumberScheduled,' +
  'AVAIL:.status.numberAvailable,UNAVAIL:.status.numberUnavailable,' +
  'MISSCHED:.status.numberMisscheduled,GEN:.metadata.generation,' +
  'OBSGEN:.status.observedGeneration'

export const ADDON_EVENT_COLS =
  'custom-columns=NS:.metadata.namespace,REASON:.reason,KIND:.involvedObject.kind,' +
  'NAME:.involvedObject.name,COUNT:.count,LAST:.lastTimestamp,MSG:.message'

export interface AddonDaemonSet {
  namespace: string
  name: string
  desired: number
  current: number
  ready: number
  updated: number
  /** Absent in the read means zero -- `omitempty` on an int32, measured. */
  available: number
  unavailable: number
  misscheduled: number
  generation: number
  observedGeneration: number
}

/** `<none>` in a numeric column. Zero for the two `omitempty` fields, and null
 *  for anything genuinely unreadable, which the caller must not turn into a
 *  number. */
function num(v: string | undefined): number | null {
  const t = (v ?? '').trim()
  if (t === '' || t === '<none>' || t === '<nil>') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function parseAddonDaemonSets(text: string): AddonDaemonSet[] {
  const out: AddonDaemonSet[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 11) continue
    const req = [num(f[2]), num(f[3]), num(f[4]), num(f[5]), num(f[8]), num(f[9]), num(f[10])]
    // The seven fields that are NOT omitempty. If any is missing the row was
    // not read, and a row that was not read must not be graded.
    if (req.some((n) => n === null)) continue
    out.push({
      namespace: f[0],
      name: f[1],
      desired: req[0] as number,
      current: req[1] as number,
      ready: req[2] as number,
      updated: req[3] as number,
      available: num(f[6]) ?? 0,
      unavailable: num(f[7]) ?? 0,
      misscheduled: req[4] as number,
      generation: req[5] as number,
      observedGeneration: req[6] as number
    })
  }
  return out
}

export interface AddonVerdict {
  level: 'ok' | 'watch' | 'alarm' | 'unknown'
  because: string
}

/**
 * Whether this add-on is running, which is not whether its rollout finished.
 *
 * The order of the checks is the finding: availability is asked BEFORE
 * up-to-dateness, because a fully updated DaemonSet with nothing available is
 * the failure this view exists for and the up-to-date test would call it done.
 */
export function daemonSetVerdict(ds: AddonDaemonSet): AddonVerdict {
  const where = `${ds.namespace}/${ds.name}`
  if (ds.observedGeneration < ds.generation) {
    // Not a fault and not a success: the controller has not looked yet, so
    // every number below it describes the PREVIOUS version.
    return {
      level: 'unknown',
      because: `${where} has been changed and its controller has not acted on it yet, so these numbers are the previous version's.`
    }
  }
  if (ds.desired === 0) {
    // Every count is zero and every ratio is satisfied, so this reads as a
    // clean rollout in any check that compares columns. It means the selector
    // matches no node -- for a CNI, that it is installed nowhere.
    return {
      level: 'watch',
      because: `${where} is scheduled onto no nodes at all, so nothing was rolled out. Its node selector matches nothing on this cluster.`
    }
  }
  if (ds.available < ds.desired) {
    const done = ds.updated >= ds.desired
    return {
      level: 'alarm',
      because: done
        ? `${where} finished rolling out to all ${ds.desired} node(s) and ${ds.desired - ds.available} of them has no working pod. The rollout is complete and the add-on is not running.`
        : `${where} is part way through: ${ds.updated} of ${ds.desired} node(s) updated, ${ds.available} working.`
    }
  }
  if (ds.misscheduled > 0) {
    return {
      level: 'watch',
      because: `${where} has ${ds.misscheduled} pod(s) on nodes it should not be on.`
    }
  }
  return { level: 'ok', because: `${where} is running on all ${ds.desired} node(s).` }
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export interface K8sWarning {
  namespace: string
  reason: string
  kind: string
  name: string
  count: number
  last: string
  message: string
}

/**
 * Warnings that are on every cluster of this shape and mean nothing.
 *
 * `InvalidDiskCapacity` is emitted by the kubelet against the NODE at startup
 * on k3s-in-Docker and never goes away. It was in the measured fixture, above
 * the two real failures, and an add-on view that leads with it trains people to
 * scroll past the list.
 */
export const ADDON_WARNING_NOISE: ReadonlySet<string> = new Set(['InvalidDiskCapacity'])

/**
 * The message column is LAST and contains spaces, commas and quotes -- a real
 * one from the fixture is 180 characters of nested image-pull error. So the
 * first six fields are split and the rest is the message, undivided.
 */
export function parseWarnings(text: string): K8sWarning[] {
  const out: K8sWarning[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const f = line.split(/\s+/)
    if (f.length < 7) continue
    const head = f.slice(0, 6)
    const at = line.indexOf(head[5]) + head[5].length
    out.push({
      namespace: head[0],
      reason: head[1],
      kind: head[2],
      name: head[3],
      count: num(head[4]) ?? 1,
      last: head[5],
      message: line.slice(at).trim()
    })
  }
  return out
}

export interface WarningGroup {
  kind: string
  name: string
  reason: string
  /** Summed across the rows, which is what the cluster actually counted. */
  count: number
  last: string
  /** Every distinct message, in the order seen. */
  messages: string[]
}

/**
 * One line per (object, reason), because the raw list is not one per problem.
 *
 * Measured: two pods failing to pull ONE image produced SIX Warning rows -- the
 * pull error, `ErrImagePull` and `ImagePullBackOff` for each pod, all carrying
 * reason `Failed` and a count of 4. The whole fixture is eight rows and
 * describes two problems. Showing them raw makes the reader do the grouping,
 * and the row count is not the problem count in either direction.
 */
export function groupWarnings(warnings: K8sWarning[], includeNoise = false): WarningGroup[] {
  const by = new Map<string, WarningGroup>()
  for (const w of warnings) {
    if (!includeNoise && ADDON_WARNING_NOISE.has(w.reason)) continue
    const key = `${w.kind} ${w.name} ${w.reason}`
    const seen = by.get(key)
    if (seen === undefined) {
      by.set(key, {
        kind: w.kind,
        name: w.name,
        reason: w.reason,
        count: w.count,
        last: w.last,
        messages: [w.message]
      })
      continue
    }
    seen.count += w.count
    if (w.last > seen.last) seen.last = w.last
    if (!seen.messages.includes(w.message)) seen.messages.push(w.message)
  }
  return [...by.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
}

// ---------------------------------------------------------------------------
// One-shot rollout status
// ---------------------------------------------------------------------------

/**
 * `rollout status` with a deadline, never without one.
 *
 * Without `--timeout` it watches until the rollout finishes, which on the case
 * this view exists to catch is never.
 *
 * `--watch=false` is the obvious way to avoid that and it is WORSE. Measured
 * against the broken DaemonSet: it printed "Waiting for daemon set
 * "broken-addon" rollout to finish: 0 of 1 updated pods are available..." and
 * EXITED 0. A caller checking the exit code gets a success for an add-on that
 * has never started, which is why `parseRolloutStatus` requires the exit code
 * and the finished wording to agree before it says done.
 */
export function rolloutStatusCommand(ref: string, timeoutSeconds: number): string {
  const t = Math.max(1, Math.floor(timeoutSeconds))
  return `rollout status ${ref} --timeout=${t}s`
}

export interface RolloutStatus {
  /** True only on a clean finish. A timeout is NOT a failure of the add-on and
   *  NOT a success -- it is the rollout still being unfinished when we stopped
   *  asking, which is why it has its own field. */
  done: boolean
  timedOut: boolean
  text: string
}

export function parseRolloutStatus(output: string, exitCode: number): RolloutStatus {
  const text = output.trim()
  if (exitCode === 0 && /successfully rolled out/.test(text)) {
    return { done: true, timedOut: false, text }
  }
  const timedOut = /timed out waiting for the condition/.test(text)
  return { done: false, timedOut, text }
}
