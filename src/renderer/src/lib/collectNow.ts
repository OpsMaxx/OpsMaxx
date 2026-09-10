import { bridgeHas } from './bridge'

/**
 * What a "Check now" has to call.
 *
 * `sampleNow()` sweeps, and a sweep collects metrics every time — but facts,
 * keys, posture and drift each sit behind their own hourly due time, and a
 * plain sweep does not clear them. So on an estate swept within the last hour,
 * a panel that called `sampleNow()` re-collected metrics, skipped the probe it
 * actually displays, then re-read the same cached values and rendered them
 * unchanged. That is indistinguishable from a button that does nothing, and it
 * is what these panels were reported for.
 *
 * `collectNow()` clears the due entries first, so the probe runs. This exists
 * as one function because the mistake was made independently in six panels:
 * the rule is easy to state and was nowhere enforced, and the failure is
 * silent everywhere it happens.
 *
 * The fallback is the usual preload-skew guard: under `electron-vite dev` the
 * renderer reloads while the process keeps the preload it booted with, so a
 * method added this session is undefined for the rest of it. A stale sweep is
 * better than a thrown error.
 */
export async function collectNow(serverIds?: readonly string[]): Promise<void> {
  const fleet = window.opsmaxx?.fleet as Record<string, unknown> | undefined
  if (bridgeHas(fleet, 'collectNow')) {
    await window.opsmaxx?.fleet?.collectNow(serverIds ? [...serverIds] : undefined)
    return
  }
  if (bridgeHas(fleet, 'sampleNow')) await window.opsmaxx?.fleet?.sampleNow()
}
