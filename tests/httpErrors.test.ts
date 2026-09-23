import { describe, it, expect, vi } from 'vitest'

// maskUrl is stream A's; this file checks that every URL in a message is
// routed through it. Its own rules are tested in apiUrl.test.ts.
vi.mock('../src/shared/apiUrl', () => ({
  maskUrl: (url: string) => url.replace(/\/\/[^@/]*@/, '//•••@').replace(/(token=)[^&\s]*/, '$1•••')
}))

import { classifyTransportError, presentError } from '../src/shared/httpErrors'
import { VAULT_ENTRY_GONE_MESSAGE, VAULT_LOCKED_MESSAGE } from '../src/shared/apiSecrets'

describe('classifyTransportError', () => {
  it.each([
    ['getaddrinfo ENOTFOUND api.example.test', 'ENOTFOUND', 'dns', 'Host not found', 'route-menu'],
    ['getaddrinfo EAI_AGAIN api.example.test', 'EAI_AGAIN', 'dns', 'Host not found', 'route-menu'],
    ['connect ECONNREFUSED 127.0.0.1:9', 'ECONNREFUSED', 'refused', 'Connection refused', 'route-menu'],
    ['Timed out after 30000ms', 'ETIMEDOUT', 'timeout', 'Timed out after 30 s', 'raise-timeout'],
    ['write EPROTO 00:error:SSL routines:wrong version number', 'EPROTO', 'tls-not-tls', 'This port does not speak TLS', 'retry-http'],
    // Electron's BoringSSL, as the built app reports it (QA 10).
    ['write EPROTO 1219771041824:error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER:../../third_party/boringssl/src/ssl/tls_record.cc:127:', undefined, 'tls-not-tls', 'This port does not speak TLS', 'retry-http'],
    ['SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER', 'ERR_SSL_WRONG_VERSION_NUMBER', 'tls-not-tls', 'This port does not speak TLS', 'retry-http'],
    ['self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'tls', 'Certificate not trusted', 'add-ca'],
    ['self-signed certificate in chain', 'SELF_SIGNED_CERT_IN_CHAIN', 'tls', 'Certificate not trusted', 'add-ca'],
    ['unable to verify', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls', 'Certificate not trusted', 'add-ca'],
    ['certificate has expired', 'CERT_HAS_EXPIRED', 'tls', 'Certificate not trusted', 'add-ca'],
    ['tls alert', 'ERR_TLS_CERT_ALTNAME_INVALID', 'tls', 'Certificate not trusted', 'add-ca'],
    ['socket hang up', 'ECONNRESET', 'reset', 'Connection reset', undefined],
    ['The request was cancelled', 'ABORTED', 'aborted', 'Cancelled', undefined],
    [VAULT_LOCKED_MESSAGE, undefined, 'vault-locked', VAULT_LOCKED_MESSAGE, 'unlock'],
    [VAULT_ENTRY_GONE_MESSAGE, undefined, 'vault-entry-gone', VAULT_ENTRY_GONE_MESSAGE, 'choose-vault'],
    ['That is 16 open sockets, which is as many as OpsMaxx will hold. Close one first.', undefined, 'socket-cap', '16 WebSockets are open, the most OpsMaxx allows', 'disconnect-idle'],
    ['Something odd', undefined, 'other', 'Something odd', undefined]
  ] as const)('%s → %s', (message, code, cls, text, action) => {
    const got = classifyTransportError(message, code)
    expect(got.class).toBe(cls)
    expect(got.message).toBe(text)
    expect(got.fix?.action).toBe(action)
  })

  it('never offers to turn verification off for a TLS failure', () => {
    for (const scratch of [true, false]) {
      const got = presentError('tls', 'self-signed certificate', { scratch })
      expect(got.fix?.label).not.toMatch(/verif|insecure|skip/i)
    }
  })

  it('offers a save first to a scratch tab with a certificate problem', () => {
    expect(presentError('tls', 'x', { scratch: true }).fix).toEqual({
      label: 'Save to a collection to add a CA…',
      action: 'save-then-ca'
    })
  })

  it('names the build-time classes', () => {
    expect(presentError('route-missing', '').message).toBe('That server was removed — requests will not be sent')
    expect(presentError('route-missing', '').fix?.action).toBe('route-menu')
    expect(presentError('unresolved-variable', '`token` is not defined in staging').fix?.action).toBe('add-variable')
    expect(presentError('bridge-stale', '').fix?.action).toBe('restart')
    expect(presentError('prod-declined', 'declined').message).toBe('')
    expect(presentError('timeout', 'x', { timeoutMs: 1500 }).message).toBe('Timed out after 1.5 s')
  })

  it('masks every URL in what main said (SEC-L8)', () => {
    const got = classifyTransportError(
      'getaddrinfo ENOTFOUND at https://user:pw@api.example.test/a?token=s3cret and wss://u:p@ws.example.test/x',
      'ENOTFOUND'
    )
    expect(got.detail).toContain('https://•••@api.example.test/a?token=•••')
    expect(got.detail).toContain('wss://•••@ws.example.test/x')
    expect(got.detail).not.toMatch(/s3cret|user:pw|u:p@/)
    const other = classifyTransportError('Not a valid URL: http://a:b@h/?token=zz')
    expect(other.message).not.toMatch(/a:b@|zz/)
  })
})

describe('review refusals get a Review fix', () => {
  it('offers review-env for an environment held for review, with the store’s exact text', async () => {
    const { ENV_REVIEW_MESSAGE } = await import('../src/renderer/src/store/api')
    const { ENV_REVIEW_TEXT } = await import('../src/shared/httpErrors')
    expect(ENV_REVIEW_TEXT).toBe(ENV_REVIEW_MESSAGE)
    expect(presentError('other', ENV_REVIEW_MESSAGE)).toEqual({
      class: 'other',
      message: ENV_REVIEW_MESSAGE,
      fix: { label: 'Review changes', action: 'review-env' }
    })
  })

  it('offers review-collection for a collection’s connection held for review', async () => {
    const { CONNECTION_REVIEW_MESSAGE } = await import('../src/shared/apiRequestBuild')
    expect(presentError('other', CONNECTION_REVIEW_MESSAGE).fix).toEqual({ label: 'Review changes', action: 'review-collection' })
  })

  it('leaves any other failure without a fix', () => {
    expect(presentError('other', 'something else').fix).toBeUndefined()
  })
})
