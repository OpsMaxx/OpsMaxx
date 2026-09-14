/**
 * The API client's workspace, as it is written to disk and read back.
 *
 * ── Why this is not just `exportWorkspace()` ───────────────────────────────
 *
 * The client's own export is an `InMemoryWorkspace`:
 *
 *     meta + documents + originalDocuments + intermediateDocuments
 *         + overrides + history + auth
 *
 * Three of those are disqualifying for a file OpsMaxx persists and backs up:
 *
 *   - `originalDocuments` and `intermediateDocuments` are two further copies
 *     of every document. A real OpenAPI description is measured in megabytes,
 *     and everything here goes into ONE `opsmaxx-data.json` written whole, on
 *     a debounce, from the main process. Three copies of a 6 MB description is
 *     not a settings file.
 *   - `history` is every response body the client has ever received. Response
 *     bodies are not configuration and have no business in a backup.
 *   - `auth` is the credentials someone typed into the auth selector, in
 *     clear. That is the one thing that must never be written here, and it is
 *     the reason this module exists rather than a `JSON.stringify` at the call
 *     site.
 *
 * So the snapshot is a deliberate projection: the workspace's own settings
 * (environments, cookies, tabs, selections) plus one copy of each document.
 * Everything else is either recoverable or must not be kept.
 *
 * Secrets, for the avoidance of doubt: environment variables hold a
 * `vault:<entryId>#field` REFERENCE rather than a value (see
 * `shared/apiSecrets.ts`), so a variable that survives into this snapshot
 * carries a pointer and not a credential. `auth` is dropped because it is the
 * one place the client stores a literal.
 */

/** The `InMemoryWorkspace` shape, as much of it as this module handles. */
export interface WorkspaceLike {
  meta?: unknown
  documents?: Record<string, unknown>
  originalDocuments?: Record<string, unknown>
  intermediateDocuments?: Record<string, unknown>
  overrides?: Record<string, unknown>
  history?: unknown
  auth?: unknown
}

export interface ApiWorkspaceSnapshot {
  version: 1
  /** Environments, cookies, tabs and which of each is active. */
  meta: unknown
  documents: Record<string, unknown>
  /**
   * What each document was built from, in the client's own terms.
   *
   * Without this a restored workspace is indistinguishable from an empty one:
   * the client would rebuild every document from its collection and overwrite
   * the restored copy, discarding exactly the edits this snapshot exists to
   * keep.
   */
  sourceKeys: Record<string, string>
  /**
   * Documents dropped to stay under the size cap, and therefore rebuilt from
   * their collection on load. Recorded rather than silently omitted so the
   * difference between "never saved" and "too big to save" stays visible.
   */
  shed?: string[]
}

/**
 * 4 MiB of serialized JSON.
 *
 * The whole of `opsmaxx-data.json` is stringified, copied to a `.bak` and
 * atomically rewritten on a 400 ms debounce, synchronously, in the main
 * process. A workspace that grows without limit turns every keystroke in the
 * API client into a multi-megabyte write, and the jank lands on the process
 * that also runs every SSH session.
 *
 * ponytail: one blob with a fixed cap. If somebody's workspace legitimately
 * exceeds this, the answer is its own file through `services/store.ts`, not a
 * bigger number.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

/** Documents whose content can be fetched again, so they are shed first. */
export type Rebuildable = (slug: string) => boolean

/**
 * A snapshot of the workspace, small enough to keep.
 *
 * Shedding order matters and is not arbitrary: a document that came from a
 * `specUrl` or a `specPath` is re-read every time the collection is opened
 * anyway, so dropping it costs nothing but a fetch. A hand-written one exists
 * ONLY here — dropping it is data loss — so it is shed last and only if
 * shedding everything else was not enough.
 */
export function toSnapshot(
  workspace: WorkspaceLike,
  sourceKeys: Record<string, string>,
  isRebuildable: Rebuildable = () => false
): ApiWorkspaceSnapshot {
  const documents: Record<string, unknown> = { ...(workspace.documents ?? {}) }
  const snapshot: ApiWorkspaceSnapshot = {
    version: 1,
    meta: workspace.meta ?? {},
    documents,
    sourceKeys: { ...sourceKeys }
  }

  if (sizeOf(snapshot) <= MAX_SNAPSHOT_BYTES) return snapshot

  const shed: string[] = []
  // Biggest first within each group: shedding the largest re-fetchable
  // document is the one that buys the most room per thing given up.
  const order = [
    ...Object.keys(documents).filter(isRebuildable),
    ...Object.keys(documents).filter((s) => !isRebuildable(s))
  ]

  for (const slug of order) {
    if (sizeOf(snapshot) <= MAX_SNAPSHOT_BYTES) break
    delete documents[slug]
    // The source key goes with it. A slug with a key but no document would
    // tell the client the document is current and stop it being rebuilt,
    // which is how a shed collection would come back empty.
    delete snapshot.sourceKeys[slug]
    shed.push(slug)
  }

  if (shed.length > 0) snapshot.shed = shed
  return snapshot
}

/**
 * The workspace to hand back to the client.
 *
 * The three dropped maps come back empty rather than absent: the client reads
 * them by key, and `undefined` where it expects an object is a different bug
 * from "there is nothing in here yet".
 */
export function fromSnapshot(snapshot: ApiWorkspaceSnapshot): Required<WorkspaceLike> {
  return {
    meta: snapshot.meta ?? {},
    documents: snapshot.documents ?? {},
    originalDocuments: {},
    intermediateDocuments: {},
    overrides: {},
    history: {},
    auth: {}
  }
}

/**
 * Whether a value is a snapshot this version can read.
 *
 * Anything else — an older shape, a truncated file, something hand-edited —
 * is treated as "no snapshot" rather than being coerced. A workspace restored
 * from a shape we do not understand is worse than one rebuilt from the
 * collections, which always works.
 */
export function isSnapshot(value: unknown): value is ApiWorkspaceSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<ApiWorkspaceSnapshot>
  return (
    v.version === 1 &&
    typeof v.documents === 'object' &&
    v.documents !== null &&
    typeof v.sourceKeys === 'object' &&
    v.sourceKeys !== null
  )
}

function sizeOf(snapshot: ApiWorkspaceSnapshot): number {
  try {
    return JSON.stringify(snapshot).length
  } catch {
    // A cycle or a BigInt somewhere in a document. It cannot be persisted at
    // all, so report it as over the cap and let the shedding empty it out.
    return Number.POSITIVE_INFINITY
  }
}
