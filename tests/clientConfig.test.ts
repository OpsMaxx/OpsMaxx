import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  lstatSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bridgeInvocation,
  claudeCodeCommand,
  claudeDesktopConfigPath,
  claudeDesktopRunning,
  httpUrl,
  writeClaudeCodeConfigTo,
  writeClaudeDesktopConfig,
  writeClaudeDesktopConfigTo,
  writeCodexConfigTo,
  codexConfigPath
} from '../src/main/services/clientConfig'
import { registerCodexMcp } from '../src/cli/agents'
import { LEGACY_MCP_SERVER_KEYS } from '../src/shared/mcpClientKeys'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opsmaxx-clientconfig-'))
  file = join(dir, 'claude_desktop_config.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const read = (): Record<string, any> => JSON.parse(readFileSync(file, 'utf8'))

describe('bridge invocation', () => {
  it('runs the bundled Electron binary as plain Node', () => {
    const inv = bridgeInvocation('tok', 5177)
    expect(inv.command).toBe(process.execPath)
    expect(inv.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', OPSMAXX_MCP_TOKEN: 'tok' })
    expect(inv.args.slice(1)).toEqual(['bridge', '--port', '5177'])
  })

  // argv is readable by every local user through `ps`; a process's environment
  // is not. The token used to sit in args, in plain sight for the bridge's life.
  it('keeps the token out of the command line', () => {
    const inv = bridgeInvocation('secret-token', 5177)
    expect(inv.args.join(' ')).not.toContain('secret-token')
    expect(inv.args).not.toContain('--token')
    expect(inv.args[0].endsWith(join('out', 'cli', 'index.js'))).toBe(true)
  })

  it('points at the unpacked copy of the CLI when running from an asar archive', async () => {
    const electron = await import('electron')
    const original = electron.app.getAppPath
    ;(electron.app as any).getAppPath = (): string => join('/Apps', 'OpsMaxx.app', 'Contents', 'Resources', 'app.asar')
    try {
      // A child process cannot be spawned from inside an asar archive, which is
      // why electron-builder.yml keeps out/cli unpacked.
      expect(bridgeInvocation('tok', 1).args[0]).toContain('app.asar.unpacked')
    } finally {
      ;(electron.app as any).getAppPath = original
    }
  })
})

describe('claude code command', () => {
  it('removes any existing entry first, so re-registering works', () => {
    // `claude mcp add` refuses a name that already exists rather than
    // replacing it, and every use after the first is a re-registration — a
    // rotated token, or a revoked session being replaced. A plain add would
    // fail exactly when it is needed.
    const cmd = claudeCodeCommand('tok', 5177)
    expect(cmd).toContain('claude mcp remove opsmaxx -s user')
    expect(cmd.indexOf('mcp remove')).toBeLessThan(cmd.indexOf('mcp add'))
    // A missing entry is not an error worth stopping on.
    expect(cmd).toContain('2>/dev/null')
  })

  it('carries the token as a bearer header against the local bridge', () => {
    const cmd = claudeCodeCommand('secret-token', 5177)
    expect(cmd).toContain('--transport http')
    expect(cmd).toContain(httpUrl(5177))
    expect(cmd).toContain('--header "Authorization: Bearer secret-token"')
  })
})

describe('claude desktop config path', () => {
  it('resolves to a claude_desktop_config.json under the platform config dir', () => {
    expect(claudeDesktopConfigPath().endsWith('claude_desktop_config.json')).toBe(true)
    expect(claudeDesktopConfigPath()).toContain('Claude')
  })
})

describe('writing the claude desktop config', () => {
  it('creates the file, and the directory, when neither exists', () => {
    const nested = join(dir, 'Claude', 'claude_desktop_config.json')
    const result = writeClaudeDesktopConfigTo(nested, 'tok', 5177)
    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(nested, 'utf8'))
    expect(written.mcpServers.opsmaxx.args).not.toContain('tok')
    expect(written.mcpServers.opsmaxx.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', OPSMAXX_MCP_TOKEN: 'tok' })
  })

  it('keeps other mcp servers and unrelated top-level keys', () => {
    writeFileSync(
      file,
      JSON.stringify({
        globalShortcut: 'Alt+Space',
        mcpServers: { burp: { command: 'python', args: ['burp.py'] } }
      })
    )
    expect(writeClaudeDesktopConfigTo(file, 'tok', 5177).ok).toBe(true)
    const next = read()
    expect(next.globalShortcut).toBe('Alt+Space')
    expect(next.mcpServers.burp).toEqual({ command: 'python', args: ['burp.py'] })
    expect(next.mcpServers.opsmaxx).toBeDefined()
  })

  it('replaces its own previous entry rather than accumulating duplicates', () => {
    writeClaudeDesktopConfigTo(file, 'old-token', 5177)
    writeClaudeDesktopConfigTo(file, 'new-token', 6000)
    const entry = read().mcpServers.opsmaxx as { args: string[]; env: Record<string, string> }
    expect(entry.env.OPSMAXX_MCP_TOKEN).toBe('new-token')
    expect(entry.args[entry.args.indexOf('--port') + 1]).toBe('6000')
    expect(Object.keys(read().mcpServers)).toEqual(['opsmaxx'])
  })

  it('backs the file up before overwriting it', () => {
    writeFileSync(file, JSON.stringify({ mcpServers: {} }))
    const result = writeClaudeDesktopConfigTo(file, 'tok', 5177)
    expect(result.backedUpTo).toBe(`${file}.opsmaxx-backup`)
    expect(existsSync(result.backedUpTo!)).toBe(true)
  })

  it('refuses to touch a file that is not valid JSON', () => {
    writeFileSync(file, '{ this is not json')
    const result = writeClaudeDesktopConfigTo(file, 'tok', 5177)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not valid JSON')
    // The user's file must survive a failed write untouched.
    expect(readFileSync(file, 'utf8')).toBe('{ this is not json')
  })

  it('treats an empty file as an empty config rather than an error', () => {
    writeFileSync(file, '   \n')
    expect(writeClaudeDesktopConfigTo(file, 'tok', 5177).ok).toBe(true)
    expect(read().mcpServers.opsmaxx).toBeDefined()
  })

  it('replaces a non-object mcpServers value instead of crashing on it', () => {
    writeFileSync(file, JSON.stringify({ mcpServers: 'nonsense' }))
    expect(writeClaudeDesktopConfigTo(file, 'tok', 5177).ok).toBe(true)
    expect(read().mcpServers.opsmaxx).toBeDefined()
  })
})

// Claude Desktop's Code tab reads ~/.claude.json like the CLI, but refuses to
// open OpsMaxx's http sign-in page, so an entry with no header can never
// connect there. The button writes one that carries the token itself.
describe('writing the claude code config', () => {
  const cc = (): string => join(dir, '.claude.json')
  const cache = (): string => join(dir, 'mcp-needs-auth-cache.json')
  const readCc = (): Record<string, any> => JSON.parse(readFileSync(cc(), 'utf8'))

  it('adds a user-scope entry that carries the token as a header', () => {
    expect(writeClaudeCodeConfigTo(cc(), 'tok', 5177).ok).toBe(true)
    expect(readCc().mcpServers.opsmaxx).toEqual({
      type: 'http',
      url: httpUrl(5177),
      headers: { Authorization: 'Bearer tok' }
    })
  })

  it("replaces a hand-added entry with no header, and keeps all of Claude Code's own state", () => {
    writeFileSync(
      cc(),
      JSON.stringify({
        numStartups: 412,
        oauthAccount: { emailAddress: 'someone@example.com' },
        mcpServers: { opsmaxx: { type: 'http', url: httpUrl(5177) }, other: { command: 'x' } }
      })
    )
    expect(writeClaudeCodeConfigTo(cc(), 'tok', 5177).ok).toBe(true)
    const next = readCc()
    expect(next.numStartups).toBe(412)
    expect(next.oauthAccount).toEqual({ emailAddress: 'someone@example.com' })
    expect(next.mcpServers.other).toEqual({ command: 'x' })
    expect(next.mcpServers.opsmaxx.headers.Authorization).toBe('Bearer tok')
  })

  // `claude mcp add` defaults to project scope, and a project entry under the
  // same name wins over the user one in that folder.
  it('removes project-scoped entries under its own names, and nothing else of the project', () => {
    writeFileSync(
      cc(),
      JSON.stringify({
        projects: {
          '/work/app': {
            allowedTools: ['Bash'],
            mcpServers: { opsmaxx: { type: 'http', url: httpUrl(5177) }, [LEGACY_MCP_SERVER_KEYS[0]]: {}, db: { command: 'pg' } }
          },
          '/work/other': { history: [] }
        }
      })
    )
    expect(writeClaudeCodeConfigTo(cc(), 'tok', 5177).ok).toBe(true)
    const projects = readCc().projects
    expect(projects['/work/app']).toEqual({ allowedTools: ['Bash'], mcpServers: { db: { command: 'pg' } } })
    expect(projects['/work/other']).toEqual({ history: [] })
  })

  it('drops a legacy user entry, which would list every tool twice', () => {
    writeFileSync(cc(), JSON.stringify({ mcpServers: { [LEGACY_MCP_SERVER_KEYS[0]]: { type: 'http' } } }))
    writeClaudeCodeConfigTo(cc(), 'tok', 5177)
    expect(Object.keys(readCc().mcpServers)).toEqual(['opsmaxx'])
  })

  it('never replaces a file it cannot parse — it holds all of Claude Code’s state', () => {
    writeFileSync(cc(), '{ not json')
    const result = writeClaudeCodeConfigTo(cc(), 'tok', 5177)
    expect(result.ok).toBe(false)
    expect(readFileSync(cc(), 'utf8')).toBe('{ not json')
  })

  it('forgets that OpsMaxx once needed a sign-in, and nothing else in that cache', () => {
    writeFileSync(cache(), JSON.stringify({ opsmaxx: { timestamp: 1 }, 'plugin:x': { timestamp: 2 } }))
    writeClaudeCodeConfigTo(cc(), 'tok', 5177, cache())
    expect(JSON.parse(readFileSync(cache(), 'utf8'))).toEqual({ 'plugin:x': { timestamp: 2 } })
  })
})

// Desktop writes the copy of this file it loaded at launch back over it on
// routine actions, so an entry added while it is open is silently dropped --
// the button reported success and Desktop came back without OpsMaxx.
describe('writing the claude desktop config while Desktop is open', () => {
  it('refuses, and says why, rather than writing an entry Desktop will erase', () => {
    const result = writeClaudeDesktopConfig('tok', 5177, true)
    expect(result).toMatchObject({ ok: false, reason: 'desktop-running' })
    expect(result.error).toContain('quit it completely')
  })

  it('answers whether Desktop is running without throwing, on any platform', () => {
    expect(typeof claudeDesktopRunning()).toBe('boolean')
  })
})

describe('writing the codex config', () => {
  const codex = (): string => join(dir, 'config.toml')
  const readToml = (): string => readFileSync(codex(), 'utf8')

  it('resolves to ~/.codex/config.toml', () => {
    expect(codexConfigPath().endsWith(join('.codex', 'config.toml'))).toBe(true)
  })

  it('writes a bridge entry Codex can launch', () => {
    expect(writeCodexConfigTo(codex(), 'tok', 5177).ok).toBe(true)
    const toml = readToml()
    expect(toml).toContain('[mcp_servers.opsmaxx]')
    expect(toml).toContain('OPSMAXX_MCP_TOKEN = "tok"')
    expect(toml).not.toContain('--token')
    expect(toml).toContain('ELECTRON_RUN_AS_NODE = "1"')
  })

  it('keeps the rest of the file, which is the user\'s own Codex config', () => {
    writeFileSync(codex(), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "python"\n')
    expect(writeCodexConfigTo(codex(), 'tok', 5177).ok).toBe(true)
    const toml = readToml()
    expect(toml).toContain('model = "gpt-5"')
    expect(toml).toContain('[mcp_servers.other]')
    expect(toml).toContain('[mcp_servers.opsmaxx]')
  })

  it('replaces its own block instead of appending another', () => {
    writeCodexConfigTo(codex(), 'old-token', 5177)
    writeCodexConfigTo(codex(), 'new-token', 6000)
    const toml = readToml()
    expect(toml).toContain('new-token')
    expect(toml).not.toContain('old-token')
    expect(toml.match(/\[mcp_servers\.opsmaxx\]/g)).toHaveLength(1)
    expect(toml.match(/opsmaxx managed block/g)).toHaveLength(2)
  })

  it('backs up an existing file first', () => {
    writeFileSync(codex(), 'model = "gpt-5"\n')
    const result = writeCodexConfigTo(codex(), 'tok', 5177)
    expect(result.backedUpTo).toBe(`${codex()}.opsmaxx-backup`)
    expect(existsSync(result.backedUpTo!)).toBe(true)
  })

  it('creates the .codex directory when it does not exist', () => {
    const nested = join(dir, '.codex', 'config.toml')
    expect(writeCodexConfigTo(nested, 'tok', 5177).ok).toBe(true)
    expect(readFileSync(nested, 'utf8')).toContain('[mcp_servers.opsmaxx]')
  })
})

// Both writers back the file up at `${file}.opsmaxx-backup` — a fully
// predictable path — one line above a write that is narrowed to 0600 because the
// token is in it. A copy of a token-bearing config is as sensitive as the
// config, and `copyFileSync` offered no mode control: it takes the source's mode
// on some platforms only, never narrows a file already at the destination, and
// follows a symlink planted there.
describe('the backup copy', () => {
  const modeOf = (f: string): number => statSync(f).mode & 0o777
  const backupOf = (f: string): string => `${f}.opsmaxx-backup`

  const writers = [
    {
      name: 'claude desktop',
      path: (): string => file,
      body: `${JSON.stringify({ mcpServers: { burp: { command: 'python' } } }, null, 2)}\n`,
      write: (f: string): { ok: boolean } => writeClaudeDesktopConfigTo(f, 'tok', 5177)
    },
    {
      name: 'codex',
      path: (): string => join(dir, 'config.toml'),
      body: 'model = "gpt-5"\n',
      write: (f: string): { ok: boolean } => writeCodexConfigTo(f, 'tok', 5177)
    }
  ]

  for (const w of writers) {
    it.skipIf(process.platform === 'win32')(`${w.name}: writes the backup 0600`, () => {
      const f = w.path()
      writeFileSync(f, w.body)
      expect(w.write(f).ok).toBe(true)
      // Usable as a backup — the bytes that were there — and not readable by
      // anyone else on the machine.
      expect(readFileSync(backupOf(f), 'utf8')).toBe(w.body)
      expect(modeOf(backupOf(f))).toBe(0o600)
    })

    it.skipIf(process.platform === 'win32')(
      `${w.name}: narrows a backup an earlier run left wide`,
      () => {
        const f = w.path()
        writeFileSync(f, w.body)
        // An explicit chmod, not `{ mode }` on the write: the umask masks that,
        // so the precondition would not actually be wide and the assertion
        // below would pass against the unfixed code.
        writeFileSync(backupOf(f), 'stale')
        chmodSync(backupOf(f), 0o644)

        expect(w.write(f).ok).toBe(true)
        expect(modeOf(backupOf(f))).toBe(0o600)
        expect(readFileSync(backupOf(f), 'utf8')).toBe(w.body)
      }
    )

    it(`${w.name}: does not write through a symlink at the backup path`, () => {
      const f = w.path()
      writeFileSync(f, w.body)
      const victim = join(dir, `victim-${w.name.replace(/\s/g, '-')}`)
      writeFileSync(victim, 'not ours')
      symlinkSync(victim, backupOf(f))

      expect(w.write(f).ok).toBe(true)
      expect(readFileSync(victim, 'utf8')).toBe('not ours')
      expect(lstatSync(backupOf(f)).isSymbolicLink()).toBe(false)
      expect(readFileSync(backupOf(f), 'utf8')).toBe(w.body)
    })
  }
})

// A client names every tool after its config key, not after the name the server
// declares. An entry from before the rename kept working -- same port -- so
// nothing ever signalled it was stale, and re-registering only removed the
// CURRENT key, adding a second entry beside the old one. Agents went on listing
// every tool under the retired name long after nothing in this repo carried it.
describe('entries left from before the rename', () => {
  it('are removed by the Claude Code one-liner, before the add', () => {
    const cmd = claudeCodeCommand('tok', 5177)
    for (const key of LEGACY_MCP_SERVER_KEYS) {
      const remove = `claude mcp remove ${key} -s user 2>/dev/null;`
      expect(cmd).toContain(remove)
      expect(cmd.indexOf(remove)).toBeLessThan(cmd.indexOf('mcp add'))
    }
  })

  it('are dropped from claude_desktop_config.json, and the user\'s other servers are not', () => {
    const legacy = Object.fromEntries(LEGACY_MCP_SERVER_KEYS.map((k) => [k, { command: 'node', args: ['old'] }]))
    writeFileSync(file, JSON.stringify({ mcpServers: { ...legacy, burp: { command: 'python' } } }))
    expect(writeClaudeDesktopConfigTo(file, 'tok', 5177).ok).toBe(true)
    expect(Object.keys(read().mcpServers).sort()).toEqual(['burp', 'opsmaxx'])
  })

  it('are dropped from the Codex config, sub-tables included, and nothing else is', () => {
    const codex = join(dir, 'config.toml')
    const legacy = LEGACY_MCP_SERVER_KEYS.map(
      (k) => `[mcp_servers.${k}]\ncommand = "node"\n\n[mcp_servers.${k}.env]\nX = "1"\n`
    ).join('\n')
    writeFileSync(codex, `model = "gpt-5"\n\n${legacy}\n[mcp_servers.other]\ncommand = "python"\n`)
    expect(writeCodexConfigTo(codex, 'tok', 5177).ok).toBe(true)
    const toml = readFileSync(codex, 'utf8')
    for (const k of LEGACY_MCP_SERVER_KEYS) expect(toml).not.toContain(`mcp_servers.${k}`)
    expect(toml).toContain('model = "gpt-5"')
    expect(toml).toContain('[mcp_servers.other]')
    expect(toml.match(/\[mcp_servers\.opsmaxx\]/g)).toHaveLength(1)
  })
})

// The app and the CLI both write a Codex block. They used to open it with
// different marker sentences, so neither recognised the other's and running
// both stacked two [mcp_servers.opsmaxx] tables in one file.
describe('the CLI and the app writing the same Codex config', () => {
  const skipOnWindows = process.platform === 'win32' ? it.skip : it
  let home: string | undefined
  beforeEach(() => {
    home = process.env.HOME
    process.env.HOME = dir
  })
  afterEach(() => {
    process.env.HOME = home
  })

  skipOnWindows('replace one block rather than stacking two, in either order', () => {
    const codex = join(dir, '.codex', 'config.toml')
    registerCodexMcp('/bin/opsmaxx', '/cli.js', 'cli-token', 5177)
    expect(writeCodexConfigTo(codex, 'app-token', 5177).ok).toBe(true)
    registerCodexMcp('/bin/opsmaxx', '/cli.js', 'cli-token-2', 5177)
    const toml = readFileSync(codex, 'utf8')
    expect(toml.match(/\[mcp_servers\.opsmaxx\]/g)).toHaveLength(1)
    expect(toml).toContain('cli-token-2')
    expect(toml).not.toContain('app-token')
  })

  skipOnWindows('recognises a block an older CLI wrote under its old marker sentence', () => {
    const codex = join(dir, '.codex', 'config.toml')
    registerCodexMcp('/bin/opsmaxx', '/cli.js', 'x', 5177)
    const old = readFileSync(codex, 'utf8').replace(
      'written by OpsMaxx, safe to remove',
      'edited by `opsmaxx codex`, safe to remove'
    )
    writeFileSync(codex, old)
    expect(writeCodexConfigTo(codex, 'tok', 5177).ok).toBe(true)
    expect(readFileSync(codex, 'utf8').match(/\[mcp_servers\.opsmaxx\]/g)).toHaveLength(1)
  })

  skipOnWindows('writes the token-bearing file 0600 from the CLI too', () => {
    registerCodexMcp('/bin/opsmaxx', '/cli.js', 'tok', 5177)
    expect(statSync(join(dir, '.codex', 'config.toml')).mode & 0o777).toBe(0o600)
  })
})
