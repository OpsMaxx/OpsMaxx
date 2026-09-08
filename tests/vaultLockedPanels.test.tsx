// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ServicesPanel } from '../src/renderer/src/components/monitor/ServicesPanel'
import { useVaultPrompt } from '../src/renderer/src/store/vaultPrompt'
import { isVaultLocked } from '../src/renderer/src/lib/withVaultUnlock'
import type { Server } from '../src/renderer/src/types'

// A locked vault stops an ON-DEMAND read, and until now it did so by printing
// the resolver's internal marker into a red box:
//
//   Error invoking remote method 'services:collect':
//   OPSMAXX_VAULT_LOCKED: this server authenticates with a vault credential,
//   and the vault is locked.
//
// The apparatus to do better already existed — withVaultUnlock, the vault
// prompt store, UnlockVaultButton — and had reached the connection surfaces
// (SFTP, tunnels, VPN, databases, the terminal) and none of the monitor
// panels. A junior sysadmin testing a locked-vault estate met the raw token.
//
// Two properties, and they are separate: the read RETRIES ITSELF after a
// successful unlock, and if the person declines, what is left on screen is a
// sentence with the unlock attached rather than the marker.

const VAULT_LOCKED_ERROR =
  "Error invoking remote method 'services:collect': OPSMAXX_VAULT_LOCKED: this server " +
  'authenticates with a vault credential, and the vault is locked.'

function server(id: string, name: string): Server {
  return {
    id,
    name,
    host: 'h',
    port: 22,
    username: 'u',
    auth: 'key',
    route: [],
    tags: [],
    workspaceId: 'w'
  } as unknown as Server
}

const SERVERS = [server('a', 'web-01')]

/** A collect that fails on a locked vault until the vault is opened. */
function lockedUntilUnlocked(): {
  collect: ReturnType<typeof vi.fn>
  unlock: () => void
} {
  let locked = true
  const collect = vi.fn(async () => {
    if (locked) throw new Error(VAULT_LOCKED_ERROR)
    return [{ serverId: 'a', serverName: 'web-01', reading: { units: [], detail: null } }]
  })
  return { collect, unlock: () => (locked = false) }
}

beforeEach(() => {
  useVaultPrompt.setState({ request: async () => false })
})

describe('an on-demand read against a locked vault', () => {
  it('asks to unlock rather than reporting the resolver’s marker', async () => {
    const { collect } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    const asked: string[] = []
    useVaultPrompt.setState({
      request: async (reason: string) => {
        asked.push(reason)
        return false
      }
    })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(asked).toHaveLength(1))
    // The dialog says why THIS screen needs it, not "a credential is required".
    expect(asked[0]).toMatch(/supervis/i)
  })

  it('retries the read once the vault is open, with no second press', async () => {
    const { collect, unlock } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    useVaultPrompt.setState({
      request: async () => {
        unlock()
        return true
      }
    })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    // Twice: the failing attempt, then the same read again after the unlock.
    // The person pressed the button once.
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('web-01')).toBeTruthy())
  })

  it('does not retry, and does not loop, when the prompt is declined', async () => {
    const { collect } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1))
  })

  it('leaves a sentence and an unlock, never the marker or the IPC channel', async () => {
    const { collect } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Unlock vault/ })).toBeTruthy())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/the vault is locked/i)
    // The two things a person cannot act on.
    expect(text).not.toContain('OPSMAXX_VAULT_LOCKED')
    expect(text).not.toContain('invoking remote method')
  })

  it('re-runs the read from that unlock button, so declining is not a dead end', async () => {
    const { collect, unlock } = lockedUntilUnlocked()
    stubBridge({ services: { collect } })
    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Unlock vault/ })).toBeTruthy())

    useVaultPrompt.setState({
      request: async () => {
        unlock()
        return true
      }
    })
    await userEvent.click(screen.getByRole('button', { name: /Unlock vault/ }))

    await waitFor(() => expect(screen.getByText('web-01')).toBeTruthy())
  })
})

