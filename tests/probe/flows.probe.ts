/**
 * Every way a device gets onto, off, and back onto an account — driven for
 * real: real addyd, real crypto, real relay, real keychain file, strict TLS.
 *
 * Each simulated machine gets its own userData directory (so its own keychain
 * file and its own enrolment record) and its own module graph (so its own
 * `addySession` singleton and its own `secrets.ts` FILE constant). Because
 * pairing is a strict lock-step ping-pong, two machines have to be in flight at
 * once — so which directory `app.getPath` answers with is carried in an
 * AsyncLocalStorage rather than a variable one of them would clobber.
 *
 * ADDY_SHIM_ROOTPUB=1 patches the one defect that blocks every other row —
 * `attach()` not sending `rootSignPub` — at the sidecar boundary, WITHOUT
 * touching src/. It is off by default so the unshimmed truth is what runs.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'

const RELAY = process.env.ADDY_RELAY ?? 'https://localhost:8490'
const JAR = process.env.ADDY_JAR ?? ''
const OUT = process.env.ADDY_OUT ?? '/tmp/addy-probe-out.txt'
const SHIM = process.env.ADDY_SHIM_ROOTPUB === '1'

const als = new AsyncLocalStorage<string>()
let importingInto = mkdtempSync(join(tmpdir(), 'addy-probe-'))
const hereDir = (): string => als.getStore() ?? importingInto

vi.mock('electron', () => ({
  app: {
    getPath: (): string => hereDir(),
    getAppPath: (): string => process.cwd(),
    getVersion: (): string => '0.6.2',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8')
  },
  shell: { openExternal: async (): Promise<void> => undefined },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }
}))

// The shim: supply `rootSignPub` on `load` from the enrolment this machine
// already has on disk, which is exactly what `attach()` fails to pass.
vi.mock('../../src/main/services/addy/sidecar', async (orig) => {
  const real = await orig<typeof import('../../src/main/services/addy/sidecar')>()
  if (!process.env.ADDY_SHIM_ROOTPUB) return real
  return {
    ...real,
    openAddyd: async (role?: '--crypto' | '--rtc', log?: (l: string) => void) => {
      const side = await real.openAddyd(role, log)
      return {
        ...side,
        send: <T>(method: string, params?: unknown, t?: number): Promise<T> => {
          if (method === 'load' && params && typeof params === 'object') {
            const p = params as Record<string, unknown>
            if (!p.rootSignPub) {
              const f = join(hereDir(), 'opsmaxx-addy.json')
              if (existsSync(f)) {
                p.rootSignPub = (JSON.parse(readFileSync(f, 'utf8')) as { rootSignPub?: string }).rootSignPub
              }
            }
          }
          return side.send<T>(method, params, t)
        }
      }
    }
  }
})

type Session = (typeof import('../../src/main/services/addy/session'))['addySession']

interface Device {
  name: string
  dir: string
  s: Session
  relaunch(): Promise<Session>
}

async function newDevice(name: string): Promise<Device> {
  const dir = mkdtempSync(join(tmpdir(), `addy-${name}-`))
  const d: Device = {
    name,
    dir,
    s: null as unknown as Session,
    async relaunch() {
      importingInto = dir
      vi.resetModules()
      d.s = await als.run(dir, async () =>
        (await import('../../src/main/services/addy/session')).addySession
      )
      return d.s
    }
  }
  await d.relaunch()
  return d
}

// ---------------------------------------------------------------- reporting

writeFileSync(OUT, `# addy flow probe ${new Date().toISOString()}\n# relay=${RELAY} shim=${SHIM}\n`)
const say = (...a: unknown[]): void => {
  appendFileSync(OUT, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n')
}

let trace = false
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/v1/pair/')) return realFetch(input as RequestInfo, init)
  try {
    const r = await realFetch(input as RequestInfo, init)
    if (trace) say(`        · ${init?.method ?? 'GET'} ${url.replace(RELAY, '')} -> ${r.status}`)
    return r
  } catch (e) {
    if (trace) say(`        · ${init?.method ?? 'GET'} ${url.replace(RELAY, '')} -> THREW ${(e as Error).message}`)
    throw e
  }
}) as typeof fetch

async function on<T>(d: Device, label: string, fn: (s: Session) => Promise<T>): Promise<T | undefined> {
  try {
    const v = await als.run(d.dir, () => fn(d.s))
    say(`  [ok]    ${d.name}.${label}:`, v === undefined ? '(void)' : v)
    return v
  } catch (err) {
    const e = err as { code?: string; message?: string }
    say(`  [THROW] ${d.name}.${label}: code=${e.code ?? '-'} msg=${e.message ?? String(err)}`)
    return undefined
  }
}

const enrolmentOf = (d: Device): { spki?: string; accountId?: string } | null => {
  const p = join(d.dir, 'opsmaxx-addy.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as object) : null
}
const secretsOf = (d: Device): string[] => {
  const p = join(d.dir, 'opsmaxx-secrets.json')
  return existsSync(p)
    ? Object.keys(JSON.parse(readFileSync(p, 'utf8')) as object).map((k) => k.replace('__machine__addy-', ''))
    : []
}
function snapshot(d: Device, when: string): void {
  say(`  -- ${d.name} ${when}: enrolment=${enrolmentOf(d) ? 'YES' : 'no'} secrets=${JSON.stringify(secretsOf(d))} attached=${d.s.attached}`)
}

const curl = (args: string[]): string =>
  execFileSync('curl', ['-sk', '--resolve', 'localhost:8480:127.0.0.1', ...args]).toString()

function mintInvite(): string {
  const out = curl([
    '-b', JAR, '-c', JAR, '-X', 'POST', '-H', 'content-type: application/json', '-d', '{}',
    'https://localhost:8480/admin/v1/my/invite'
  ])
  const v = JSON.parse(out) as { invite?: string; error?: string }
  if (!v.invite) throw new Error(v.error ?? out)
  return v.invite
}
const consoleAccounts = (): string =>
  curl(['-b', JAR, '-c', JAR, 'https://localhost:8480/admin/v1/my/accounts']).trim()

/** The relay console's own view of the device count, which is what an operator
 *  looks at when a user says "it says I have two machines". */
