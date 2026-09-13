// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stubBridge } from './setup/renderer'
import {
  RECOVERY_BUDGET_MS,
  RETRY_DELAYS_MS,
  evictPooledConnection,
  recoveryDelay,
  shouldAutoRecover,
  useSessionRecovery
} from '../src/renderer/src/hooks/useSessionRecovery'

/**
 * A terminal that carries itself across a reboot.
 *
 * What this replaces, verbatim from the report:
 *
 *     root@vmi3102619:~# reboot
 *     [session closed]
 *     Press Enter to reconnect in this tab.
 *     Connecting to Chain305 (…)…
 *     Connection failed: Connection lost before handshake
 *
 * followed by a modal saying the app could not tell what went wrong. Every word
 * true, none of it useful: the user knew exactly what went wrong.
 *
 * The dangerous half of the fix is the half that must NOT happen. `ssh.ts`
 * already documents what retrying an authentication failure costs — a
 * background sweep answering a challenge with `finish([])` every interval,
 * MaxAuthTries, fail2ban, and the user locked out of their own sessions. The
 * auth tests below are the ones that matter.
 */

const AUTH = 'All configured authentication methods failed'
const REBOOT_DROP = 'Session closed'
const HANDSHAKE = 'Session closed · Connection lost before handshake'

// ---------------------------------------------------------------------------
// Which endings are eligible at all
// ---------------------------------------------------------------------------

describe('what counts as an ending a server coming back would fix', () => {
  it.each([
    // The reported case: the close reason the far end gave was nothing at all.
    [REBOOT_DROP, true],
    [HANDSHAKE, true],
    ['Session closed · closed by server (SIGHUP — often an idle timeout)', true],
    ['connect ECONNREFUSED 10.0.0.4:22', true],
    ['Timed out while waiting for handshake', true]
  ])('retries the network-shaped ending %s', (reason, eligible) => {
    expect(shouldAutoRecover(reason)).toBe(eligible)
  })

  it.each([
    // THE one. A credential the server refused is refused identically forever,
    // and every attempt spends one of the host's MaxAuthTries.
    [AUTH],
    ['Permission denied (publickey)'],
    // A rebuilt host presenting a different key is a decision for a person.
    ['Host key verification failed'],
    ["ENOENT: no such file or directory, open '/home/a/.ssh/id_ed25519'"],
    ['Encrypted private key detected, no passphrase given'],
    ['Permission denied']
  ])('never retries %s', (reason) => {
    expect(shouldAutoRecover(reason)).toBe(false)
  })

  it.each([
    // A shell that ran and finished is the far side doing what it was told. A
    // machine going away does not hand back an exit code.
    ['Session closed · shell exited'],
    ['Session closed · shell exited with 3'],
    // A container image with no shell would otherwise be dialled for minutes.
    ['Session closed · shell exited with 127']
  ])('never retries %s', (reason) => {
    expect(shouldAutoRecover(reason)).toBe(false)
  })

  it('has nothing to act on when there is no reason', () => {
    expect(shouldAutoRecover(null)).toBe(false)
    expect(shouldAutoRecover('')).toBe(false)
  })
})