describe('a failure that is not the vault', () => {
  it('is passed through word for word', async () => {
    // The diagnosis this app spends its effort on. A component that started
    // rewording these would be hiding it.
    const collect = vi.fn(async () => {
      throw new Error('sudo: a password is required')
    })
    stubBridge({ services: { collect } })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(screen.getByText(/sudo: a password is required/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Unlock vault/ })).toBeNull()
    expect(collect).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The shapes a locked vault ACTUALLY arrives in.
//
// Assuming it always arrives as a rejection was a bug in the first cut of this
// work: `withVaultUnlock` was wrapped around six on-demand reads, and three of
// them could never have fired, because the readers behind them catch
// everything and return a probe. The first version of the test above hid that
// by stubbing a collect that throws — which the real `services:collect`
// handler, whose per-target try/catch pushes a reading per host, never does.
//
// So these are the real shapes, taken from the handlers rather than imagined.
// ---------------------------------------------------------------------------
describe('recognising a locked vault however it arrives', () => {
  const MARKER =
    'OPSMAXX_VAULT_LOCKED: this server authenticates with a vault credential, and the vault is locked.'

  it('a rejection — fleet:storage, which resolves credentials in the handler argument', () => {
    expect(isVaultLocked(new Error(MARKER))).toBe(true)
  })

  it('a top-level error field — services:write and every single-target writer', () => {
    expect(isVaultLocked({ ok: false, error: MARKER })).toBe(true)
  })

  it('a probe detail — docker:list and k8s:read, whose readers catch everything', () => {
    // The shape that made three of the six wraps dead code.
    expect(isVaultLocked({ ok: false, reason: 'unknown', detail: MARKER })).toBe(true)
  })

  it('a per-host reading — services:collect and cron:collect', () => {
    expect(
      isVaultLocked([
        { serverId: 'a', serverName: 'web-01', reading: { units: [], detail: 'fine' } },
        { serverId: 'b', serverName: 'db-01', reading: { units: [], detail: MARKER } }
      ])
    ).toBe(true)
  })

  it('the VPN result code, which carries no marker text at all', () => {
    expect(isVaultLocked({ errorCode: 'vault-locked' })).toBe(true)
    expect(isVaultLocked({ code: 'vault-locked' })).toBe(true)
  })

  it('says no to every failure that is not the vault', () => {
    expect(isVaultLocked(null)).toBe(false)
    expect(isVaultLocked(undefined)).toBe(false)
    expect(isVaultLocked(new Error('sudo: a password is required'))).toBe(false)
    expect(isVaultLocked({ ok: false, reason: 'no-docker', detail: 'docker: not found' })).toBe(false)
    expect(isVaultLocked([{ reading: { detail: 'Connection refused' } }])).toBe(false)
    expect(isVaultLocked({ ok: true })).toBe(false)
  })

  it('stays bounded on a large or deep result rather than walking all of it', () => {
    // A probe can carry hundreds of containers. Deciding whether a call failed
    // must not become real work, and must not recurse without a floor.
    const wide = { containers: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `c${i}` })) }
    const t0 = performance.now()
    expect(isVaultLocked(wide)).toBe(false)
    expect(performance.now() - t0).toBeLessThan(50)

    // Deeper than the depth limit: not found, and no stack overflow.
    let deep: unknown = MARKER
    for (let i = 0; i < 50; i++) deep = { nested: deep }
    expect(isVaultLocked(deep)).toBe(false)

    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => isVaultLocked(cyclic)).not.toThrow()
  })
})

