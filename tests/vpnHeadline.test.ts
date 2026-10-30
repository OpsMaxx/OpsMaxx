// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { headline } from '../src/renderer/src/components/vpn/useVpnProfiles'
import { applyLanguage, t } from '../src/renderer/src/lib/i18n'
import { describeVpnError } from '../src/main/services/vpn/errors'

describe('the toast says something', () => {
  it('keeps the first sentence for a failure that has one', () => {
    expect(headline('The server rejected these credentials. Check the username.')).toBe(
      'The server rejected these credentials.'
    )
  })

  it('promotes the detail when the first sentence is the internal non-message', () => {
    // What OpenVPN actually produced: a toast with no fact in it, in front of
    // the one detail that explained the failure.
    expect(
      headline(
        'Something went wrong inside OpsMaxx. The management socket path is 123 bytes, which is too long: /Users/x/Library/Application Support/OpsMaxx/vpn-run/vpn-abc/mgmt/m.sock'
      )
    ).toBe('The management socket path is 123 bytes, which is too long: /Users/x/Library/Application Support/OpsMaxx/vpn-run/vpn-abc/mgmt/m.sock')
  })

  it('falls back to the generic sentence when there is genuinely nothing else', () => {
    expect(headline('Something went wrong inside OpsMaxx.')).toBe(
      'Something went wrong inside OpsMaxx.'
    )
  })

  it('handles a message with no sentence break', () => {
    expect(headline('  No response from the server  ')).toBe('No response from the server')
  })

  it('says the sentence in the user\'s language, matched by its code rather than its words', async () => {
    // Main composes the text in English, because an agent reads the same
    // result; the screen says it again from the catalog.
    await applyLanguage('en-XA')
    try {
      const said = t('main.vpn.error.port-in-use', { detail: '' })
      expect(said).not.toBe('The local port is already in use.')
      expect(headline(describeVpnError('port-in-use', 'Port 1080 on 127.0.0.1.'), 'port-in-use')).toBe(said)
      // The internal non-message is still recognised, and still gives way.
      expect(headline(describeVpnError('internal', 'The socket path is too long.'), 'internal')).toBe(
        'The socket path is too long.'
      )
      expect(headline('Something went wrong inside OpsMaxx.', 'internal')).toBe(
        t('main.vpn.error.internal', { detail: '' })
      )
    } finally {
      await applyLanguage('en')
    }
  })
})

