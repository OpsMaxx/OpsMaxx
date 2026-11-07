import { app } from 'electron'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { atomicWriteFileSync } from './atomicWrite'
import {
  BRIDGE_TOKEN_ENV,
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  LEGACY_MCP_SERVER_KEYS,
  MCP_SERVER_KEY,
  spliceCodexBlock
} from '../../shared/mcpClientKeys'

// Writes MCP client configuration on the user's behalf, so connecting an agent
// is a button rather than a hand-edited JSON file with a 130-character absolute
// path in it. Nothing here grants access — the token it embeds was already
// minted by mcpAuth with an explicit workspace/group scope.

const SERVER_KEY = MCP_SERVER_KEY

// process.execPath is OpsMaxx's own Electron binary. With
// ELECTRON_RUN_AS_NODE it runs plain JS, so the bridge needs no separate Node
// install and does not depend on PATH — which Claude Desktop does not inherit
// from a login shell, and which is the usual reason a `"command": "node"` entry
// works in a terminal and fails inside the app.
function bridgeScript(): string {
  const appPath = app.getAppPath()
  // Packaged builds run from app.asar; asarUnpack (electron-builder.yml) keeps
  // out/cli outside it precisely so it can be spawned as a real file, and a
  // child process cannot be launched from inside an archive at all.
  const root = appPath.endsWith('app.asar') ? `${appPath}.unpacked` : appPath
  return join(root, 'out', 'cli', 'index.js')
}

export interface BridgeInvocation {
  command: string
  args: string[]
  env: Record<string, string>
}

// The token travels in `env`, not `args`: a running process's argv is readable
// by every local user through `ps`, its environment is not. It is still in the
// client's config file either way -- that file is 0600, see below.
export function bridgeInvocation(token: string, port: number): BridgeInvocation {
  return {
    command: process.execPath,
    args: [bridgeScript(), 'bridge', '--port', String(port)],
    env: { ELECTRON_RUN_AS_NODE: '1', [BRIDGE_TOKEN_ENV]: token }
  }
}

