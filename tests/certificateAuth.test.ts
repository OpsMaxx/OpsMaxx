import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshHop } from '../src/shared/ssh'

// Certificate authentication for a server the user saved themselves, rather
// than one a cloud provider mints a certificate for. The certificate is read
// from disk at dial time, and by default from where OpenSSH puts it.

const { readCertificateFile } = await import('../src/main/services/ssh')
const { resolveSecrets } = await import('../src/main/services/credentialResolver')
const { refreshMcpDataCache } = await import('../src/main/services/mcpDataCache')

let dir: string
const hop = (extra: Partial<SshHop>): SshHop => ({
  host: 'h',
  port: 22,
  username: 'u',
  auth: 'certificate',
  ...extra
})

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'opsmaxx-cert-'))
  writeFileSync(join(dir, 'id_ed25519-cert.pub'), 'CONVENTION')
  writeFileSync(join(dir, 'custom.pub'), 'NAMED')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('which certificate file is presented', () => {
  it('uses <key>-cert.pub when none is named, as ssh does', () => {
    expect(readCertificateFile(hop({ keyPath: join(dir, 'id_ed25519') }))).toBe('CONVENTION')
  })

  it('prefers a certificate the user named', () => {
    expect(
      readCertificateFile(hop({ keyPath: join(dir, 'id_ed25519'), certificatePath: join(dir, 'custom.pub') }))
    ).toBe('NAMED')
  })

  it('says where it looked when the conventional file is not there', () => {
    expect(() => readCertificateFile(hop({ keyPath: join(dir, 'other') }))).toThrow(/next to the key/)
  })

  // A key from the vault is material with no file beside it, so the default
  // identity must not be guessed at in its place.
  it('asks for the file when the key came from the vault and none is named', () => {
    expect(() => readCertificateFile(hop({ privateKey: 'PEM' }))).toThrow(/No certificate file is configured/)
  })
})

describe('the saved record decides the method', () => {
  // A dozen renderer paths fold every method but password and agent into
  // 'key'. Presenting the bare key to a server that only trusts the CA fails
  // as a rejected credential, so main promotes it from the saved record.
  it('promotes a folded call to certificate for a certificate server', () => {
    refreshMcpDataCache({
      workspaces: [{ id: 'ws', name: 'W' }],
      servers: [{ id: 'sc', workspaceId: 'ws', name: 'C', host: 'h', port: 22, username: 'u', auth: 'certificate', os: 'Linux', route: [] }]
    })
    expect(resolveSecrets({ ...hop({ auth: 'key' }), serverId: 'sc' }).auth).toBe('certificate')
  })

  it('leaves every other server alone', () => {
    refreshMcpDataCache({
      workspaces: [{ id: 'ws', name: 'W' }],
      servers: [{ id: 'sk', workspaceId: 'ws', name: 'K', host: 'h', port: 22, username: 'u', auth: 'key', os: 'Linux', route: [] }]
    })
    expect(resolveSecrets({ ...hop({ auth: 'key' }), serverId: 'sk' }).auth).toBe('key')
  })
})
