import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A clipboard the relay hands back after a restart.
 *
 * The sidecar refuses a mail it has already opened, but only from memory, so
 * after OpsMaxx restarts the relay could deliver a clipboard still inside its
 * window a second time, pasted into whatever terminal has focus. This device
 * now remembers what it applied, on disk, until each window closes.
 */
const userData = mkdtempSync(join(tmpdir(), 'addy-clip-replay-'))
const clip = { text: '' }
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  clipboard: { readText: () => clip.text, writeText: (t: string) => void (clip.text = t) }
}))

const { applySealedClipboard } = await import('../src/main/services/addy/clipboard')
const { identifyText } = await import('../src/shared/clipboardIdentity')

const BB = 'bb'.repeat(32)
// A sidecar with NO memory of what it opened, as after a restart.
const deps = {
  addyd: {
    alive: () => true,
    send: async (method: string, params?: unknown) => {
      const p = params as Record<string, unknown>
      if (method !== 'openMail') throw new Error(`unexpected ${method}`)
      const frame = JSON.parse(Buffer.from(p.sealed as string, 'base64').toString('utf8'))
      return { from: BB, sentAt: frame.sentAt, payload: p.sealed }
    }
  } as never,
  relay: {} as never,
  peers: () => [BB],
  peerEnc: () => 'ee'.repeat(32)
}

const sealed = (text: string, sentAt: number): string =>
  Buffer.from(
    JSON.stringify({ kind: 'text', text, identity: { hash: identifyText(text).hash, size: text.length }, sentAt }),
    'utf8'
  ).toString('base64')

describe('a clipboard delivered twice', () => {
  it('is applied once, even when the sidecar has forgotten it', async () => {
    const mail = sealed('rm -rf /tmp/x', Date.now())
    await applySealedClipboard(deps, mail)
    expect(clip.text).toBe('rm -rf /tmp/x')
    clip.text = ''
    await expect(applySealedClipboard(deps, mail)).rejects.toThrow(/already delivered once/)
    expect(clip.text).toBe('')
  })

  it('still applies a different clipboard from the same device', async () => {
    await applySealedClipboard(deps, sealed('ls', Date.now() + 1))
    expect(clip.text).toBe('ls')
  })
})
