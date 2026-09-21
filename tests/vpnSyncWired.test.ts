import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The reconcile is actually CALLED when a collection arrives.
 *
 * `vpnProfilesExternalChange` has its own unit tests and they pass whether or
 * not anything invokes it — which is the whole of the defect it exists to fix.
 * The sync engine already wrote the profiles to disk, the renderer already
 * redrew its list, and the one thing missing was a line in `onApplied` telling
 * the manager. A tunnel deleted on another device kept its routes because of a
 * missing call, not a missing function.
 *
 * So this walks the text, like tests/cicdBridgeWired.test.ts and for the same
 * reason. It is crude on purpose: a regex over source proves a NAME is
 * mentioned, not that the call is correct, and "nothing anywhere mentions
 * this" is exactly the failure being prevented.
 */

const ROOT = resolve(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const MAIN = read('src/main/index.ts')

/** The body of `addySession.onApplied(...)`, which is where the three
 *  collections that need more than a renderer message are handled. */
function onAppliedBody(): string {
  const start = MAIN.indexOf('addySession.onApplied(')
  expect(start).toBeGreaterThan(-1)
  // To the next top-level statement. Generous rather than exact: what is being
  // asserted is "inside this handler", not a brace count.
  const end = MAIN.indexOf('\naddySession.watch(', start)
  expect(end).toBeGreaterThan(start)
  return MAIN.slice(start, end)
}

describe('the applied-collections handler', () => {
  it('tells the VPN manager when vpns arrives', () => {
    expect(onAppliedBody()).toMatch(/collections\.includes\('vpns'\)/)
    expect(onAppliedBody()).toMatch(/vpnProfilesExternalChange\(\)/)
  })

  it('still tells the vault and the env registry', () => {
    // The precedent this follows, and a guard against the new line arriving by
    // way of deleting one of them.
    const body = onAppliedBody()
    expect(body).toMatch(/collections\.includes\('env'\)[\s\S]*envSecretsExternalChange\(\)/)
    expect(body).toMatch(/collections\.includes\('vault'\)[\s\S]*vaultExternalChange\(\)/)
  })

  it('imports the reconcile from the manager rather than redeclaring it', () => {
    expect(MAIN).toMatch(/vpnProfilesExternalChange,[\s\S]*from '\.\/services\/vpn\/manager'/)
  })
})
