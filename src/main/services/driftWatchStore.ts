import { DRIFT_WATCHES, type DriftWatch } from '../../shared/drift'
import { checkDriftWatch, type DriftWatchProposal } from '../../shared/driftWatch'

// The main-process copy of the operator's custom drift watches.
//
// Modelled on `accessWriteGate.ts`, and for the same reason stated there: a
// renderer-side check constrains only the honest UI. `checkDriftWatch` running
// in a settings dialog is a good dialog; it is not a defence, because the
// threat is a blob on disk or a compromised renderer putting a path into
// `data:save` that no dialog ever saw.
//
// EVERY STORED WATCH IS RE-VALIDATED HERE, on every sync, against the same
// checker the dialog uses. That is the whole point of the file: the path ends
// up interpolated into a shell script by `buildDriftCommand`, so the process
// that runs the script is the process that has to be sure about the path.
//
// AND THE DEFAULT IS THE CATALOGUE, NOT AN EMPTY LIST. A settings blob that
// predates this key, a half-written one, a renderer that never sent one — every
// path where we do not positively know what the operator chose ends with the
// fixed catalogue and nothing else, which is what shipped before this existed.

let custom: DriftWatch[] = []

/** What a stored watch looks like in the settings blob. Deliberately the
 *  proposal shape rather than a `DriftWatch`: the id, the label fallback and
 *  the rule ordering are derived by the checker, so a blob cannot assert them. */
interface StoredWatch {
  path?: unknown
  label?: unknown
  comment?: unknown
  rules?: unknown
}

function asProposal(v: StoredWatch): DriftWatchProposal {
  return {
    path: typeof v.path === 'string' ? v.path : '',
    label: typeof v.label === 'string' ? v.label : '',
    comment: typeof v.comment === 'string' ? v.comment : '#',
    // `Array.isArray` and nothing more. It arrives by structured clone, where
    // a `string[]` annotation is a claim, so the guard is real -- a string here
    // would make `.some` below throw. Filtering the ELEMENTS would be dead
    // code: `checkDriftWatch` refuses any member that is not a known rule id,
    // and a second filter that reads as though it were keeping that invariant
    // is worse than no filter at all.
    rules: Array.isArray(v.rules) ? (v.rules as never[]) : []
  }
}

/**
 * Read the custom watches out of the renderer's data blob.
 *
 * A watch that fails the check is DROPPED rather than repaired. There is no
 * safe repair for a path that could break out of a shell literal, and silently
 * fixing one would mean the file being read is not the file that was approved.
 */
export function syncDriftWatches(data: unknown): void {
  const raw = (data as { settings?: { driftWatches?: unknown } } | null)?.settings?.driftWatches
  if (!Array.isArray(raw)) {
    custom = []
    return
  }
  const out: DriftWatch[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    // Checked against what has been accepted SO FAR as well as the catalogue,
    // so a blob containing the same path twice cannot produce two watches with
    // one id.
    const check = checkDriftWatch(asProposal(entry as StoredWatch), [...DRIFT_WATCHES, ...out])
    if (check.ok) out.push(check.watch)
  }
  custom = out
}

/** The catalogue plus whatever survived validation. The catalogue is always
 *  first, so a custom watch cannot displace one. */
export function driftWatchesForCollection(): DriftWatch[] {
  return [...DRIFT_WATCHES, ...custom]
}

/** Test seam. Not exported to the renderer and not reachable over IPC. */
export function setDriftWatchesForTests(watches: DriftWatch[]): void {
  custom = watches
}
