import type { Server } from '../types'

/**
 * Which servers a host dropdown offers, and which one it starts on.
 *
 * ===========================================================================
 * WHY THIS IS NOT `servers.filter((s) => s.status !== 'offline')`
 * ===========================================================================
 *
 * Six panels shared that line — Docker, Kubernetes, cron, cron editing, log
 * tail and broadcast — and it did two jobs at once: it chose the default AND
 * it decided what existed. The second job is the one that was wrong.
 *
 * `Server.status` is written from one place, the terminal transport's
 * lifecycle callback, on the edge of a connect. It is not a probe and not a
 * heartbeat: nothing re-asserts it, so a host that has not been opened in this
 * session reads `offline` whether or not it is reachable. A user watching a
 * live shell on a server they could not find in the Docker dropdown was
 * looking at exactly that.
 *
 * And the filter is not even answering the right question. These panels run
 * `docker ps` and `kubectl` over SSH, which dials the host on demand — an
 * existing connection is convenient, never a precondition. Removing a row
 * because of a field that is stale by construction takes away the one action
 * that would have corrected it.
 *
 * So everything is listed and everything is selectable. What `status` is still
 * good for is a sensible STARTING point and an honest label, which is all it
 * ever reliably meant.
 */

/** A host as a dropdown offers it. */
export interface HostChoice {
  id: string
  name: string
  /** Appended in the option text, never used to exclude. `null` when the host
   *  is dialled — there is nothing to say about the ordinary case.
   *
   *  Deliberately the ONLY status-derived field here. An earlier draft also
   *  carried a `connected` boolean that neither consumer read: the option text
   *  uses `note`, and the empty-state wording asks `anyConnected(servers)`,
   *  which recomputes from the servers themselves. A second way to ask the
   *  same question is how the two come to disagree. */
  note: string | null
}

const CONNECTED = new Set(['online', 'idle', 'connecting'])

export function hostChoices(servers: Server[]): HostChoice[] {
  return servers.map((s) => {
    const connected = CONNECTED.has(s.status)
    return {
      id: s.id,
      name: s.name,
      // Says what is known without claiming more than the field supports.
      // "offline" would be a statement about the host; this is a statement
      // about this app's session with it, which is the only thing `status`
      // actually records.
      note: connected ? null : 'not connected'
    }
  })
}

/**
 * The id a panel should start on: the first connected host, else the first
 * host at all, else null for "nothing saved here".
 *
 * Preferring a connected one keeps the old default behaviour, which was the
 * defensible half of the filter — opening a panel on a host that is already
 * dialled is a better first guess than the alphabetically first one.
 */
export function defaultHostId(servers: Server[]): string | null {
  return servers.find((s) => CONNECTED.has(s.status))?.id ?? servers[0]?.id ?? null
}

/** Whether ANY host here is currently dialled. For empty-state wording only —
 *  never for deciding what may be selected. */
export function anyConnected(servers: Server[]): boolean {
  return servers.some((s) => CONNECTED.has(s.status))
}

/**
 * Which host id a panel should actually act on, given what it has stored.
 *
 * Both Docker and Kubernetes hold the selection in component-local state, which
 * outlives the thing it names: delete the server, or switch to a workspace
 * without it, and the panel still holds the old id. Resolving here rather than
 * reading `serverId` straight is what keeps the dropdown and the target from
 * disagreeing — a stale id matches no `<option>`, so the browser renders the
 * select blank while the panel believes it has a target.
 *
 * THE LOCAL SENTINEL IS A VALID ANSWER AND MUST SURVIVE.
 *
 * `localId` is not a row in `servers` — deliberately, because that list is
 * persisted and mirrored into the MCP data cache, so a pseudo-server would
 * become an agent-addressable target the moment it was written. The staleness
 * check was `servers.some(...)` alone, which is false for the sentinel for
 * exactly that reason, so choosing "This machine" was discarded as stale and
 * the panel snapped back to `defaultHostId`. Reported as "This machine option
 * is not getting selected" on both panels: with any saved server present it
 * was impossible to target the local daemon at all.
 *
 * Returns the sentinel only when there is nothing saved to prefer, which is the
 * fallback that keeps a panel with no servers usable rather than dead.
 */
export function resolveHostId(stored: string, servers: Server[], localId: string): string {
  if (stored === localId) return localId
  if (stored !== '' && servers.some((s) => s.id === stored)) return stored
  return defaultHostId(servers) ?? localId
}
