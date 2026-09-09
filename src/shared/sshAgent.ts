// Where an SSH agent actually listens, given what a user or an ~/.ssh/config
// wrote down.
//
// OpenSSH's `IdentityAgent` accepts several things that are not a path — the
// literal `SSH_AUTH_SOCK`, the literal `none`, a `~`, and `$VAR` — and on
// Windows the agent is a named pipe rather than a socket at all. ssh2 wants one
// concrete string (or the word `pageant`), so this is the translation.
//
// Pure and env-injected so it is testable without a home directory, a shell, or
// an agent: every caller passes the environment it means.

/** What `IdentityAgent none` means: this host deliberately uses no agent. */
export const AGENT_NONE = 'none'

/**
 * Windows' OpenSSH agent, and the shape third-party agents use too.
 *
 * 1Password, Bitwarden and KeePassXC all expose a named pipe here rather than a
 * Unix socket, so a Windows agent path legitimately looks nothing like a path.
 */
const WINDOWS_PIPE = /^\\\\[.?]\\pipe\\/i

/**
 * PuTTY's agent, which ssh2 accepts as this exact word rather than as a path.
 * Kept as a passthrough so a Windows user who runs Pageant can name it.
 */
export const PAGEANT = 'pageant'

/**
 * Windows' built-in OpenSSH agent.
 *
 * The default there when nothing is configured: it is what `ssh.exe` talks to,
 * and 1Password and Bitwarden both expose their agents at this same pipe name
 * so that existing tools find them.
 */
export const WINDOWS_OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

export interface AgentEnv {
  /** Usually `process.env`. Only SSH_AUTH_SOCK and expanded vars are read. */
  env: Record<string, string | undefined>
  /** Usually `os.homedir()`. Expands a leading `~`. */
  home: string
  /** Usually `process.platform`. Decides whether pipes and Pageant are legal. */
  platform: string
}

export type AgentResolution =
  | { kind: 'socket'; socket: string }
  /** `none`, explicitly. Not an error, and not a reason to fall back. */
  | { kind: 'none' }
  /** Nothing was configured, so the caller should use its own default. */
  | { kind: 'unset' }
  | { kind: 'error'; reason: string }

/** `$VAR` and `${VAR}`, as OpenSSH expands them. An unset var expands to ''. */
function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    return env[a ?? b] ?? ''
  })
}

/**
 * Resolve a configured agent location to something ssh2 can be handed.
 *
 * `raw` is what the user typed or what `IdentityAgent` said. Empty or absent
 * means "not configured", which is distinct from `none`: the first lets the
 * caller fall back to SSH_AUTH_SOCK, the second forbids it.
 */
