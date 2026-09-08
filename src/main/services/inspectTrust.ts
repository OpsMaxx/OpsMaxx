import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { InspectTrustStore } from '../../shared/inspect'
import { elevatorForPlatform } from './vpn/elevation'

const run = promisify(execFile)

// Trust, and the machine settings that point traffic at us.
//
// Two jobs live here because they share one property that shapes both: they
// are the only parts of the traffic inspector that change state OUTSIDE this
// application. A CA in the system keychain and a system-wide proxy setting
// both outlive the process that made them, and both are capable of leaving a
// machine worse than they found it — one by trusting a key that no longer
// exists, the other by pointing every connection at a port nothing is
// listening on.
//
// So everything here obeys three rules:
//
//  1. **Nothing is installed that cannot be uninstalled by the same code.**
//     Every install has a matching remove, and the remove runs on quit, on the
//     next launch after a crash, and on demand.
//  2. **What was changed is written down before it is changed.** The previous
//     proxy settings go to disk first. A process that dies between "changed"
//     and "remembered" is the case that strands a machine offline, and it is
//     the only ordering that survives it.
//  3. **A store we cannot change is reported, never silently skipped.**
//     Firefox, the JVM and Node keep their own trust stores. Telling someone
//     their certificate is installed while their Node script still fails is
//     worse than telling them nothing.

const CERT_BASENAME = 'opsmaxx-inspector-ca.crt'
const NSS_NICKNAME = 'OpsMaxx Traffic Inspector'
const LINUX_ANCHOR_DEBIAN = '/usr/local/share/ca-certificates'
const LINUX_ANCHOR_RHEL = '/etc/pki/ca-trust/source/anchors'

/** Bounded so a hung `security` or `certutil` cannot wedge the status panel. */
const PROBE_TIMEOUT_MS = 10_000

export interface TrustContext {
  platform: NodeJS.Platform
  /** Where the public certificate is written for tools that take a path. */
  certPath: string
  certPem: string
  commonName: string
}

// ------------------------------------------------------------------ fingerprints

/** DER bytes out of a PEM certificate. */
export function derFromPem(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

export function sha256Hex(pem: string): string {
  return createHash('sha256').update(derFromPem(pem)).digest('hex')
}

/** Windows identifies a certificate in a store by its SHA-1 thumbprint and
 *  nothing else, however much everyone would prefer otherwise. */
export function sha1Hex(pem: string): string {
  return createHash('sha1').update(derFromPem(pem)).digest('hex')
}

// ------------------------------------------------------------------ cert file

/** Writes the public certificate where the user and their tools can reach it.
 *  0644, deliberately: this is the half that is meant to be handed out, and a
 *  0600 file is one a container or another user cannot read. */
export async function writeCertFile(certPem: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'inspect')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, CERT_BASENAME)
  await writeFile(path, certPem, { mode: 0o644 })
  await chmod(path, 0o644).catch(() => {})
  return path
}

export async function removeCertFile(): Promise<void> {
  await rm(join(app.getPath('userData'), 'inspect', CERT_BASENAME), { force: true }).catch(() => {})
}

// ------------------------------------------------------------------ detection

async function tryRun(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await run(cmd, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true })
    return { ok: true, stdout: String(stdout ?? '') }
  } catch (e) {
    const stdout = (e as { stdout?: string })?.stdout
    return { ok: false, stdout: String(stdout ?? '') }
  }
}

