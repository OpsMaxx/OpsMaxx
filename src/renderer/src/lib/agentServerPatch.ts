/**
 * The plain fields of an agent's `update_server` patch, by name.
 *
 * Named rather than spread. A spread applies whatever the IPC message carried,
 * and some fields of a server record are not an agent's to set at all —
 * `shares` mounts folders from this computer on the server, which no agent path
 * may do (tests/reverseMountNotExposed.test.ts). Credentials and the route are
 * handled by the caller; they are not plain fields.
 */
const AGENT_FIELDS = ['name', 'host', 'port', 'username', 'auth', 'os', 'cloud'] as const

type AgentField = (typeof AGENT_FIELDS)[number]

export function agentServerFields<T extends object>(patch: T): Partial<Pick<T, Extract<keyof T, AgentField>>> {
  const out: Partial<Pick<T, Extract<keyof T, AgentField>>> = {}
  for (const key of AGENT_FIELDS) {
    const value = (patch as Record<string, unknown>)[key]
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}
