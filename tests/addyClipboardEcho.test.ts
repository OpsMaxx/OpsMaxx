import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The bounce, and only the bounce.
 *
 * `isOwnEcho` was exported, armed on every receive and called from nowhere,
 * with a comment explaining why that was fine. It is the shape of every dead
 * feature found in this module, so it now has a caller — and a caller needs a
 * test that can tell the two cases apart, because suppressing too much is
 * worse than suppressing nothing: the same text copied again later is a real
 * event and losing it would look like the clipboard silently failing.
 */

const clip = { text: '', read: (): string => clip.text, write: (t: string): void => { clip.text = t } }
vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'addy-clip-')) },
  clipboard: { readText: () => clip.read(), writeText: (t: string) => clip.write(t) }
}))

const { sendClipboard, applySealedClipboard, MAX_CLIPBOARD_BYTES } = await import(
  '../src/main/services/addy/clipboard'
)
// The real identity hash, so the suppressor sees exactly what it would in the
// app — a test that invented its own hash would agree with itself and with
// nothing else.
const { identifyText } = await import('../src/shared/clipboardIdentity')

/** A sidecar that frames rather than encrypts — see addySync.test.ts. */
const addyd = {
  alive: () => true,
  send: async (method: string, params?: unknown) => {
    const p = params as Record<string, unknown>
    if (method === 'whoami') return { devicePub: 'aa'.repeat(32) }
    if (method === 'seal') return { sealed: p.payload }
    if (method === 'open') return { payload: p.sealed }
    throw new Error(`unexpected ${method}`)
  }
}

const posted: unknown[] = []
const relay = {
  request: async (_m: string, path: string, body?: unknown) => {
    if (path === '/v1/mail') posted.push(body)
    return { ok: true, json: async () => ({ messages: [] }) }
  }
}

const deps = {
  addyd: addyd as never,
  relay: relay as never,
  epoch: () => 1,
  peers: () => ['bb'.repeat(32)]
}

/** What `applySealedClipboard` takes: the payload this fake seal produces. */
const sealedOf = (text: string): string =>
  Buffer.from(
    JSON.stringify({
      kind: 'text',
      text,
      identity: { hash: hashOf(text), size: Buffer.byteLength(text) },
      sentAt: Date.now()
    }),
    'utf8'
  ).toString('base64')

function hashOf(text: string): string {
  return identifyText(text).hash
}

beforeEach(() => {
  posted.length = 0
  clip.text = ''
})

describe('sending back what was just received', () => {
  it('is refused, and says why', async () => {
    await applySealedClipboard(deps, sealedOf('ssh -J bastion web-01'))
    const r = await sendClipboard(deps)
    expect(r.sent).toBe(0)
    expect(r.skipped).toMatch(/just received/)
    expect(posted).toHaveLength(0)
  })

  it('does not suppress the next thing the user actually copies', async () => {
    // The failure that would be worse than no suppression at all: a clipboard
    // that quietly stops sending.
    await applySealedClipboard(deps, sealedOf('the received thing'))
    clip.write('something the user copied')
    const r = await sendClipboard(deps)
    expect(r.sent).toBe(1)
  })

  it('sends the same text again once the arming is spent', async () => {
    // The suppressor consumes its arming, and a re-copy later is a real event.
    await applySealedClipboard(deps, sealedOf('same text'))
    await sendClipboard(deps) // consumes it
    const again = await sendClipboard(deps)
    expect(again.sent).toBe(1)
  })

  it('still refuses an empty clipboard for its own reason', async () => {
    clip.write('')
    const r = await sendClipboard(deps)
    expect(r.skipped).toMatch(/no text/i)
  })

  it('still refuses something too large', async () => {
    clip.write('x'.repeat(MAX_CLIPBOARD_BYTES + 1))
    const r = await sendClipboard(deps)
    expect(r.skipped).toMatch(/limit/)
  })
})