export function httpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`
}

// The one-liner for Claude Code, which speaks Streamable HTTP directly and so
// needs no bridge process at all.
//
// Removes first, because `claude mcp add` refuses a name that already exists
// ("MCP server opsmaxx already exists in user config") rather than replacing
// it. Every time after the first is a re-registration — a new session, or a
// revoked one being replaced — so the plain add would have failed exactly when
// it was needed most. `opsmaxx claude` has always done remove-then-add for
// this reason (src/cli/agents.ts); this just matches it.
//
// The legacy keys are removed too. Removing only the current one left an entry
// from before the rename in place beside the new one, and Claude Code names
// every tool after its config key — so agents went on listing the retired name
// long after nothing in this repo carried it. See shared/mcpClientKeys.ts.
export function claudeCodeCommand(token: string, port: number): string {
  const add = [
    'claude mcp add -s user --transport http',
    SERVER_KEY,
    httpUrl(port),
    `--header "Authorization: Bearer ${token}"`
  ].join(' ')
  const removes = [SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS]
    .map((key) => `claude mcp remove ${key} -s user 2>/dev/null;`)
    .join(' ')
  return `${removes} ${add}`
}

// ---------------------------------------------------------------------------
// Claude Code's own config, written directly
// ---------------------------------------------------------------------------
//
// The Code tab of Claude Desktop runs Claude Code and reads the same user-scope
// entries from ~/.claude.json as the terminal CLI. An entry there WITHOUT a
// bearer header -- one added by hand, with the CLI then signing in through
// OpsMaxx's OAuth pages -- works in the terminal and not in Desktop: Desktop
// refuses to open a sign-in page that is not https ("Refused to open sign-in
// URL for opsmaxx: must be https"), and OpsMaxx's are on http://127.0.0.1. With
// the token in a header there is nothing to sign in to. Copying a command for
// the user to paste fixed it only where someone could open a terminal, so the
// button now writes the entry itself.
//
// Claude Code writes this file through a temp file and a rename, and an entry
// added from another process survives the many sessions that rewrite it -- so
// unlike Claude Desktop's own config it can be written while Claude is open.
// writeClaudeCodeConfig() still re-reads it afterwards, once, to catch the one
// race left: a session's write landing between this read and this rename.
export function claudeCodeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json')
}

function claudeCodeNeedsAuthCachePath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'mcp-needs-auth-cache.json')
}

export function claudeCodeEntry(token: string, port: number): Record<string, unknown> {
  return { type: 'http', url: httpUrl(port), headers: { Authorization: `Bearer ${token}` } }
}

function hasEntry(file: string, token: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { headers?: Record<string, string> }> }
    return parsed.mcpServers?.[SERVER_KEY]?.headers?.Authorization === `Bearer ${token}`
  } catch {
    return false
  }
}

export function writeClaudeCodeConfigTo(file: string, token: string, port: number, cacheFile?: string): WriteResult {
  let existing: Record<string, unknown> = {}
  if (existsSync(file)) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, path: file, error: `Could not read ${file}: ${(err as Error).message}` }
    }
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
        existing = parsed as Record<string, unknown>
      } catch (err) {
        // Claude Code's whole state lives in this file. Never replace it.
        return { ok: false, path: file, error: `${file} is not valid JSON (${(err as Error).message}), so it was left untouched.` }
      }
    }
  }

  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const servers = isRecord(existing.mcpServers) ? { ...existing.mcpServers } : {}
  for (const key of LEGACY_MCP_SERVER_KEYS) delete servers[key]
  servers[SERVER_KEY] = claudeCodeEntry(token, port)
  const next: Record<string, unknown> = { ...existing, mcpServers: servers }

  // A project-scoped entry under the same name wins over the user one, and
  // `claude mcp add` defaults to project scope -- so a hand-added entry from
  // before, with no header, would still be the one used in that folder.
  if (isRecord(existing.projects)) {
    const projects: Record<string, unknown> = {}
    for (const [dir, project] of Object.entries(existing.projects)) {
      if (isRecord(project) && isRecord(project.mcpServers)) {
        const own = { ...project.mcpServers }
        for (const key of [SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS]) delete own[key]
        projects[dir] = { ...project, mcpServers: own }
      } else projects[dir] = project
    }
    next.projects = projects
  }

  try {
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 0o600, `${file}.opsmaxx-tmp`)
  } catch (err) {
    return { ok: false, path: file, error: `Could not write ${file}: ${(err as Error).message}` }
  }

  // Claude Code remembers which servers last asked for a sign-in and may not
  // try them again for a while. The entry this replaces did ask; this one never
  // will. A cache, so dropping one key of it costs nothing.
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, unknown>
      let changed = false
      for (const key of [SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS]) {
        if (key in cache) {
          delete cache[key]
          changed = true
        }
      }
      if (changed) atomicWriteFileSync(cacheFile, JSON.stringify(cache), 0o600, `${cacheFile}.opsmaxx-tmp`)
    } catch {
      /* the entry is written; a stale cache only delays the first connect */
    }
  }

  return { ok: true, path: file }
}

export async function writeClaudeCodeConfig(token: string, port: number): Promise<WriteResult> {
  const file = claudeCodeConfigPath()
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = writeClaudeCodeConfigTo(file, token, port, claudeCodeNeedsAuthCachePath())
    if (!result.ok) return result
    await new Promise((r) => setTimeout(r, 1_000))
    if (hasEntry(file, token)) return result
  }
  return { ok: false, path: file, error: `${file} kept being rewritten while OpsMaxx wrote to it.` }
}

export function claudeDesktopConfigPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude', 'claude_desktop_config.json')
}

export function codexConfigPath(): string {
  // Codex uses ~/.codex on every platform, including Windows.
  return join(homedir(), '.codex', 'config.toml')
}

export interface WriteResult {
  ok: boolean
  path: string
  backedUpTo?: string
  error?: string
  /** Set when nothing was written because Claude Desktop is open. */
  reason?: 'desktop-running'
}

// Claude Desktop loads claude_desktop_config.json once, at launch, and writes
// its in-memory copy back over the file on routine actions -- opening a
// session, changing a preference. So an entry added while it is open lasts
// only until its next write: seen on a real machine, the opsmaxx entry was
// written at 08:06 and gone at 08:26, the file byte-for-byte the size of the
// backup taken just before it was added. The button reported success, the
// user restarted Desktop as told, and Desktop came back without OpsMaxx. The
// only write that sticks is one made while Desktop is closed.
//
// macOS asks LaunchServices by bundle id rather than matching a process path:
// on a real machine `pgrep` did not see Desktop's main process at all, only
// its helpers, and Claude Code's own `claude.app` binaries live under the same
// Application Support folder. `lsappinfo` prints `"pid"=N` for a running app
// and nothing otherwise, exiting 0 either way.
//
// ponytail: Windows matches the image name, which another program could share.
// Desktop has no lock file or API to ask instead. Linux has no official Claude
// Desktop, so it is never reported as running there.
export function claudeDesktopRunning(): boolean {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('lsappinfo', ['info', '-only', 'pid', '-app', 'com.anthropic.claudefordesktop'], {
        encoding: 'utf8'
      })
      return /"pid"\s*=\s*\d+/.test(r.stdout ?? '')
    }
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Claude.exe', '/NH'], { encoding: 'utf8' })
      return /\bClaude\.exe\b/i.test(r.stdout ?? '')
    }
  } catch {
    // A check that cannot run must not block the button; the toast still says
    // to quit and reopen Desktop.
  }
  return false
}

export function writeClaudeDesktopConfig(token: string, port: number, running = claudeDesktopRunning()): WriteResult {
  const file = claudeDesktopConfigPath()
  if (running) {
    return {
      ok: false,
      path: file,
      reason: 'desktop-running',
      error: 'Claude Desktop is open. It rewrites its config file from memory and would drop OpsMaxx again — quit it completely first, then connect.'
    }
  }
  return writeClaudeDesktopConfigTo(file, token, port)
}

// Merges a `opsmaxx` entry into whatever is already in the file. A user's
// other MCP servers are none of our business, so an unreadable or non-JSON file
// is a hard stop rather than something to overwrite with a clean config — the
// entry can always be added by hand from the docs.
//
// Takes the path explicitly so tests can exercise the merge without writing to
// the real Claude Desktop config on the machine running them.
export function writeClaudeDesktopConfigTo(file: string, token: string, port: number): WriteResult {
  let existing: Record<string, unknown> = {}
  let backedUpTo: string | undefined

  if (existsSync(file)) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, path: file, error: `Could not read ${file}: ${(err as Error).message}` }
    }
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
        existing = parsed as Record<string, unknown>
      } catch (err) {
        return {
          ok: false,
          path: file,
          error:
            `${file} is not valid JSON (${(err as Error).message}), so it was left untouched. ` +
            `Fix or move the file and try again, or add the entry by hand — see docs/AI-MCP.md.`
        }
      }
    }
    backedUpTo = `${file}.opsmaxx-backup`
    try {
      // The same helper, for the same two reasons, as the real write below — a
      // copy of a token-bearing config is as sensitive as the config. `mode` on
      // copyFileSync is not a thing: it takes the source's mode on some
      // platforms only, NEVER narrows a file already sitting at the
      // destination, and follows a symlink planted there. This path is as
      // predictable as the temp path was. `raw` is the bytes just read, so
      // nothing is read twice.
      atomicWriteFileSync(backedUpTo, raw, 0o600, `${backedUpTo}.opsmaxx-tmp`)
    } catch {
      // A backup is a courtesy, not a precondition — the merge below preserves
      // every key it did not write, so failing to copy is not worth aborting for.
      backedUpTo = undefined
    }
  }

  const servers =
    existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {}

  // An entry left from before the rename points at the same bridge and would
  // show every tool twice, once under the retired name.
  for (const key of LEGACY_MCP_SERVER_KEYS) delete servers[key]
  const { command, args, env } = bridgeInvocation(token, port)
  servers[SERVER_KEY] = { command, args, env }

  const next = { ...existing, mcpServers: servers }

  try {
    mkdirSync(dirname(file), { recursive: true })
    // 0600, where this went out with no mode at all and took the umask — so the
    // bearer token this writes was world-readable on a default install. These two
    // writers are the reason the helper takes a mode: of everything that calls
    // `atomicWriteFileSync`, they are the only ones that land OUTSIDE userData
    // (`~/.config`, `~/.codex`, `~/Library/Application Support/Claude`), where the
    // 0700 directory that covers every other caller does not reach. The agent that
    // reads it back runs as this same user, so narrowing the mode costs it
    // nothing.
    //
    // Not the only bytes the app ever puts outside userData — backup.ts writes the
    // `.spbackup` archive wherever a save dialog sent it, and a transient 0600
    // dump config under `tmpdir()`. Both are different in the way that matters
    // here: one is a path the user chose in that moment and the other is deleted
    // in a `finally`, whereas these two are long-lived files this app places in
    // somebody else's config directory on its own initiative and then leaves
    // there.
    atomicWriteFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 0o600, `${file}.opsmaxx-tmp`)
  } catch (err) {
    return { ok: false, path: file, error: `Could not write ${file}: ${(err as Error).message}` }
  }

  return { ok: true, path: file, backedUpTo }
}

// Codex reads a TOML config and, like Claude Desktop, launches MCP servers as
// stdio subprocesses — so it gets the same bridge, in a different file format.
//
// There is no TOML dependency in this project and adding one for three
// key/value pairs is not worth it, so the entry is spliced in as a marked
// block, the same approach `opsmaxx codex` already uses (src/cli/agents.ts),
// with the same markers (shared/mcpClientKeys.ts). TOML basic-string escaping
// is a subset of JSON's, which makes JSON.stringify a safe way to quote each
// value.

export function writeCodexConfig(token: string, port: number): WriteResult {
  return writeCodexConfigTo(codexConfigPath(), token, port)
}

export function writeCodexConfigTo(file: string, token: string, port: number): WriteResult {
  const { command, args, env } = bridgeInvocation(token, port)
  const block = [
    CODEX_BLOCK_START,
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    `env = { ${Object.entries(env)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(', ')} }`,
    CODEX_BLOCK_END
  ].join('\n')

  let existing = ''
  let backedUpTo: string | undefined

  if (existsSync(file)) {
    try {
      existing = readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, path: file, error: `Could not read ${file}: ${(err as Error).message}` }
    }
    backedUpTo = `${file}.opsmaxx-backup`
    try {
      // Same reasoning as writeClaudeDesktopConfigTo above, and the block this
      // file is a backup of carries the token either way.
      atomicWriteFileSync(backedUpTo, existing, 0o600, `${backedUpTo}.opsmaxx-tmp`)
    } catch {
      backedUpTo = undefined
    }
  }

  // Replacing between the markers keeps everything the user wrote around it,
  // and re-running replaces the previous block rather than stacking another.
  const next = spliceCodexBlock(existing, block)

  try {
    mkdirSync(dirname(file), { recursive: true })
    // Same reasoning as writeClaudeDesktopConfigTo above: outside userData, and
    // the block it splices in carries the token.
    atomicWriteFileSync(file, next, 0o600, `${file}.opsmaxx-tmp`)
  } catch (err) {
    return { ok: false, path: file, error: `Could not write ${file}: ${(err as Error).message}` }
  }

  return { ok: true, path: file, backedUpTo }
}