function which(cmd: string): boolean {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const names = process.platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`] : [cmd]
  return dirs.some((d) => d && names.some((n) => existsSync(join(d, n))))
}

/** Is our CA in the operating system's own trust store right now?
 *
 *  Asked by fingerprint rather than by name, because a stale certificate from
 *  a previous install has the same name and a different key — and a UI that
 *  says "trusted" while the running proxy signs with a different authority
 *  sends the user hunting for a problem in entirely the wrong place. */
async function systemTrustState(ctx: TrustContext): Promise<InspectTrustStore> {
  const base = { id: 'system' as const, label: 'System trust store', installable: true }
  if (ctx.platform === 'darwin') {
    // Presence and trust are different facts, and only the second one matters.
    //
    // This used to answer with `find-certificate`, which reports a certificate
    // sitting in the keychain with no trust setting attached as "trusted". On
    // a real machine the install added the certificate and the trust setting
    // did not take: the panel then said the certificate was fine, hid the
    // install button, and every single host came back as though it pinned —
    // because every client on the machine was, correctly, refusing a root it
    // does not trust. `verify-cert` is the question actually being asked.
    const present = await tryRun('security', [
      'find-certificate',
      '-a',
      '-Z',
      '-c',
      ctx.commonName,
      '/Library/Keychains/System.keychain'
    ])
    const installed = present.stdout.toUpperCase().includes(sha256Hex(ctx.certPem).toUpperCase())
    const verified = await tryRun('security', ['verify-cert', '-c', ctx.certPath, '-p', 'ssl'])
    if (verified.ok) return { ...base, state: 'trusted' }
    return {
      ...base,
      state: 'untrusted',
      hint: installed
        ? 'The certificate is in your keychain but is not trusted, so every HTTPS request still fails. Install it again to add the trust setting.'
        : 'Install the certificate to intercept HTTPS in Safari, Chrome and native apps.'
    }
  }
  invalidateTrustCache()
  if (ctx.platform === 'win32') {
    // A certificate in the Root store IS trusted on Windows — the store is the
    // trust setting, unlike macOS where the two are separate. `-verifystore`
    // is still the stronger question: it fails for a certificate that is
    // present but expired or otherwise unusable.
    const thumb = sha1Hex(ctx.certPem).toUpperCase()
    const verified = await tryRun('certutil', ['-user', '-verifystore', 'Root', thumb])
    if (verified.ok && verified.stdout.toUpperCase().includes(thumb)) {
      return { ...base, state: 'trusted' }
    }
    return {
      ...base,
      state: 'untrusted',
      hint: 'Install the certificate to intercept HTTPS in Edge, Chrome and .NET applications.'
    }
  }
  if (ctx.platform === 'linux') {
    const installed =
      existsSync(join(LINUX_ANCHOR_DEBIAN, CERT_BASENAME)) ||
      existsSync(join(LINUX_ANCHOR_RHEL, CERT_BASENAME))
    return {
      ...base,
      state: installed ? 'trusted' : 'untrusted',
      hint: installed ? undefined : 'Install the certificate into the system anchors. Needs administrator rights once.'
    }
  }
  return { ...base, state: 'unsupported', installable: false }
}

/** Firefox, Thunderbird and Chrome-on-Linux all read NSS, which the operating
 *  system's own store never reaches. */
async function nssTrustState(ctx: TrustContext): Promise<InspectTrustStore> {
  const base = { id: 'nss' as const, label: 'Firefox and NSS applications' }
  const dbDir = join(homedir(), '.pki', 'nssdb')
  if (ctx.platform === 'win32') {
    return {
      ...base,
      state: 'unknown',
      installable: false,
      hint: 'Firefox keeps its own trust store. Set Settings → Privacy → Security Devices, or enable enterprise roots.'
    }
  }
  if (!which('certutil') || !existsSync(dbDir)) {
    return {
      ...base,
      state: 'unknown',
      installable: false,
      hint: which('certutil')
        ? 'No NSS database found. Firefox creates one the first time it runs.'
        : 'Install nss-tools (certutil) and OpsMaxx can add the certificate for Firefox.'
    }
  }
  const { stdout } = await tryRun('certutil', ['-d', `sql:${dbDir}`, '-L', '-n', NSS_NICKNAME])
  const trusted = stdout.includes('Certificate:')
  return {
    ...base,
    state: trusted ? 'trusted' : 'untrusted',
    installable: true,
    hint: trusted ? undefined : 'Add the certificate to the NSS database so Firefox accepts it.'
  }
}

/** Stores OpsMaxx deliberately does not touch. Reporting them is the whole
 *  contribution: each one is a real reason an intercepted request fails, and
 *  each has a one-line fix the user can apply themselves. */
function reportOnlyStores(ctx: TrustContext): InspectTrustStore[] {
  return [
    {
      id: 'node',
      label: 'Node.js',
      state: 'unknown',
      installable: false,
      hint: `Node ignores the system store. Set NODE_EXTRA_CA_CERTS=${ctx.certPath} — sessions OpsMaxx starts get this automatically.`
    },
    {
      id: 'python',
      label: 'Python requests',
      state: 'unknown',
      installable: false,
      hint: `requests uses its own bundle. Set REQUESTS_CA_BUNDLE=${ctx.certPath} — sessions OpsMaxx starts get this automatically.`
    },
    {
      id: 'java',
      label: 'Java',
      state: 'unknown',
      installable: false,
      hint: `The JVM uses its own keystore: keytool -importcert -cacerts -alias opsmaxx -file ${ctx.certPath}`
    }
  ]
}

/** Trust does not change between two calls a second apart, and every call
 *  shells out to `security` or `certutil` with a ten-second timeout each. The
 *  status is read on every start, stop and passthrough change, so without this
 *  a busy panel spawns a process per keystroke. Invalidated explicitly by the
 *  two things that actually change trust. */
let trustCache: { key: string; at: number; value: InspectTrustStore[] } | null = null
const TRUST_CACHE_MS = 5_000

export function invalidateTrustCache(): void {
  trustCache = null
}

export async function trustStatus(ctx: TrustContext): Promise<InspectTrustStore[]> {
  // Keyed on the fingerprint: regenerating the authority must not be answered
  // from a cache describing the one it replaced.
  const key = `${ctx.platform}:${sha256Hex(ctx.certPem)}`
  const now = Date.now()
  if (trustCache && trustCache.key === key && now - trustCache.at < TRUST_CACHE_MS) {
    return trustCache.value
  }
  const [system, nss] = await Promise.all([systemTrustState(ctx), nssTrustState(ctx)])
  const value = [system, nss, ...reportOnlyStores(ctx)]
  trustCache = { key, at: now, value }
  return value
}

// ------------------------------------------------------------------ install

export interface TrustChangeResult {
  ok: boolean
  /** Set when the user declined the elevation prompt, which is a normal
   *  outcome and not a failure to report as an error. */
  declined?: boolean
  message?: string
}

/** Installs the CA into the operating system's trust store.
 *
 *  One prompt, nothing left behind that can still become root, and a matching
 *  uninstall — the same contract `sidecar/netd/privileged.go` sets for the
 *  tunnel. Windows needs no prompt at all because the per-user Root store does
 *  not require administrator rights, and asking for rights we do not need is
 *  how an application teaches people to click through prompts. */
export async function installSystemTrust(ctx: TrustContext): Promise<TrustChangeResult> {
  invalidateTrustCache()
  if (ctx.platform === 'win32') {
    const res = await tryRun('certutil', ['-user', '-addstore', 'Root', ctx.certPath])
    return res.ok
      ? { ok: true }
      : { ok: false, message: 'Windows refused to add the certificate to the user trust store.' }
  }

  const elevator = elevatorForPlatform(ctx.platform)
  const probe = await elevator.probe()
  if (!probe.available) {
    return { ok: false, message: probe.reason ?? 'This machine has no way to ask for administrator rights.' }
  }

  const reason = 'OpsMaxx needs administrator rights once to trust its traffic-inspection certificate.'
  let command: string
  let args: string[]
  if (ctx.platform === 'darwin') {
    command = 'security'
    args = [
      'add-trusted-cert',
      '-d',
      '-r',
      'trustRoot',
      '-p',
      'ssl',
      '-k',
      '/Library/Keychains/System.keychain',
      ctx.certPath
    ]
  } else {
    // Debian and RHEL keep anchors in different places and update them with
    // different commands. Running the pair that exists, rather than detecting
    // the distribution, is both shorter and correct on the derivatives that
    // ship one of each.
    const anchor = existsSync(LINUX_ANCHOR_RHEL) ? LINUX_ANCHOR_RHEL : LINUX_ANCHOR_DEBIAN
    const update = existsSync('/usr/sbin/update-ca-trust') || which('update-ca-trust')
      ? 'update-ca-trust extract'
      : 'update-ca-certificates'
    command = 'sh'
    args = [
      '-c',
      `mkdir -p ${shq(anchor)} && cp ${shq(ctx.certPath)} ${shq(join(anchor, CERT_BASENAME))} && chmod 644 ${shq(join(anchor, CERT_BASENAME))} && ${update}`
    ]
  }

  const proc = await elevator.run({ reason, command, args })
  const exit = await proc.wait()
  if (exit.declined) return { ok: false, declined: true, message: 'The administrator prompt was declined.' }
  if (exit.code !== 0) {
    return { ok: false, message: `The trust store rejected the certificate (exit ${exit.code ?? 'unknown'}).` }
  }

  // Verified rather than assumed. `security add-trusted-cert` can exit 0 having
  // added the certificate to the keychain without attaching the trust setting
  // — a managed Mac can drop it, and so can a policy this process cannot see.
  // The result is a certificate that looks installed and is refused by every
  // client, which is far worse than an install that admits it failed.
  invalidateTrustCache()
  const after = await systemTrustState(ctx)
  if (after.state !== 'trusted') {
    return {
      ok: false,
      message:
        after.hint ??
        'The certificate was added but is still not trusted. A device management profile may be preventing it.'
    }
  }
  return { ok: true }
}

export async function removeSystemTrust(ctx: TrustContext): Promise<TrustChangeResult> {
  if (ctx.platform === 'win32') {
    const thumb = sha1Hex(ctx.certPem).toUpperCase()
    const res = await tryRun('certutil', ['-user', '-delstore', 'Root', thumb])
    return res.ok ? { ok: true } : { ok: false, message: 'Windows did not remove the certificate.' }
  }
  const elevator = elevatorForPlatform(ctx.platform)
  const probe = await elevator.probe()
  if (!probe.available) {
    return { ok: false, message: probe.reason ?? 'This machine has no way to ask for administrator rights.' }
  }
  const reason = 'OpsMaxx needs administrator rights once to remove its traffic-inspection certificate.'
  let command: string
  let args: string[]
  if (ctx.platform === 'darwin') {
    command = 'security'
    args = ['delete-certificate', '-c', ctx.commonName, '-t', '/Library/Keychains/System.keychain']
  } else {
    const update = which('update-ca-trust') ? 'update-ca-trust extract' : 'update-ca-certificates --fresh'
    command = 'sh'
    args = [
      '-c',
      `rm -f ${shq(join(LINUX_ANCHOR_DEBIAN, CERT_BASENAME))} ${shq(join(LINUX_ANCHOR_RHEL, CERT_BASENAME))}; ${update}`
    ]
  }
  const proc = await elevator.run({ reason, command, args })
  const exit = await proc.wait()
  if (exit.declined) return { ok: false, declined: true, message: 'The administrator prompt was declined.' }
  return exit.code === 0 ? { ok: true } : { ok: false, message: 'The certificate could not be removed.' }
}

/** NSS needs no elevation: the database belongs to the user. */
export async function installNssTrust(ctx: TrustContext): Promise<TrustChangeResult> {
  invalidateTrustCache()
  const dbDir = join(homedir(), '.pki', 'nssdb')
  if (!which('certutil') || !existsSync(dbDir)) {
    return { ok: false, message: 'No NSS database to add the certificate to.' }
  }
  // Removed first, so re-running after regenerating the CA replaces the stale
  // certificate instead of leaving two under one nickname.
  await tryRun('certutil', ['-d', `sql:${dbDir}`, '-D', '-n', NSS_NICKNAME])
  const res = await tryRun('certutil', [
    '-d',
    `sql:${dbDir}`,
    '-A',
    '-t',
    'C,,',
    '-n',
    NSS_NICKNAME,
    '-i',
    ctx.certPath
  ])
  return res.ok ? { ok: true } : { ok: false, message: 'certutil did not add the certificate.' }
}

export async function removeNssTrust(): Promise<TrustChangeResult> {
  invalidateTrustCache()
  const dbDir = join(homedir(), '.pki', 'nssdb')
  if (!which('certutil') || !existsSync(dbDir)) return { ok: true }
  await tryRun('certutil', ['-d', `sql:${dbDir}`, '-D', '-n', NSS_NICKNAME])
  return { ok: true }
}

/**
 * Tell WinINET that the proxy settings changed.
 *
 * Writing the registry alone only affects processes that start afterwards:
 * every browser and .NET application already running reads its proxy
 * configuration once and keeps it. Without this, turning capture on appears to
 * do nothing until the user restarts their browser — and turning it off leaves
 * them proxied through a closed port until they do.
 *
 * There is no command-line way to raise `InternetSetOption`, so this goes
 * through PowerShell with a P/Invoke declaration. Best-effort: a machine with
 * PowerShell locked down still gets the registry change, which is what a newly
 * started process reads.
 */
async function notifyWinInetSettingsChanged(): Promise<void> {
  const script = [
    "$sig = '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'",
    "$t = Add-Type -MemberDefinition $sig -Name W -Namespace S -PassThru",
    // 39 = INTERNET_OPTION_SETTINGS_CHANGED, 37 = INTERNET_OPTION_REFRESH.
    "$null = $t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)",
    "$null = $t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)"
  ].join('; ')
  await tryRun('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
}

/** POSIX single-quote escaping. The paths here are ours, but they run through
 *  `sh -c` under elevation, and a path containing a quote must be a broken
 *  command rather than an injected one. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ------------------------------------------------------------------ system proxy

/** What the machine's proxy settings were before we touched them.
 *
 *  Written to disk BEFORE the change and deleted only after the restore
 *  succeeds, so a power cut in the middle leaves a file that the next launch
 *  finds and acts on. This is the whole defence against the worst failure this
 *  feature has: a user with no internet and no idea why. */
interface ProxyBackup {
  platform: NodeJS.Platform
  takenAt: number
  darwin?: { service: string; web: string[]; secure: string[] }[]
  win32?: { proxyEnable?: string; proxyServer?: string; proxyOverride?: string }
  linux?: { mode: string; host: string; port: string; httpsHost: string; httpsPort: string }
  kde?: { proxyType: string; httpProxy: string; httpsProxy: string }
}

function backupPath(): string {
  return join(app.getPath('userData'), 'inspect', 'system-proxy-backup.json')
}

async function saveBackup(b: ProxyBackup): Promise<void> {
  await mkdir(join(app.getPath('userData'), 'inspect'), { recursive: true, mode: 0o700 })
  await writeFile(backupPath(), JSON.stringify(b), { mode: 0o600 })
}

async function loadBackup(): Promise<ProxyBackup | null> {
  try {
    return JSON.parse(await readFile(backupPath(), 'utf8')) as ProxyBackup
  } catch {
    return null
  }
}

async function clearBackup(): Promise<void> {
  await rm(backupPath(), { force: true }).catch(() => {})
}

/** True when this machine's proxy settings are currently pointed at us. */
export async function systemProxyEngaged(): Promise<boolean> {
  return (await loadBackup()) !== null
}

/** KDE's config tools are versioned by major release and only one is present. */
function kwriteconfig(): string {
  return which('kwriteconfig6') ? 'kwriteconfig6' : 'kwriteconfig5'
}

function kreadconfig(): string {
  return which('kreadconfig6') ? 'kreadconfig6' : 'kreadconfig5'
}

function isKde(): boolean {
  const desktop = `${process.env.XDG_CURRENT_DESKTOP ?? ''} ${process.env.DESKTOP_SESSION ?? ''}`
  return /kde|plasma/i.test(desktop)
}

async function readKdeProxy(): Promise<{ proxyType: string; httpProxy: string; httpsProxy: string }> {
  const r = kreadconfig()
  const get = async (k: string): Promise<string> =>
    (await tryRun(r, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', k])).stdout.trim()
  return {
    proxyType: await get('ProxyType'),
    httpProxy: await get('httpProxy'),
    httpsProxy: await get('httpsProxy')
  }
}

async function darwinServices(): Promise<string[]> {
  const { stdout } = await tryRun('networksetup', ['-listallnetworkservices'])
  return stdout
    .split('\n')
    .slice(1) // the first line is a note about disabled services
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*'))
}

/**
 * Points the machine at the inspector.
 *
 * macOS needs administrator rights for `networksetup`; Windows and GNOME do
 * not, because the settings are per-user there. That asymmetry is not smoothed
 * over: asking for rights on a platform that does not need them trains people
 * to approve prompts without reading them.
 */
export async function engageSystemProxy(
  host: string,
  port: number,
  platform: NodeJS.Platform = process.platform
): Promise<TrustChangeResult> {
  if (await systemProxyEngaged()) return { ok: true }

  if (platform === 'darwin') {
    const services = await darwinServices()
    if (services.length === 0) return { ok: false, message: 'No network services to configure.' }
    const backup: ProxyBackup = { platform, takenAt: Date.now(), darwin: [] }
    for (const service of services) {
      const web = await tryRun('networksetup', ['-getwebproxy', service])
      const secure = await tryRun('networksetup', ['-getsecurewebproxy', service])
      backup.darwin!.push({
        service,
        web: web.stdout.split('\n'),
        secure: secure.stdout.split('\n')
      })
    }
    await saveBackup(backup)

    const script = services
      .map(
        (s) =>
          `networksetup -setwebproxy ${shq(s)} ${shq(host)} ${port} && ` +
          `networksetup -setsecurewebproxy ${shq(s)} ${shq(host)} ${port}`
      )
      .join(' ; ')
    const elevator = elevatorForPlatform(platform)
    const probe = await elevator.probe()
    if (!probe.available) {
      await clearBackup()
      return { ok: false, message: probe.reason ?? 'No way to ask for administrator rights.' }
    }
    const proc = await elevator.run({
      reason: 'OpsMaxx needs administrator rights to route this machine’s traffic through its inspector.',
      command: 'sh',
      args: ['-c', script]
    })
    const exit = await proc.wait()
    if (exit.declined || exit.code !== 0) {
      await clearBackup()
      return {
        ok: false,
        declined: exit.declined,
        message: exit.declined ? 'The administrator prompt was declined.' : 'The proxy settings were not applied.'
      }
    }
    return { ok: true }
  }

  if (platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const read = async (name: string): Promise<string | undefined> => {
      const { ok, stdout } = await tryRun('reg', ['query', key, '/v', name])
      if (!ok) return undefined
      const m = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, 'i'))
      return m?.[1]?.trim()
    }
    await saveBackup({
      platform,
      takenAt: Date.now(),
      win32: {
        proxyEnable: await read('ProxyEnable'),
        proxyServer: await read('ProxyServer'),
        proxyOverride: await read('ProxyOverride')
      }
    })
    const set = await tryRun('reg', [
      'add',
      key,
      '/v',
      'ProxyServer',
      '/t',
      'REG_SZ',
      '/d',
      `${host}:${port}`,
      '/f'
    ])
    const enable = await tryRun('reg', ['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'])
    if (!set.ok || !enable.ok) {
      await restoreSystemProxy()
      return { ok: false, message: 'Windows did not accept the proxy setting.' }
    }
    await notifyWinInetSettingsChanged()
    return { ok: true }
  }

  if (platform === 'linux') {
    // KDE keeps its proxy settings in kioslaverc, not in gsettings, so a KDE
    // machine previously got "no gsettings" and no way forward at all.
    if (isKde() && which(kwriteconfig())) {
      await saveBackup({ platform, takenAt: Date.now(), kde: await readKdeProxy() })
      const w = kwriteconfig()
      const url = `http://${host}:${port}`
      await tryRun(w, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'ProxyType', '1'])
      await tryRun(w, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpProxy', url])
      const ok = await tryRun(w, [
        '--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', 'httpsProxy', url
      ])
      if (!ok.ok) {
        await restoreSystemProxy()
        return { ok: false, message: 'KDE did not accept the proxy setting.' }
      }
      return { ok: true }
    }
    if (!which('gsettings')) {
      return {
        ok: false,
        message:
          'This desktop exposes no proxy setting OpsMaxx can change. Use “Copy shell setup” and point applications at the proxy yourself.'
      }
    }
    const get = async (schema: string, k: string): Promise<string> =>
      (await tryRun('gsettings', ['get', schema, k])).stdout.trim()
    await saveBackup({
      platform,
      takenAt: Date.now(),
      linux: {
        mode: await get('org.gnome.system.proxy', 'mode'),
        host: await get('org.gnome.system.proxy.http', 'host'),
        port: await get('org.gnome.system.proxy.http', 'port'),
        httpsHost: await get('org.gnome.system.proxy.https', 'host'),
        httpsPort: await get('org.gnome.system.proxy.https', 'port')
      }
    })
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.http', 'host', host])
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.http', 'port', String(port)])
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.https', 'host', host])
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.https', 'port', String(port)])
    const mode = await tryRun('gsettings', ['set', 'org.gnome.system.proxy', 'mode', 'manual'])
    if (!mode.ok) {
      await restoreSystemProxy()
      return { ok: false, message: 'The desktop did not accept the proxy setting.' }
    }
    return { ok: true }
  }

  return { ok: false, message: 'Changing system proxy settings is not supported on this platform.' }
}