export function resolveAgentSocket(raw: string | undefined, ctx: AgentEnv): AgentResolution {
  const trimmed = (raw ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!trimmed) return { kind: 'unset' }

  if (trimmed.toLowerCase() === AGENT_NONE) return { kind: 'none' }

  // Pageant is a name, not a location, and only means anything on Windows.
  if (trimmed.toLowerCase() === PAGEANT) {
    return ctx.platform === 'win32'
      ? { kind: 'socket', socket: PAGEANT }
      : { kind: 'error', reason: 'Pageant is a Windows agent and is not available on this platform.' }
  }

  // `IdentityAgent SSH_AUTH_SOCK` means "whatever the environment says", which
  // is the one case where the config defers back to the ambient agent.
  if (trimmed === 'SSH_AUTH_SOCK' || trimmed === '$SSH_AUTH_SOCK' || trimmed === '${SSH_AUTH_SOCK}') {
    const fromEnv = ctx.env.SSH_AUTH_SOCK?.trim()
    if (!fromEnv) {
      return {
        kind: 'error',
        reason:
          'This connection defers to SSH_AUTH_SOCK, but no agent socket is set in this environment.'
      }
    }
    // Recursed, not returned verbatim. Returning it directly skipped the
    // absolute-path and named-pipe checks every other value goes through, so an
    // environment carrying a relative path handed ssh2 something that resolves
    // against whatever directory the app was launched from. `${SSH_AUTH_SOCK}`
    // is also accepted above; it was previously the one spelling of three that
    // fell through to generic expansion.
    return resolveAgentSocket(fromEnv, { ...ctx, env: { ...ctx.env, SSH_AUTH_SOCK: undefined } })
  }

  const expanded = expandVars(trimmed, ctx.env)
  if (!expanded) {
    return {
      kind: 'error',
      // The RAW value, never the expanded one. Every message below follows the
      // same rule: an expanded value contains the contents of an environment
      // variable, and these strings travel to the renderer and into the result
      // of an agent-facing `execute_command`. Reporting what the user wrote is
      // what they need to fix it; reporting what it expanded to is a disclosure
      // of process environment that nobody asked for.
      reason: `The agent location "${trimmed}" expanded to nothing — the variable it names is not set.`
    }
  }

  if (WINDOWS_PIPE.test(expanded)) {
    return ctx.platform === 'win32'
      ? { kind: 'socket', socket: expanded }
      : { kind: 'error', reason: 'A named pipe is a Windows agent address and cannot be used here.' }
  }

  // `~` only at the start, and only as its own segment: `~user` is another
  // user's home, which we cannot resolve and must not silently treat as ours.
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    return { kind: 'socket', socket: ctx.home + expanded.slice(1) }
  }
  if (expanded.startsWith('~')) {
    return {
      kind: 'error',
      reason: `"${trimmed}" names another user's home directory, which cannot be resolved here. Use an absolute path.`
    }
  }

  // Anything else has to be absolute. A relative socket path would resolve
  // against whatever directory the app happens to have been started from,
  // which is never where an agent is listening.
  const absolute = expanded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(expanded)
  if (!absolute) {
    return {
      kind: 'error',
      reason: `The agent socket path must be absolute, or start with "~/". Got "${trimmed}".`
    }
  }

  return { kind: 'socket', socket: expanded }
}

/**
 * The agent to hand ssh2, for a hop that authenticates with one.
 *
 * The precedence is the interesting part. A socket stored on the CONNECTION
 * wins over the ambient one, because an Electron app inherits whatever agent
 * the desktop session started it with — on macOS that is launchd's own agent,
 * which holds none of the keys a user's chosen agent holds. A connection
 * imported from an `IdentityAgent` line was explicitly told where to look, and
 * silently substituting SSH_AUTH_SOCK for it is how "All configured
 * authentication methods failed" happens on a host that works from a terminal.
 */
export function agentForHop(
  configured: string | undefined,
  ctx: AgentEnv
): { agent?: string; error?: string } {
  const resolved = resolveAgentSocket(configured, ctx)
  switch (resolved.kind) {
    case 'socket':
      return { agent: resolved.socket }
    case 'error':
      return { error: resolved.reason }
    case 'none':
      return {
        error:
          'This connection is set to use no agent (IdentityAgent none). Choose a key or a password instead.'
      }
    case 'unset': {
      // Nothing configured: the ambient agent, which is the historical
      // behaviour and still right for a user who runs one agent per session.
      const ambient = ctx.env.SSH_AUTH_SOCK?.trim()
      if (ambient) return { agent: ambient }
      // Windows' own OpenSSH agent, which is what `ssh` uses there and what
      // 1Password/Bitwarden emulate. Pageant is PuTTY's and is a deliberate
      // choice a user makes, not a default worth guessing — defaulting to it
      // meant a Windows machine with the OpenSSH agent running was told no
      // agent could be found.
      if (ctx.platform === 'win32') return { agent: WINDOWS_OPENSSH_PIPE }
      return {
        error:
          'No SSH agent was found. Set the agent socket on this connection, or start an agent before connecting.'
      }
    }
  }
}
