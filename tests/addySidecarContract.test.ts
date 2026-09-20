import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8')

/**
 * What the parent sends the sidecar must be what the sidecar requires.
 *
 * THE MOST EXPENSIVE BUG IN THIS FEATURE WAS ONE MISSING FIELD. `attach()`
 * sent four of `loadRequest`'s five, and the sidecar refuses a load without
 * `rootSignPub` because a device cannot verify a root-signed roster entry
 * without it. So `attach` threw on every path after the first: create an
 * account, quit, reopen, and the device could not sync and could not pair —
 * "no account is loaded" — while the panel still said it was enrolled.
 *
 * It survived roughly two hundred and thirty tests because every one of them
 * stubs `openAddyd`, and A STUB CANNOT REFUSE A FIELD IT WAS NEVER TOLD ABOUT.
 * The only way to catch this without a real sidecar in every test is to read
 * both sides and compare them, which is what this does.
 */
describe('the load request matches what the sidecar requires', () => {
  const go = read('sidecar', 'addyd', 'crypto.go')
  const ts = read('src', 'main', 'services', 'addy', 'session.ts')

  it('sends every json field of loadRequest', () => {
    const struct = go.slice(go.indexOf('type loadRequest struct'))
    const body = struct.slice(0, struct.indexOf('\n}'))
    expect(body.length, 'the parser is wrong, not the code: loadRequest not found').toBeGreaterThan(80)

    const required = [...body.matchAll(/json:"(\w+)"/g)].map((m) => m[1])
    expect(
      required.length,
      `the parser is wrong, not the code: found ${required.length} fields on loadRequest`
    ).toBeGreaterThanOrEqual(5)

    // The object literal the parent actually sends.
    const call = ts.slice(ts.indexOf("addyd.send('load'"))
    const sent = call.slice(0, call.indexOf('})'))
    expect(sent.length, 'the parser is wrong, not the code: no load call found').toBeGreaterThan(40)

    for (const field of required) {
      expect(
        sent,
        `the sidecar's loadRequest has "${field}" and the parent never sends it. ` +
          `handleLoad refuses the whole load, so attach() throws — which means resume() at ` +
          `launch fails, the engine never starts, and beginPairing answers "no account is ` +
          `loaded" on a device the panel still calls enrolled.`
      ).toContain(field)
    }
  })

  it('refuses before the round trip when the key it needs is missing', () => {
    const fn = ts.slice(ts.indexOf('async attach('))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    // A device whose record predates the field, or whose provisional record
    // was written without it, gets a sentence naming the remedy rather than
    // the sidecar's "rootSignPub is 32 bytes of hex".
    expect(body, 'no guard: the failure surfaces as a sidecar type error').toMatch(
      /rootSignPub === undefined|rootSignPub === ''/
    )
    expect(body, 'the guard does not say what to do about it').toMatch(/twelve-word|pair it again/)
  })
})
