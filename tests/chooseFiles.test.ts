import { describe, it, expect, vi, beforeAll } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { certificateBlocks, MAX_BODY_FILE_BYTES, MAX_SPEC_FILE_BYTES } from '../src/shared/httpClient'

vi.mock('../src/main/services/ssh', () => ({ acquire: vi.fn(), release: vi.fn() }))
const { chooseBodyFile, chooseCaFile, chooseSpecFile } = await import('../src/main/services/httpClient')

const dir = app.getPath('userData')
const pick = (path: string | null): void => {
  ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () =>
    path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] }
}

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqh\n-----END PRIVATE KEY-----'

beforeAll(() => {
  writeFileSync(join(dir, 'body.bin'), Buffer.from([1, 2, 3]))
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(Math.max(MAX_BODY_FILE_BYTES, MAX_SPEC_FILE_BYTES) + 1))
  writeFileSync(join(dir, 'api.yaml'), 'openapi: 3.0.0\n')
  writeFileSync(join(dir, 'ca.pem'), `subject=/CN=Company CA\n${CERT}\ntrailing notes\n${CERT}\n`)
  writeFileSync(join(dir, 'server.pem'), `${CERT}\n${KEY}\n`)
  writeFileSync(join(dir, 'rsa.pem'), `${CERT}\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n`)
})

describe('http:chooseBodyFile', () => {
  it('returns a basename and the bytes, never the path', async () => {
    pick(join(dir, 'body.bin'))
    const r = await chooseBodyFile(null)
    expect(r).toMatchObject({ name: 'body.bin' })
    expect(JSON.stringify(r)).not.toContain(dir)
    expect([...new Uint8Array((r as { bytes: ArrayBuffer }).bytes)]).toEqual([1, 2, 3])
  })

  it('refuses a file over the cap', async () => {
    pick(join(dir, 'big.bin'))
    expect(await chooseBodyFile(null)).toMatchObject({ error: expect.stringMatching(/larger than 32 MiB/) })
  })

  it('returns null when dismissed', async () => {
    pick(null)
    expect(await chooseBodyFile(null)).toBeNull()
  })
})

describe('http:chooseCaFile', () => {
  it('keeps certificate blocks only', async () => {
    pick(join(dir, 'ca.pem'))
    expect(await chooseCaFile(null)).toEqual({ pem: `${CERT}\n${CERT}\n` })
  })

  it.each(['server.pem', 'rsa.pem'])('refuses %s, which holds a private key', async (name) => {
    pick(join(dir, name))
    const r = await chooseCaFile(null)
    expect(r).toMatchObject({ error: expect.stringMatching(/private key/) })
    expect(JSON.stringify(r)).not.toContain('MIIEvQ')
  })

  it('refuses a file with no certificate, and the textarea path shares the filter', () => {
    expect(certificateBlocks('hello')).toMatchObject({ error: expect.any(String) })
    expect(certificateBlocks(`${KEY}`)).toMatchObject({ error: expect.stringMatching(/private key/) })
  })
})

describe('http:chooseSpecFile', () => {
  it('returns the basename and the text, never the path', async () => {
    pick(join(dir, 'api.yaml'))
    const r = await chooseSpecFile(null)
    expect(r).toEqual({ name: 'api.yaml', text: 'openapi: 3.0.0\n' })
    expect(JSON.stringify(r)).not.toContain(dir)
  })

  it('refuses a file over the cap, and returns null when dismissed', async () => {
    pick(join(dir, 'big.bin'))
    expect(await chooseSpecFile(null)).toMatchObject({ error: expect.stringMatching(/larger than 32 MiB/) })
    pick(null)
    expect(await chooseSpecFile(null)).toBeNull()
  })
})
