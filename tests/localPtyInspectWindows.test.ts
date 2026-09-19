import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { LocalShell, LocalShellKind } from '../src/shared/local'

/**
 * Why a Windows terminal OpsMaxx opened captured nothing.
 *
 * Reported as: "in windows traffic capture nothing showed up when i ran it
 * with terminals opsmaxx opens i tried curl and it didn't show up." The panel
 * said "Capturing on 127.0.0.1:…", the certificate was there, the request
 * count stayed at zero. Three separate causes, all of which present exactly
 * like that:
 *
 *  1. **The environment merge was case-sensitive and Windows is not.** The
 *     spawn built its environment with `{...sanitisedEnv(), ...inspectEnv()}`.
 *     JavaScript object keys are case-sensitive; Windows environment variables
 *     are not. A machine that already had `Http_Proxy` set — a VPN client, a
 *     login script, an older proxy tool — therefore handed CreateProcess a
 *     block containing BOTH that and our `HTTP_PROXY`, with the stale one
 *     first because the base layer is spread first. Windows resolves a name by
 *     scanning the block case-insensitively and answering with the first
 *     match, so curl read the stale value and went somewhere else entirely.
 *
 *  2. **PowerShell's `curl` is not curl.** Windows PowerShell 5.1 — the
 *     PowerShell on every Windows machine that has not installed 7, and the
 *     shell this app itself offers as the Windows default — ships `curl` and
 *     `wget` as aliases for `Invoke-WebRequest`. That cmdlet is .NET
 *     Framework: it takes its proxy from the machine's WinINET settings and
 *     ignores `HTTP_PROXY` completely. The environment was injected perfectly
 *     and the request still could not be seen, because the user was not
 *     running curl. No environment variable can fix that, so the app has to
 *     say it.
 *
 *  3. **A terminal opened before Start is never routed and was never told.**
 *     An environment is inherited once, at spawn. The stop path already writes
 *     a notice into every affected shell; the start path wrote nothing.
 *
 * Nothing here runs on Windows or spawns a pty. The seams are
 * `@lydell/node-pty` — so the assertions read the environment object the pty
 * ACTUALLY receives, not a re-derivation of it — and the WebContents, which
 * records every byte the main process pushes at a terminal.
 */

const hoisted = vi.hoisted(() => ({
  /** Every spawn, as it reached node-pty. */
  spawns: [] as { file: string; args: string[]; opts: Record<string, unknown> }[],
  /** Whether capture is currently injecting into new sessions. */
  injecting: false,
  /** What inspectEnv() hands back while it is. */
  injected: {} as Record<string, string>,
  /** The callbacks localPty registers with the inspector, captured so the test
   *  can fire them the way a real start/stop would — which is also what proves
   *  the registration happens at all. */
  onStarted: [] as (() => void)[],
  onStopped: [] as (() => void)[],
  /** The shell findShell() resolves to. */
  shell: null as LocalShell | null
}))

vi.mock('@lydell/node-pty', () => {
  const spawn = (file: string, args: string[], opts: Record<string, unknown>) => {
    hoisted.spawns.push({ file, args, opts })
    return {
      pid: 4242,
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {},
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} })
    }
  }
  // Both shapes, because the real package is CommonJS and loadPty() unwraps
  // `.default` when it is there. A mock with only the named export makes the
  // module under test take its `.default` branch against a Vitest proxy that
  // throws, which fails as a spawn error rather than as anything to do with
  // the code.
  return { spawn, default: { spawn } }
})

vi.mock('../src/main/services/inspect', () => ({
  inspectEnv: () => (hoisted.injecting ? { ...hoisted.injected } : {}),
  inspectInjectsSessions: () => hoisted.injecting,
  onInspectStarted: (fn: () => void) => hoisted.onStarted.push(fn),
  onInspectStopped: (fn: () => void) => hoisted.onStopped.push(fn)
}))

vi.mock('../src/main/services/shellDiscovery', async (importOriginal) => {
  // sanitisedEnv stays REAL. It is the layer the collision comes from — it
  // forwards process.env verbatim — and a stubbed one would have hidden the
  // whole bug.
  const actual = await importOriginal<typeof import('../src/main/services/shellDiscovery')>()
  return { ...actual, findShell: async () => hoisted.shell }
})

import { childEnv, localConnect, localNotifyInspectStopped } from '../src/main/services/localPty'

/** The proxy the inspector is listening on. Values a stale variable could not
 *  coincidentally match. */
const PROXY = 'http://127.0.0.1:58653'
const CERT = 'C:\\Users\\x\\AppData\\Roaming\\OpsMaxx\\inspect\\opsmaxx-inspector-ca.crt'

/** inspectEnv()'s documented shape: both casings of each proxy variable,
 *  because on a POSIX machine they are two different variables and real tools
 *  read one or the other. Reproduced rather than imported because the real one
 *  answers `{}` unless a sidecar is actually listening — what is under test
 *  here is what the SPAWN does with it, which is the half that was wrong. */
