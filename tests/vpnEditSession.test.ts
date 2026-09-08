import { describe, it, expect, beforeEach, vi } from 'vitest'

// The main-process half of editing a stored `.ovpn`.
//
// The vault and the parser are the real ones' shapes but not the real ones:
// what is under test is the SESSION -- that the certificates and keys stay in
// this process between the two calls, that a lock forgets them, and that the
// old vault entry is handed back for deletion AFTER the save rather than
// deleted here.

const staged = vi.hoisted(() => ({ calls: [] as unknown[] }))
const vault = vi.hoisted(() => ({ body: '' , locked: false }))

vi.mock('../src/main/services/credentialResolver', () => ({
  isVaultLockedError: (e: unknown) => (e as { code?: string })?.code === 'vault-locked',
  resolveVpnSecrets: async () => {
    if (vault.locked) throw Object.assign(new Error('locked'), { code: 'vault-locked' })
    return { configBody: vault.body, all: [] }
  }
}))

vi.mock('../src/main/services/vpn/vaultBridge', () => ({
  stageImportedSecrets: async (...args: unknown[]) => {
    staged.calls.push(args)
    return {
      vaultEntryId: 'new-entry',
      refs: { configBody: { vaultEntryId: 'new-entry', field: 'configBody' } }
    }
  }
}))

const {
  forgetVpnEdits,
  vpnEditCancel,
  vpnEditCommit,
  vpnEditRead,
  vpnEditSessionCountForTests
} = await import('../src/main/services/vpn/edit')

const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIB\n-----END CERTIFICATE-----'

const BODY = [
  'client',
  'dev tun',
  'proto udp',
  'remote vpn.example.com 1194',
  '<ca>',
  CERT,
  '</ca>',
  '<cert>',
  CERT,
  '</cert>',
  '<key>',
  KEY,
  '</key>',
  ''
].join('\n')

/** A profile shape, loose on purpose: what is under test is the session, and a
 *  fully typed `VpnProfile` here would drag the whole spec union in for no
 *  assertion that depends on it. */
const profile = (over: Record<string, unknown> = {}): Parameters<typeof vpnEditRead>[0] =>
  ({
  id: 'p1',
  name: 'office',
  workspaceId: 'ws',
  spec: {
    kind: 'openvpn',
    configRef: { vaultEntryId: 'old-entry', field: 'configBody' },
    authMode: 'cert',
    redirectGateway: false,
    strippedDirectives: [],
    remotes: [{ host: 'vpn.example.com', port: 1194, proto: 'udp' }]
  },
    ...over
  }) as unknown as Parameters<typeof vpnEditRead>[0]

beforeEach(() => {
  staged.calls = []
  vault.body = BODY
  vault.locked = false
  forgetVpnEdits()
})

describe('what the renderer is handed', () => {
  it('carries no key material', async () => {
    const r = await vpnEditRead(profile())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).not.toContain('BEGIN PRIVATE KEY')
    expect(r.text).not.toContain('BEGIN CERTIFICATE')
    expect(r.text).toContain('remote vpn.example.com 1194')
  })

  it('names which blocks are being held, without their contents', async () => {
    const r = await vpnEditRead(profile())
    expect(r.ok && r.blocks).toEqual(['ca', 'cert', 'key'])
  })

  it('refuses a profile that is not OpenVPN', async () => {
    const r = await vpnEditRead(profile({ spec: { kind: 'wireguard' } }))
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toContain('Only an OpenVPN profile')
  })

  it('refuses an empty configuration rather than editing one into existence', async () => {
    vault.body = '   \n'
    expect((await vpnEditRead(profile())).ok).toBe(false)
  })

  it('says to unlock the vault rather than reporting a broken profile', async () => {
    vault.locked = true
    const r = await vpnEditRead(profile())
    expect(r.ok ? '' : r.errorCode).toBe('vault-locked')
  })
})

