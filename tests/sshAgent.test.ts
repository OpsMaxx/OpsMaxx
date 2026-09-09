import { describe, it, expect } from 'vitest'
import { agentForHop, resolveAgentSocket } from '../src/shared/sshAgent'
import { parseSshConfig } from '../src/shared/sshconfig'

/**
 * Agent authentication, and the `IdentityAgent` line that configures it.
 *
 * The bug these cover: `authFor` read `process.env.SSH_AUTH_SOCK` and nothing
 * else, and the config parser dropped `IdentityAgent` into an ignored bag. In a
 * desktop app that combination is silently wrong — the app inherits whatever
 * agent the session manager launched it with (on macOS, launchd's own), so a
 * user whose keys live in Bitwarden, 1Password or KeePassXC has none of them
 * available. It surfaced as "All configured authentication methods failed"
 * against a host that connects fine from a terminal, because `ssh` had read the
 * IdentityAgent line and this app had thrown it away.
 */

const POSIX = { env: {}, home: '/Users/ada', platform: 'darwin' }
const WIN = { env: {}, home: 'C:\\Users\\ada', platform: 'win32' }

describe('resolveAgentSocket', () => {
  it('treats nothing configured as unset rather than as an error', () => {
    expect(resolveAgentSocket(undefined, POSIX)).toEqual({ kind: 'unset' })
    expect(resolveAgentSocket('   ', POSIX)).toEqual({ kind: 'unset' })
  })

  it('expands a leading ~ against this user home', () => {
    expect(resolveAgentSocket('~/.bitwarden-ssh-agent.sock', POSIX)).toEqual({
      kind: 'socket',
      socket: '/Users/ada/.bitwarden-ssh-agent.sock'
    })
  })

  // `~otheruser` is a different home. Resolving it against ours would point at
  // a socket that is not theirs and may well exist.
  it('refuses another user home rather than guessing', () => {
    const r = resolveAgentSocket('~root/.ssh/agent.sock', POSIX)
    expect(r.kind).toBe('error')
  })

  it('expands $VAR and ${VAR}', () => {
    const ctx = { ...POSIX, env: { XDG_RUNTIME_DIR: '/run/user/501' } }
    expect(resolveAgentSocket('$XDG_RUNTIME_DIR/agent.sock', ctx)).toEqual({
      kind: 'socket',
      socket: '/run/user/501/agent.sock'
    })
    expect(resolveAgentSocket('${XDG_RUNTIME_DIR}/agent.sock', ctx)).toEqual({
      kind: 'socket',
      socket: '/run/user/501/agent.sock'
    })
  })

  it('reports a variable that is not set instead of building a broken path', () => {
    expect(resolveAgentSocket('$NOT_SET_ANYWHERE', POSIX).kind).toBe('error')
  })

  // The one case where the config defers back to the ambient agent.
  it('honours the literal SSH_AUTH_SOCK', () => {
    const ctx = { ...POSIX, env: { SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.123' } }
    expect(resolveAgentSocket('SSH_AUTH_SOCK', ctx)).toEqual({
      kind: 'socket',
      socket: '/tmp/ssh-abc/agent.123'
    })
    expect(resolveAgentSocket('SSH_AUTH_SOCK', POSIX).kind).toBe('error')
    // `${VAR}` too — previously the one spelling of three that fell through to
    // generic expansion rather than being recognised.
    expect(resolveAgentSocket('${SSH_AUTH_SOCK}', ctx)).toEqual({
      kind: 'socket',
      socket: '/tmp/ssh-abc/agent.123'
    })
  })

  /**
   * The env value goes back through the same checks.
   *
   * Returning it verbatim skipped the absolute-path and named-pipe rules that
   * every other value obeys, so an environment carrying a relative path handed
   * ssh2 something that resolves against whatever directory the app happened to
   * be launched from.
   */
  it('validates what the environment supplied rather than trusting it', () => {
    const bad = { ...POSIX, env: { SSH_AUTH_SOCK: 'relative/agent.sock' } }
    expect(resolveAgentSocket('SSH_AUTH_SOCK', bad).kind).toBe('error')
  })

  it('distinguishes `none` from unset', () => {
    // Unset lets the caller fall back to the ambient agent; `none` forbids it.
    expect(resolveAgentSocket('none', POSIX)).toEqual({ kind: 'none' })
    expect(resolveAgentSocket('None', POSIX)).toEqual({ kind: 'none' })
  })

  it('accepts a Windows named pipe on Windows and refuses it elsewhere', () => {
    // 1Password, Bitwarden and KeePassXC all expose a pipe rather than a socket.
    expect(resolveAgentSocket('\\\\.\\pipe\\openssh-ssh-agent', WIN)).toEqual({
      kind: 'socket',
      socket: '\\\\.\\pipe\\openssh-ssh-agent'
    })
    expect(resolveAgentSocket('\\\\.\\pipe\\openssh-ssh-agent', POSIX).kind).toBe('error')
  })

  it('accepts pageant by name, on Windows only', () => {
    expect(resolveAgentSocket('pageant', WIN)).toEqual({ kind: 'socket', socket: 'pageant' })
    expect(resolveAgentSocket('pageant', POSIX).kind).toBe('error')
  })

  // A relative path would resolve against whatever directory the app was
  // started from, which is never where an agent listens.
  it('requires an absolute path', () => {
    expect(resolveAgentSocket('agent.sock', POSIX).kind).toBe('error')
    expect(resolveAgentSocket('./agent.sock', POSIX).kind).toBe('error')
  })
})

describe('agentForHop', () => {
  it('prefers the hop own socket over the ambient one', () => {
    const ctx = { ...POSIX, env: { SSH_AUTH_SOCK: '/tmp/launchd/Listeners' } }
    // The whole point: launchd's agent is what an Electron app inherits, and it
    // is not the agent the user put their keys in.
    expect(agentForHop('~/.bitwarden-ssh-agent.sock', ctx).agent).toBe(
      '/Users/ada/.bitwarden-ssh-agent.sock'
    )
  })

  it('falls back to the ambient agent when none is configured', () => {
    const ctx = { ...POSIX, env: { SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.1' } }
    expect(agentForHop(undefined, ctx).agent).toBe('/tmp/ssh-abc/agent.1')
  })

  /**
   * Windows' own OpenSSH agent, not Pageant.
   *
   * That pipe is what `ssh.exe` talks to and what 1Password and Bitwarden
   * expose their agents at, so it is the right default. Pageant is PuTTY's and
   * is a deliberate choice — defaulting to it told a Windows machine with the
   * OpenSSH agent running that no agent could be found.
   */
  it('falls back to the OpenSSH pipe on Windows with no socket set', () => {
    expect(agentForHop(undefined, WIN).agent).toBe('\\\\.\\pipe\\openssh-ssh-agent')
  })

  it('explains itself when there is no agent at all', () => {
    const r = agentForHop(undefined, POSIX)
    expect(r.agent).toBeUndefined()
    // Actionable rather than "authentication failed".
    expect(r.error).toMatch(/agent/i)
  })

  it('reports `none` as a configuration to change, not as a missing agent', () => {
    expect(agentForHop('none', POSIX).error).toMatch(/no agent/i)
  })
})

describe('parseSshConfig IdentityAgent', () => {
  // The reported config, reduced. Both hosts are agent-only.
  const CONFIG = `
Host monkey-d-luffy 100.125.20.86
    User om
    IdentityAgent ~/.bitwarden-ssh-agent.sock

Host roronoa-zoro
    User om
    IdentityAgent ~/.bitwarden-ssh-agent.sock

Host legacy
    User ops
    IdentityFile ~/.ssh/id_ed25519
`

  it('reads IdentityAgent instead of dropping it into extras', () => {
    const hosts = parseSshConfig(CONFIG)
    const luffy = hosts.find((h) => h.alias === 'monkey-d-luffy')
    expect(luffy?.identityAgent).toBe('~/.bitwarden-ssh-agent.sock')
    // The old behaviour: parsed nowhere, kept only as display text.
    expect(luffy?.extras.identityagent).toBeUndefined()
  })

  it('keeps it as written, for an environment the parser does not have', () => {
    const hosts = parseSshConfig(CONFIG)
    // No `~` expansion here: this module has no home directory and guessing one
    // would bake the importing machine's path into a stored connection.
    expect(hosts.find((h) => h.alias === 'roronoa-zoro')?.identityAgent).toBe(
      '~/.bitwarden-ssh-agent.sock'
    )
  })

  it('applies a wildcard IdentityAgent to the hosts it matches', () => {
    const hosts = parseSshConfig(`
Host *
    IdentityAgent ~/.1password/agent.sock

Host alpha
    User ops
`)
    expect(hosts.find((h) => h.alias === 'alpha')?.identityAgent).toBe('~/.1password/agent.sock')
  })

  it('leaves a key-only host without an agent', () => {
    expect(parseSshConfig(CONFIG).find((h) => h.alias === 'legacy')?.identityAgent).toBeUndefined()
  })
})