const INSPECT_ENV: Record<string, string> = {
  HTTP_PROXY: PROXY,
  HTTPS_PROXY: PROXY,
  http_proxy: PROXY,
  https_proxy: PROXY,
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
  NODE_EXTRA_CA_CERTS: CERT,
  REQUESTS_CA_BUNDLE: CERT,
  SSL_CERT_FILE: CERT,
  CURL_CA_BUNDLE: CERT,
  GIT_SSL_CAINFO: CERT
}

function winShell(kind: LocalShellKind, id = `win32-${kind}`): LocalShell {
  return {
    id,
    label: kind,
    kind,
    path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoLogo']
  }
}

function fakeWebContents(): { wc: WebContents; sent: { channel: string; args: unknown[] }[] } {
  const sent: { channel: string; args: unknown[] }[] = []
  const wc = {
    id: 7,
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
  } as unknown as WebContents
  return { wc, sent }
}

/**
 * What GetEnvironmentVariable would answer inside the spawned process.
 *
 * Windows environment variable names are case-insensitive, and a block that
 * contains two spellings of one name is resolved by scanning it and returning
 * the FIRST match — which is insertion order, the order node-pty writes the
 * object's keys out in. This is the platform's rule, reproduced here the way
 * tests/inspectTrustWindows.test.ts reproduces `reg query`'s output format:
 * the behaviour being modelled is the operating system's, not this codebase's.
 */
function windowsLookup(env: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key]
  }
  return undefined
}

/** The environment the pty was actually handed on the last spawn. */
function spawnedEnv(): Record<string, string> {
  const last = hoisted.spawns.at(-1)
  expect(last, 'nothing was spawned').toBeTruthy()
  return last!.opts.env as Record<string, string>
}

/** Everything written to a terminal's output, joined. */
function output(sent: { channel: string; args: unknown[] }[], sessionId: string): string {
  return sent
    .filter((s) => s.channel === `local:data:${sessionId}`)
    .map((s) => String(s.args[0]))
    .join('')
}

beforeEach(() => {
  hoisted.spawns.length = 0
  hoisted.injecting = true
  hoisted.injected = { ...INSPECT_ENV }
  hoisted.shell = winShell('powershell')
  for (const k of Object.keys(process.env)) {
    if (/^(http|https|no)_proxy$/i.test(k)) delete process.env[k]
  }
})

describe('the environment the pty is actually handed', () => {
  // The bug. A pre-existing variable in ANY spelling other than the two
  // inspectEnv() emits survives the spread and, on Windows, wins.
  it('lets no pre-existing spelling of a proxy variable outrank the injected one', async () => {
    process.env.Http_Proxy = 'http://stale.invalid:3128'
    process.env.Https_Proxy = 'http://stale.invalid:3128'
    process.env.No_Proxy = '*'

    const { wc } = fakeWebContents()
    await localConnect(wc, { sessionId: 's1', shellId: 'win32-powershell', cols: 80, rows: 24 })
    const env = spawnedEnv()

    expect(windowsLookup(env, 'HTTP_PROXY')).toBe(PROXY)
    expect(windowsLookup(env, 'HTTPS_PROXY')).toBe(PROXY)
    expect(windowsLookup(env, 'NO_PROXY')).toBe('localhost,127.0.0.1,::1')
    // And the stale spellings are gone outright, not merely outranked: an
    // entry still in the block is an entry some other tool can read.
    expect(Object.keys(env).filter((k) => /^http_proxy$/i.test(k)).sort()).toEqual([
      'HTTP_PROXY',
      'http_proxy'
    ])

    delete process.env.Http_Proxy
    delete process.env.Https_Proxy
    delete process.env.No_Proxy
  })

  // The POSIX half of the same rule, which is why the fix cannot just
  // lower-case everything: a Linux or macOS shell needs BOTH spellings,
  // because curl reads http_proxy and half of everything else reads HTTP_PROXY.
  it('keeps both spellings the inspector deliberately emits', async () => {
    const { wc } = fakeWebContents()
    await localConnect(wc, { sessionId: 's2', shellId: 'win32-powershell', cols: 80, rows: 24 })
    const env = spawnedEnv()
    expect(env.HTTP_PROXY).toBe(PROXY)
    expect(env.http_proxy).toBe(PROXY)
    expect(env.NODE_EXTRA_CA_CERTS).toBe(CERT)
  })

  // The layering order the spawn site documents: a shell profile that sets one
  // of these on purpose still wins over the inspector's.
  it('still lets the shell its own env, last, over the injected one', async () => {
    hoisted.shell = { ...winShell('msys2'), env: { HTTPS_PROXY: 'http://the-shells-own:1' } }
    const { wc } = fakeWebContents()
    await localConnect(wc, { sessionId: 's3', shellId: 'win32-msys2', cols: 80, rows: 24 })
    expect(windowsLookup(spawnedEnv(), 'HTTPS_PROXY')).toBe('http://the-shells-own:1')
  })

  it('injects nothing at all when capture is off', async () => {
    hoisted.injecting = false
    const { wc } = fakeWebContents()
    await localConnect(wc, { sessionId: 's4', shellId: 'win32-powershell', cols: 80, rows: 24 })
    expect(windowsLookup(spawnedEnv(), 'HTTP_PROXY')).toBeUndefined()
  })
})

