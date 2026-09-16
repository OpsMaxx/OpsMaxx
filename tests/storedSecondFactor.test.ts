import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A remembered second factor, which the app could store and never show.
 *
 * The prompter short-circuits on a saved `kbAnswer`: it returns the stored
 * string and NO dialog is raised at all. That is right for a static secret and
 * wrong for a one-time code, and when it is wrong the failure is invisible —
 * the server stops asking and starts refusing, with nothing on any screen
 * saying an answer is being replayed on the user's behalf, and no way to undo
 * it short of deleting the credential.
 *
 * Two halves: the shape has to REPORT one, and something has to be able to
 * drop it. The third half — not storing a rotating code in the first place —
 * is in tests/sshPromptQueue.test.tsx, where the switch lives.
 */

const secrets = new Map<string, string>()

vi.mock('../src/main/services/secrets', () => ({
  getSecret: (id: string) => secrets.get(id) ?? null,
  setSecret: (id: string, v: string) => {
    secrets.set(id, v)
    return true
  }
}))

vi.mock('../src/main/services/vault', () => ({
  vaultStatus: () => ({ exists: false, unlocked: false, stage: 'locked', entryCount: 0 }),
  vaultEntriesForResolve: () => null
}))

const { credentialShapeForServer, forgetKbAnswer } = await import(
  '../src/main/services/credentialResolver'
)

beforeEach(() => secrets.clear())

describe('reporting one', () => {
  it('says so beside a key', () => {
    secrets.set('srv-1', JSON.stringify({ keyPath: '/home/a/.ssh/id_ed25519', kbAnswer: '123456' }))
    expect(credentialShapeForServer('srv-1')).toMatchObject({ kind: 'key', savedAnswer: true })
  })

  it('says so beside a password', () => {
    secrets.set('srv-1', JSON.stringify({ password: 'hunter2', kbAnswer: '123456' }))
    expect(credentialShapeForServer('srv-1')).toMatchObject({ kind: 'password', savedAnswer: true })
  })

  /**
   * The case that was completely invisible. A blob holding only a remembered
   * answer reports `kind: 'none'` — no credential at all — and yet something IS
   * being sent on every connect. Reporting the shape without this field made
   * that server look like one nothing had ever been configured for.
   */
  it('says so when there is no credential at all', () => {
    secrets.set('srv-1', JSON.stringify({ kbAnswer: '123456' }))
    expect(credentialShapeForServer('srv-1')).toMatchObject({ kind: 'none', savedAnswer: true })
  })

  it('says so beside an agent socket', () => {
    secrets.set('srv-1', JSON.stringify({ agentSocket: '/tmp/agent', kbAnswer: '123456' }))
    expect(credentialShapeForServer('srv-1')).toMatchObject({ kind: 'agent', savedAnswer: true })
  })

  it('does not claim one that is not there', () => {
    secrets.set('srv-1', JSON.stringify({ password: 'hunter2' }))
    expect(credentialShapeForServer('srv-1').savedAnswer).toBe(false)
  })

  // Nothing stored is nothing stored; this must not become a truthy report on
  // a server that has never been connected to.
  it('reports nothing for a server with no blob', () => {
    expect(credentialShapeForServer('srv-unknown')).toEqual({ kind: 'none' })
  })
})

describe('dropping one', () => {
  it('removes the answer and leaves the credential', () => {
    secrets.set('srv-1', JSON.stringify({ keyPath: '/home/a/.ssh/id_ed25519', kbAnswer: '123456' }))
    expect(forgetKbAnswer('srv-1')).toBe(true)

    const blob = JSON.parse(secrets.get('srv-1') as string)
    expect(blob.kbAnswer).toBeUndefined()
    // The point of a targeted delete: forgetting a wrong second factor must not
    // cost the user the key that was working.
    expect(blob.keyPath).toBe('/home/a/.ssh/id_ed25519')
    expect(credentialShapeForServer('srv-1')).toMatchObject({ kind: 'key', savedAnswer: false })
  })

  it('does nothing, and says so, when there is none', () => {
    secrets.set('srv-1', JSON.stringify({ password: 'hunter2' }))
    expect(forgetKbAnswer('srv-1')).toBe(false)
    expect(JSON.parse(secrets.get('srv-1') as string)).toEqual({ password: 'hunter2' })
  })

  it('does not invent a blob for a server that has none', () => {
    expect(forgetKbAnswer('srv-unknown')).toBe(false)
    expect(secrets.has('srv-unknown')).toBe(false)
  })

  // A corrupt blob is the same as no stored credential everywhere else here,
  // and rewriting one would be a way to lose whatever could still be read.
  it('leaves a blob it cannot parse exactly as it found it', () => {
    secrets.set('srv-1', 'not json')
    expect(forgetKbAnswer('srv-1')).toBe(false)
    expect(secrets.get('srv-1')).toBe('not json')
  })
})

describe('the way out is reachable', () => {
  const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

  it('is wired from main to the editor', () => {
    expect(read('src/main/index.ts')).toContain("ipcMain.handle('ssh:forget-kb-answer'")
    expect(read('src/preload/index.ts')).toContain("ipcRenderer.invoke('ssh:forget-kb-answer', serverId)")
  })

  // Beside the credential it sits next to, in the dialog the user already
  // opens to change one. A new screen for this would be a screen nobody finds.
  it('is offered in the connection editor when there is one', () => {
    const modal = read('src/renderer/src/components/connections/AddServerModal.tsx')
    expect(modal).toContain('stored?.savedAnswer')
    expect(modal).toContain('Forget saved answer')
  })

  // The value itself never crosses the bridge. Same rule as the rest of the
  // shape: a path is already on screen, a secret is not.
  it('reports a boolean and never the answer', () => {
    expect(read('src/shared/credentialShape.ts')).toContain('savedAnswer?: boolean')
  })
})
