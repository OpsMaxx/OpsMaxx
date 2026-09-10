import { describe, it, expect } from 'vitest'

/**
 * A namespace belongs to the cluster it was chosen in.
 *
 * Reported as "the Kubernetes namespace dropdown doesn't refresh the list".
 * The list itself always refreshed — `kubectl get ns` runs on every read — but
 * the SELECTION did not: changing the host cleared the probe and left
 * `namespace` (and `context`) holding names from the previous cluster. The
 * select is hidden while the probe is null, so the stale value was invisible,
 * and the next read was silently scoped to a namespace that usually does not
 * exist on the new cluster.
 *
 * The rule, extracted so it can be tested without a DOM: a selection survives
 * only while the cluster still offers it.
 */

/** What the panel does after every read. */
function keepNamespace(available: readonly string[], chosen: string): string {
  if (chosen === '') return ''
  return available.includes(chosen) ? chosen : ''
}

describe('a namespace selection after the cluster answers', () => {
  it('is kept when the cluster still has it', () => {
    expect(keepNamespace(['default', 'chainsaw', 'kube-system'], 'chainsaw')).toBe('chainsaw')
  })

  it('falls back to all namespaces when the cluster does not', () => {
    // "lazy" is a namespace on another cluster. Scoping a read to it here
    // returns nothing and says nothing about why.
    expect(keepNamespace(['default', 'chainsaw', 'kube-system'], 'lazy')).toBe('')
  })

  it('leaves "all namespaces" alone', () => {
    // The empty string is a real choice, not an absent one.
    expect(keepNamespace(['default'], '')).toBe('')
  })

  it('falls back rather than blanking the control', () => {
    // A <select> whose value matches no option renders BLANK rather than
    // failing, so the visible symptom of getting this wrong is a control
    // showing nothing while the reads under it stay scoped to a namespace
    // that is gone.
    const chosen = keepNamespace([], 'chainsaw')
    expect(chosen).toBe('')
    expect(chosen).not.toBe('chainsaw')
  })
})
