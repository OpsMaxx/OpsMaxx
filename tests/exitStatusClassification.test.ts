import { describe, it, expect } from 'vitest'
import { classifyConnectionError } from '../src/shared/connectionError'
import { adviseOnError } from '../src/renderer/src/lib/connectionError'

// Typing a command that does not exist and then typing `exit` produced:
//
//   "OpsMaxx could not tell what went wrong from what the server said."
//
// next to a button offering to edit the connection — for a session in which
// nothing had gone wrong at all.
//
// `exit` with no argument returns the status of the last command, so a typo at
// the prompt ends the shell with 127. transport.ts writes "shell exited" for
// status 0 and "shell exited with N" otherwise, and the classifier's pattern
// carried a negative lookahead — `(?! with)` — so everything except a status-0
// exit fell past it, matched none of the failure patterns, and landed in
// `unknown`, whose whole job is to admit it cannot explain a FAILURE.
//
// The intent behind the lookahead was real: a container exec that dies because
// the image has no shell also exits 127, and that IS worth keeping on screen.
// So the two are split rather than merged.

const dead = (why: string): string => `Session closed · ${why}`

describe('a shell that exited', () => {
  it('cleanly, is an exit', () => {
    expect(classifyConnectionError(dead('shell exited'))).toBe('exited')
  })

  it('carrying a status, is still an exit and not a mystery', () => {
    expect(classifyConnectionError(dead('shell exited with 127'))).toBe('exited-nonzero')
    expect(classifyConnectionError(dead('shell exited with 1'))).toBe('exited-nonzero')
  })

  it('never offers to edit the connection, whichever way it ended', () => {
    // The Edit button is the part that turned a mistyped command into what
    // looked like an authentication problem. There is nothing to correct in a
    // connection that worked.
    for (const why of ['shell exited', 'shell exited with 127']) {
      expect(adviseOnError(dead(why)).edit, why).toBe(false)
    }
  })

  it('does not say OpsMaxx failed to understand it', () => {
    const advice = adviseOnError(dead('shell exited with 127'))
    expect(advice.cause).not.toMatch(/could not tell/i)
    expect(advice.cause).toMatch(/exited/i)
  })

  it('can still be retried, because reconnecting is the obvious next thing', () => {
    expect(adviseOnError(dead('shell exited with 127')).retry).toBe(true)
  })
})

describe('what the split must not break', () => {
  it('a real failure is still a failure', () => {
    expect(classifyConnectionError('Permission denied (publickey)')).toBe('auth')
    expect(classifyConnectionError('connection refused')).toBe('refused')
    expect(classifyConnectionError('Host denied (verification failed)')).toBe('host-key')
  })

  it('text nobody recognises is still unknown, and still admits it', () => {
    const advice = adviseOnError('the server said something nobody has seen before')
    expect(classifyConnectionError('the server said something nobody has seen before')).toBe('unknown')
    expect(advice.cause).toMatch(/could not tell/i)
    expect(advice.edit).toBe(true)
  })

  it('the more specific exit pattern is tested before the general one', () => {
    // "shell exited with 127" contains "shell exited". If the order were
    // reversed the lookahead would be doing the work again and the split would
    // be silently inert.
    expect(classifyConnectionError('shell exited with 127')).not.toBe('exited')
  })
})
