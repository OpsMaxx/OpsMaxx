import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ComposeReader } from '../src/main/services/compose'

// The wiring, and the boundary it exists to hold: a `.env` value comes out of
// the vault in MAIN, goes onto the host, and never travels back or sideways.
//
// The escaping and planning are covered in `envWrite.test.ts` against a
// recorded measurement. What is asserted here is where the value is allowed to
// be.

const src = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

const SECRET = 'p@ss w0rd # not-a-comment $HOME'

function reader(over: Partial<{ text: string; code: number; stdout: string }> = {}): {
  r: ComposeReader
  commands: string[]
} {
  const commands: string[] = []
  const r = new ComposeReader({
    exec: async (_cfg: unknown, command: string) => {
      commands.push(command)
      if (command.startsWith('head') || command.includes(' head ')) {
        return { ok: true, code: 0, stdout: over.text ?? 'A=1\nB=2\n', stderr: '' }
      }
      return {
        ok: true,
        code: over.code ?? 0,
        stdout: over.stdout ?? '===OPSMAXX-END===\n',
        stderr: ''
      }
    }
  } as unknown as ConstructorParameters<typeof ComposeReader>[0])
  return { r, commands }
}

describe('writing the value', () => {
  it('replaces the line and says which one, and nothing else', async () => {
    const { r } = reader()
    const out = await r.writeEnvValue({}, { path: '/srv/app/.env', name: 'B' }, SECRET)
    expect(out).toEqual({
      ok: true,
      name: 'B',
      line: 2,
      action: 'replace',
      backup: '/srv/app/.env.opsmaxx-bak'
    })
  })

  it('appends a name the file does not have', async () => {
    const { r } = reader()
    const out = await r.writeEnvValue({}, { path: '/srv/app/.env', name: 'NEW' }, SECRET)
    expect(out).toMatchObject({ ok: true, action: 'append', line: null })
  })

  // The result travels to a renderer. Nothing on it may carry the value, and
  // no error path may either.
  it('never returns the value or the file text, on any path', async () => {
    const cases = [
      reader(),
      reader({ code: 1, stdout: 'permission denied' }),
      reader({ stdout: 'no end marker' }),
      reader({ text: 'B=1\nB=2\n' })
    ]
    for (const { r } of cases) {
      const out = await r.writeEnvValue({}, { path: '/srv/app/.env', name: 'B' }, SECRET)
      expect(JSON.stringify(out)).not.toContain(SECRET)
      expect(JSON.stringify(out)).not.toContain('A=1')
    }
  })

  it('quotes the value into the command so a hash and a dollar survive', async () => {
    const { r, commands } = reader()
    await r.writeEnvValue({}, { path: '/srv/app/.env', name: 'B' }, SECRET)
    const write = commands.find((c) => c.includes('OPSMAXX_COMPOSE_EOF'))!
    expect(write).toContain('B="p@ss w0rd # not-a-comment $$HOME"')
  })

  // Measured: compose takes the LAST duplicate, so writing one of them would
  // change the file and not the stack.
  it('refuses a file that sets the name twice', async () => {
    const { r, commands } = reader({ text: 'B=1\nB=2\n' })
    const out = await r.writeEnvValue({}, { path: '/srv/app/.env', name: 'B' }, SECRET)
    expect(out.ok).toBe(false)
    expect(commands.some((c) => c.includes('OPSMAXX_COMPOSE_EOF'))).toBe(false)
  })

  it('refuses an empty value rather than writing NAME=""', async () => {
    const { r, commands } = reader()
    const out = await r.writeEnvValue({}, { path: '/srv/app/.env', name: 'B' }, '')
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.reason).toContain('nothing in the field')
    expect(commands).toHaveLength(0)
  })

  // Everything past the plan holds either the file body or the built command,
  // and both contain the value. A thrown message from any of them must not
  // become the reason.
  it('never turns a thrown error into a reason, because the throw may hold the body', async () => {
    const r = new ComposeReader({
      exec: async (_cfg: unknown, command: string): Promise<unknown> => {
        if (command.startsWith('head')) return { ok: true, code: 0, stdout: 'A=1\nB=2\n', stderr: '' }
        throw new Error(`connection reset while sending B="${SECRET}"`)
      }
    } as unknown as ConstructorParameters<typeof ComposeReader>[0])
    const out = await r.writeEnvValue({}, { path: '/srv/app/.env', name: 'B' }, SECRET)
    expect(out.ok).toBe(false)
    expect(JSON.stringify(out)).not.toContain(SECRET)
    expect(JSON.stringify(out)).not.toContain('connection reset')
  })

  it('refuses a path or a name that is not one', async () => {
    const { r } = reader()
    expect((await r.writeEnvValue({}, { path: 'relative/.env', name: 'B' }, SECRET)).ok).toBe(false)
    expect((await r.writeEnvValue({}, { path: '/srv/.env', name: '1BAD' }, SECRET)).ok).toBe(false)
  })

  // The write chain is `cp && tee && mv && echo <marker>`. A shell that died
  // between stages exits 0 with the file half replaced.
  it('does not report success without the end marker', async () => {
    const { r } = reader({ stdout: '' })
    expect((await r.writeEnvValue({}, { path: '/srv/.env', name: 'B' }, SECRET)).ok).toBe(false)
  })
})

