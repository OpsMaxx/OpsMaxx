import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configYaml } from '../src/main/services/vpn/drivers/ngrok'

/**
 * The generated config, handed to the real ngrok agent to judge.
 *
 * This exists because the config format was the one thing in that driver that
 * could not be reasoned out from the source: `version` selects a whole schema,
 * and emitting `version: 3` over a v2-shaped body would produce a file matching
 * neither — which the agent would reject at start, on a user's machine, for a
 * profile that validated perfectly in the app.
 *
 * `ngrok config check` parses without connecting or publishing anything, so
 * this asserts the format without opening a port.
 *
 * Skipped where the agent is not installed, which is most CI machines. That is
 * deliberate rather than lazy: the alternative is asserting against a fixture
 * of what the format is believed to be, which is the belief that needed
 * checking in the first place.
 */

function hasNgrok(): boolean {
  try {
    execFileSync('ngrok', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const check = (body: string): { ok: boolean; output: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'om-ngrok-'))
  const file = join(dir, 'ngrok.yml')
  writeFileSync(file, body)
  try {
    return { ok: true, output: execFileSync('ngrok', ['config', 'check', '--config', file], {
      encoding: 'utf8',
      timeout: 20_000
    }) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}` }
  }
}

describe.runIf(hasNgrok())('the config the agent actually accepts', () => {
  it('accepts a single http endpoint', () => {
    const r = check(
      configYaml({
        kind: 'ngrok',
        tunnels: [{ name: 'web', proto: 'http', localPort: 3000, acknowledgedExposure: true }]
      })
    )
    expect(r.ok, r.output).toBe(true)
    expect(r.output).toMatch(/valid/i)
  })

  // Several endpoints, and a tcp one — `addr` and `remote_addr` differ per
  // protocol, and the agent rejects the wrong pairing rather than ignoring it.
  it('accepts several endpoints across protocols, with a region', () => {
    const r = check(
      configYaml({
        kind: 'ngrok',
        region: 'eu',
        tunnels: [
          { name: 'web', proto: 'http', localPort: 3000, acknowledgedExposure: true },
          { name: 'db', proto: 'tcp', localPort: 5432, acknowledgedExposure: true },
          { name: 'secure', proto: 'tls', localPort: 8443, acknowledgedExposure: true }
        ]
      })
    )
    expect(r.ok, r.output).toBe(true)
  })

  /**
   * A reserved address, in the shape each protocol wants: `domain` for
   * http/tls, `remote_addr` for tcp. Getting this backwards is a start-time
   * failure rather than a parse error, so it is worth asserting the agent
   * agrees with the pairing the generator chose.
   */
  it('accepts a reserved domain and a reserved tcp address', () => {
    const r = check(
      configYaml({
        kind: 'ngrok',
        tunnels: [
          { name: 'web', proto: 'http', localPort: 3000, domain: 'example.ngrok.app', acknowledgedExposure: true },
          { name: 'db', proto: 'tcp', localPort: 5432, domain: '1.tcp.ngrok.io:12345', acknowledgedExposure: true }
        ]
      })
    )
    expect(r.ok, r.output).toBe(true)
  })

  /**
   * The injection guard, proved against the real parser rather than against
   * our own regex.
   *
   * YAML is line-oriented, so a newline in an interpolated value writes new
   * configuration — a `domain` carrying one could append an endpoint the spec
   * never held, and therefore one with no exposure acknowledgement behind it.
   * The generator refuses to build the file at all, which is why this asserts a
   * throw rather than an invalid file: nothing hostile ever reaches disk.
   */
  it('never writes a file for a value that would inject configuration', () => {
    for (const hostile of [
      'ok.example\n  evil:\n    proto: tcp\n    addr: 22',
      'ok.example\nlog: /tmp/stolen'
    ]) {
      expect(() =>
        configYaml({
          kind: 'ngrok',
          tunnels: [
            { name: 'web', proto: 'http', localPort: 3000, domain: hostile, acknowledgedExposure: true }
          ]
        })
      ).toThrow()
    }
    expect(() =>
      configYaml({
        kind: 'ngrok',
        region: 'us\nauthtoken: stolen',
        tunnels: [{ name: 'web', proto: 'http', localPort: 3000, acknowledgedExposure: true }]
      })
    ).toThrow()
  })
})
