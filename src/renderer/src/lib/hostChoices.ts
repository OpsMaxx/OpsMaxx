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
  /** Appended in the option text, never used to exclude. */
  note: string | null
  connected: boolean
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
      note: connected ? null : 'not connected',
      connected
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
