import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  peersFrom,
  stateFor,
  type TailscaleStatus
} from '../src/main/services/vpn/drivers/tailscale'

/**
 * The Tailscale driver, against a real Tailscale.
 *
 * The whole file exists for one assertion, which no amount of reading could
 * settle: the macOS app bundle ships a SINGLE executable that decides between
 * opening its GUI window and behaving as a command-line tool by sniffing
 * SHLVL/TERM/TERM_PROGRAM/PS1 — none of which an Electron spawn inherits.
 *
 * That failure is invisible in development. `electron-vite dev` is started from
 * a terminal and inherits those variables, so it works; a packaged app does
 * not, and does not. It is also invisible to an exit-code check, which is the
 * part worth knowing: the bundle returns 0 while failing to launch its GUI.
 *
 * Both facts are asserted below against the real binary.
 */

const BUNDLE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const LAUNCHER = '/usr/local/bin/tailscale'

const have = (p: string): boolean => process.platform === 'darwin' && existsSync(p)

function run(bin: string, env: NodeJS.ProcessEnv): { code: number | null; out: string } {
  try {
    const out = execFileSync(bin, ['status', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 20_000
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? null, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe.runIf(have(BUNDLE))('the macOS app-bundle CLI', () => {
  /**
   * The trap, reproduced. Without the variable the bundle tries to open its
   * window and answers with an error string rather than JSON — and answers it
   * with exit code 0, so a driver that trusted the exit status would treat a
   * GUI launch as a successful status read.
   */
  it('does not answer as a CLI when the environment looks like a spawn', () => {
    const r = run(BUNDLE, {})
    expect(r.out.trim().startsWith('{'), `unexpectedly got JSON: ${r.out.slice(0, 80)}`).toBe(false)
    expect(r.out).toMatch(/GUI/i)
    // The part that makes it dangerous rather than merely wrong.
    expect(r.code).toBe(0)
  })

  it('answers as a CLI with TAILSCALE_BE_CLI set, which is what the driver sends', () => {
    const r = run(BUNDLE, { TAILSCALE_BE_CLI: '1' })
    expect(r.out.trim().startsWith('{'), r.out.slice(0, 120)).toBe(true)
    expect(JSON.parse(r.out).BackendState).toBeTruthy()
  })
})

describe.runIf(have(LAUNCHER))('the standalone launcher', () => {
  // The standalone build installs a real CLI rather than the GUI's own binary,
  // so it needs no coaxing — worth pinning, because it is why the driver
  // prefers this path when both exist.
  it('answers as a CLI even with no environment at all', () => {
    const r = run(LAUNCHER, {})
    expect(r.out.trim().startsWith('{'), r.out.slice(0, 120)).toBe(true)
  })
})

describe.runIf(have(LAUNCHER))('parsing this machine real status', () => {
  const status = JSON.parse(
    run(LAUNCHER, { ...process.env, TAILSCALE_BE_CLI: '1' }).out
  ) as TailscaleStatus

  it('maps the live backend state onto a state the UI has', () => {
    const mapped = stateFor(status.BackendState)
    // Whatever this machine is doing, the mapping must produce a real state
    // and never fall through to the unknown-state branch.
    expect(['connected', 'starting', 'error']).toContain(mapped.state)
    if (status.BackendState === 'Running') expect(mapped.state).toBe('connected')
  })

  it('reads every peer the tailnet reports, or none without inventing any', () => {
    const peers = peersFrom(status)
    expect(Array.isArray(peers)).toBe(true)
    // Every peer that survives must be dialable: a row with no address is a row
    // that cannot become a connection, which is the whole point of the list.
    for (const p of peers) {
      expect(p.host, JSON.stringify(p)).not.toBe('')
      expect(p.name, JSON.stringify(p)).not.toBe('')
    }
  })

  /**
   * The suffix strip, against the real one this tailnet uses.
   *
   * `DNSName` is fully qualified and trailing-dotted — `host.tailXXXX.ts.net.`
   * — and the short name is what a person types and what MagicDNS resolves, so
   * that is what the list should show. Built from the live suffix rather than a
   * guessed one, because the format of that field is the thing being checked.
   */
  it('strips this tailnet own MagicDNS suffix', () => {
    const suffix = status.MagicDNSSuffix
    expect(suffix, 'this tailnet reported no MagicDNS suffix').toBeTruthy()
    const peers = peersFrom({
      MagicDNSSuffix: suffix,
      Peer: {
        'key:1': {
          DNSName: `worker-1.${suffix}.`,
          HostName: 'worker-1',
          TailscaleIPs: ['100.64.0.9'],
          Online: true,
          OS: 'linux'
        },
        // No addresses: cannot be dialled, so it must not become a row.
        'key:2': { DNSName: `ghost.${suffix}.`, HostName: 'ghost', TailscaleIPs: [], Online: false }
      }
    })
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({ name: 'worker-1', host: '100.64.0.9', online: true })
  })
})
