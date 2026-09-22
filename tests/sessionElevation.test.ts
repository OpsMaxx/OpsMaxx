import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../src/main/services/mcpServer.ts', import.meta.url)),
  'utf8'
)

/** The body of gate(), which is where every one of these rules has to hold. */
const GATE = SRC.slice(SRC.indexOf('async function gate('), SRC.indexOf("return { ok: true, approval: 'not-required' }"))

/**
 * An approval, remembered for the rest of the session.
 *
 * Approving the same kind of action over and over is how an operator learns to
 * click through the dialog without reading it -- at which point the dialog is
 * worse than useless, because it still looks like a control. So the operator
 * can answer for the session, and that one answer covers that capability on
 * that server until the session ends -- but only when they chose it.
 */

describe('what one approval covers', () => {
  // A missing end marker makes GATE the rest of the file, and every
  // not.toMatch below would then be scanning code gate() never runs.
  it('reads gate() and only gate()', () => {
    expect(SRC.indexOf("return { ok: true, approval: 'not-required' }")).toBeGreaterThan(SRC.indexOf('async function gate('))
    expect(GATE).not.toMatch(/function auditSuccess/)
    // gate() is a couple of hundred lines; the whole file is thousands.
    expect(GATE.length).toBeGreaterThan(0)
    expect(GATE.split('\n').length).toBeLessThan(250)
  })

  it('is scoped to the session, the server AND the capability', () => {
    // Not session-wide: a person approving an action is looking at a server
    // name while they do it, and carrying that consent to a machine they were
    // not looking at is a different grant from the one they gave.
    expect(SRC).toMatch(/const elevationKey = \(sessionId: string, serverId: string, scope: string\)/)
    // The scope defaults to the capability, which is what keeps that grain the
    // default for every caller that does not ask for a narrower one.
    expect(GATE).toMatch(/`\$\{subject\.elevationScope \?\? ctx\.capability\}\\u0000\$\{check\.reason\}`/)
  })

  // A capability several differently-shaped tools share is too coarse a key on
  // its own. `manageServers` is the case: an approval to repoint a connection
  // must not also buy the deletion of it. So update_server names a scope, which
  // narrows its remembered yes to that one tool on that one server -- and
  // remove_server stays per-call, so it reads no elevation and writes none.
  it('does not let one tool spend another tool\'s approval', () => {
    expect(SRC).toMatch(/elevationScope: 'update_server'/)
    // Each window runs to the end of that tool's GateSubject literal, which is
    // where `perCall` lives. Sized past remove_server's long `because`.
    const removeAt = SRC.indexOf("toolName: 'remove_server'")
    expect(removeAt).toBeGreaterThanOrEqual(0)
    expect(SRC.slice(removeAt, removeAt + 1200)).toMatch(/perCall: true/)
    const addAt = SRC.indexOf("toolName: 'add_server'")
    expect(addAt).toBeGreaterThanOrEqual(0)
    expect(SRC.slice(addAt, addAt + 1200)).toMatch(/perCall: true/)
  })

  // "Approve once" used to add the elevation too, so the button's label was a
  // grant of one call and its effect was a grant of the session. Only the
  // separately labelled session answer writes the cache now; a plain
  // `approved` is exactly one call.
  it('remembers only after an explicit approval for the session', () => {
    expect(GATE).toMatch(/if \(decision === 'approved-for-session' && !perCall\) sessionElevations\.add\(key\)/)
    expect(GATE).not.toMatch(/decision === 'approved' && !perCall\) sessionElevations/)
    // Offered only where the cache would honour it.
    expect(GATE).toMatch(/const sessionGrant = perCall \? undefined/)
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
    expect(GATE).toMatch(/if \(decision === 'approved-for-session' && !perCall\)/)
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

  // A grant is an answer to the question the policy asked. Keyed on the rule
  // as well as the capability, so a grant given under "Terminal commands
  // require approval" cannot answer a path rule that asks on its own account.
  it('is keyed on the rule that asked, not only the capability', () => {
    expect(GATE).toMatch(/\\u0000\$\{check\.reason\}/)
  })

  // Each of these is a tool whose policy says "always asks" or "never silent"
  // for the dangerous half of what it does; a session grant would make the
  // sentence false on the second call.
  it.each([
    ['execute_command', /perCall: elevated/],
    ['query_database', /perCall: !reads/],
    ['set_tunnel', /perCall: running/],
    ['set_vpn', /perCall: running/],
    ['container_action', /perCall: action !== 'start'/]
  ])('makes the dangerous half of %s per-call', (tool, flag) => {
    const at = SRC.indexOf(`toolName: '${tool}'`)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(SRC.slice(at, at + 1800)).toMatch(flag)
  })

  // get_server_metrics wrote 'not-required' whatever gate() said, so a metrics
  // read that a human approved -- or approved for the session -- was audited
  // as one nobody was asked about, and the carried rows after it had no
  // granting row to point back to. Only gate()'s own deny branch may write a
  // literal approval; every tool writes what gate() handed it.
  it('is audited as gate() reported it, never as a hard-coded answer', () => {
    const outsideGate = SRC.replace(GATE, '')
    expect(outsideGate).not.toMatch(/auditSuccess\(ctx, '/)
    expect(outsideGate).not.toMatch(/approval: 'not-required',\s*result/)
  })

  it('dies with the session', () => {
    expect(SRC).toMatch(/export function clearSessionElevations/)
    expect(SRC).toMatch(/export function clearAllSessionElevations/)
  })

  it('is memory only, so it cannot outlive the process', () => {
    expect(SRC).toMatch(/const sessionElevations = new Set<string>\(\)/)
  })
})
