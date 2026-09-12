import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { WS_MIN_PASSWORD } from '../src/shared/workspace'
import { wsLockSet } from '../src/main/services/wslock'

// One password floor, not two.
//
// main enforced a bare `6` in wslock.ts and the renderer's WorkspaceManager.tsx
// had its own `const MIN_WS_PASSWORD = 6`, with a comment on each saying it was
// kept in step with the other by hand. That is the arrangement that let the
// vault's minimum end up as three different numbers in three files — main
// refusing 8 while the renderer and the shared constant said 12 — so this pins
// the workspace one by IMPORT rather than by comparing two literals.

describe('the workspace password floor', () => {
  it('is what main imports, with no literal of its own', () => {
    // The behavioural check below cannot tell the shared constant from a
    // re-hardcoded literal that happens to agree with it — and agreeing is the
    // normal state of the bug right up to the moment somebody changes the
    // constant. So main gets the same source assertion the renderer gets.
    const src = readFileSync('src/main/services/wslock.ts', 'utf8')
    expect(src).toContain("import { WS_MIN_PASSWORD } from '../../shared/workspace'")
    expect(src).not.toMatch(/const\s+\w*MIN\w*PASSWORD\s*=/)
    expect(src).toMatch(/password\.length\s*<\s*WS_MIN_PASSWORD/)
    // No digit on the right of that comparison, whichever way it is written.
    expect(src).not.toMatch(/password\.length\s*<\s*\d/)
  })

  it('is what main enforces', async () => {
    const short = 'a'.repeat(WS_MIN_PASSWORD - 1)
    const rejected = await wsLockSet('ws-floor', short)
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain(`${WS_MIN_PASSWORD}`)

    const accepted = await wsLockSet('ws-floor', 'a'.repeat(WS_MIN_PASSWORD))
    expect(accepted.ok).toBe(true)
  })

  it('is what the renderer imports, with no copy of its own', () => {
    // A source assertion because the alternative — rendering the form and
    // reading the number back out of a placeholder — would pass just as well
    // against a re-introduced local literal that happened to agree.
    const src = readFileSync(
      'src/renderer/src/components/workspace/WorkspaceManager.tsx',
      'utf8'
    )
    expect(src).toContain("import { WS_MIN_PASSWORD } from '../../../../shared/workspace'")
    expect(src).not.toMatch(/const\s+\w*MIN\w*PASSWORD\s*=/)
  })
})
