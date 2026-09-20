import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * `attach()` must hand the sidecar every field `load` refuses to run without.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 *
 * `resume()` is the only thing that reattaches a machine at launch, and it
 * reattaches through `attach()`. `attach()` sends four fields; the sidecar's
 * `handleLoad` requires five. The missing one is `rootSignPub`, and the
 * sidecar's answer is `config-invalid: rootSignPub is 32 bytes of hex`.
 *
 * Measured against a real relay and a real addyd, the consequence is total:
 * create an account, quit, reopen, and the machine comes back with
 * `enrolled: true`, `sync.running: false` and that sentence as its problem.
 * It cannot sync, and it cannot pair a second device either, because
 * `beginPairing` needs a loaded account and answers `no account is loaded`.
 * One restart is all it takes, and nothing in the app recovers from it.
 *
 * None of the ~230 existing addy tests catch it: every one of them replaces
 * `openAddyd` with a stub that accepts any parameters at all. A stub cannot
 * refuse a field it was never told about, so the one check that mattered —
 * does the payload satisfy the process that receives it — was the one nothing
 * made. This test makes it from BOTH sides: the Go source says what is
 * required, and the live call says what is sent.
 */

const ROOT = resolve(__dirname, '..')
const CRYPTO_GO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')

/**
 * The fields `handleLoad` rejects the call over, read out of the Go rather
 * than listed here.
 *
 * A list in this file would be a second copy of the sidecar's contract, free
 * to go stale the moment somebody adds a field to `handleLoad` — which is the
 * same drift this test exists to catch, one level up. So the body of
 * `handleLoad` is sliced out and every `codedf(ErrConfigInvalid, "<name> is …")`
 * in it names a required field.
 */
function requiredByHandleLoad(): string[] {
  const start = CRYPTO_GO.indexOf('func handleLoad(')
  expect(start, 'handleLoad has been renamed; this test needs updating').toBeGreaterThan(-1)
  const body = CRYPTO_GO.slice(start, CRYPTO_GO.indexOf('\nfunc ', start + 1))
  const names = new Set<string>()
  for (const m of body.matchAll(/coded[f]?\(\s*Err(?:ConfigInvalid|NotPaired),\s*"(\w+) is\b/g)) {
    names.add(m[1])
  }
  return [...names]
}

describe('the sidecar contract attach() has to satisfy', () => {
  it('names the fields load refuses without, from the Go itself', () => {
    const required = requiredByHandleLoad()
    // Enough of them to prove the extraction works at all: a regex that
    // matched nothing would make every assertion below vacuously true.
    expect(required).toContain('accountId')
    expect(required).toContain('deviceSignSeed')
    expect(required).toContain('deviceEncKey')
    expect(required).toContain('rootSignPub')
  })

  /**
   * The check has to be able to pass, and to fail, on the right input.
   *
   * `attach()` is a file another change owns, so this proves the assertion
   * discriminates without editing it: the same loop run over a payload that
   * carries all five fields is silent, and over one missing `rootSignPub`
   * raises — which is the mutation this test exists to catch.
   */
  it('the check passes on a complete payload and fails on the real one', () => {
    const required = requiredByHandleLoad()
    const check = (params: Record<string, unknown>): void => {
      for (const f of required) expect(params[f]).toBeTruthy()
    }
    const complete = {
      accountId: 'a'.repeat(32),
      deviceSignSeed: 'c2VlZA==',
      deviceEncKey: 'ZW5j',
      epochKeys: { 1: 'YWs=' },
      rootSignPub: 'b'.repeat(64)
    }
    expect(() => check(complete)).not.toThrow()
    const { rootSignPub: _dropped, ...asAttachSendsIt } = complete
    expect(() => check(asAttachSendsIt)).toThrow()
  })

  it('attach() sends every one of them', async () => {
    const sent: Record<string, unknown>[] = []
    vi.resetModules()
    vi.doMock('../src/main/services/addy/sidecar', async (orig) => {
      const real = await orig<typeof import('../src/main/services/addy/sidecar')>()
      return {
        ...real,
        openAddyd: async () => ({
          alive: () => true,
          close: async () => {},
          send: async (method: string, params?: unknown) => {
            sent.push({ method, params })
            return {}
          }
        })
      }
    })
    const { addySession } = await import('../src/main/services/addy/session')

    await addySession.attach(
      {
        baseURL: 'https://relay.example',
        token: '',
        accountId: 'a'.repeat(32),
        epoch: 1,
        // Carried on the account precisely so it can be handed over here —
        // `AddyAccount` declares it and `resume()` reads it off the enrolment.
        rootSignPub: 'b'.repeat(64),
        epoch1SignPub: 'c'.repeat(64)
      },
      { deviceSignSeed: 'c2VlZA==', deviceEncKey: 'ZW5j', epochKeys: { 1: 'YWs=' } }
    )

    const load = sent.find((f) => f.method === 'load')
    expect(load, 'attach() did not send `load` at all').toBeTruthy()
    const params = (load!.params ?? {}) as Record<string, unknown>

    for (const field of requiredByHandleLoad()) {
      expect(
        params[field],
        `attach() omits \`${field}\`, which the sidecar refuses to load without — ` +
          'so every resume() at launch fails and the device never reattaches'
      ).toBeTruthy()
    }

    await addySession.detach()
  })
})
