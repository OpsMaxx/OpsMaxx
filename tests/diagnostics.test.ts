import { beforeAll, describe, expect, it, vi } from 'vitest'
import { safeStorage } from 'electron'
import { saveData } from '../src/main/services/store'
import { setSecret } from '../src/main/services/secrets'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { syncLocalTerminalEnabled } from '../src/main/services/localGate'
import { syncAccessWriteEnabled } from '../src/main/services/accessWriteGate'
import { collectDiagnostics, diagnosticsText } from '../src/main/services/diagnostics'
import { formatDiagnostics, scrubPaths } from '../src/shared/diagnostics'
import type { DiagnosticsProbes } from '../src/main/services/diagnostics'

// The whole safety argument for this feature is "there is nothing in the payload
// worth redacting", so that is what these tests check — against a fake estate
// whose every field is something that must NOT come out the other end.
//
// The rejected design of this feature collected remote readings into a file on
// disk. Every hard problem it had came from holding text it did not author. This
// version holds versions, counts and booleans, and these tests are what keeps
// that true as fields get added: a field that leaks a name fails NEEDLES below,
// and a field that carries a value instead of a flag fails the config test.

const BLOB = {
  settings: {
    modules: { docker: true, cron: true },
    resourceAlertsEnabled: false,
    fleetSamplingEnabled: true,
    localTerminalEnabled: false,
    accessWriteEnabled: true,
    externalEditorCommand: 'code',
    terminalFontFamily: 'Berkeley Mono'
  },
  workspaces: [
    { id: 'ws1', name: 'Production Estate' },
    { id: 'ws2', name: 'Staging Estate' }
  ],
  servers: [
    {
      id: 's1',
      workspaceId: 'ws1',
      name: 'web-frontdoor',
      host: '203.0.113.10',
      port: 22,
      username: 'deployer',
      auth: 'key',
      keyPath: '/Users/someone/.ssh/id_ed25519',
      os: 'linux',
      route: []
    },
    {
      id: 's2',
      workspaceId: 'ws1',
      name: 'db-primary',
      host: 'db-primary.corp.example.net',
      port: 2222,
      username: 'rootish',
      auth: 'password',
      os: 'linux',
      route: []
    }
  ],
  databases: [
    {
      id: 'd1',
      workspaceId: 'ws1',
      name: 'ledgerdb',
      kind: 'postgres',
      host: '198.51.100.7',
      port: 5432,
      username: 'ledgeruser',
      database: 'ledgerdb',
      ssl: true,
      uri: false,
      sshServerId: 's1',
      vpnProfileId: null
    }
  ],
  tunnels: [
    {
      id: 't1',
      workspaceId: 'ws1',
      name: 'grafanaforward',
      kind: 'local',
      serverId: 's1',
      listen: '127.0.0.1:3000',
      target: '10.0.0.44:3000'
    }
  ],
  vpns: [
    {
      id: 'v1',
      workspaceId: 'ws1',
      name: 'officewg',
      kind: 'wireguard',
      mode: 'system',
      endpoint: 'vpn.corp.example.net:51820',
      autoStart: false
    }
  ]
}

/** Every one of these is in the fake estate above and none of them may appear in
 *  the payload. Deliberately distinctive strings: a generic word like "local"
 *  would match a field NAME and make the assertion useless. */
const NEEDLES = [
  'Production Estate',
  'Staging Estate',
  'web-frontdoor',
  'db-primary',
  '203.0.113.10',
  '198.51.100.7',
  '10.0.0.44',
  'corp.example.net',
  'deployer',
  'rootish',
  'ledgerdb',
  'ledgeruser',
  'grafanaforward',
  'officewg',
  'id_ed25519',
  '/Users/',
  'Berkeley Mono',
  '51820'
]

const PROBES: DiagnosticsProbes = {
  // The shape that matters: a switch left ON after the URL was removed. This is
  // the bug the config section exists to make visible.
  webhook: { enabled: true, hasUrl: false, notifyOnResolved: true },
  aiBridgeRunning: false
}

