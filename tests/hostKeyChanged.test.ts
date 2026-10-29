import { describe, it, expect, beforeEach, vi } from 'vitest'
import { app, clipboard } from 'electron'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A changed host key stops the connection, and then offers the way forward.
 *
 * The dialog used to refuse and point at Settings → Security, leaving a person
 * who had just rebuilt a server hunting for the one control that fixes it.
 */

const answers: number[] = []
const shown: { buttons?: string[]; detail?: string }[] = []
vi.mock('../src/main/services/promptWindow', () => ({
  askInWindow: async (o: { buttons?: string[]; detail?: string }) => {
    shown.push(o)
    return { response: answers.shift() ?? 0, checkboxChecked: false }
  }
}))

const { verifyHostKey, fingerprint } = await import('../src/main/services/knownhosts')

const userData = app.getPath('userData')
const FILE = join(userData, 'opsmaxx-known-hosts.json')
const oldKey = Buffer.from('old-host-key')
const newKey = Buffer.from('new-host-key')

beforeEach(() => {
  rmSync(join(userData, 'opsmaxx-sync-trust.json'), { force: true })
  writeFileSync(FILE, JSON.stringify({ 'h.example:22': { id: 'h.example:22', fingerprint: fingerprint(oldKey), addedAt: '' } }))
  answers.length = 0
  shown.length = 0
})

describe('a host presenting a different key', () => {
  it('refuses by default, and Cancel is the default button', async () => {
    expect(await verifyHostKey('h.example', 22, newKey, true)).toBe(false)
    expect(shown[0]!.buttons).toEqual(['Cancel', 'Copy fingerprints', 'Replace the trusted key…'])
  })

  it('replaces the key after a second, explicit yes, and connects', async () => {
    answers.push(2, 1)
    expect(await verifyHostKey('h.example', 22, newKey, true)).toBe(true)
    expect(shown[1]!.buttons).toEqual(['Cancel', 'Replace and connect'])
    // Remembered: the next connection is not asked again.
    expect(await verifyHostKey('h.example', 22, newKey, true)).toBe(true)
    expect(shown).toHaveLength(2)
  })

  it('backs out at the second question', async () => {
    answers.push(2, 0)
    expect(await verifyHostKey('h.example', 22, newKey, true)).toBe(false)
    expect(await verifyHostKey('h.example', 22, oldKey, true)).toBe(true)
  })

  it('copies both fingerprints and asks again', async () => {
    answers.push(1, 0)
    expect(await verifyHostKey('h.example', 22, newKey, true)).toBe(false)
    expect(clipboard.readText()).toContain(fingerprint(oldKey))
    expect(clipboard.readText()).toContain(fingerprint(newKey))
    expect(shown).toHaveLength(2)
  })

  it('offers no replace button to a background check, and says what to do instead', async () => {
    answers.push(2)
    expect(await verifyHostKey('h.example', 22, newKey, false)).toBe(false)
    expect(shown[0]!.buttons).toEqual(['OK', 'Copy fingerprints'])
    expect(shown[0]!.detail).toContain('open it from the sidebar')
  })

  it('shows one dialog for every connection that meets the same changed key', async () => {
    const all = await Promise.all([1, 2, 3].map(() => verifyHostKey('h.example', 22, newKey, true)))
    expect(all).toEqual([false, false, false])
    expect(shown).toHaveLength(1)
  })
})
