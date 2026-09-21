import { describe, it, expect } from 'vitest'
import { parseK8sOutput, buildK8sReadCommand } from '../src/shared/kubernetes'

// The namespace selector did nothing to the pod list.
//
// The command runs BOTH reads — `--all-namespaces` first, because an RBAC
// denial there is common and falling back is more useful than failing — and the
// parser preferred the cluster-wide one whenever it succeeded. On any ordinary
// admin kubeconfig that is always, so picking `security` scoped the overview,
// usage and resource reads and left the list underneath showing every pod in
// the cluster.
//
// The fix is in the parser rather than the renderer on purpose: filtering
// `probe.pods` in the UI would leave `allNamespaces` and the per-node pod
// counts disagreeing with the list they are drawn beside.

const row = (ns: string, name: string): string =>
  [ns, name, 'true', 'Running', 'app', '<none>', '<none>', '0', 'node-1', '2026-09-01T10:00:00Z'].join('   ')

const out = (parts: { all?: string; nsPods?: string; ns?: string }): string =>
  [
    '{"clientVersion":{"gitVersion":"v1.29.2"}}',
    '===OPSMAXX-CTX===',
    '*         prod    prod    admin      default',
    '===OPSMAXX-NS===',
    parts.ns ?? 'default\nsecurity\ninfra',
    '===OPSMAXX-PODS-ALL===',
    parts.all ?? '',
    '===OPSMAXX-PODS-NS===',
    parts.nsPods ?? ''
  ].join('\n')

const CLUSTER = [row('security', 'certify-api'), row('infra', 'datadog'), row('kube-system', 'fluentbit')].join('\n')
const JUST_SECURITY = row('security', 'certify-api')

const names = (p: ReturnType<typeof parseK8sOutput>): string[] =>
  p.ok ? p.pods.map((x) => x.name) : []

describe('picking a namespace', () => {
  it('lists only that namespace, even when the account can list the whole cluster', () => {
    // The reported bug, exactly: `security` selected, and certify/infra/
    // istio-system/kube-system pods still on screen.
    const probe = parseK8sOutput(out({ all: CLUSTER, nsPods: JUST_SECURITY }), 0, 'security')
    expect(names(probe)).toEqual(['certify-api'])
  })

  it('still lists the whole cluster when no namespace is picked', () => {
    const probe = parseK8sOutput(out({ all: CLUSTER, nsPods: JUST_SECURITY }), 0)
    expect(names(probe)).toEqual(['certify-api', 'datadog', 'fluentbit'])
  })

  it('falls back to filtering the cluster-wide read when the namespaced one failed', () => {
    // A namespaced read can fail on its own (a typo'd namespace, a narrower
    // role). Returning nothing there would be a worse answer than the right
    // rows taken from the read that did work.
    const probe = parseK8sOutput(
      out({ all: CLUSTER, nsPods: 'Error from server (Forbidden): pods is forbidden' }),
      0,
      'security'
    )
    expect(names(probe)).toEqual(['certify-api'])
  })

  it('reports WHY the list is narrow, so a choice is not read as a permission', () => {
    // `allNamespaces` stays about the ACCOUNT. A user who narrows the list has
    // not lost the permission, and saying "this account cannot list across the
    // cluster" about their own choice is a different and alarming claim.
    const probe = parseK8sOutput(out({ all: CLUSTER, nsPods: JUST_SECURITY }), 0, 'security')
    expect(probe.ok && probe.allNamespaces).toBe(true)
    expect(probe.ok && probe.scopedTo).toBe('security')
  })

  it('leaves scopedTo null when RBAC did the narrowing rather than the user', () => {
    const probe = parseK8sOutput(
      out({ all: 'Error from server (Forbidden): pods is forbidden', nsPods: JUST_SECURITY }),
      0
    )
    expect(probe.ok && probe.allNamespaces).toBe(false)
    expect(probe.ok && probe.scopedTo).toBe(null)
  })

  it('ignores a namespace that would not survive validation', () => {
    // The command builder drops an invalid namespace rather than interpolating
    // it, so the parser must not then claim the list was scoped to it.
    const probe = parseK8sOutput(out({ all: CLUSTER, nsPods: JUST_SECURITY }), 0, 'not a namespace; rm -rf /')
    expect(probe.ok && probe.scopedTo).toBe(null)
    expect(names(probe)).toEqual(['certify-api', 'datadog', 'fluentbit'])
  })

  it('does NOT claim a namespace is empty when both reads were refused', () => {
    // An account that can list namespaces but not pods in one of them is the
    // ordinary multi-tenant case, and it survives the cluster-silent guard
    // because `kubectl get ns` succeeded. Setting scopedTo there turned "the
    // cluster said forbidden twice" into "the cluster answered and has no pods
    // in security" — an affirmative claim about a namespace nobody read.
    const refused = 'Error from server (Forbidden): pods is forbidden'
    const probe = parseK8sOutput(out({ all: refused, nsPods: refused }), 0, 'security')
    expect(probe.ok && probe.pods).toEqual([])
    expect(probe.ok && probe.scopedTo, 'nothing was narrowed, because nothing was read').toBe(null)
  })

  it('trims a namespace before using it, on both the command and the filter', () => {
    // validateNamespace trims before testing, so " security " passes. The
    // command then interpolated it verbatim — `--namespace= security`, an
    // empty flag plus a stray positional — and the new filter compared the
    // untrimmed string, emptying the list it was asked to narrow.
    expect(buildK8sReadCommand(undefined, ' security ')).toContain('--namespace=security')
    const probe = parseK8sOutput(out({ all: CLUSTER, nsPods: '' }), 0, ' security ')
    expect(probe.ok && probe.scopedTo).toBe('security')
    expect(names(probe)).toEqual(['certify-api'])
  })

  it('asks kubectl for the namespace it was given', () => {
    // The parser can only prefer the namespaced section if the command
    // actually scoped it.
    expect(buildK8sReadCommand(undefined, 'security')).toContain('--namespace=security')
  })
})
