import { describe, expect, it } from 'vitest'
import {
  adviseOnError,
  classifyConnectionError,
  errorText,
  faultAdvice
} from '../src/renderer/src/lib/connectionError'
import type { ConnectionFault } from '../src/renderer/src/lib/connectionError'

// Which button an error gets is decided entirely by this classifier, so the
// strings it is fed are the ones the app actually produces — ssh2's phrasing,
// node's errno text, and the sentences tunnel.ts writes itself. A pattern that
// drifts away from those does not fail loudly; it quietly turns a fixable
// problem back into a wall of driver output with no way out. Hence the fixtures.

describe('classifyConnectionError', () => {
  it('reads a host key that no longer matches', () => {
    expect(classifyConnectionError('Handshake failed: host key verification failed')).toBe('host-key')
  })

  it('reads a taken port from the sentence tunnel.ts writes', () => {
    // Not "EADDRINUSE": tunnel.ts already translates that one, and the
    // classifier has to recognise its own app's wording too.
    expect(classifyConnectionError('Port 8080 on 127.0.0.1 is already in use.')).toBe('port-in-use')
    expect(classifyConnectionError('listen EADDRINUSE: address already in use')).toBe('port-in-use')
  })

  it('separates a rejected credential from a refused file', () => {
    expect(classifyConnectionError('All configured authentication methods failed')).toBe('auth')
    expect(classifyConnectionError('Permission denied (publickey,password)')).toBe('auth')
    // The bare form is a filesystem refusal — a different sentence and a
    // different fix from a credential the server would not take.
    expect(classifyConnectionError('Permission denied')).toBe('permission')
  })

  it('reads a missing key file without claiming every missing file is one', () => {
    expect(classifyConnectionError("ENOENT: no such file or directory, open '/home/a/.ssh/id_ed25519'")).toBe(
      'key-missing'
    )
    expect(classifyConnectionError('No such file /var/log/app.log')).toBe('unknown')
  })

  it('reads the ordinary network refusals', () => {
    expect(classifyConnectionError('connect ECONNREFUSED 10.0.0.4:5432')).toBe('refused')
    expect(classifyConnectionError('getaddrinfo ENOTFOUND db.internal')).toBe('unreachable')
    expect(classifyConnectionError('Timed out while waiting for handshake')).toBe('unreachable')
  })

  it('says nothing rather than guessing', () => {
    expect(classifyConnectionError(undefined)).toBe('unknown')
    expect(classifyConnectionError('')).toBe('unknown')
    expect(classifyConnectionError('something nobody has seen before')).toBe('unknown')
  })
})

describe('errorText', () => {
  it('drops the IPC preamble that describes the transport, not the problem', () => {
    const err = new Error(
      "Error invoking remote method 'sftp:connect': Error: OPSMAXX_VAULT_LOCKED: this server authenticates with a vault credential, and the vault is locked."
    )
    expect(errorText(err)).toBe(
      'OPSMAXX_VAULT_LOCKED: this server authenticates with a vault credential, and the vault is locked.'
    )
  })

  it('handles anything that was thrown, not just Errors', () => {
    expect(errorText('plain string')).toBe('plain string')
    expect(errorText(new Error('Error: doubled up'))).toBe('doubled up')
  })
})

// ---------------------------------------------------------------------------
// What each fault offers, which is the half the terminal never asked for
// ---------------------------------------------------------------------------
//
// The classifier above has been right for a while and the database surface used
// it. The terminal did not: an unreachable host, a wrong port, a wrong username
// and a rejected key all arrived as one string — "Connection failed: Timed out
// while waiting for handshake" — over a card whose only button was Reconnect.
//
// Reconnect cannot fix three of those four. On a rejected credential it re-runs
// the same rejected credential and fails identically, forever, and the card then
// reassured the reader that reconnecting "usually skips authentication" at the
// exact moment authentication was the suspect.

describe('a failure offers the action that can actually help', () => {
  // THE assertion. Offering retry on an auth failure is offering a button that
  // is known not to work, which is worse than offering nothing.
  it('does not offer a retry for a credential the server already rejected', () => {
    const a = adviseOnError('All configured authentication methods failed')
    expect(a.retry).toBe(false)
    expect(a.edit).toBe(true)
    expect(a.cause).toMatch(/username|credential/i)
  })

  it.each([
    ['Permission denied (publickey)', false],
    ['ENOENT: no such file, open /home/u/.ssh/id_rsa', false],
    ['Encrypted private key detected, no passphrase given', false],
    ['connect ECONNREFUSED 127.0.0.1:22', true],
    ['ETIMEDOUT', true]
  ])('%s → retry=%s', (text, retry) => {
    expect(adviseOnError(text).retry).toBe(retry)
  })

  // A changed host key is a decision — rebuilt server, or interception — and it
  // is not made by pressing a button on a failure card.
  it('offers neither retry nor edit for a host-key mismatch', () => {
    const a = adviseOnError('Host key verification failed')
    expect(a.retry).toBe(false)
    expect(a.edit).toBe(false)
    expect(a.hint).toMatch(/certain the server changed/i)
  })

  // Everything the fix could be is behind Edit connection, so a fault whose fix
  // is a field must say so or the user has nowhere to go.
  it('points at the connection settings whenever the fix is a field on it', () => {
    for (const t of ['ECONNREFUSED', 'ETIMEDOUT', 'authentication failed', 'no such file id_ed25519']) {
      expect(adviseOnError(t).edit, t).toBe(true)
    }
  })
})

describe('an unrecognised failure is not given an invented explanation', () => {
  // Inventing a cause for text we did not recognise is how four different
  // problems came to share one wrong sentence in the first place.
  it('says it could not tell, rather than naming a cause', () => {
    const a = adviseOnError('kex_exchange_identification: banner line contains invalid characters')
    expect(a.cause).toMatch(/could not tell/i)
    expect(a.cause).not.toMatch(/username|port|listening|firewall/i)
  })

  it('still lets the user try again and look at the settings', () => {
    const a = adviseOnError(null)
    expect(a.retry).toBe(true)
    expect(a.edit).toBe(true)
  })
})

describe('every fault is answered', () => {
  // A fault added to the union with no advice would fall through to undefined
  // and render an empty card.
  it('gives every classification a cause sentence', () => {
    const faults: ConnectionFault[] = [
      'host-key',
      'port-in-use',
      'passphrase',
      'key-missing',
      'auth',
      'refused',
      'unreachable',
      'permission',
      'unknown'
    ]
    for (const f of faults) {
      const a = faultAdvice(f)
      expect(a, f).toBeDefined()
      expect(a.cause.length, f).toBeGreaterThan(10)
    }
  })
})