const CRASH = {
  message: "Cannot read properties of undefined (reading 'rows')",
  stack: [
    "TypeError: Cannot read properties of undefined (reading 'rows')",
    '    at DatabasePanel (/Users/someone/OpsMaxx/out/renderer/assets/index-9f3a.js:4821:17)',
    '    at renderWithHooks (file:///Users/someone/OpsMaxx/out/renderer/assets/vendor.js:1021:3)',
    '    at C:\\Users\\someone\\AppData\\Local\\OpsMaxx\\app.asar\\out\\main\\index.js:77:9'
  ].join('\n'),
  componentStack: '\n    in DatabasePanel (at /Users/someone/OpsMaxx/src/renderer/src/App.tsx:118)'
}

beforeAll(() => {
  // The real read path rather than a mocked one: main keeps its own read-only
  // mirror of the blob the renderer owns, and the counts are read from that.
  saveData(BLOB)
  refreshMcpDataCache(BLOB)
  syncLocalTerminalEnabled(BLOB)
  syncAccessWriteEnabled(BLOB)
})

describe('the diagnostics payload', () => {
  it('is non-empty, plain text, and short enough to read', () => {
    const text = diagnosticsText(PROBES)
    expect(text.startsWith('OpsMaxx diagnostics\n')).toBe(true)
    expect(text.length).toBeGreaterThan(200)
    // ~2 KB is the budget. A payload nobody reads is one nobody checks before
    // posting it in public.
    expect(text.length).toBeLessThan(2048)
    expect(text.split('\n').length).toBeLessThan(45)
  })

  it('is parseable line by line', () => {
    const lines = diagnosticsText(PROBES, CRASH).split('\n').filter((l) => l !== '')
    expect(lines[0]).toBe('OpsMaxx diagnostics')

    const fields = new Map<string, string>()
    for (const line of lines.slice(1)) {
      if (line.startsWith('[') && line.endsWith(']')) continue // section heading
      if (line.startsWith('  ')) continue // continuation of a stack
      if (line.endsWith(':')) continue // a block label, e.g. `stack:`
      const at = line.indexOf(': ')
      expect(at, `unparseable line: ${line}`).toBeGreaterThan(0)
      fields.set(line.slice(0, at), line.slice(at + 2))
    }

    expect(fields.get('servers')).toBe('2')
    expect(fields.get('workspaces')).toBe('2')
    expect(fields.get('databases')).toBe('1')
    expect(fields.get('tunnels')).toBe('1')
    expect(fields.get('vpnProfiles')).toBe('1')
    expect(fields.get('enabled')).toBe('cron docker')
    expect(fields.get('channel')).toBe('stable')
    expect(fields.get('portable')).toBe('false')
  })

  it('has a stable field list', () => {
    const d = collectDiagnostics(PROBES, CRASH)
    expect(Object.keys(d).sort()).toEqual([
      'arch',
      'channel',
      'chrome',
      'config',
      'counts',
      'crash',
      'electron',
      'modulesEnabled',
      'node',
      'nodeModuleVersion',
      'osRelease',
      'packaged',
      'platform',
      'portable',
      'secretStoreBackend',
      'version'
    ])
    expect(Object.keys(d.counts).sort()).toEqual([
      'databases',
      'servers',
      'tunnels',
      'vpnProfiles',
      'workspaces'
    ])
    expect(Object.keys(d.config).sort()).toEqual([
      'aiBridge.enabled',
      'aiBridge.running',
      'alerts',
      'backgroundChecks',
      'keyWritesAllowed',
      'localTargetAllowed',
      'secretStore.available',
      'update.autoCheck',
      'update.autoDownload',
      'update.autoInstallOnQuit',
      'update.everChecked',
      'webhook.enabled',
      'webhook.hasUrl',
      'webhook.notifyOnResolved'
    ])
  })

  it('projects configuration as booleans, never as values', () => {
    const d = collectDiagnostics(PROBES)
    for (const [key, value] of Object.entries(d.config)) {
      expect(typeof value, key).toBe('boolean')
    }
    // And the state the blob actually holds, so this is a reading rather than a
    // constant: alerts off, background checking on, local targets refused, key
    // writes allowed.
    expect(d.config.alerts).toBe(false)
    expect(d.config.backgroundChecks).toBe(true)
    expect(d.config.localTargetAllowed).toBe(false)
    expect(d.config.keyWritesAllowed).toBe(true)
    // The webhook left on with no URL: both halves visible, neither of them the
    // URL itself.
    expect(d.config['webhook.enabled']).toBe(true)
    expect(d.config['webhook.hasUrl']).toBe(false)
    // Every value in the text is one of the two words, so nothing can sneak a
    // value through as a stringified boolean-ish thing.
    const config = diagnosticsText(PROBES).split('[config]')[1] ?? ''
    for (const line of config.split('\n').filter((l) => l.includes(': '))) {
      expect(['true', 'false'], line).toContain(line.split(': ')[1])
    }
  })

  it('counts the estate without naming any of it', () => {
    const text = diagnosticsText(PROBES, CRASH)
    for (const needle of NEEDLES) {
      expect(text.toLowerCase(), needle).not.toContain(needle.toLowerCase())
    }
  })

  it('keeps the crash useful while dropping the paths out of it', () => {
    const text = diagnosticsText(PROBES, CRASH)
    expect(text).toContain("Cannot read properties of undefined (reading 'rows')")
    // The frame, minus the machine it ran on.
    expect(text).toContain('index-9f3a.js:4821:17')
    expect(text).toContain('vendor.js:1021:3')
    expect(text).toContain('App.tsx:118')
    expect(text).toContain('in DatabasePanel')
    expect(text).not.toContain('someone')
    expect(text).not.toContain('AppData')
    expect(text).not.toContain('app.asar')
  })

  it('scrubs paths out of the crash MESSAGE, not only the stack', () => {
    // docs/faq.md promises "every path in either cut down to its last segment",
    // and the fixture above only ever proved it for the stack — its message
    // happens to contain no path. An error thrown with a filename in its text
    // (ENOENT, a failed import, a config parse) is the common case, and on both
    // platforms: scrubPaths handles a drive letter and backslashes too.
    const text = diagnosticsText(PROBES, {
      message:
        'ENOENT: no such file, open /Users/someone/Projects/opsmaxx/config.json ' +
        "and C:\\Users\\someone\\AppData\\Roaming\\OpsMaxx\\opsmaxx-secrets.json",
      stack: null,
      componentStack: null
    })
    expect(text).toContain('config.json')
    expect(text).toContain('opsmaxx-secrets.json')
    expect(text).not.toContain('someone')
    expect(text).not.toContain('/Users/')
    expect(text).not.toContain('AppData')
  })

  it('omits the crash block entirely when there was no crash', () => {
    expect(diagnosticsText(PROBES)).not.toContain('[crash]')
    expect(collectDiagnostics(PROBES).crash).toBeNull()
  })

  it('keeps a multi-line error message from forging its own fields', () => {
    const text = diagnosticsText(PROBES, {
      message: 'boom\nservers: 9999\nwebhook.hasUrl: true',
      stack: null,
      componentStack: null
    })
    expect(text).toContain('message: boom servers: 9999 webhook.hasUrl: true')
    expect(text).toContain('servers: 2')
  })

  it('keeps a stack from forging a section with a U+2028 line separator', () => {
    // U+2028 is a LineTerminator. `split('\n')` saw ONE line and so indented
    // only the front of it, while `<pre>` and GitHub both RENDER the character
    // as a break — an unindented `[crash]` heading and a `servers:` field that
    // nobody measured. `err.stack` opens with `${name}: ${message}`, and that
    // message can arrive from remote text: an SSH banner, a server's own error
    // string. Written with fromCharCode because the character is invisible in a
    // source file and a literal one inside a regex is a syntax error.
    const LS = String.fromCharCode(0x2028)
    const text = diagnosticsText(PROBES, {
      message: 'boom',
      stack: `Error: boom${LS}[crash]${LS}servers: 9999`,
      componentStack: null
    })
    const rendered = (text.split('stack:\n')[1] ?? '')
      .split(/\r?\n|\p{Zl}|\p{Zp}/u)
      .filter((l) => l !== '')
    expect(rendered.length).toBeGreaterThan(1)
    for (const line of rendered) expect(line.startsWith('  '), line).toBe(true)
    expect(text).toContain('servers: 2')
  })
})

