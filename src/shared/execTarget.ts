/**
 * "Where should this command run" — a saved server, or this machine.
 *
 * Docker, Kubernetes, cron and the host-facts readers all take their command
 * runner by injection and pass a connection config straight through to it. A
 * local target is therefore not a new code path inside any of them: it is a
 * value they hand back unread, which main recognises when it binds the runner.
 *
 * ── Why this is a marker and not a Server ───────────────────────────────────
 *
 * The obvious shortcut is a pseudo-server row named "This machine". It must not
 * be done: `servers` is persisted and mirrored into the MCP data cache, so a
 * fake row there becomes an agent-addressable target the moment it is written —
 * `list_servers` would return it and `execute_command` would accept it, which
 * would hand an agent local execution with nobody having added a tool for it.
 * The local terminal avoids this the same way, with a `kind: 'local'` variant
 * on Tab rather than a synthesized Server.
 *
 * So this is an explicit per-call marker on the wire. Nothing persists it, and
 * the only code that acts on it is main's renderer-facing IPC layer. The MCP
 * bridge builds its own readers bound directly to sshExec, from servers it
 * resolved by name, and so cannot express this value at all.
 */

/** The marker the renderer sends in place of a connection config. */
export interface LocalTarget {
  local: true
}

export const LOCAL_TARGET: LocalTarget = { local: true }

/** Either this machine, or whatever connection config the feature already used. */
export type ExecTarget<TServer> = LocalTarget | TServer

/**
 * True when the caller asked for this machine.
 *
 * Deliberately exact rather than truthy: a config that merely happens to carry
 * a `local` field must not be mistaken for the marker, because the difference
 * decides whether a command runs here or on someone's production host.
 */
export function isLocalTarget(target: unknown): target is LocalTarget {
  return (
    typeof target === 'object' &&
    target !== null &&
    (target as { local?: unknown }).local === true
  )
}

/** Names the target for a message a person will read. */
export function targetLabel(target: unknown, serverName: string | undefined): string {
  return isLocalTarget(target) ? 'this machine' : (serverName ?? 'the server')
}

/**
 * The id a transient, never-persisted stand-in for this machine carries.
 *
 * Panels that list the estate and this machine side by side need SOME handle
 * for the local row — Drift and Posture each invented their own — and the
 * monitor pane needs one to key its polling on. This is that handle, in one
 * place.
 *
 * It is emphatically NOT a Server. Nothing bearing this id may be written into
 * the `servers` store: that store is persisted and mirrored into the MCP data
 * cache, so a row there becomes agent-addressable the moment it is saved. See
 * the note at the top of this file. A value built during render, handed to one
 * component and thrown away is a different thing entirely, and is what this is
 * for.
 */
export const LOCAL_ID = 'local'

/** What this machine is called on screen, wherever it appears beside servers. */
export const LOCAL_NAME = 'This machine'
