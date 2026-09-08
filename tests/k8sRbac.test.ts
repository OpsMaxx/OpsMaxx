import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { parseCanIList, summariseRbac, RBAC_UNIVERSAL } from '../src/shared/k8sRbac'

// Item 39's RBAC row. Both fixtures are real `kubectl auth can-i --list`
// output from k3s v1.31.5: one for the admin kubeconfig, one for a service
// account bound to a Role granting get/list/watch on pods.

const DIR = fileURLToPath(new URL('./fixtures/k8s/rbac', import.meta.url))
const rules = (n: string): ReturnType<typeof parseCanIList> =>
  parseCanIList(readFileSync(join(DIR, n), 'utf8'))

describe('what the restricted account can actually do', () => {
  const limited = rules('limited.txt')

  it('finds the two rules the Role granted', () => {
    const pods = limited.filter((r) => r.resource === 'pods' || r.resource === 'pods/log')
    expect(pods).toHaveLength(2)
    expect(pods[0].verbs.sort()).toEqual(['get', 'list', 'watch'])
  })

  // A row for a non-resource rule has NO resource, so its line begins with
  // spaces. Splitting on whitespace reads `[/api/*]` as the resource name and
  // shifts every column after it.
  it('reads a row whose first column is empty without shifting the rest', () => {
    const nonResource = limited.filter((r) => r.resource === '' && r.nonResourceUrl !== '')
    expect(nonResource.length).toBeGreaterThan(0)
    expect(nonResource.some((r) => r.nonResourceUrl === '/api/*')).toBe(true)
    // And that row's verbs are still the verbs.
    expect(nonResource[0].verbs).toEqual(['get'])
  })

  it('reads kubectl’s empty list as empty, not as a value', () => {
    expect(limited.find((r) => r.resource === 'pods')!.resourceNames).toEqual([])
  })

  // THE finding. `system:basic-user` grants these to EVERY authenticated
  // identity, including the most restricted account on the cluster. Counting
  // them reports five permissions for an account that has two, and buries the
  // two that matter.
  it('does not count the rules every identity has', () => {
    expect(limited.some((r) => RBAC_UNIVERSAL.has(r.resource))).toBe(true)
    const s = summariseRbac(limited)
    expect(s.meaningful.some((r) => RBAC_UNIVERSAL.has(r.resource))).toBe(false)
  })

  it('says read-only, because none of its verbs changes anything', () => {
    const s = summariseRbac(limited)
    expect(s.clusterAdmin).toBe(false)
    expect(s.writes).toEqual([])
    expect(s.headline).toContain('Read-only')
  })
})

describe('what the admin kubeconfig can do', () => {
  const admin = rules('admin.txt')

  it('is recognised as cluster-admin from *.* and *', () => {
    const s = summariseRbac(admin)
    expect(s.clusterAdmin).toBe(true)
    expect(s.headline).toContain('anything to anything')
  })
})

describe('an answer that is not a permission list', () => {
  it('does not read a failure as a token that can do nothing', () => {
    // "Error from server (Forbidden)" is not an empty set of permissions, and
    // reporting it as one would describe a cluster-admin token as harmless.
    const s = summariseRbac(parseCanIList('Error from server (Forbidden): unknown'))
    expect(s.headline).toContain('unknown')
    expect(s.headline).not.toContain('Read-only')
  })

  it('returns nothing for output with no header, rather than guessing at columns', () => {
    expect(parseCanIList('pods [] [] [get]')).toEqual([])
  })
})
