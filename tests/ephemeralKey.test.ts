import { describe, expect, it } from 'vitest'
import { utils } from 'ssh2'
import { generateEphemeralKey } from '../src/main/services/cloud/providers/shared'

// ssh2's own ed25519 generator emits a key its parser rejects about 1 time in
// 256 (a public key starting with 0x00 loses that byte). 2000 draws without
// the retry fail with probability 1 - (255/256)^2000, about 99.96%.
describe('generateEphemeralKey', () => {
  it('only hands out keys ssh2 can read', () => {
    for (let i = 0; i < 2000; i++) {
      const { privateKey, publicKey } = generateEphemeralKey()
      expect(utils.parseKey(privateKey)).not.toBeInstanceOf(Error)
      expect(publicKey).toMatch(/^ssh-ed25519 /)
    }
  })
})
