import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Which screens may raise a dialog to read a gauge.
 *
 * `metricsSample` defaults to `allowPrompt = true`, and the `metrics:sample`
 * IPC handler took that default. That is defensible for the Monitor tab, which
 * is one host the user navigated to. It is not defensible for the fleet grid:
 * `ServerMonitorCard` is rendered once per server and polls every one that is
 * not marked offline, so a single sweep across an estate with second factors on
 * it could raise a verification-code dialog per host, attached to nothing
 * anybody clicked.
 *
 * And once a second dialog exists, the prompt for the connection the user
 * actually asked for is the one that gets covered or dropped — which is how
 * this ends up in the same report as "it shows Enter Vault password instead of
 * the auth code". See tests/sshPromptQueue.test.tsx.
 *
 * The flag is deliberately renderer-supplied, which the rest of this app does
 * not do for transports. It is safe here for one reason and the tests below
 * pin it: the flag can only ever RAISE a dialog, never suppress one. A
 * renderer that lies can ask a question; it cannot skip one.
 */

const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

const MAIN = read('src/main/index.ts')
const PRELOAD = read('src/preload/index.ts')
const HOOK = read('src/renderer/src/hooks/useServerMetrics.ts')

describe('the handler', () => {
  it('defaults to raising nothing', () => {
    expect(MAIN).toContain('metricsSample(key, preparedSshTarget(cfg), interactive === true)')
  })

  /**
   * `interactive === true`, not `interactive`. An absent argument, a null from
   * an older preload, or anything else truthy-adjacent all have to mean "no",
   * because the default is the safe one and only an explicit yes may leave it.
   */
  it('treats anything but an explicit yes as no', () => {
    expect(MAIN).not.toMatch(/metricsSample\(key, preparedSshTarget\(cfg\), interactive\)/)
  })

  it('carries it across the bridge', () => {
    expect(PRELOAD).toContain("ipcRenderer.invoke('metrics:sample', key, cfg, interactive)")
  })

  // The fleet sampler has always been unattended and stays that way.
  it('leaves the fleet sampler alone', () => {
    expect(MAIN).toContain('metricsSample(key, preparedSshTarget(cfg as SshConnectConfig), false)')
  })
})

describe('the hook', () => {
  it('defaults to no prompt, so a caller that says nothing asks nothing', () => {
    expect(HOOK).toMatch(/interactive = false/)
  })

  it('sends it with the sample', () => {
    const i = HOOK.indexOf('metrics.sample(')
    expect(i).toBeGreaterThan(-1)
    expect(HOOK.slice(i, i + 260)).toContain('interactive')
  })
})

describe('the screens', () => {
  const lift = (p: string): boolean => /useServerMetrics\([^)]*,\s*true\)/.test(read(p))

  // One host, on screen, because the user opened it. A fingerprint to confirm
  // or a code to type is the answer to their click.
  it('lets the Monitor tab ask', () => {
    expect(lift('src/renderer/src/components/panel/MonitorView.tsx')).toBe(true)
  })

  it("lets the terminal's monitor strip ask", () => {
    expect(lift('src/renderer/src/components/panel/MonitorStrip.tsx')).toBe(true)
  })

  // The one that must not. N cards, N hosts, N dialogs.
  it('does not let the fleet grid ask', () => {
    expect(lift('src/renderer/src/components/monitor/ServerMonitorCard.tsx')).toBe(false)
  })
})

describe('the agent bridge', () => {
  // An agent asked for this, so there is nobody whose click a dialog would be
  // the answer to. Same rule as `sshTest`, which `probeServer` reaches.
  it('never prompts for an MCP metrics read', () => {
    expect(read('src/main/services/mcpServer.ts')).toContain(
      'metricsSample(`mcp:${s.id}`, cfg, false)'
    )
  })
})
