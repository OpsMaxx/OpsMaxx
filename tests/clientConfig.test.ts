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
  httpUrl,
  writeClaudeDesktopConfigTo,
  writeCodexConfigTo,
  codexConfigPath
} from '../src/main/services/clientConfig'

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
    expect(inv.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(inv.args.slice(1)).toEqual(['bridge', '--token', 'tok', '--port', '5177'])
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
    expect(written.mcpServers.opsmaxx.args).toContain('--token')
    expect(written.mcpServers.opsmaxx.args).toContain('tok')
    expect(written.mcpServers.opsmaxx.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
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
    const args: string[] = read().mcpServers.opsmaxx.args
    expect(args).toContain('new-token')
    expect(args).not.toContain('old-token')
    expect(args[args.indexOf('--port') + 1]).toBe('6000')
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
    expect(toml).toContain('"--token", "tok"')
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