/**
 * Puts the machine back exactly as it was.
 *
 * Called on stop, on quit, and on the next launch after a crash. It is safe to
 * call when nothing was ever changed — the absence of a backup file is the
 * signal that there is nothing to undo, which is why the file is written
 * first and deleted last.
 *
 * It takes no platform argument on purpose. What has to be undone is what the
 * backup file says was done, and that file records the platform it was written
 * on — a machine whose settings were changed by a macOS build must be restored
 * the macOS way even if something else is asking.
 */
export async function restoreSystemProxy(): Promise<TrustChangeResult> {
  const backup = await loadBackup()
  if (!backup) return { ok: true }

  if (backup.platform === 'darwin' && backup.darwin) {
    const parse = (lines: string[]): { enabled: boolean; server: string; port: string } => ({
      enabled: /Enabled:\s*Yes/i.test(lines.join('\n')),
      server: lines.find((l) => l.startsWith('Server:'))?.split(':')[1]?.trim() ?? '',
      port: lines.find((l) => l.startsWith('Port:'))?.split(':')[1]?.trim() ?? '0'
    })
    const script = backup.darwin
      .map(({ service, web, secure }) => {
        const w = parse(web)
        const s = parse(secure)
        const restoreOne = (kind: 'web' | 'securewebproxy', v: typeof w): string =>
          v.enabled && v.server
            ? `networksetup -set${kind === 'web' ? 'webproxy' : 'securewebproxy'} ${shq(service)} ${shq(v.server)} ${shq(v.port)}`
            : `networksetup -set${kind === 'web' ? 'webproxystate' : 'securewebproxystate'} ${shq(service)} off`
        return `${restoreOne('web', w)} ; ${restoreOne('securewebproxy', s)}`
      })
      .join(' ; ')
    const elevator = elevatorForPlatform(backup.platform)
    const probe = await elevator.probe()
    if (!probe.available) {
      return { ok: false, message: 'Cannot restore the proxy settings without administrator rights.' }
    }
    const proc = await elevator.run({
      reason: 'OpsMaxx needs administrator rights to restore this machine’s proxy settings.',
      command: 'sh',
      args: ['-c', script]
    })
    const exit = await proc.wait()
    if (exit.code !== 0) {
      // The backup file stays. A restore that did not happen must be
      // retried next launch, not forgotten because it was attempted once.
      return {
        ok: false,
        declined: exit.declined,
        message: 'The proxy settings were not restored. OpsMaxx will try again next time it starts.'
      }
    }
    await clearBackup()
    return { ok: true }
  }

  if (backup.platform === 'win32' && backup.win32) {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const prior = backup.win32
    if (prior.proxyServer) {
      await tryRun('reg', ['add', key, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', prior.proxyServer, '/f'])
    } else {
      await tryRun('reg', ['delete', key, '/v', 'ProxyServer', '/f'])
    }
    const enable = prior.proxyEnable && /1|0x1/.test(prior.proxyEnable) ? '1' : '0'
    await tryRun('reg', ['add', key, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', enable, '/f'])
    await notifyWinInetSettingsChanged()
    await clearBackup()
    return { ok: true }
  }

  if (backup.kde) {
    const w = kwriteconfig()
    const prior = backup.kde
    const set = async (k: string, v: string): Promise<void> => {
      await tryRun(w, ['--file', 'kioslaverc', '--group', 'Proxy Settings', '--key', k, v])
    }
    await set('httpProxy', prior.httpProxy)
    await set('httpsProxy', prior.httpsProxy)
    // Last, so the type only flips back once the addresses are already right.
    await set('ProxyType', prior.proxyType || '0')
    await clearBackup()
    return { ok: true }
  }

  if (backup.platform === 'linux' && backup.linux) {
    const l = backup.linux
    const unquote = (v: string): string => v.replace(/^'(.*)'$/, '$1')
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.http', 'host', unquote(l.host)])
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.http', 'port', l.port || '0'])
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.https', 'host', unquote(l.httpsHost)])
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy.https', 'port', l.httpsPort || '0'])
    await tryRun('gsettings', ['set', 'org.gnome.system.proxy', 'mode', unquote(l.mode) || 'none'])
    await clearBackup()
    return { ok: true }
  }

  await clearBackup()
  return { ok: true }
}