describe('the shape the real services:collect handler produces', () => {
  const MARKER =
    'OPSMAXX_VAULT_LOCKED: this server authenticates with a vault credential, and the vault is locked.'

  /** Resolves with a per-host reading, exactly as the handler does — it catches
   *  per target and never rejects. */
  function perHostLocked(): { collect: ReturnType<typeof vi.fn>; unlock: () => void } {
    let locked = true
    const collect = vi.fn(async () => [
      {
        serverId: 'a',
        serverName: 'web-01',
        reading: locked
          ? { status: 'unknown', linger: 'unknown', units: [], detail: MARKER }
          : { status: 'ok', linger: 'ok', units: [], detail: null }
      }
    ])
    return { collect, unlock: () => (locked = false) }
  }

  it('prompts and retries even though nothing was thrown', async () => {
    const { collect, unlock } = perHostLocked()
    stubBridge({ services: { collect } })
    useVaultPrompt.setState({
      request: async () => {
        unlock()
        return true
      }
    })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(collect).toHaveBeenCalledTimes(2))
  })

  it('offers the unlock instead of printing the marker into a row', async () => {
    const { collect } = perHostLocked()
    stubBridge({ services: { collect } })

    render(<ServicesPanel servers={SERVERS} />)
    await userEvent.click(screen.getByRole('button', { name: /Read services/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Unlock vault/ })).toBeTruthy())
    expect(document.body.textContent ?? '').not.toContain('OPSMAXX_VAULT_LOCKED')
  })
})

// ---------------------------------------------------------------------------
// Writes.
//
// The property that matters is a NEGATIVE one: a multi-host write must not
// re-run itself after an unlock. A broadcast, a job and a key revoke all fail
// per host, so a run where twelve hosts succeeded and three hit a locked vault
// would, on a blanket retry, execute a second time on the twelve that already
// ran — a duplicate execution nobody asked for, off a single confirmation.
//
// The single-target install is the exception, and only because nothing ran:
// resolveChainSecrets throws before sshExec is entered, and the confirmation
// that preceded it named that one server and that one unit.
// ---------------------------------------------------------------------------
describe('a write that hits a locked vault', () => {
  const MARKER = 'OPSMAXX_VAULT_LOCKED: this server authenticates with a vault credential.'

  it('installs a unit again after an unlock, because nothing was written', async () => {
    const { UnitInstallPanel } = await import(
      '../src/renderer/src/components/operations/UnitInstallPanel'
    )
    let locked = true
    const write = vi.fn(async () =>
      locked ? { ok: false, error: MARKER } : { ok: true, output: 'WROTE: ok' }
    )
    stubBridge({ services: { write } })
    useVaultPrompt.setState({
      request: async () => {
        locked = false
        return true
      }
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<UnitInstallPanel servers={SERVERS} />)
    // The panel opens with no server chosen, so Install is disabled until one
    // is picked — a write never defaults to a host.
    await userEvent.selectOptions(screen.getByLabelText('Server'), 'a')
    await userEvent.clear(screen.getByLabelText('Unit name'))
    await userEvent.type(screen.getByLabelText('Unit name'), 'demo.service')
    await userEvent.clear(screen.getByLabelText('ExecStart'))
    await userEvent.type(screen.getByLabelText('ExecStart'), '/usr/local/bin/demo')

    await userEvent.click(screen.getByRole('button', { name: /^Install$/ }))
    // Twice: the attempt that found the vault locked and wrote nothing, then
    // the same install once it was open. One press, one install.
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
  })

  it('never retries a multi-host write, whatever the unlock returns', async () => {
    // Straight at withVaultUnlock's contract, because the danger is generic:
    // if a broadcast were ever wrapped in it, this is what would happen.
    const { withVaultUnlock } = await import('../src/renderer/src/lib/withVaultUnlock')
    useVaultPrompt.setState({ request: async () => true })

    const run = vi.fn(async () => [
      { serverName: 'web-01', state: 'done' },
      { serverName: 'db-01', state: 'failed', error: MARKER }
    ])
    // The wrapper WOULD retry this, which is exactly why no multi-host writer
    // is allowed to use it. Asserting the hazard is real keeps the reason for
    // the rule from being lost.
    await withVaultUnlock('x', run)
    expect(run).toHaveBeenCalledTimes(2)

    // And the broadcast panel, which does not use it, must call run once only.
    const { BroadcastPanel } = await import(
      '../src/renderer/src/components/monitor/BroadcastPanel'
    )
    const broadcastRun = vi.fn(async () => undefined)
    stubBridge({ broadcast: { run: broadcastRun, cancel: vi.fn() } })
    render(<BroadcastPanel servers={SERVERS} />)
    expect(broadcastRun).not.toHaveBeenCalled()
  })
})
