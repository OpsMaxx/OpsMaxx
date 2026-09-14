// Writing to OpsMaxx's own configuration has to happen in the renderer: it owns
// the connection list, the tunnel list and the persistence that auto-saves from
// them — and that save is what refreshes the MCP cache main reads back. Main
// asks for the work and awaits the answer, the same shape as the
// keyboard-interactive prompt round trip in index.ts.
//
// TWO SEAMS, DELIBERATELY. `setAgentServerCreator` is the original add path and
// keeps its own shape: it is the one operation that also carries a credential,
// the renderer does noticeably more for it than a store call (vault vs keychain,
// and a rollback when the keychain refuses), and its integration test stubs this
// exact signature. `setAgentConfigWriter` is everything that came after — edits,
// removals and tunnels — which are all "call one store action and report back".
// Collapsing them would have meant rewriting the add path's test to prove a
// refactor, which is the wrong thing to spend a rewrite on.

import type { CloudTarget } from '../../shared/cloud'
import type { SshAuth } from '../../shared/ssh'
import type { TunnelKind } from '../../shared/tunnel'

/** One jump hop, already resolved from a friendly name to a saved server.
 *
 *  `serverId` is the whole point: the hop authenticates with THAT server's
 *  stored credential, resolved at dial time by resolveChainSecrets, so nothing
 *  here carries a secret. The rest is what the renderer's own hop editor copies
 *  off the picked server (see RouteHops.selectSavedServer) and is needed so the
 *  saved record renders without a second lookup. */
export interface AgentHop {
  serverId: string
  label: string
  host: string
  port: number
  username: string
  auth: SshAuth
}

export interface AgentServerRequest {
  workspaceId: string
  name: string
  /** Empty for a cloud server: the provider resolves the address at connect time. */
  host: string
  port: number
  username: string
  auth: 'password' | 'key' | 'agent'
  password?: string
  keyPath?: string
  passphrase?: string
  os?: string
  /** The jump chain, first hop dialled first. Absent means connect directly. */
  route?: AgentHop[]
  /**
   * Reach this server through a cloud provider instead of dialling `host`.
   *
   * Validated before it gets here and validated again on the way back out of
   * the data cache. It carries identifiers only - there is no credential to
   * pass, because the provider's own CLI holds the session.
   */
  cloud?: CloudTarget
}

export interface AgentServerResult {
  ok: boolean
  serverId?: string
  error?: string
}

/** What `update_server` may change. Every field is optional and absent means
 *  "leave it alone" — except `route`, where an empty array is the only way an
 *  agent can say "stop going through a bastion", so absent and `[]` have to
 *  mean different things. */
export interface AgentServerPatch {
  name?: string
  host?: string
  port?: number
  username?: string
  auth?: 'password' | 'key' | 'agent'
  password?: string
  keyPath?: string
  passphrase?: string
  os?: string
  route?: AgentHop[]
  cloud?: CloudTarget
}

export type AgentConfigRequest =
  | { kind: 'server.update'; serverId: string; patch: AgentServerPatch }
  | { kind: 'server.remove'; serverId: string }
  | {
      kind: 'tunnel.add'
      workspaceId: string
      name: string
      tunnelKind: TunnelKind
      serverId: string | null
      listen: string
      target: string
    }
  | { kind: 'tunnel.remove'; tunnelId: string }

export interface AgentConfigResult {
  ok: boolean
  /** The id of whatever was created, for the operations that create something. */
  id?: string
  error?: string
}

type Creator = (req: AgentServerRequest) => Promise<AgentServerResult>
type Writer = (req: AgentConfigRequest) => Promise<AgentConfigResult>

let creator: Creator | null = null
let writer: Writer | null = null

export function setAgentServerCreator(fn: Creator): void {
  creator = fn
}

export function setAgentConfigWriter(fn: Writer): void {
  writer = fn
}

// A closed window is not an error worth retrying — the approval it would have
// needed cannot be shown either.
export function createServerForAgent(req: AgentServerRequest): Promise<AgentServerResult> {
  if (!creator) return Promise.resolve({ ok: false, error: 'OpsMaxx is not ready to add a server right now.' })
  return creator(req)
}

export function writeConfigForAgent(req: AgentConfigRequest): Promise<AgentConfigResult> {
  if (!writer)
    return Promise.resolve({ ok: false, error: 'OpsMaxx is not ready to change its configuration right now.' })
  return writer(req)
}

export function resetAgentServerCreatorForTests(): void {
  creator = null
  writer = null
}
