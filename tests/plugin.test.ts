import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..')
const plugin = resolve(root, 'plugins/opsmaxx')
const json = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(root, p), 'utf8')) as Record<string, unknown>

describe('the Claude Code plugin', () => {
  it('declares a marketplace pointing at a plugin that exists', () => {
    const market = json('.claude-plugin/marketplace.json') as {
      name: string
      owner: { name: string }
      plugins: { name: string; source: string }[]
    }
    expect(market.name).toBe('opsmaxx')
    expect(market.owner.name).toBeTruthy()
    expect(market.plugins).toHaveLength(1)
    const entry = market.plugins[0]
    expect(entry.source).toBe('./plugins/opsmaxx')
    // The manifest has to be where the loader looks, and only plugin.json goes
    // inside .claude-plugin -- skills, hooks and .mcp.json live at plugin root.
    const manifest = json('plugins/opsmaxx/.claude-plugin/plugin.json') as { name: string }
    expect(manifest.name).toBe(entry.name)
  })

  it('wires the MCP server without putting a token in a config file', () => {
    const mcp = json('plugins/opsmaxx/.mcp.json') as {
      mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
    }
    const server = mcp.mcpServers.opsmaxx
    expect(server).toBeTruthy()
    // The relay reads the session the opsmaxx CLI already cached, so nothing
    // secret belongs here. A token committed to a plugin would be published.
    const serialized = JSON.stringify(server)
    expect(serialized.toLowerCase()).not.toContain('token')
    expect(serialized.toLowerCase()).not.toContain('authorization')
  })

  it('gives every skill a name and a description the model can match on', () => {
    const dir = resolve(plugin, 'skills')
    const skills = readdirSync(dir).filter((d) => statSync(resolve(dir, d)).isDirectory())
    expect(skills.length).toBeGreaterThan(0)
    for (const name of skills) {
      const body = readFileSync(resolve(dir, name, 'SKILL.md'), 'utf8')
      const front = /^---\n([\s\S]*?)\n---/.exec(body)
      expect(front, `${name} has no frontmatter`).toBeTruthy()
      const meta = front![1]
      expect(meta, `${name} frontmatter has no name`).toMatch(/^name:\s*\S+/m)
      expect(meta, `${name} frontmatter has no description`).toMatch(/^description:\s*\S+/m)
      // The directory is the invocation path, so a mismatch is a broken skill.
      expect(meta).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, 'm'))
      // Discovery is the whole point: a description that only names the product
      // never fires for someone describing their actual problem.
      expect(body.length, `${name} is suspiciously short`).toBeGreaterThan(200)
    }
  })

  describe('the ssh advisory hook', () => {
    const script = resolve(plugin, 'hooks/prefer-bridge.sh')
    const run = (stdin: string): { out: string; status: number } => {
      try {
        return { out: execFileSync(script, { input: stdin, encoding: 'utf8' }), status: 0 }
      } catch (err) {
        const e = err as { stdout?: string; status?: number }
        return { out: e.stdout ?? '', status: e.status ?? -1 }
      }
    }
    const payload = (command: string): string => JSON.stringify({ tool_input: { command } })

    it('is registered against the Bash tool by exact name', () => {
      const hooks = json('plugins/opsmaxx/hooks/hooks.json') as {
        hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
      }
      const entry = hooks.hooks.PreToolUse[0]
      // Anything outside [A-Za-z0-9_-, |] would be read as a regex instead.
      expect(entry.matcher).toBe('Bash')
      expect(entry.hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}')
    })

    it.each(['ssh root@10.0.0.1 uptime', 'sudo scp a b', 'sftp host'])(
      'suggests the bridge for %s',
      (command) => {
        const { out, status } = run(payload(command))
        expect(status).toBe(0)
        const parsed = JSON.parse(out) as { hookSpecificOutput: Record<string, unknown> }
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
        expect(parsed.hookSpecificOutput.additionalContext).toContain('list_servers')
        // Advisory only. A permission decision here would prompt or block.
        expect(parsed.hookSpecificOutput).not.toHaveProperty('permissionDecision')
      }
    )

    it.each(['ls -la', 'systemctl restart sshd', 'git push'])('stays quiet for %s', (command) => {
      const { out, status } = run(payload(command))
      expect(status).toBe(0)
      expect(out).toBe('')
    })

    it('never fails a tool call, whatever it is handed', () => {
      for (const stdin of ['', 'not json at all', '{"tool_input":{}}']) {
        expect(run(stdin).status, `exited non-zero on ${JSON.stringify(stdin)}`).toBe(0)
      }
    })
  })
})
