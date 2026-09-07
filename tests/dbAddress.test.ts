import { describe, it, expect } from 'vitest'

import {
  DB_ADDRESS_UNPARSED_LABEL,
  displayHostFromUri,
  formatDbAddress,
  looksLikeSecret,
  parseDbAddress,
  sanitiseStoredHost
} from '../src/shared/dbAddress'

// The bug this file exists for, in one string.
//
// An ADO.NET connection string has no scheme, no `@`, and none of `/ : ?`. The
// old derivation matched on `@`, fell back to splitting on those three, found
// no separator, and returned the WHOLE STRING as the host — which was then
// persisted and printed in the tab chrome with the password in it, permanently,
// for as long as the tab was open.
const ADO = 'Server=db01,11433;Database=master;User Id=sa;Password=hunter2;Encrypt=false'

describe('the string that started it', () => {
  it('takes the server out of an ADO.NET string and leaves the password behind', () => {
    expect(parseDbAddress(ADO)).toEqual({ kind: 'parsed', host: 'db01', port: 11433 })
  })

  it('never lets the password reach the rendered address', () => {
    const shown = formatDbAddress(displayHostFromUri(ADO), 1433)
    expect(shown).not.toContain('hunter2')
    expect(shown).not.toContain('Password')
    expect(shown).toBe('db01:1433')
  })

  // The second half of the screenshot: `...Encrypt=false:1433`. The record's
  // own port column was glued onto whatever the "host" was, so a failure to
  // parse produced a malformed value that also lied about the port.
  it('does not glue a port onto a host it could not find', () => {
    expect(formatDbAddress('', 1433)).toBe(DB_ADDRESS_UNPARSED_LABEL)
    expect(formatDbAddress('', 1433)).not.toContain('1433')
  })
})

describe('a parse that did not succeed never renders as one', () => {
  // THE rule. Every other guarantee in this module is downstream of it: there
  // is no branch that returns caller-supplied text verbatim as a hostname.
  it.each([
    ['a bare sentence', 'this is not a connection string'],
    ['key/value with no host key', 'Database=master;User Id=sa;Password=hunter2'],
    ['a scheme with nothing after it', 'postgresql://'],
    ['empty', ''],
    ['whitespace', '   ']
  ])('refuses to guess a host from %s', (_label, input) => {
    expect(parseDbAddress(input)).toEqual({ kind: 'unparsed' })
    expect(displayHostFromUri(input)).toBe('')
  })

  it('shows a neutral label rather than the input it could not parse', () => {
    expect(formatDbAddress(sanitiseStoredHost(ADO.replace('Server=db01,11433;', '')), 1433)).toBe(
      DB_ADDRESS_UNPARSED_LABEL
    )
  })
})

describe('URI strings, per driver', () => {
  it.each([
    ['postgresql://user:pass@db.example.net:5432/app', 'db.example.net', 5432],
    ['mysql://root:pw@10.0.0.4:3306/shop', '10.0.0.4', 3306],
    ['redis://:pw@cache01:6379/0', 'cache01', 6379],
    ['mongodb+srv://u:p@cluster0.mongodb.net/app', 'cluster0.mongodb.net', null],
    ['postgres://db.example.net/app', 'db.example.net', null]
  ])('parses %s', (uri, host, port) => {
    expect(parseDbAddress(uri)).toEqual({ kind: 'parsed', host, port })
  })

  // A password may itself contain an `@`. Splitting on the FIRST one leaves the
  // tail of the credential sitting in the host, which is the same class of leak
  // as the original bug wearing different clothes.
  it('splits userinfo at the last @, not the first', () => {
    const a = parseDbAddress('postgresql://user:p@ssw0rd@db.example.net:5432/app')
    expect(a).toEqual({ kind: 'parsed', host: 'db.example.net', port: 5432 })
  })

  it('names the first seed of a replica set rather than listing them all', () => {
    expect(parseDbAddress('mongodb://u:p@a.example.net:27017,b.example.net:27017/app')).toEqual({
      kind: 'parsed',
      host: 'a.example.net',
      port: 27017
    })
  })

  it('stops the authority at the path, query or fragment', () => {
    for (const s of [
      'postgresql://db.example.net/app?sslmode=require',
      'postgresql://db.example.net?sslmode=require',
      'postgresql://db.example.net#frag'
    ]) {
      expect(parseDbAddress(s)).toMatchObject({ host: 'db.example.net' })
    }
  })
})