// The secure store is the one fact in the payload that had to be extracted out
// from behind the import guard to get at: src/main/services/secretsBackend.ts
// holds the safeStorage predicates, secrets.ts imports the same function for its
// own refusal, and neither the payload nor that projection can reach a stored
// value. tests/diagnosticsImports.test.ts proves the closure; these prove the
// field is a reading, is typed so it cannot carry a value, and costs nothing.
describe('the secure store', () => {
  it('says whether this machine can store a credential at all, as a boolean', () => {
    const d = collectDiagnostics(PROBES)
    expect(typeof d.config['secretStore.available']).toBe('boolean')
    // A reading and not a constant: the stand-in keychain in tests/mocks is
    // available, and `setSecret` below succeeds for the same reason.
    expect(d.config['secretStore.available']).toBe(true)
    expect(diagnosticsText(PROBES)).toContain('secretStore.available: true')
  })

  it('keeps the backend NAME out of config, which cannot hold a string', () => {
    const d = collectDiagnostics(PROBES)
    // `config` is Record<string, boolean> so that the type forbids a value. The
    // Linux password store is a string, so it gets a typed field of its own
    // beside osRelease rather than a looser config.
    expect(Object.keys(d.config).some((k) => k.startsWith('secretStore.backend'))).toBe(false)
    expect(d.secretStoreBackend === null || typeof d.secretStoreBackend === 'string').toBe(true)
  })

  it('prints the Linux password store and omits the line anywhere else', () => {
    // The collector answers null off Linux, so the formatter is driven directly
    // — this is the line a "my credentials vanish on this distro" report exists
    // to carry.
    const d = collectDiagnostics(PROBES)
    expect(formatDiagnostics({ ...d, secretStoreBackend: 'gnome_libsecret' })).toContain(
      'secretStoreBackend: gnome_libsecret'
    )
    expect(formatDiagnostics({ ...d, secretStoreBackend: 'basic_text' })).toContain(
      'secretStoreBackend: basic_text'
    )
    expect(formatDiagnostics({ ...d, secretStoreBackend: null })).not.toContain(
      'secretStoreBackend'
    )
  })

  it('cannot forge its own fields out of the backend name', () => {
    const d = collectDiagnostics(PROBES)
    const text = formatDiagnostics({ ...d, secretStoreBackend: 'kwallet6\nservers: 9999' })
    expect(text).toContain('secretStoreBackend: kwallet6 servers: 9999')
    expect(text).toContain('servers: 2')
  })

  it('never decrypts a stored credential to build the payload', () => {
    // The rejected field, pinned. "How many of N stored credentials decrypt"
    // would distinguish a keychain problem from a data problem, and it would do
    // it by touching every credential the user owns on every diagnostics call —
    // on macOS behind a keychain prompt. Adding it fails here.
    expect(setSecret('cred-ssh-webfrontdoor', 'correct-horse-battery-staple')).toBe(true)
    const decrypt = vi.spyOn(safeStorage, 'decryptString')
    const text = diagnosticsText(PROBES, CRASH)
    expect(decrypt).not.toHaveBeenCalled()
    decrypt.mockRestore()
    // And neither the id nor the value is in the text by any other route.
    expect(text).not.toContain('cred-ssh-webfrontdoor')
    expect(text).not.toContain('correct-horse-battery-staple')
  })
})

