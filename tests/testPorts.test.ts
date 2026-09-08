import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Every test that stands up a real MCP server binds a real TCP port, and vitest
// runs files in parallel. Two files sharing a number do not fail cleanly: the
// second server's client connects to the FIRST one's listener, authenticates
// against a session store that has never heard of its token, and every
// assertion in the file fails with "this token is not recognized" -- a sentence
// about authentication, in a file about something else.
//
// That happened, between `vpnPolicy` and `capacityTool` on 58741, and it stayed
// invisible for as long as the scheduler happened to keep them apart. It became
// visible when two unrelated test files were ADDED, which changed the order.
// The condition is cheap to state, so it is stated here rather than rediscovered.

const DIR = fileURLToPath(new URL('.', import.meta.url))

/** `const PORT = <n>` at any indentation. The suite's own convention, and the
 *  only shape this needs to understand. */
const DECL = /^\s*const PORT = (\d+)$/gm

function ports(): Map<number, string[]> {
  const byPort = new Map<number, string[]>()
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.test.ts') && !f.endsWith('.test.tsx')) continue
    if (f === 'testPorts.test.ts') continue
    const text = readFileSync(join(DIR, f), 'utf8')
    for (const m of text.matchAll(DECL)) {
      const n = Number(m[1])
      byPort.set(n, [...(byPort.get(n) ?? []), f])
    }
  }
  return byPort
}

describe('the ports test files bind', () => {
  it('are not shared between two files', () => {
    const shared = [...ports()].filter(([, files]) => files.length > 1)
    expect(shared.map(([n, f]) => `${n}: ${f.join(', ')}`)).toEqual([])
  })

  // A guard that matched nothing would pass forever while the suite drifted.
  it('are actually being read by this test', () => {
    expect(ports().size).toBeGreaterThan(5)
  })
})