describe('the backoff', () => {
  it('starts short, holds at the last step and stays inside the budget', () => {
    expect(recoveryDelay(1)).toBe(2_000)
    expect(recoveryDelay(RETRY_DELAYS_MS.length)).toBe(30_000)
    // Past the end of the table it holds rather than running off it.
    expect(recoveryDelay(40)).toBe(30_000)
    expect(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(RECOVERY_BUDGET_MS)
  })
})

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface Props {
  dead: string | null
  online: boolean
}

/** Every side effect the loop has, in the order it had them. */
let log: string[]
let poolEvict: ReturnType<typeof vi.fn>
let poolClose: ReturnType<typeof vi.fn>

/** `null` is a session with no saved server behind it — a local shell. */
function harness(serverId: string | null = 'srv-1') {
  const dial = vi.fn(() => {
    log.push('dial')
  })
  const view = renderHook(({ dead, online }: Props) => useSessionRecovery(dead, online, dial, serverId ?? undefined), {
    initialProps: { dead: null, online: false } as Props
  })

  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  /** The session ends, or an attempt comes back having failed. */
  const drop = (reason: string): void => {
    act(() => view.rerender({ dead: reason, online: false }))
  }
  /** An attempt starts: `dial` clears the reason before the new session runs. */
  const dialling = (): void => {
    act(() => view.rerender({ dead: null, online: false }))
  }
  const fail = (reason: string): void => {
    dialling()
    drop(reason)
  }
  const succeed = (): void => {
    act(() => view.rerender({ dead: null, online: true }))
  }
  return { ...view, dial, advance, drop, fail, succeed }
}

beforeEach(() => {
  vi.useFakeTimers()
  log = []
  poolEvict = vi.fn(async (id: string) => {
    log.push(`evict:${id}`)
    return 1
  })
  poolClose = vi.fn(async () => undefined)
  stubBridge({ ssh: { poolEvict, poolClose } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a network-class drop', () => {
  it('reconnects on its own and stops once the server is back', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)

    // Visible immediately: which attempt, and how long until it happens.
    expect(h.result.current.recovery.active).toBe(true)
    expect(h.result.current.recovery.attempt).toBe(1)
    expect(h.result.current.recovery.nextInSec).toBe(2)
    expect(h.dial).not.toHaveBeenCalled()

    await h.advance(2_000)
    expect(h.dial).toHaveBeenCalledTimes(1)

    // Still coming up.
    h.fail(HANDSHAKE)
    expect(h.result.current.recovery.attempt).toBe(2)
    await h.advance(5_000)
    expect(h.dial).toHaveBeenCalledTimes(2)

    // Back.
    h.succeed()
    expect(h.result.current.recovery.active).toBe(false)
    expect(h.result.current.recovery.exhausted).toBe(false)
    await h.advance(RECOVERY_BUDGET_MS)
    expect(h.dial).toHaveBeenCalledTimes(2)
  })

  it('counts down so the wait is not a blank card', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)
    // Attempt 3 waits ten seconds, which is long enough that a still card
    // reads as a hang.
    await h.advance(2_000)
    h.fail(HANDSHAKE)
    await h.advance(5_000)
    h.fail(HANDSHAKE)
    expect(h.result.current.recovery.nextInSec).toBe(10)
    await h.advance(3_000)
    expect(h.result.current.recovery.nextInSec).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// THE one that matters
// ---------------------------------------------------------------------------

describe('an authentication failure', () => {
  it('never arms a run at all', async () => {
    const h = harness()
    h.drop(AUTH)
    expect(h.result.current.recovery.active).toBe(false)
    await h.advance(RECOVERY_BUDGET_MS * 2)
    expect(h.dial).not.toHaveBeenCalled()
    expect(poolEvict).not.toHaveBeenCalled()
  })

  it('ends a run in progress on the first attempt that hits it', async () => {
    // The realistic shape: the box came back, but it came back rebuilt, or the
    // key is gone. One attempt discovers that; a loop would spend the rest of
    // the budget tripping MaxAuthTries on a host that is now up and listening.
    const h = harness()
    h.drop(REBOOT_DROP)
    await h.advance(2_000)
    expect(h.dial).toHaveBeenCalledTimes(1)

    h.fail(AUTH)
    expect(h.result.current.recovery.active).toBe(false)
    // Not "exhausted": nothing ran out. The ordinary card explains the auth
    // failure and offers Edit connection, which is the action that can help.
    expect(h.result.current.recovery.exhausted).toBe(false)

    await h.advance(RECOVERY_BUDGET_MS * 2)
    expect(h.dial).toHaveBeenCalledTimes(1)
  })

  it('does not arm again after it, however long the session sits dead', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)
    await h.advance(2_000)
    h.fail(AUTH)
    // A re-render with a different failure string must not look like a fresh
    // ending and start the loop over.
    h.fail(HANDSHAKE)
    await h.advance(RECOVERY_BUDGET_MS)
    expect(h.dial).toHaveBeenCalledTimes(1)
  })

  it('is equally refused for a changed host key', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)
    await h.advance(2_000)
    h.fail('Host key verification failed')
    await h.advance(RECOVERY_BUDGET_MS)
    expect(h.dial).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Bounded, and honest about it
// ---------------------------------------------------------------------------

describe('the budget', () => {
  it('runs out and says so rather than going quiet', async () => {
    const h = harness()
    const started = Date.now()
    h.drop(REBOOT_DROP)

    let guard = 0
    while (h.result.current.recovery.active && guard++ < 100) {
      await h.advance(recoveryDelay(h.result.current.recovery.attempt))
      h.fail(HANDSHAKE)
    }
    const elapsed = Date.now() - started

    expect(h.result.current.recovery.active).toBe(false)
    expect(h.result.current.recovery.exhausted).toBe(true)
    // Bounded in both directions. The lower bound is the point of the feature:
    // it has to outlast a reboot that takes minutes, not give up at the first
    // slow one. The upper bound is the promise the budget makes.
    expect(elapsed).toBeGreaterThan(4 * 60_000)
    expect(elapsed).toBeLessThanOrEqual(RECOVERY_BUDGET_MS)
    expect(h.dial.mock.calls.length).toBeGreaterThan(5)
    const spent = h.dial.mock.calls.length
    await h.advance(RECOVERY_BUDGET_MS * 2)
    expect(h.dial).toHaveBeenCalledTimes(spent)
  })
})

// ---------------------------------------------------------------------------
// Never fight the user
// ---------------------------------------------------------------------------

describe('the user', () => {
  it('stops the loop by cancelling, and it stays stopped', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)
    expect(h.result.current.recovery.active).toBe(true)

    act(() => h.result.current.cancelRecovery())
    expect(h.result.current.recovery.active).toBe(false)
    expect(h.result.current.recovery.exhausted).toBe(false)

    await h.advance(RECOVERY_BUDGET_MS)
    expect(h.dial).not.toHaveBeenCalled()

    // And a later re-render of the same dead session does not quietly restart
    // something the user just switched off.
    h.fail(HANDSHAKE)
    await h.advance(RECOVERY_BUDGET_MS)
    expect(h.dial).not.toHaveBeenCalled()
  })

  it('takes over with a manual Reconnect instead of racing the countdown', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)

    // What the Reconnect button does, through useTerminalSession's wrapper:
    // cancel the run, then dial.
    act(() => {
      h.result.current.cancelRecovery()
      h.dial()
    })
    expect(h.dial).toHaveBeenCalledTimes(1)

    // The attempt the loop had scheduled must not also fire.
    await h.advance(RECOVERY_BUDGET_MS)
    expect(h.dial).toHaveBeenCalledTimes(1)
  })

  it('gets the loop back after a session that actually came up', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)
    act(() => h.result.current.cancelRecovery())
    h.succeed()
    // A reboot an hour later is a new problem, not the one they cancelled.
    h.drop(REBOOT_DROP)
    expect(h.result.current.recovery.active).toBe(true)
  })

  it('drops its timers when the pane goes away', async () => {
    const h = harness()
    h.drop(REBOOT_DROP)
    h.unmount()
    await h.advance(RECOVERY_BUDGET_MS)
    expect(h.dial).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The pooled connection
// ---------------------------------------------------------------------------

describe('the connection a retry gets', () => {
  it('is never the pooled socket the drop happened on', async () => {
    const h = harness('srv-9')
    h.drop(REBOOT_DROP)
    await h.advance(2_000)

    // Order is the assertion. Evicting after the dial would hand the attempt
    // the dead connection and evict it in time for the attempt after.
    expect(log).toEqual(['evict:srv-9', 'dial'])

    h.fail(HANDSHAKE)
    await h.advance(5_000)
    expect(log).toEqual(['evict:srv-9', 'dial', 'evict:srv-9', 'dial'])
  })

  it('evicts rather than closing, so other panes on the same host survive', async () => {
    // `poolClose` destroys the shared connection: every other terminal pane,
    // the file browser and the metrics sampler go with it. The pool comment on
    // `sshOpenFresh` refuses it for exactly this reason.
    const h = harness()
    h.drop(REBOOT_DROP)
    await h.advance(2_000)
    expect(poolEvict).toHaveBeenCalledWith('srv-1')
    expect(poolClose).not.toHaveBeenCalled()
  })

  it('still dials when the pool cannot be reached', async () => {
    // A recovery that skipped the attempt because an IPC call rejected would
    // be a worse failure than the one it is recovering from.
    stubBridge({ ssh: { poolEvict: vi.fn(async () => { throw new Error('no bridge') }) } })
    const h = harness()
    h.drop(REBOOT_DROP)
    await h.advance(2_000)
    expect(h.dial).toHaveBeenCalledTimes(1)
  })

  it('has nothing to evict for a session with no saved server', async () => {
    const h = harness(null)
    h.drop(REBOOT_DROP)
    await h.advance(2_000)
    expect(poolEvict).not.toHaveBeenCalled()
    expect(h.dial).toHaveBeenCalledTimes(1)
  })

  it('asks main for the eviction rather than working out pool keys here', async () => {
    // Key shape (`srv:<id>`, `parent>self`, `|vpn:…`, `|<poolTag>`) is main's,
    // and a second copy of it in the renderer is a copy that drifts.
    await evictPooledConnection('srv-2')
    expect(poolEvict).toHaveBeenCalledWith('srv-2')
  })
})

// ---------------------------------------------------------------------------
// Wired up where it has to be
// ---------------------------------------------------------------------------

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

describe('the session hook', () => {
  const SRC = read('../src/renderer/src/hooks/useTerminalSession.ts')

  it('evicts on every reconnect, not only the automatic one', () => {
    // Pressing Reconnect by hand has the same dead-socket problem, and one
    // place to fix it beats remembering two.
    expect(SRC).toMatch(/evictPooledConnection\(transport\.serverId\)/)
  })

  it('lets a manual reconnect cancel the run it is taking over from', () => {
    expect(SRC).toMatch(/cancelRecovery\(\)\s*\n\s*dial\(\)/)
  })

  it('feeds recovery a real success signal, not the absence of a failure', () => {
    // `dead` going null happens when an attempt STARTS. Without `ready` the
    // loop cannot tell a working session from an in-flight one.
    expect(SRC).toMatch(/setOnline\(true\)/)
  })
})

describe('the failure card', () => {
  const SRC = read('../src/renderer/src/components/terminal/TerminalView.tsx')

  it('no longer promises that reconnecting reuses the pooled connection', () => {
    // It said so at the exact moment that was the wrong thing to do.
    expect(SRC).not.toMatch(/Reconnecting reuses the pooled connection/)
    expect(SRC).toMatch(/drops the shared connection first/)
  })

  it('shows the run and offers a way out of it', () => {
    expect(SRC).toMatch(/Stop trying/)
    expect(SRC).toMatch(/recovery\.attempt/)
    expect(SRC).toMatch(/recovery\.nextInSec/)
  })
})
