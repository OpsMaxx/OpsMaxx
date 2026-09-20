import { describe, it, expect } from 'vitest'
import { whyFetchFailed } from '../src/main/services/addy/relay'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The offline state is the one the panel was rebuilt for, and it was the one
 * state the panel could not reach.
 */
describe('a relay that is down does not take the panel down with it', () => {
  const session = readFileSync(
    join(__dirname, '..', 'src', 'main', 'services', 'addy', 'session.ts'),
    'utf8'
  )

  it('status() does not let a network call throw the whole snapshot away', () => {
    const fn = session.slice(session.indexOf('async status()'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    expect(body.length, 'the parser is wrong, not the code').toBeGreaterThan(400)
    // The conflicts count reaches the relay. Every other line answers from
    // what this device already knows, and the snapshot carries the `problem`
    // field and the retry the offline case exists for — so a throw here took
    // down the explanation along with the number.
    const line = body.slice(body.indexOf('conflicts:'))
    expect(
      line.slice(0, 200),
      'conflicts() is awaited bare inside status(), so a relay that is down makes the whole ' +
        'snapshot throw — and the problem banner and Try again button can never render'
    ).toContain('.catch(')
  })

  it('reconnect() does not call an attached-but-not-signed-in session a success', () => {
    const fn = session.slice(session.indexOf('async reconnect()'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    expect(body.length, 'the parser is wrong, not the code').toBeGreaterThan(100)
    expect(
      body,
      'resume() reports resumed:true for a session that loaded its keys and failed to log in, ' +
        'so Try again said "Connected." over a banner still saying it was not'
    ).toContain("token !== ''")
  })

  // A bare colon told somebody there was a problem and refused to say what.
  it.each([
    [Object.assign(new TypeError(''), { cause: new Error('connect ECONNREFUSED 127.0.0.1:8490') }), /ECONNREFUSED/],
    [Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(''), { code: 'ENOTFOUND' }) }), /ENOTFOUND/],
    [new Error(''), /no reason given/],
    [undefined, /no reason given/]
  ])('says why the connection failed (%#)', (err, want) => {
    const why = whyFetchFailed(err)
    expect(why.trim(), 'an empty reason is a bare colon on the screen').not.toBe('')
    expect(why).toMatch(want)
  })
})