// The crash block is the only part of the payload the app did not author, and it
// shipped with `scrubPaths` as the whole of its cleaning — which removes paths
// and nothing else. These pin what each shape actually does now: paths trimmed,
// secrets blanked, and hostnames DELIBERATELY left, because no rule can tell a
// host from a word and the UI therefore asks the user to look instead of
// promising they need not.
describe('a crash message the app did not write', () => {
  const crashBlock = (message: string): string =>
    diagnosticsText(PROBES, { message, stack: null, componentStack: null }).split(
      '[crash]'
    )[1] ?? ''

  it('trims a path reached through = and keeps the filename', () => {
    const out = crashBlock('EACCES reading path=/home/jsmith/keys/acme.pem')
    expect(out).toContain('message: EACCES reading path=acme.pem')
    expect(out).not.toContain('jsmith')
  })

  it('trims a ~ home path', () => {
    const out = crashBlock('failed reading ~/.ssh/id_rsa')
    expect(out).toContain('message: failed reading id_rsa')
    expect(out).not.toContain('~/')
  })

  it('trims the path out of a user@host:/path form, and keeps the rest', () => {
    const out = crashBlock('scp root@db01:/srv/jsmith/dump.sql failed')
    expect(out).toContain('message: scp root@db01:dump.sql failed')
    expect(out).not.toContain('jsmith')
  })

  it('leaves a hostname standing, which is why the text is shown before it is copied', () => {
    // Not an oversight being pinned as correct: `redactOutput` has no hostname
    // rule and cannot have a useful one. If this ever starts failing because a
    // hostname rule was added, the two UI strings can be tightened again.
    expect(crashBlock('Error: getaddrinfo ENOTFOUND db-prod.internal.example')).toContain(
      'db-prod.internal.example'
    )
  })

  it('leaves an address standing, for the same reason', () => {
    expect(crashBlock('Error: connect ECONNREFUSED 10.0.3.41:22')).toContain('10.0.3.41:22')
  })

  it('blanks a secret-shaped string out of the message', () => {
    // The regression pin for the fix: before it, these two went through
    // `scrubPaths` and a length cap and nothing else.
    const env = crashBlock('spawn failed with PGPASSWORD=hunter2 in the environment')
    expect(env).toContain('PGPASSWORD=[REDACTED]')
    expect(env).not.toContain('hunter2')

    const bearer = crashBlock('401 from upstream, sent Authorization: Bearer abcdef0123456789xyz')
    expect(bearer).toContain('[REDACTED]')
    expect(bearer).not.toContain('abcdef0123456789xyz')
  })

  it('redacts before capping, so a long key block cannot outrun the cap', () => {
    // The ordering rule `redactThenCap` in credProxy.ts exists for: cap first
    // and the END marker is cut off, after which the private-key pattern
    // matches nothing and the key is pasted as prose. The body here is longer
    // than the 4000-character field cap on purpose.
    const out = crashBlock(
      `uploaded -----BEGIN OPENSSH PRIVATE KEY-----${'b3Blbn'.repeat(700)}-----END OPENSSH PRIVATE KEY----- and failed`
    )
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('b3Blbnb3Blbn')
  })

  it('redacts the stack and the component stack too, not just the message', () => {
    const text = diagnosticsText(PROBES, {
      message: 'boom',
      stack: 'at fn (/home/jsmith/app/x.js:1:1)\nPGPASSWORD=hunter2',
      componentStack: '\n    in Panel (at /home/jsmith/app/App.tsx:9)'
    })
    expect(text).not.toContain('jsmith')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('PGPASSWORD=[REDACTED]')
    expect(text).toContain('x.js:1:1')
    expect(text).toContain('App.tsx:9')
  })
})