function consoleDevices(): number {
  const v = JSON.parse(consoleAccounts()) as { accounts?: { devices?: number }[] }
  return v.accounts?.[0]?.devices ?? -1
}

/** Start or stop the TLS front door, optionally on a different certificate. */
function frontdoor(what: 'up' | 'down', certs = 'certs1'): void {
  const sh = join(process.env.ADDY_SCRATCH ?? '', 'flows', 'frontdoor.sh')
  execFileSync(sh, what === 'up' ? ['up', join(process.env.ADDY_SCRATCH ?? '', 'flows', certs)] : ['down'])
  say(`  (front door ${what}${what === 'up' ? ' on ' + certs : ''})`)
}

/** Pair `joiner` onto the account `host` is on. Returns whether it worked. */
async function pair(host: Device, joiner: Device): Promise<boolean> {
  const h = await on(host, 'beginPairing', (s) => s.beginPairing(RELAY))
  if (!h) return false
  const [jr, hr] = await Promise.allSettled([
    als.run(joiner.dir, () => joiner.s.joinPairing(RELAY, h.code, h.pairingId)),
    als.run(host.dir, () => host.s.awaitPairing())
  ])
  if (hr.status !== 'fulfilled' || jr.status !== 'fulfilled') {
    say('  pairing did not confirm:', String(hr.status === 'rejected' ? hr.reason : jr.status === 'rejected' ? jr.reason : ''))
    await on(host, 'cancelPairing', (s) => s.cancelPairing())
    return false
  }
  const [fin, comp] = await Promise.allSettled([
    als.run(joiner.dir, () => joiner.s.finishJoin()),
    als.run(host.dir, () => host.s.completePairing(hr.value))
  ])
  say(`  ${joiner.name} finishJoin:`, fin.status === 'fulfilled' ? fin.value : String(fin.reason))
  say(`  ${host.name} completePairing:`, comp.status === 'fulfilled' ? comp.value : String(comp.reason))
  return fin.status === 'fulfilled' && comp.status === 'fulfilled'
}

