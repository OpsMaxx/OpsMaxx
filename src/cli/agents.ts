import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../main/services/atomicWrite.js'
import {
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  LEGACY_MCP_SERVER_KEYS,
  MCP_SERVER_KEY,
  spliceCodexBlock
} from '../shared/mcpClientKeys.js'

function bridgeArgs(selfScript: string, token: string, port: number): string[] {
  return [selfScript, 'bridge', '--token', token, '--port', String(port)]
}

// Re-registers (remove, then add) so a fresh pairing always replaces a
// stale/expired token instead of leaving Claude Code pointed at one that no
// longer works. The legacy keys go too — see shared/mcpClientKeys.ts for why an
// entry from before the rename otherwise outlives every re-registration.
export function registerClaudeMcp(execPath: string, selfScript: string, token: string, port: number): void {
  for (const key of [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS]) {
    spawnSync('claude', ['mcp', 'remove', key], { stdio: 'ignore', shell: process.platform === 'win32' })
  }
  const res = spawnSync(
    'claude',
    ['mcp', 'add', '--transport', 'stdio', MCP_SERVER_KEY, '--', execPath, ...bridgeArgs(selfScript, token, port)],
    { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' }
  )
  if (res.error || res.status !== 0) {
    throw new Error('Could not register OpsMaxx with Claude Code. Is the `claude` CLI installed and on PATH?')
  }
}

// Codex has no `mcp add` command, so edit ~/.codex/config.toml directly. The
// block and its markers are the app's own (main/services/clientConfig.ts), so
// running both writers replaces one block rather than stacking two.
export function registerCodexMcp(execPath: string, selfScript: string, token: string, port: number): void {
  const dir = join(homedir(), '.codex')
  const file = join(dir, 'config.toml')
  mkdirSync(dir, { recursive: true })
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''

  const args = bridgeArgs(selfScript, token, port)
  const block = [
    CODEX_BLOCK_START,
    `[mcp_servers.${MCP_SERVER_KEY}]`,
    `command = ${JSON.stringify(execPath)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    CODEX_BLOCK_END
  ].join('\n')

  // 0600 and atomic, as the app's writer is: the block carries a bearer token,
  // and this file lives outside any directory OpsMaxx owns, so the umask was
  // all that stood between the token and the rest of the machine.
  atomicWriteFileSync(file, spliceCodexBlock(existing, block), 0o600, `${file}.opsmaxx-tmp`)
}
