import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/main/services/tunnel.ts', import.meta.url))
const src = readFileSync(SRC, 'utf8')

/**
 * A tunnel that is listening is not necessarily a tunnel that works.
 *
 * `setState(t, 'active')` fires when the LOCAL LISTENER binds. Whether anything
 * gets through to the target is a separate question, answered per connection --
 * and all three answers used to be thrown away by a bare
 * `.catch(() => socket.destroy())`. If the target refused, every connection died
 * silently: green dot, connection count nought, no error, nothing in the log.
 * The user's report for this class of bug is always the same sentence, "it says
 * connected but nothing works".
 *
 * There is no end-to-end test here because driving the real service needs an SSH
 * server fixture, and this is deliberately the narrow check: that no path from a
 * failed forward reaches a bare destroy without recording why first.
 */

/** Every `.catch(...)` body in the file, and every socket error handler. */
function failureHandlers(text: string): string[] {
  const out: string[] = []
  const re = /\.catch\(([\s\S]{0,220}?)\)\s*(?:\n|;|\})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1])
  const re2 = /socket\.on\('error',([\s\S]{0,220}?)\)\s*(?:\n|;)/g
  while ((m = re2.exec(text))) out.push(m[1])
  return out
}

describe('a forward that cannot reach its target', () => {
  it('records why before tearing the socket down', () => {
    const swallowed = failureHandlers(src).filter(
      (h) =>
        /destroy\(\)|\.end\(\)/.test(h) &&
        // Either it reports to the tunnel's status, or -- on the ephemeral path,
        // which has no Active tunnel and so no status channel -- it at least
        // logs the reason instead of discarding it.
        !/forwardFailed|console\.error/.test(h)
    )
    expect(swallowed).toEqual([])
  })

  it('does not flip the tunnel into an error state to say so', () => {
    // The listener is genuinely up and the next connection may well succeed, so
    // an error state would be its own untruth -- and would race with a stop
    // already under way.
    const fn = src.slice(src.indexOf('function forwardFailed'))
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toMatch(/setState/)
  })

  it('carries the count and the reason out to the renderer', () => {
    expect(src).toMatch(/lastForwardError: t\.lastForwardError/)
    expect(src).toMatch(/forwardFailures: t\.forwardFailures \|\| undefined/)
  })

  it('starts each run from zero rather than inheriting the last one', () => {
    expect(src).toMatch(/t\.forwardFailures = 0/)
    expect(src).toMatch(/t\.lastForwardError = undefined/)
  })
})
