import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Editing a server redials the open pane, and keeps its scrollback.
 *
 * Two halves that pull against each other, which is why they are asserted
 * together rather than in the pool tests next door.
 *
 * `tests/poolKeyCarriesRevision.test.ts` covers main: a revision in the pool
 * key, so an edited record cannot be answered by the socket authenticated to
 * the machine it used to name. That is verified end to end against real
 * hardware — repointing a saved server at an unroutable address makes the next
 * command time out rather than answer from the old host.
 *
 * None of it reaches a terminal pane on its own. A mounted session holds a
 * session id that main already knows, so the renderer has to tear that session
 * down and dial again. `useTerminalSession` does that when `transport.key`
 * changes, and the revision is in there for exactly this reason.
 *
 * THE TRAP, which 0.50.23 shipped: that same hook builds the xterm in a second
 * effect, and the effect's cleanup calls `term.dispose()`. Both effects keyed
 * on `transport.key`, so an edit did not just redial the session — it threw
 * away the terminal above it. Rotating a password took the scrollback with it,
 * which is usually the thing you most want to read.
 *
 * So there are two strings now. `key` is the SESSION and carries the revision.
 * `paneKey` is the PANE and must never carry it. A test that only checked the
 * redial would have passed on the version that lost the scrollback.
 */

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

const TRANSPORT = 'src/renderer/src/lib/transport.ts'
const HOOK = 'src/renderer/src/hooks/useTerminalSession.ts'

describe('the session key carries the revision, so an edit redials', () => {
  const src = read(TRANSPORT)

  it('puts the revision in the ssh session key', () => {
    expect(src).toContain('key: `ssh:${server.id}:${server.rev ?? 0}`')
  })

  it('puts it in a container shell session key too', () => {
    // A container shell rides the same pooled connection, so it has to redial
    // as well rather than keep exec'ing on the old machine.
    expect(src).toContain('key: `container:${server.id}:${server.rev ?? 0}:${containerRef}`')
  })

  it('is what the session effect keys on', () => {
    expect(read(HOOK)).toContain('}, [transport.key, generation])')
  })
})

describe('the pane key does not, so the scrollback survives', () => {
  const src = read(TRANSPORT)

  it('gives ssh a pane key with no revision in it', () => {
    expect(src).toContain('paneKey: `ssh:${server.id}`')
    expect(src).not.toContain('paneKey: `ssh:${server.id}:${server.rev')
  })

  it('overrides it for a container shell rather than inheriting the host’s', () => {
    // containerTransport spreads sshTransport. Without this line a container
    // pane and a host pane on the same server would share one terminal.
    expect(src).toContain('paneKey: `container:${server.id}:${containerRef}`')
    expect(src).not.toContain('paneKey: `container:${server.id}:${server.rev')
  })

  it('is what the terminal effect keys on, and is not the session key', () => {
    const hook = read(HOOK)
    expect(hook).toContain('const paneKey = transport.paneKey ?? transport.key')
    expect(hook).toContain('}, [paneKey])')
    // The regression itself: the terminal effect must not key on the string
    // that carries the revision.
    expect(hook).not.toContain('}, [transport.key])')
  })

  it('still disposes the terminal when the pane genuinely changes', () => {
    // The fallback matters. A local shell has no saved record to revise and
    // therefore no paneKey, so it must keep keying on `key` — otherwise
    // switching shells reuses another shell's terminal.
    const hook = read(HOOK)
    expect(hook).toContain('term.dispose()')
    expect(read(TRANSPORT)).toMatch(/key: `local:\$\{shell\.id\}/)
    expect(read(TRANSPORT)).not.toMatch(/paneKey: `local:/)
  })
})