describe('childEnv resolves case across layers but not within one', () => {
  it('drops an earlier spelling and keeps two spellings from the same layer', () => {
    const merged = childEnv({ Http_Proxy: 'stale' }, { HTTP_PROXY: 'new', http_proxy: 'new' })
    expect(merged.Http_Proxy).toBeUndefined()
    expect(merged.HTTP_PROXY).toBe('new')
    expect(merged.http_proxy).toBe('new')
  })

  it('leaves everything that does not collide exactly where it was', () => {
    const merged = childEnv({ PATH: '/bin', TERM: 'dumb' }, { TERM: 'xterm-256color' })
    expect(merged).toEqual({ PATH: '/bin', TERM: 'xterm-256color' })
  })
})

describe('a shell is told what is true of it', () => {
  // The report. The environment reached this shell correctly and `curl` still
  // captured nothing, because in Windows PowerShell `curl` is a built-in alias
  // for Invoke-WebRequest, which does not read HTTP_PROXY at all.
  it('warns a Windows PowerShell session that its curl is Invoke-WebRequest', async () => {
    const { wc, sent } = fakeWebContents()
    await localConnect(wc, { sessionId: 'ps', shellId: 'win32-powershell', cols: 80, rows: 24 })
    const text = output(sent, 'ps')
    expect(text).toContain('Invoke-WebRequest')
    expect(text).toContain('curl.exe')
  })

  // PowerShell 6 removed the aliases, so in pwsh `curl` already IS curl.exe.
  // Saying otherwise there would be a false claim about someone's shell.
  it('does not repeat that warning for PowerShell 7, where curl is curl', async () => {
    hoisted.shell = winShell('pwsh')
    const { wc, sent } = fakeWebContents()
    await localConnect(wc, { sessionId: 'p7', shellId: 'win32-pwsh', cols: 80, rows: 24 })
    const text = output(sent, 'p7')
    expect(text).toContain('routed through OpsMaxx traffic capture')
    expect(text).not.toContain('Invoke-WebRequest')
  })

  // WSL is a different machine: wsl.exe carries only what WSLENV names, and
  // 127.0.0.1 inside the distribution is the distribution. Claiming that
  // session is routed would be a plain lie.
  it('tells a WSL session it is NOT captured rather than that it is', async () => {
    hoisted.shell = winShell('wsl')
    const { wc, sent } = fakeWebContents()
    await localConnect(wc, { sessionId: 'w', shellId: 'win32-wsl', cols: 80, rows: 24 })
    const text = output(sent, 'w')
    expect(text).toContain('nothing you run here is captured')
    expect(text).not.toContain('routed through OpsMaxx traffic capture')
  })

  it('says nothing when capture is off', async () => {
    hoisted.injecting = false
    const { wc, sent } = fakeWebContents()
    await localConnect(wc, { sessionId: 'q', shellId: 'win32-powershell', cols: 80, rows: 24 })
    expect(output(sent, 'q')).toBe('')
  })
})

describe('shells that were already open when capture started', () => {
  it('are told they are not part of it, through the inspector’s own callback', async () => {
    hoisted.injecting = false
    const { wc, sent } = fakeWebContents()
    await localConnect(wc, { sessionId: 'old', shellId: 'win32-powershell', cols: 80, rows: 24 })
    expect(output(sent, 'old')).toBe('')

    // Capture starts. Fired through the callback localPty registered at module
    // load, which is the path a real start takes.
    hoisted.injecting = true
    expect(hoisted.onStarted.length).toBeGreaterThan(0)
    for (const fn of hoisted.onStarted) fn()

    const text = output(sent, 'old')
    expect(text).toContain('was opened before it')
    expect(text).toContain('Copy shell setup')
  })

  it('does not tell a shell that IS routed that it is not', async () => {
    const { wc, sent } = fakeWebContents()
    await localConnect(wc, { sessionId: 'new', shellId: 'win32-powershell', cols: 80, rows: 24 })
    for (const fn of hoisted.onStarted) fn()
    expect(output(sent, 'new')).not.toContain('was opened before it')
  })

  // Previously unreachable in a test: the notice was addressed with
  // webContents.fromId(), which answers nothing outside a real Electron
  // process, so the whole path was asserted by nobody.
  it('tells a routed shell when capture stops', async () => {
    const { wc, sent } = fakeWebContents()
    await localConnect(wc, { sessionId: 'z', shellId: 'win32-powershell', cols: 80, rows: 24 })
    localNotifyInspectStopped()
    expect(output(sent, 'z')).toContain('Traffic capture stopped')
  })
})