describe('the session holds what the renderer must not', () => {
  it('keeps the blocks in this process between the two calls', async () => {
    const r = await vpnEditRead(profile())
    expect(vpnEditSessionCountForTests()).toBe(1)
    if (!r.ok) return
    const c = await vpnEditCommit(r.editId, 'office', 'ws', r.text)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    // The body that was staged carries the key again.
    const secrets = (staged.calls[0] as unknown[])[3] as { configBody?: string }
    expect(secrets.configBody).toContain(KEY)
  })

  // Key material does not outlive the unlock that made it readable.
  it('forgets every edit when the vault locks', async () => {
    const r = await vpnEditRead(profile())
    forgetVpnEdits()
    expect(vpnEditSessionCountForTests()).toBe(0)
    if (!r.ok) return
    const c = await vpnEditCommit(r.editId, 'office', 'ws', r.text)
    expect(c.ok).toBe(false)
    expect(c.ok ? '' : c.error).toContain('no longer held')
  })

  it('does not make somebody wait for a timeout after they cancel', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    vpnEditCancel(r.editId)
    expect(vpnEditSessionCountForTests()).toBe(0)
  })

  // A sanitiser refusal is the normal case for a second attempt, and the edit
  // is still on screen.
  it('keeps the session when the commit was refused', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const bad = await vpnEditCommit(r.editId, 'office', 'ws', `${r.text}\nup /tmp/x.sh`)
    expect(bad.ok).toBe(false)
    expect(vpnEditSessionCountForTests()).toBe(1)
  })

  it('drops the session once the commit succeeded', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    await vpnEditCommit(r.editId, 'office', 'ws', r.text)
    expect(vpnEditSessionCountForTests()).toBe(0)
  })

  it('refuses an edit id it has never seen', async () => {
    const c = await vpnEditCommit('nope', 'office', 'ws', 'client\n')
    expect(c.ok).toBe(false)
    expect(c.ok ? '' : c.error).toContain('edit it again')
  })
})

describe('committing', () => {
  it('stages a NEW entry and names the old one for the caller to delete', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const c = await vpnEditCommit(r.editId, 'office', 'ws', r.text)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.vaultEntryId).toBe('new-entry')
    // Handed back, NOT deleted here. Save-then-delete leaves a recoverable
    // orphan; delete-then-save leaves a profile pointing at nothing.
    expect(c.replacedVaultEntryId).toBe('old-entry')
  })

  it('points the new spec at the new entry', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const c = await vpnEditCommit(r.editId, 'office', 'ws', r.text)
    expect(c.ok && (c.spec as { configRef: { vaultEntryId: string } }).configRef.vaultEntryId).toBe(
      'new-entry'
    )
  })

  it('carries an edited directive into the stored body', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const edited = r.text.replace('remote vpn.example.com 1194', 'remote vpn2.example.com 443')
    const c = await vpnEditCommit(r.editId, 'office', 'ws', edited)
    expect(c.ok).toBe(true)
    const secrets = (staged.calls[0] as unknown[])[3] as { configBody?: string }
    expect(secrets.configBody).toContain('remote vpn2.example.com 443')
  })

  // An edit is exactly as trustworthy as an import and goes through the same
  // door. This file adds no rules of its own.
  it('lets the sanitiser refuse a directive the edit introduced', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const c = await vpnEditCommit(r.editId, 'office', 'ws', `${r.text}\nup /tmp/evil.sh`)
    expect(c.ok).toBe(false)
    expect(staged.calls).toHaveLength(0)
  })

  it('refuses a key pasted back in, and stages nothing', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const c = await vpnEditCommit(r.editId, 'office', 'ws', `${r.text}\n<key>\n${KEY}\n</key>`)
    expect(c.ok).toBe(false)
    if (c.ok) return
    expect(c.error).toContain('is an import, not an edit')
    expect(staged.calls).toHaveLength(0)
  })

  it('reports what changed against what the operator was shown', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const edited = r.text.replace('proto udp', 'proto tcp')
    const c = await vpnEditCommit(r.editId, 'office', 'ws', edited)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.change.added).toContain('proto tcp')
    expect(c.change.removed).toContain('proto udp')
  })

  it('reports a block the operator removed', async () => {
    const r = await vpnEditRead(profile())
    if (!r.ok) return
    const edited = r.text
      .split('\n')
      .filter((l) => !l.includes('<ca>'))
      .join('\n')
    const c = await vpnEditCommit(r.editId, 'office', 'ws', edited)
    if (!c.ok) return
    expect(c.change.blocksRemoved).toContain('ca')
  })
})