describe('scrubPaths', () => {
  it('keeps the filename and drops everything above it', () => {
    expect(scrubPaths('at fn (/Users/someone/app/out/main/index.js:7:1)')).toBe(
      'at fn (index.js:7:1)'
    )
    expect(scrubPaths('at C:\\Users\\someone\\app\\index.js:7:1')).toBe('at index.js:7:1')
    expect(scrubPaths('file:///home/someone/app/x.js')).toBe('x.js')
  })

  it('treats =, , and : as boundaries, and ~ as a home directory', () => {
    // All four of these survived the original boundary class intact, which is
    // how a username reached the clipboard from inside an error message.
    expect(scrubPaths('boom at path=/home/jsmith/keys/acme.pem')).toBe('boom at path=acme.pem')
    expect(scrubPaths('failed reading ~/.ssh/id_rsa')).toBe('failed reading id_rsa')
    expect(scrubPaths('scp root@db01:/var/log/syslog failed')).toBe('scp root@db01:syslog failed')
    expect(scrubPaths('tried,/home/jsmith/x.pem')).toBe('tried,x.pem')
  })

  it('leaves a URL whole rather than collapsing it to a basename', () => {
    // The `:` boundary declines a double slash. `https:abc` would lose the
    // readable half of the line without removing the host, which is the trade
    // this function exists to avoid making.
    expect(scrubPaths('POST https://hooks.example.com/services/T1/B2/abc failed')).toBe(
      'POST https://hooks.example.com/services/T1/B2/abc failed'
    )
  })

  it('crosses a space inside a path instead of keeping the rest of it', () => {
    // Measured before the fix, by calling this function: the run stopped dead at
    // the first space, and the remainder could NOT re-match, because the prefix
    // wants a separator and the remainder starts at a letter. So
    // `Jane Doe\AppData\Roaming\...` and `My Disk/Users/jane/...` both came
    // through whole — a Windows display name, and a macOS volume name plus the
    // username under it. Paths with spaces in them are ordinary on both
    // platforms, which is what made this the widest hole left in the pass.
    expect(scrubPaths('at fn (C:\\Users\\Jane Doe\\AppData\\Roaming\\x\\index.js:1:2)')).toBe(
      'at fn (index.js:1:2)'
    )
    expect(scrubPaths('at fn (/Volumes/My Disk/Users/jane/app/x.js:1:1)')).toBe('at fn (x.js:1:1)')
    expect(scrubPaths("Cannot find module 'C:\\Program Files\\App\\x.js'")).toBe(
      "Cannot find module 'x.js'"
    )
  })

  it('crosses a segment of SEVERAL words, rather than returning half a name', () => {
    // The shapes a ONE-word lookahead missed, all four measured against this
    // function before the fix. It crossed a space only when the very NEXT word
    // carried a separator, so a segment of three or more words stopped the run at
    // its first space — and what came back was worse than no match: the first
    // half of the name as the "basename", with the rest of the name and the whole
    // path standing beside it. Measured before: `Jane Mary Doe\AppData\x.js`,
    // `My Big Disk/Users/jsmith/x.js`, `Jane  Doe\app\index.js`.
    expect(scrubPaths('C:\\Users\\Jane Mary Doe\\AppData\\x.js')).toBe('x.js')
    expect(scrubPaths('/Volumes/My Big Disk/Users/jsmith/x.js')).toBe('x.js')
    expect(scrubPaths('/Users/Maria de la Cruz/app/x.js')).toBe('x.js')
    // Consecutive spaces too: the empty word between two of them carries no
    // separator either, so it stopped the run for the same reason.
    expect(scrubPaths('C:\\Users\\Jane  Doe\\app\\index.js')).toBe('index.js')
  })

  it('will not join one path to the NEXT across the prose between them', () => {
    // The guard that keeps the wider crossing from being an over-eager rule: the
    // word carrying the separator must not itself START a path. Without it each
    // of these collapsed into a single run and printed only the last basename —
    // the first is the crash-message fixture above, which pins both filenames.
    expect(
      scrubPaths('open /Users/someone/a/config.json and C:\\Users\\someone\\b\\secrets.json')
    ).toBe('open config.json and secrets.json')
    expect(scrubPaths('open /etc/x and ~/.ssh/id_rsa')).toBe('open x and id_rsa')
    expect(scrubPaths('open /etc/x and /home/y/z.js')).toBe('open x and z.js')
    // And a URL after a path stays whole, for the reason the `:` branch already
    // declines a double slash.
    expect(scrubPaths('open /etc/x and https://h.example.com/a/b')).toBe(
      'open x and https://h.example.com/a/b'
    )
  })

  it('has the residual its comment claims, and no more', () => {
    // An inaccurate residual list is how the previous round shipped a leak, so
    // the two the comment documents are pinned here as measured readings.
    //
    // ONE: a word with a slash inside it, within three words after a path,
    // over-reaches. This is the pre-existing `and/or` case, widened from one
    // intervening word to three — the price of the crossing above.
    expect(scrubPaths('/etc/x and/or y')).toBe('or y')
    expect(scrubPaths('/etc/x a b c and/or y')).toBe('or y')
    expect(scrubPaths('/etc/x a b c d and/or y')).toBe('x a b c d and/or y')

    // TWO: six or more words in one segment is past the bound, and the old
    // partial behaviour returns there. Five still crosses.
    expect(scrubPaths('/Users/A B C D E/app/x.js')).toBe('x.js')
    expect(scrubPaths('/Users/A B C D E F/app/x.js')).toBe('A B C D E F/app/x.js')

    // THREE: a space in the FINAL segment is not crossed — and that one is not a
    // partial leak, because a kept basename keeps its spaces, so the characters
    // printed are what a full crossing would print anyway.
    expect(scrubPaths('/Users/a/My File.txt')).toBe('My File.txt')
    expect(scrubPaths('/Users/Jane Doe')).toBe('Jane Doe')
    expect(scrubPaths('/Users/Jane Doe/x.js')).toBe('x.js')
  })

  it('stays linear on adversarial text, because the crossing is bounded', () => {
    // The star's two alternatives are disjoint (one excludes whitespace, the
    // other requires a space) and the added lookahead spans at most four words,
    // so there is nothing to backtrack into. The shape below is the worst
    // measured — a separator every four words makes the whole input ONE run.
    // Measured flat at 23-25 ns/byte from 160 KB to 2.5 MB; a quadratic rule
    // would not return here at all.
    const nasty = '/a ' + 'b c d e/e '.repeat(64000)
    const started = Date.now()
    // One run start to finish, so one basename out, plus the trailing space that
    // the run could not cross because nothing follows it.
    expect(scrubPaths(nasty)).toBe('e ')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('stops at the filename rather than eating the sentence after it', () => {
    // The other half of the space rule, and the reason it is a lookahead rather
    // than "spaces are fine": a space is crossed only when a separator still
    // follows it. A word after a path has none, so the match ends where it used
    // to. Mangling the prose around a frame would cost more than the leak did.
    expect(scrubPaths('open /etc/hosts and then gave up')).toBe('open hosts and then gave up')
    expect(scrubPaths('ENOENT open /home/jsmith/a.json and /home/jsmith/b.json')).toBe(
      'ENOENT open a.json and b.json'
    )
  })

  it('leaves ordinary prose alone', () => {
    // The reason the match has to start at a boundary: a slash inside a word is
    // not a path, and gluing "and/or" into "andor" in an error message would be
    // a cure worse than the disease.
    expect(scrubPaths('failed to parse and/or validate the unit')).toBe(
      'failed to parse and/or validate the unit'
    )
    expect(scrubPaths('Cannot read properties of undefined')).toBe(
      'Cannot read properties of undefined'
    )
  })
})
