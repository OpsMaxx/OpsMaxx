import { createHash } from 'node:crypto'

/**
 * Three-way merge for a collection that is a list of identified records.
 *
 * WHY THIS EXISTS. The sync unit was the whole `servers` array: add a host on
 * the laptop while deleting one on the phone inside the same five-minute
 * window and the result was not a merge, it was a conflict a person had to
 * open the chooser and resolve. `sync.ts` names the case exactly — "these
 * differ in one entry and I want both" — and for one person with three devices
 * and a large fleet it is routine.
 *
 * WHY NOT PER-ITEM METADATA ON THE WIRE. The obvious design is `updatedAt` and
 * `deletedAt` on every record inside the sealed payload. It costs a schema bump
 * — which puts every device on an older build into read-only until it updates,
 * by `ErrSchemaTooNew` in protocol/object.go — and it needs tombstones, because
 * a delete is currently expressed by absence and an item-wise merge without
 * them resurrects every one.
 *
 * None of that is necessary if the BASE is available, and it is: the last state
 * this device agreed with the relay about. With a common ancestor, "absent
 * here and present there" stops being ambiguous — it is a delete if the
 * ancestor had it and an add if it did not — and the merge is an ordinary
 * three-way one. The payload on the wire does not change at all, so a device on
 * an older build reads a merged collection exactly as it reads any other.
 *
 * WHAT IS KEPT AS THE BASE. Not the records — a fingerprint per id. It answers
 * both questions the merge asks ("was this record present" and "has it changed
 * since") and nothing else, so `opsmaxx-addy-sync.json` does not become a
 * second plaintext copy of the estate sitting beside the sealed one. Ids are
 * generated and opaque; hostnames, usernames and labels are not in here.
 */

/** Stable stringify: same bytes for the same record whatever order the keys
 *  arrived in. Two builds serialising one record differently must not read as
 *  an edit on both sides, because that is a conflict nobody made. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

const fingerprint = (item: unknown): string =>
  createHash('sha256').update(canonical(item)).digest('hex').slice(0, 16)

interface Identified {
  id: string
}

/** The records, if this payload is a list of them, or null if it is anything
 *  else. `apiWorkspace` is an object and several collections may not stay
 *  lists, so this is a question asked per payload rather than a list of names
 *  kept somewhere that can go stale. */
export function asRecords(payload: Buffer): Identified[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.toString('utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: Identified[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null
    const id = (item as Identified).id
    // Duplicate ids would make "the record with this id" ambiguous and the
    // merge would silently drop one. Refuse the whole payload instead.
    if (typeof id !== 'string' || !id || out.some((o) => o.id === id)) return null
    out.push(item as Identified)
  }
  return out
}

/** What this device last agreed with the relay: id -> fingerprint. */
export type Base = Record<string, string>

export function baseOf(payload: Buffer): Base | null {
  const records = asRecords(payload)
  if (!records) return null
  const base: Base = {}
  for (const r of records) base[r.id] = fingerprint(r)
  return base
}

export interface MergeResult {
  merged: Buffer
  /** For the log line, and for the panel to say what it did rather than just
   *  that it did something. */
  added: number
  removed: number
  updated: number
}

/**
 * Merge local and remote against the base they both came from.
 *
 * Returns null when it must NOT decide — a payload that is not a list of
 * records, a missing base, or a record that both sides changed differently.
 * The caller then falls back to the conflict copy and the chooser, which is
 * the existing behaviour and the right one: the whole point is to stop asking
 * a person about edits that do not overlap, not to start guessing about edits
 * that do.
 */
export function mergeCollections(
  base: Base | undefined,
  local: Buffer,
  remote: Buffer
): MergeResult | null {
  if (!base) return null
  const localRecords = asRecords(local)
  const remoteRecords = asRecords(remote)
  if (!localRecords || !remoteRecords) return null

  const R = new Map(remoteRecords.map((r) => [r.id, r]))

  let added = 0
  let removed = 0
  let updated = 0
  const out: Identified[] = []
  const emitted = new Set<string>()

  const changed = (id: string, item: Identified): boolean =>
    !(id in base) || base[id] !== fingerprint(item)

  // Local order first, then whatever only the remote has. Deterministic, and it
  // keeps the order the person on THIS device arranged rather than reshuffling
  // their list because another device pushed.
  for (const l of localRecords) {
    const r = R.get(l.id)
    emitted.add(l.id)
    if (!r) {
      // Gone on the remote. A delete if the base had it, an add of ours if not.
      if (l.id in base) {
        if (changed(l.id, l)) return null // edited here, deleted there
        removed++
        continue
      }
      added++
      out.push(l)
      continue
    }
    const lChanged = changed(l.id, l)
    const rChanged = changed(r.id, r)
    if (lChanged && rChanged) {
      // Both touched it. Identical edits are not a conflict; different ones are
      // the one thing this function refuses to decide.
      if (canonical(l) !== canonical(r)) return null
      out.push(l)
      updated++
      continue
    }
    if (lChanged) {
      out.push(l)
      updated++
      continue
    }
    if (rChanged) {
      out.push(r)
      updated++
      continue
    }
    out.push(l)
  }

  for (const r of remoteRecords) {
    if (emitted.has(r.id)) continue
    if (r.id in base) {
      // Deleted here. Honour it unless the other device edited it meanwhile,
      // which is a question for a person.
      if (changed(r.id, r)) return null
      removed++
      continue
    }
    added++
    out.push(r)
  }

  return { merged: Buffer.from(JSON.stringify(out), 'utf8'), added, removed, updated }
}