const devices: Record<string, Device> = {}
let accountId = ''
let mnemonic = ''

describe('addy device-sync flow matrix', () => {
  it('PATH 1 — fresh machine, create an account from a console invite', async () => {
    say('\n================ PATH 1: create an account with an invite')
    const a = (devices.A = await newDevice('A'))
    const invite = mintInvite()
    trace = true
    const made = await on(a, 'createAccount', (s) => s.createAccount(RELAY, invite, 'laptop'))
    trace = false
    accountId = made?.accountId ?? ''
    mnemonic = made?.mnemonic ?? ''
    snapshot(a, 'after createAccount')
    say('  console:', consoleAccounts())
    await on(a, 'status', (s) => s.status())
    expect(accountId).toHaveLength(32)
  }, 120_000)

  it('PATH 5 — a second invite for the same person is refused', async () => {
    say('\n================ PATH 5: a second invite')
    let refusal = ''
    try {
      mintInvite()
      refusal = 'NOT REFUSED — an invite was issued'
    } catch (e) {
      refusal = (e as Error).message
    }
    say('  relay console says:', refusal)
    expect(refusal).not.toContain('NOT REFUSED')
  }, 30_000)

  it('PATH 12a — relaunch with the relay up', async () => {
    say('\n================ PATH 12a: relaunch, relay up (this is resume())')
    const a = devices.A
    await a.relaunch()
    await on(a, 'resume', (s) => s.resume())
    snapshot(a, 'after resume')
    await on(a, 'status', (s) => s.status())
  }, 120_000)

  it('PATH 2 — fresh machine joins by pairing: code shown on A, typed on B', async () => {
    say('\n================ PATH 2: pair, showing on A and typing on B')
    const a = devices.A
    const b = (devices.B = await newDevice('B'))

    const handle = await on(a, 'beginPairing', (s) => s.beginPairing(RELAY))
    if (!handle) {
      say('  !! no code to show — the rest of this path cannot run')
      return
    }
    say('  code shown on A:', handle.code, ' pairingId:', handle.pairingId)

    // Both halves in flight at once: the rendezvous is a strict ping-pong.
    const bJoin = als.run(b.dir, () => b.s.joinPairing(RELAY, handle.code, handle.pairingId))
    const aWait = als.run(a.dir, () => a.s.awaitPairing())
    const [bConf, aConf] = await Promise.allSettled([bJoin, aWait])
    say('  B joinPairing:', bConf.status === 'fulfilled' ? { sas: bConf.value.sas } : String(bConf.reason))
    say('  A awaitPairing:', aConf.status === 'fulfilled' ? { sas: aConf.value.sas } : String(aConf.reason))
    if (aConf.status === 'fulfilled' && bConf.status === 'fulfilled') {
      say('  emoji agree:', JSON.stringify(aConf.value.sas) === JSON.stringify(bConf.value.sas))
    }
    if (aConf.status !== 'fulfilled' || bConf.status !== 'fulfilled') return

    const bFinish = als.run(b.dir, () => b.s.finishJoin())
    const aComplete = als.run(a.dir, () => a.s.completePairing(aConf.value))
    const [fin, comp] = await Promise.allSettled([bFinish, aComplete])
    say('  B finishJoin:', fin.status === 'fulfilled' ? fin.value : String(fin.reason))
    say('  A completePairing:', comp.status === 'fulfilled' ? comp.value : String(comp.reason))

    snapshot(a, 'after pairing')
    snapshot(b, 'after pairing')
    await on(a, 'status', (s) => s.status())
    await on(b, 'status', (s) => s.status())
    await on(a, 'roster', async (s) => {
      const r = await s.refreshRoster()
      return { n: r.devices.length, still: r.stillListed, labels: r.devices.map((x) => x.label) }
    })
    say('  console device count:', consoleDevices())
  }, 240_000)

  it('PATH 3 — pairing the other direction: code shown on the FRESH machine', async () => {
    say('\n================ PATH 3: fresh machine shows the code, enrolled machine types it')
    const a = devices.A
    const c = (devices.C = await newDevice('C'))
    // The fresh machine is the one calling beginPairing.
    const handle = await on(c, 'beginPairing', (s) => s.beginPairing(RELAY))
    if (!handle) {
      say('  fresh machine cannot show a code at all')
      return
    }
    say('  code shown on fresh C:', handle.code)
    const aJoin = als.run(a.dir, () => a.s.joinPairing(RELAY, handle.code, handle.pairingId))
    const cWait = als.run(c.dir, () => c.s.awaitPairing())
    const [aj, cw] = await Promise.allSettled([aJoin, cWait])
    say('  A joinPairing:', aj.status === 'fulfilled' ? { sas: aj.value.sas } : String(aj.reason))
    say('  C awaitPairing:', cw.status === 'fulfilled' ? { sas: cw.value.sas } : String(cw.reason))
    if (cw.status === 'fulfilled') {
      // The device showing the code is the one that must complete — and it is
      // the one with no account.
      await on(c, 'completePairing', (s) => s.completePairing(cw.value))
    }
    // Whatever that did to the machine that DID have an account.
    snapshot(a, 'after typing a fresh machine\'s code')
    await on(a, 'status', (s) => s.status())
    say('  console device count:', consoleDevices())
    await on(a, 'cancelPairing', (s) => s.cancelPairing())
    await on(c, 'cancelPairing', (s) => s.cancelPairing())
  }, 240_000)

  it('PATH 11 — leave twice in a row, and leave with nothing to leave', async () => {
    say('\n================ PATH 11: leave twice / leave with nothing')
    const z = await newDevice('Z')
    await on(z, 'leaveAccount (never joined)', (s) => s.leaveAccount())
    snapshot(z, 'after leaving nothing')

    const b = devices.B
    if (b) {
      await on(b, 'leaveAccount (1st)', (s) => s.leaveAccount())
      snapshot(b, 'after 1st leave')
      await on(b, 'leaveAccount (2nd)', (s) => s.leaveAccount())
      snapshot(b, 'after 2nd leave')
      await on(b, 'status', (s) => s.status())
      say('  console device count after B left:', consoleDevices())
      await on(devices.A, 'A roster after B left', async (s) => {
        const r = await s.refreshRoster()
        return { n: r.devices.length, labels: r.devices.map((x) => x.label) }
      })
    }
  }, 120_000)

  it('PATH 7 — leave, then re-join by invite', async () => {
    say('\n================ PATH 7: re-join by invite after leaving')
    const b = devices.B
    if (!b) return
    let invite = ''
    try {
      invite = mintInvite()
      say('  console issued an invite:', invite.slice(0, 12) + '…')
    } catch (e) {
      say('  console REFUSED an invite:', (e as Error).message)
    }
    if (invite) {
      await on(b, 'createAccount (re-join by invite)', (s) => s.createAccount(RELAY, invite, 'desktop'))
      snapshot(b, 'after re-join by invite')
      say('  console:', consoleAccounts())
    }
  }, 120_000)

  it('PATH 6 — leave, then re-join by pairing', async () => {
    say('\n================ PATH 6: re-join by pairing after leaving')
    const a = devices.A
    const d = (devices.D = await newDevice('D'))
    await on(d, 'leaveAccount (fresh, to be sure)', (s) => s.leaveAccount())
    const handle = await on(a, 'beginPairing', (s) => s.beginPairing(RELAY))
    if (!handle) return
    const dJoin = als.run(d.dir, () => d.s.joinPairing(RELAY, handle.code, handle.pairingId))
    const aWait = als.run(a.dir, () => a.s.awaitPairing())
    const [dj, aw] = await Promise.allSettled([dJoin, aWait])
    if (aw.status !== 'fulfilled' || dj.status !== 'fulfilled') {
      say('  pairing did not confirm:', String(aw.status === 'rejected' ? aw.reason : dj.status === 'rejected' ? dj.reason : ''))
      return
    }
    const [fin, comp] = await Promise.allSettled([
      als.run(d.dir, () => d.s.finishJoin()),
      als.run(a.dir, () => a.s.completePairing(aw.value))
    ])
    say('  D finishJoin:', fin.status === 'fulfilled' ? fin.value : String(fin.reason))
    say('  A completePairing:', comp.status === 'fulfilled' ? comp.value : String(comp.reason))
    snapshot(d, 'after re-join by pairing')

    // Now D leaves and pairs back on, which is the row this path actually asks.
    await on(d, 'leaveAccount', (s) => s.leaveAccount())
    snapshot(d, 'after leave')
    const h2 = await on(a, 'beginPairing (again)', (s) => s.beginPairing(RELAY))
    if (!h2) return
    const [dj2, aw2] = await Promise.allSettled([
      als.run(d.dir, () => d.s.joinPairing(RELAY, h2.code, h2.pairingId)),
      als.run(a.dir, () => a.s.awaitPairing())
    ])
    if (aw2.status !== 'fulfilled') {
      say('  re-pair did not confirm:', String(aw2.reason))
      return
    }
    say('  emoji agree on re-pair:', dj2.status === 'fulfilled' && JSON.stringify(dj2.value.sas) === JSON.stringify(aw2.value.sas))
    const [fin2, comp2] = await Promise.allSettled([
      als.run(d.dir, () => d.s.finishJoin()),
      als.run(a.dir, () => a.s.completePairing(aw2.value))
    ])
    say('  D finishJoin (re-join):', fin2.status === 'fulfilled' ? fin2.value : String(fin2.reason))
    say('  A completePairing (re-join):', comp2.status === 'fulfilled' ? comp2.value : String(comp2.reason))
    snapshot(d, 'after re-join by pairing')
    await on(a, 'A roster', async (s) => {
      const r = await s.refreshRoster()
      return { n: r.devices.length, labels: r.devices.map((x) => x.label) }
    })
    say('  console device count:', consoleDevices())
  }, 300_000)

  it('PATH 4 + 8 — recover an account from the twelve-word phrase', async () => {
    say('\n================ PATH 4: recover from the phrase on a machine with nothing')
    const e = (devices.E = await newDevice('E'))
    trace = true
    await on(e, 'recoverFromPhrase', (s) => s.recoverFromPhrase(RELAY, mnemonic, 'recovered'))
    trace = false
    snapshot(e, 'after recovery')
    await on(e, 'status', (s) => s.status())
    say('  console device count:', consoleDevices())

    say('\n================ PATH 8: leave, then re-join by the phrase')
    await on(e, 'leaveAccount', (s) => s.leaveAccount())
    snapshot(e, 'after leave')
    await on(e, 'recoverFromPhrase (again)', (s) => s.recoverFromPhrase(RELAY, mnemonic, 'recovered-again'))
    snapshot(e, 'after re-recovery')
    await on(devices.A, 'A roster', async (s) => {
      const r = await s.refreshRoster()
      return { n: r.devices.length, labels: r.devices.map((x) => x.label) }
    })

    say('\n  -- a WRONG phrase, which is what a mistyped card looks like')
    const f = await newDevice('F')
    await on(f, 'recoverFromPhrase (wrong words)', (s) =>
      s.recoverFromPhrase(RELAY, 'abandon '.repeat(11) + 'about', 'typo')
    )
    snapshot(f, 'after a wrong phrase')
  }, 300_000)

  it('PATH 9 — revoked by another device', async () => {
    say('\n================ PATH 9: A revokes D; what D does next')
    const a = devices.A
    const d = devices.D
    if (!a || !d) return
    const before = await als.run(d.dir, () => d.s.refreshRoster())
    const self = before.self
    say('  D pub_sign:', self)
    let wiped: unknown = 'no callback'
    await als.run(d.dir, async () => d.s.onRevoked((t) => { wiped = t }))
    await on(a, 'revokeDevice(D)', (s) => s.revokeDevice(self!))
    say('  console device count after revoke:', consoleDevices())
    await on(d, 'D refreshRoster (finds itself gone)', async (s) => {
      const r = await s.refreshRoster()
      return { n: r.devices.length, stillListed: r.stillListed, problem: r.problem }
    })
    // The wipe is fire-and-forget, so give it a moment before judging it.
    await new Promise((r) => setTimeout(r, 3000))
    say('  D onRevoked fired with:', wiped)
    say('  D tombstone:', existsSync(join(d.dir, 'opsmaxx-addy-revoked.json'))
      ? readFileSync(join(d.dir, 'opsmaxx-addy-revoked.json'), 'utf8')
      : 'NONE')
    await on(d, 'D status', (s) => s.status())
    snapshot(d, 'after being revoked')
    await on(d, 'D syncNow', (s) => s.syncNow())
  }, 300_000)

  it('PATH 10 + 12b — the relay is unreachable', async () => {
    say('\n================ PATH 10/12b: relay down')
    frontdoor('down')
    say('  (TLS front door killed)')

    const a = devices.A
    say('\n  -- 12b: relaunch while the relay is down')
    await a.relaunch()
    await on(a, 'resume (relay down)', (s) => s.resume())
    snapshot(a, 'after resume with relay down')
    await on(a, 'status', (s) => s.status())

    say('\n  -- 10: leave while the relay is down')
    await on(a, 'leaveAccount (relay down)', (s) => s.leaveAccount())
    snapshot(a, 'after leaving with relay down')
    await on(a, 'status', (s) => s.status())

    // and back up, so later rows have a relay
    frontdoor('up', 'certs1')
    say('  (TLS front door back up on certs1)')
  }, 300_000)

  it('PATH 13 — relaunch after the relay presents a different TLS key', async () => {
    say('\n================ PATH 13: the relay\'s certificate changed')
    const g = (devices.G = await newDevice('G'))
    const host = devices.E ?? devices.A
    await on(host, 'resume (stand the host back up)', (s) => s.resume())
    if (!host.s.attached) { say('  no attached host; PATH 13 not run'); return }
    if (!(await pair(host, g))) return
    snapshot(g, 'on the account')
    say('  pinned spki:', String(enrolmentOf(g)?.spki).slice(0, 16) + '…')

    frontdoor('up', 'certs2')
    say('  the relay now presents a DIFFERENT key, from a CA this machine trusts')

    await g.relaunch()
    await on(g, 'resume (after the key changed)', (s) => s.resume())
    snapshot(g, 'after the key changed')
    await on(g, 'status', (s) => s.status())
    say('  spki on disk now:', String(enrolmentOf(g)?.spki).slice(0, 16) + '…')
    say('  -- what can the user do about it?')
    await on(g, 'refreshRoster', (s) => s.refreshRoster())
    await on(g, 'leaveAccount', (s) => s.leaveAccount())
    snapshot(g, 'after leaving')

    frontdoor('up', 'certs1')
  }, 300_000)

  it('PATH 14 — relaunch with the keychain unreadable', async () => {
    say('\n================ PATH 14: a secret has gone from the keychain')
    const h = (devices.H = await newDevice('H'))
    const host = devices.E ?? devices.A
    await on(host, 'resume', (s) => s.resume())
    if (!host.s.attached) { say('  no attached host; PATH 14 not run'); return }
    if (!(await pair(host, h))) return
    snapshot(h, 'on the account')

    const p = join(h.dir, 'opsmaxx-secrets.json')
    const map = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>
    const gone = Object.keys(map).find((k) => k.includes(':device-enc'))
    if (!gone) { say('  no device-enc secret to remove'); return }
    delete map[gone]
    writeFileSync(p, JSON.stringify(map))
    say('  removed from the keychain:', gone.replace('__machine__addy-', ''))

    await h.relaunch()
    await on(h, 'resume (keychain short one key)', (s) => s.resume())
    await on(h, 'status', (s) => s.status())
    snapshot(h, 'after the keychain lost a key')
    say('  -- what can the user do about it?')
    await on(h, 'leaveAccount', (s) => s.leaveAccount())
    snapshot(h, 'after leaving')
  }, 300_000)

  // PATH 15 lives in flows2.probe.ts. The version that was here borrowed one
  // device's `SOURCES` for both machines — and `store.ts` captures its file
  // path at module load, so both edits landed in the same file and the result
  // looked like silent data loss when it was only a bad harness.
})
