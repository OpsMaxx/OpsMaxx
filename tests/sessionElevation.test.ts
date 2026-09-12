import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/main/services/mcpServer.ts', import.meta.url)),
  'utf8'
)

/** The body of gate(), which is where every one of these rules has to hold. */
const GATE = SRC.slice(SRC.indexOf('async function gate('), SRC.indexOf('\n  return { ok: true }\n}'))

/**
 * An approval, remembered for the rest of the session.
 *
 * Approving the same kind of action over and over is how an operator learns to
 * click through the dialog without reading it -- at which point the dialog is
 * worse than useless, because it still looks like a control. One answer now
 * covers that capability on that server until the session ends.
 */

describe('what one approval covers', () => {
  it('is scoped to the session, the server AND the capability', () => {
    // Not session-wide: a person approving an action is looking at a server
    // name while they do it, and carrying that consent to a machine they were
    // not looking at is a different grant from the one they gave.
    expect(SRC).toMatch(/const elevationKey = \(sessionId: string, serverId: string, capability: string\)/)
  })

  it('remembers only after a real approval', () => {
    expect(GATE).toMatch(/if \(decision === 'approved' && !perCall\) sessionElevations\.add\(key\)/)
  })

  // `ciTrigger` starts a build on infrastructure OpsMaxx does not administer,
  // cannot inspect, and cannot stop once the provider has accepted it. One
  // approval covering every later build on that server for the rest of the
  // session is an unbounded remote execution loop -- and the agent deciding to
  // take it is reading build output that whoever opened the merge request
  // wrote. So this capability is excluded from the cache in BOTH directions:
  // it never reads an elevation and never writes one. Every run is its own ask.
  //
  // This is the second line of defence, not the first. policyEngine's
  // evaluateCiTrigger upgrades `allow` to `ask` unconditionally, because an
  // `allow` decision never reaches this code at all -- gate() returns before
  // the ask branch. Removing either one silently re-opens the loop.
  it('never carries an approval for a capability whose effect leaves the app', () => {
    expect(GATE).toMatch(/const perCall = ctx\.capability === 'ciTrigger'/)
    expect(GATE).toMatch(/if \(!perCall && sessionElevations\.has\(key\)\)/)
    expect(GATE).toMatch(/if \(decision === 'approved' && !perCall\)/)
  })

  it('is consulted only for an ask, never to soften a deny', () => {
    // The deny branch returns before any of this. An elevation lifts a
    // question; it must never lift a refusal.
    const denyAt = GATE.indexOf("check.decision === 'deny'")
    const askAt = GATE.indexOf("check.decision === 'ask'")
    const lookupAt = GATE.indexOf('sessionElevations.has(key)')
    expect(denyAt).toBeGreaterThanOrEqual(0)
    expect(askAt).toBeGreaterThan(denyAt)
    expect(lookupAt).toBeGreaterThan(askAt)
  })

  it('records a carried approval as its own thing in the audit log', () => {
    // The audit log is the only place the difference between "a human looked at
    // this one" and "a human looked at one like it" survives, and that is
    // exactly what an audit is for.
    expect(GATE).toMatch(/approval: 'approved-earlier'/)
  })

  it('dies with the session', () => {
    expect(SRC).toMatch(/export function clearSessionElevations/)
    expect(SRC).toMatch(/export function clearAllSessionElevations/)
  })

  it('is memory only, so it cannot outlive the process', () => {
    expect(SRC).toMatch(/const sessionElevations = new Set<string>\(\)/)
  })
})
