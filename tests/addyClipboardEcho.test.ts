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

const { sendClipboard, receiveClipboard, applySealedClipboard, MAX_CLIPBOARD_BYTES } =
  await import('../src/main/services/addy/clipboard')
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
const sealedOf = (text: string, sentAt = Date.now()): string =>
  Buffer.from(
    JSON.stringify({
      kind: 'text',
      text,
      identity: { hash: hashOf(text), size: Buffer.byteLength(text) },
      sentAt
    }),
    'utf8'
  ).toString('base64')

/** The deps, with a mailbox the relay is serving. */
function depsWithMail(messages: { id: number; sealed: string }[]): typeof deps {
  return {
    ...deps,
    relay: {
      request: async (_m: string, path: string) => {
        if (path === '/v1/mail') {
          return {
            ok: true,
            json: async () => ({
              messages: messages.map((m) => ({
                ...m,
                fromDevice: 'bb'.repeat(32),
                kind: 'clipboard'
              }))
            })
          }
        }
        return { ok: true, json: async () => ({}) }
      }
    } as never
  }
}

function hashOf(text: string): string {
  return identifyText(text).hash
}

beforeEach(() => {
  posted.length = 0
  clip.text = ''
})

describe('a clipboard the relay held on to', () => {
  it('is not pasted when it is stale', async () => {
    // "Newest" was the last element of the array THE RELAY returned, in the
    // relay's order, with the rollback check disabled and `sentAt` written
    // into every payload and read by nothing. So a relay could keep any
    // clipboard row it had ever carried and serve it as current: the user
    // presses receive expecting the URL they just copied and pastes last
    // week's password into whatever has focus.
    const old = sealedOf('last week: hunter2', Date.now() - 8 * 24 * 60 * 60_000)
    const r = await receiveClipboard(depsWithMail([{ id: 1, sealed: old }]))

    expect(r.applied).toBe(false)
    expect(r.reason).toMatch(/minutes old/)
    expect(clip.read()).toBe('')
  })

  it('takes the newest by its OWN timestamp, not the relay ordering', async () => {
    // `sentAt` is inside the seal, so it is the sender's claim. The order of
    // the array is the relay's to pick.
    const recent = sealedOf('the one I just copied', Date.now() - 1000)
    const older = sealedOf('an older one', Date.now() - 5 * 60_000)
    // Served newest-first, which is the wrong way round for "take the last".
    const r = await receiveClipboard(
      depsWithMail([
        { id: 1, sealed: recent },
        { id: 2, sealed: older }
      ])
    )

    expect(r.applied).toBe(true)
    expect(clip.read()).toBe('the one I just copied')
  })

  it('applies a fresh one', async () => {
    const r = await receiveClipboard(
      depsWithMail([{ id: 1, sealed: sealedOf('fresh', Date.now()) }])
    )
    expect(r.applied).toBe(true)
    expect(clip.read()).toBe('fresh')
  })
})

describe('an echo flag armed by somebody else', () => {
  it('cannot suppress a send the user did not receive', async () => {
    // The flag was armed straight from `payload.identity.hash`, which the
    // SENDER chooses. So a peer could arm this device's suppressor with the
    // hash of something the user was about to copy, and their next send would
    // be refused with "that is what this device just received" — a one-shot
    // denial with a misleading reason.
    const lying = Buffer.from(
      JSON.stringify({
        kind: 'text',
        text: 'what was actually sent',
        // The hash of something else entirely.
        identity: { hash: hashOf('what the user is about to copy'), size: 22 },
        sentAt: Date.now()
      }),
      'utf8'
    ).toString('base64')

    await applySealedClipboard(deps, lying)

    // The user copies the thing the sender tried to pre-suppress.
    clip.write('what the user is about to copy')
    const r = await sendClipboard(deps)

    expect(r.sent, 'a peer suppressed a send it had no part in').toBe(1)
  })
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
