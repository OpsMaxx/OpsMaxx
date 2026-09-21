import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// "CPU & memory" did nothing on this machine, and nothing said why.
//
// `server` is undefined BY CONSTRUCTION when the host dropdown is on the local
// daemon — `const server = localSelected ? undefined : eligible.find(...)`. So
// a handler guarding `if (!server) return` returns on its first line: no IPC,
// no error, no console output. A silent button next to a clean console is what
// that looks like from outside.
//
// Six handlers were converted to `hasTarget` when the local target was added
// and two were missed. They were missed because nothing failed — the local
// daemon is also the DEFAULT when no saved server is online, so the bug was
// only ever visible to someone using the feature the conversion was for.
//
// This is a source-shape test on purpose. The behavioural alternative is
// rendering the panel with a stubbed bridge per handler, which is a great deal
// of machinery to prove a negative about a line that is one token long.

const SRC = readFileSync(
  resolve(__dirname, '..', 'src/renderer/src/components/docker/DockerPanel.tsx'),
  'utf8'
)

/** Handlers allowed to insist on a SAVED server, each with the reason why. */
const SERVER_ONLY: Record<string, RegExp> = {
  // The job model mints an approval against a saved server's id and main
  // re-derives the plan from it, so a non-server target is a change to the
  // consent model rather than a dropdown gaining an option.
  launchEngineJob: /consent model/
}

function handlers(): Array<{ name: string; guard: string; body: string }> {
  const out: Array<{ name: string; guard: string; body: string }> = []
  const re = /const (\w+) = async \([^)]*\): Promise<void> => \{\n([\s\S]*?)\n  \}\n/g
  for (const m of SRC.matchAll(re)) {
    const [, name, body] = m
    const g = body.match(/if \(!(server|hasTarget)\b[^)]*\) return/)
    if (g) out.push({ name, guard: g[1], body })
  }
  return out
}

describe('reading Docker on this machine', () => {
  it('guards on hasTarget, never on server, wherever the command targets targetCfg()', () => {
    // The tell is `targetCfg()`: a handler that sends its command there has
    // already been taught about the local daemon, so refusing to run because
    // no SAVED server is selected is the contradiction.
    const wrong = handlers()
      .filter((h) => h.guard === 'server')
      .filter((h) => h.body.includes('targetCfg()'))
      .map((h) => h.name)
    expect(wrong, 'these send commands to the local target and then refuse to run against it').toEqual([])
  })

  it('names a reason for every handler that still demands a saved server', () => {
    // A `!server` guard is allowed. Being unexplained is not: that is how
    // these two came to look identical to the six that were converted.
    for (const h of handlers().filter((x) => x.guard === 'server')) {
      const why = SERVER_ONLY[h.name]
      expect(why, `${h.name} guards on !server with no entry here saying why`).toBeTruthy()
      // Comment prose wraps, so the reason is matched against the body with
      // its comment markers and line breaks flattened. Otherwise this passes
      // or fails on where a sentence happened to break.
      const prose = h.body.replace(/^\s*\/\/ ?/gm, '').replace(/\s+/g, ' ')
      expect(prose, `${h.name} must keep saying why in the code, not only here`).toMatch(why)
    }
  })

  it('still finds the handlers it is meant to be checking', () => {
    // A regex that silently matches nothing would make both assertions above
    // pass for ever. Pin the shape.
    const found = handlers().map((h) => h.name)
    expect(found.length).toBeGreaterThan(6)
    expect(found).toContain('loadStats')
    expect(found).toContain('confirmReclaim')
    expect(found).toContain('launchEngineJob')
  })
})