describe('where the value is allowed to be', () => {
  // A `writeEnvValue(cfg, req, value)` on `ComposeBridge` would require the
  // PRELOAD to implement it, putting the secret in the renderer.
  it('keeps the value-taking method off the interface the preload implements', () => {
    const shared = src('../src/shared/compose.ts')
    const iface = shared.slice(
      shared.indexOf('export interface ComposeBridge {'),
      shared.indexOf('export interface ComposePreloadBridge')
    )
    expect(iface).not.toContain('writeEnvValue')
    expect(shared).toContain('`writeEnvValue` is deliberately NOT on this interface')
  })

  it('gives the preload a method with no parameter that could hold a value', () => {
    const pre = src('../src/preload/index.ts')
    const fn = pre.slice(pre.indexOf('writeEnvValue: ('), pre.indexOf("invoke('compose:write-env-value'"))
    expect(fn).toContain('vaultEntryId')
    expect(fn).not.toMatch(/\bvalue\s*:\s*string/)
  })

  // The renderer sends an id; main is where the secret exists.
  it('resolves the vault in main, in the handler', () => {
    const main = src('../src/main/index.ts')
    const handler = main.slice(
      main.indexOf("ipcMain.handle(\n  'compose:write-env-value'"),
      main.indexOf('// ---- What is scheduled across the estate ----')
    )
    expect(handler).toContain('resolveVaultField(ref)')
    expect(handler).toContain('registerEnvSecret(')
  })

  // Registering after a successful write would leave a window in which the
  // secret is on the host and unredacted in its output.
  it('registers the value for redaction before the write, not after', () => {
    const main = src('../src/main/index.ts')
    const handler = main.slice(
      main.indexOf("ipcMain.handle(\n  'compose:write-env-value'"),
      main.indexOf('// ---- What is scheduled across the estate ----')
    )
    expect(handler.indexOf('registerEnvSecret(')).toBeLessThan(
      handler.indexOf('composeReader.writeEnvValue(')
    )
  })

  // The reader is handed a resolved value, exactly as `dbSampler` is handed
  // resolved configs: the vault-shaped decisions stay in one place.
  it('does not let the compose reader reach the vault', () => {
    const svc = src('../src/main/services/compose.ts')
    expect(svc).not.toMatch(/vaultEntry|resolveVaultField|vaultList/)
  })

  // A value written onto a host must be scrubbed from that host's own output,
  // and the entry it came from is usually not the SSH credential.
  it('adds the written value to what is redacted for that server', () => {
    const cr = src('../src/main/services/credentialResolver.ts')
    expect(cr).toContain('envSecretValuesForServer(serverId)')
    const reg = src('../src/main/services/envSecretRegistry.ts')
    // A reference, never a value: a plaintext copy on disk to improve an
    // output filter would be the vault leaking to make redaction nicer.
    expect(reg).toContain('WHAT IS STORED IS A REFERENCE, NEVER A VALUE')
    expect(reg).not.toMatch(/\bvalue\s*:\s*string/)
  })
})
