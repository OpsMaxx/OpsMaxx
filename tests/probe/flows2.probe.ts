/**
 * The two rows the first probe could not answer cleanly.
 *
 *  - PATH 13 done properly: a NEW key from the SAME CA, so the chain still
 *    verifies and the only thing that changed is the pinned SPKI. The first
 *    run swapped the CA too, so what refused was Node, not the pin.
 *  - PATH 15 done properly: `syncNow()` returns null for three different
 *    reasons and the first run got null every time, so no pass ever ran and
 *    the divergent-edit case was never actually exercised.
 */
import { describe, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'

const RELAY = process.env.ADDY_RELAY ?? 'https://localhost:8490'
const JAR = process.env.ADDY_JAR ?? ''
const OUT = process.env.ADDY_OUT ?? '/tmp/addy-probe2.txt'
const SCRATCH = process.env.ADDY_SCRATCH ?? ''

const als = new AsyncLocalStorage<string>()
let importingInto = mkdtempSync(join(tmpdir(), 'addy-probe2-'))
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

vi.mock('../../src/main/services/addy/sidecar', async (orig) => {
  const real = await orig<typeof import('../../src/main/services/addy/sidecar')>()
  if (!process.env.ADDY_SHIM_ROOTPUB) return real
  return {
    ...real,
    openAddyd: async (role?: '--crypto' | '--rtc', log?: (l: string) => void) => {
      const side = await real.openAddyd(role, log)
      return {
        ...side,
        send: <T>(m: string, p?: unknown, t?: number): Promise<T> => {
          if (m === 'load' && p && typeof p === 'object') {
            const q = p as Record<string, unknown>
            if (!q.rootSignPub) {
              const f = join(hereDir(), 'opsmaxx-addy.json')
              if (existsSync(f)) q.rootSignPub = (JSON.parse(readFileSync(f, 'utf8')) as { rootSignPub?: string }).rootSignPub
            }
          }
          return side.send<T>(m, p, t)
        }
      }
    }
  }
})

type Session = (typeof import('../../src/main/services/addy/session'))['addySession']
type Sources = (typeof import('../../src/main/services/addy/collections'))['SOURCES']
interface Device { name: string; dir: string; s: Session; src: Sources; relaunch(): Promise<Session> }

async function newDevice(name: string): Promise<Device> {
  const dir = mkdtempSync(join(tmpdir(), `addy-${name}-`))
  const d: Device = {
    name, dir, s: null as unknown as Session, src: null as unknown as Sources,
    async relaunch() {
      importingInto = dir
      vi.resetModules()
      await als.run(dir, async () => {
        // BOTH from the same graph, and that is the whole point: `store.ts`
        // captures its file path at module load, so a `SOURCES` borrowed from
        // another device's graph reads and writes THAT device's data file.
        d.s = (await import('../../src/main/services/addy/session')).addySession
        d.src = (await import('../../src/main/services/addy/collections')).SOURCES
      })
      return d.s
    }
  }
  await d.relaunch()
  return d
}

writeFileSync(OUT, `# addy probe 2 ${new Date().toISOString()}\n`)
const say = (...a: unknown[]): void =>
  appendFileSync(OUT, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n')

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

const curl = (a: string[]): string =>
  execFileSync('curl', ['-sk', '--resolve', 'localhost:8480:127.0.0.1', ...a]).toString()
const mintInvite = (): string => {
  const v = JSON.parse(curl(['-b', JAR, '-c', JAR, '-X', 'POST', '-H', 'content-type: application/json',
    '-d', '{}', 'https://localhost:8480/admin/v1/my/invite'])) as { invite?: string; error?: string }
  if (!v.invite) throw new Error(v.error)
  return v.invite
}
function frontdoor(what: 'up' | 'down', certs = 'certs1'): void {
  execFileSync(join(SCRATCH, 'flows', 'frontdoor.sh'),
    what === 'up' ? ['up', join(SCRATCH, 'flows', certs)] : ['down'])
  say(`  (front door ${what}${what === 'up' ? ' on ' + certs : ''})`)
}
const enrolmentOf = (d: Device): { spki?: string } | null => {
  const p = join(d.dir, 'opsmaxx-addy.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as object) : null
}
const secretsOf = (d: Device): number => {
  const p = join(d.dir, 'opsmaxx-secrets.json')
  return existsSync(p) ? Object.keys(JSON.parse(readFileSync(p, 'utf8')) as object).length : 0
}

async function pair(host: Device, joiner: Device): Promise<boolean> {
  const h = await on(host, 'beginPairing', (s) => s.beginPairing(RELAY))
  if (!h) return false
  const [jr, hr] = await Promise.allSettled([
    als.run(joiner.dir, () => joiner.s.joinPairing(RELAY, h.code, h.pairingId)),
    als.run(host.dir, () => host.s.awaitPairing())
  ])
  if (hr.status !== 'fulfilled' || jr.status !== 'fulfilled') {
    say('  pairing did not confirm'); return false
  }
  const [fin, comp] = await Promise.allSettled([
    als.run(joiner.dir, () => joiner.s.finishJoin()),
    als.run(host.dir, () => host.s.completePairing(hr.value))
  ])
  return fin.status === 'fulfilled' && comp.status === 'fulfilled'
}

/** `syncNow()` answers null for three different reasons. Keep asking until a
 *  pass actually runs, so a test of sync is a test of sync. */
async function syncForReal(d: Device, label: string): Promise<unknown> {
  for (let i = 0; i < 40; i++) {
    const r = await als.run(d.dir, () => d.s.syncNow())
    if (r !== null) { say(`  [pass]  ${d.name}.${label} (attempt ${i + 1}):`, r); return r }
    await new Promise((res) => setTimeout(res, 250))
  }
  say(`  [none]  ${d.name}.${label}: syncNow() returned null 40 times (attached=${d.s.attached})`)
  return null
}

describe('probe 2', () => {
  it('PATH 13 — a new key from the SAME CA: only the pin changed', async () => {
    say('\n================ PATH 13 (proper): the relay re-keys, same CA')
    frontdoor('up', 'certs1')
    const a = await newDevice('P')
    await on(a, 'createAccount', (s) => s.createAccount(RELAY, mintInvite(), 'laptop'))
    const pinned = enrolmentOf(a)?.spki
    say('  pinned spki:', String(pinned).slice(0, 20) + '…')

    frontdoor('up', 'certs1b')
    say('  same CA, new key — the chain still verifies, only the SPKI moved')

    await a.relaunch()
    const r = await on(a, 'resume (after the re-key)', (s) => s.resume())
    say('  attached after resume:', a.s.attached)
    await on(a, 'status', (s) => s.status())
    say('  spki still on disk:', String(enrolmentOf(a)?.spki).slice(0, 20) + '…',
      ' unchanged:', enrolmentOf(a)?.spki === pinned)
    say('  -- the remedy the message names is "join again". Can they?')
    await on(a, 'leaveAccount', (s) => s.leaveAccount())
    say('  secrets left behind:', secretsOf(a))
    void r
    frontdoor('up', 'certs1')
  }, 300_000)

  it('PATH 15 — two machines, a divergent edit each, both come back', async () => {
    say('\n================ PATH 15 (proper): divergent edits')
    frontdoor('up', 'certs1')
    const m = await newDevice('M')
    await on(m, 'createAccount', (s) => s.createAccount(RELAY, mintInvite(), 'machine-one'))
    const n = await newDevice('N')
    if (!(await pair(m, n))) { say('  could not pair; PATH 15 not run'); return }
    say('  M and N are both on the account')

    const servers = (d: Device): NonNullable<Sources['servers']> => {
      const s = d.src.servers
      if (!s) throw new Error('`servers` is not a synced collection any more')
      return s
    }
    const put = (d: Device, v: unknown): void =>
      als.run(d.dir, () => servers(d).write(Buffer.from(JSON.stringify(v), 'utf8')))
    const get = (d: Device): string =>
      String(als.run(d.dir, () => servers(d).read())?.toString('utf8') ?? 'null')

    put(m, [{ id: 'shared', name: 'agreed' }])
    await syncForReal(m, 'upload the agreed state')
    await syncForReal(n, 'adopt the agreed state')
    say('  M sees:', get(m))
    say('  N sees:', get(n))

    say('\n  -- now each edits it while the other cannot see')
    put(m, [{ id: 'shared', name: 'agreed' }, { id: 'fromM', name: 'added on M' }])
    put(n, [{ id: 'shared', name: 'agreed' }, { id: 'fromN', name: 'added on N' }])

    await syncForReal(m, 'M comes back first')
    await syncForReal(n, 'N comes back second')
    say('  M sees:', get(m))
    say('  N sees:', get(n))
    await on(n, 'conflicts', (s) => s.conflicts())
    await on(m, 'conflicts', (s) => s.conflicts())

    say('\n  -- and one more pass each, since sync is a loop')
    await syncForReal(m, 'M again')
    await syncForReal(n, 'N again')
    say('  M sees:', get(m))
    say('  N sees:', get(n))
    await on(n, 'conflicts', (s) => s.conflicts())
    await on(m, 'status', (s) => s.status())
  }, 300_000)

  it('PATH 12c — reconnect() is the Try again button; does it work?', async () => {
    say('\n================ PATH 12c: the relay goes away and comes back')
    frontdoor('up', 'certs1')
    const d = await newDevice('R')
    await on(d, 'createAccount', (s) => s.createAccount(RELAY, mintInvite(), 'laptop'))
    await on(d, 'status (healthy)', (s) => s.status())

    frontdoor('down')
    say('  -- the relay is gone. This is the state the Try again button is for.')
    await on(d, 'status (relay down)', (s) => s.status())
    await on(d, 'reconnect (relay still down)', (s) => s.reconnect())
    await on(d, 'pauseSync', async (s) => s.pauseSync())
    await on(d, 'resumeSync (relay down)', async (s) => s.resumeSync())

    frontdoor('up', 'certs1')
    say('  -- the relay is back. Pressing Try again now:')
    await on(d, 'reconnect (relay back)', (s) => s.reconnect())
    await on(d, 'status (after reconnect)', (s) => s.status())
    await syncForReal(d, 'sync after reconnect')
  }, 300_000)
})