describe('key/value strings, per SQL Server', () => {
  // The port comes after a COMMA, not a colon. Reading it as a colon is how a
  // port gets concatenated onto a host instead of separated from it.
  it('reads the comma port form', () => {
    expect(parseDbAddress('Server=db01,11433;Database=master')).toEqual({
      kind: 'parsed',
      host: 'db01',
      port: 11433
    })
  })

  it('treats keys as case- and space-insensitive, the way the driver does', () => {
    for (const k of ['Data Source', 'datasource', 'DATA SOURCE', 'DataSource']) {
      expect(parseDbAddress(`${k}=db01;Initial Catalog=master`)).toMatchObject({ host: 'db01' })
    }
  })

  it('prefers an explicit Server over an aliased Data Source', () => {
    expect(parseDbAddress('Data Source=alias01;Server=real01;Database=x')).toMatchObject({
      host: 'real01'
    })
  })

  it('strips a network-protocol prefix', () => {
    expect(parseDbAddress('Server=tcp:db01,1433;Database=x')).toEqual({
      kind: 'parsed',
      host: 'db01',
      port: 1433
    })
  })

  it('uses an explicit Port only when the server value did not carry one', () => {
    expect(parseDbAddress('Server=db01;Port=15432')).toMatchObject({ port: 15432 })
    expect(parseDbAddress('Server=db01,11433;Port=15432')).toMatchObject({ port: 11433 })
  })

  // A duplicated key is resolved first-wins, matching the drivers. A later
  // `Server=` overriding an earlier one would let a crafted string move the
  // displayed host away from the one actually connected to.
  it('resolves a duplicated key first-wins', () => {
    expect(parseDbAddress('Server=first;Server=second;Database=x')).toMatchObject({ host: 'first' })
  })
})

describe('ports are digits or they are nothing', () => {
  it.each([
    ['db01:0', null],
    ['db01:65536', null],
    ['db01:1433extra', null],
    ['db01:', null],
    ['db01:5432', 5432]
  ])('%s', (input, port) => {
    expect(parseDbAddress(input)).toMatchObject({ port })
  })

  // Number('') is 0 and Number('x') is NaN. Either one reaching the header
  // renders as ":0" or ":NaN" beside a real hostname, which reads like a fact.
  it('never yields NaN', () => {
    for (const s of ['db01:', 'db01:abc', 'Server=db01,;Database=x']) {
      const a = parseDbAddress(s)
      if (a.kind === 'parsed') expect(Number.isNaN(a.port as number)).toBe(false)
    }
  })
})

describe('IPv6', () => {
  it('keeps a bracketed literal whole and takes its port', () => {
    expect(parseDbAddress('postgresql://[2001:db8::1]:5432/app')).toEqual({
      kind: 'parsed',
      host: '2001:db8::1',
      port: 5432
    })
  })

  // An unbracketed literal is indistinguishable from a host with several
  // colons. Truncating at the first colon would show a host that does not
  // exist, which is worse than showing no port.
  it('does not truncate an unbracketed literal at the first colon', () => {
    expect(parseDbAddress('2001:db8::1')).toEqual({ kind: 'parsed', host: '2001:db8::1', port: null })
  })
})

describe('records already poisoned by the old build heal on read', () => {
  // Fixing only the write path would keep printing the old password forever:
  // every record saved by an affected build already has the whole string in
  // `host`, and nothing rewrites it.
  it('re-parses a stored host that is really a connection string', () => {
    expect(sanitiseStoredHost(ADO)).toBe('db01')
    expect(formatDbAddress(ADO, 1433)).toBe('db01:1433')
  })

  it('passes an ordinary stored host through untouched', () => {
    expect(sanitiseStoredHost('db.example.net')).toBe('db.example.net')
    expect(sanitiseStoredHost('10.0.0.4')).toBe('10.0.0.4')
  })

  it('returns null rather than a fragment when the stored value cannot be salvaged', () => {
    expect(sanitiseStoredHost('Database=master;Password=hunter2')).toBeNull()
    expect(sanitiseStoredHost('')).toBeNull()
    expect(sanitiseStoredHost(null)).toBeNull()
    expect(sanitiseStoredHost(undefined)).toBeNull()
  })

  it('never returns a value carrying a credential, whatever the shape', () => {
    for (const s of [ADO, 'pwd=hunter2', 'postgresql://u:p@h/db', 'Password=x;Server=y']) {
      const out = sanitiseStoredHost(s)
      if (out !== null) {
        expect(looksLikeSecret(out)).toBe(false)
        expect(out.toLowerCase()).not.toContain('password')
        expect(out).not.toContain('=')
      }
    }
  })
})

describe('the secret sniffer guards the display path', () => {
  it.each(['Password=x', 'pwd=x', 'AccountKey=x', 'token=x', 'postgres://u:p@h/db'])(
    'flags %s',
    (s) => expect(looksLikeSecret(s)).toBe(true)
  )

  // It must not flag ordinary hosts: a false positive costs the neutral label,
  // which is a worse experience for somebody who did nothing wrong.
  it.each(['db.example.net', '10.0.0.4', '2001:db8::1', 'postgres://host/db', 'my-password-db'])(
    'leaves %s alone',
    (s) => expect(looksLikeSecret(s)).toBe(false)
  )
})
