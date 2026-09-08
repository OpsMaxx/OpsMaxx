import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { hpaUtilisationText, judgeHpas, parseHpas, type K8sHpa } from '../src/shared/k8sHpa'

// Item 39's HPA row. The two fixtures are THE SAME HPA on the same k3s
// v1.31.5, a minute apart — before the metrics API was serving and after.

const DIR = fileURLToPath(new URL('./fixtures/k8s/hpa', import.meta.url))
const one = (n: string): K8sHpa => parseHpas(readFileSync(join(DIR, n), 'utf8'))[0]

describe('the two states that both look like zero', () => {
  const unmeasured = one('fresh.txt')
  const measured = one('measured.txt')

  it('reads the same HPA’s spec identically in both', () => {
    for (const h of [unmeasured, measured]) {
      expect(h.minReplicas).toBe(2)
      expect(h.maxReplicas).toBe(10)
      expect(h.currentReplicas).toBe(2)
      expect(h.targetUtilization).toBe(80)
    }
  })

  // THE finding, and it is sharper than the row's own wording. An HPA with no
  // metrics reports `desiredReplicas: 0` — a real 0 in the API, not `<none>` —
  // while its minimum is 2. Read as a number it says "this autoscaler wants to
  // scale a production deployment to nothing", and on a cluster whose metrics
  // API never serves it says that for ever.
  it('does not report an unmeasured HPA as wanting zero replicas', () => {
    const raw = readFileSync(join(DIR, 'fresh.txt'), 'utf8').trim().split(/\s+/)
    expect(raw[6]).toBe('0') // desiredReplicas, straight from the cluster
    expect(unmeasured.desiredReplicas).toBeNull()
    expect(unmeasured.currentUtilization).toBeNull()
  })

  it('reports a measured zero as a zero, because that one is real', () => {
    expect(measured.currentUtilization).toBe(0)
    expect(measured.desiredReplicas).toBe(2)
  })

  it('renders the two differently, which is the point of the row', () => {
    expect(hpaUtilisationText(unmeasured)).toBe('not measured')
    expect(hpaUtilisationText(measured)).toBe('0% of 80%')
  })

  it('says an unmeasured HPA cannot scale at all', () => {
    const f = judgeHpas([unmeasured])
    expect(f[0].verdict).toBe('unmeasured')
    expect(f[0].because).toContain('cannot scale')
    expect(f[0].because).toContain('metrics API')
  })

  it('says nothing about a measured HPA that is doing its job', () => {
    expect(judgeHpas([measured])).toEqual([])
  })
})

describe('the two an operator would want pointed out', () => {
  const base = one('measured.txt')

  it('names an autoscaler that has run out of room', () => {
    // At the ceiling AND over target: it has done everything it can, and the
    // answer is a bigger maximum rather than anything it can do itself.
    const f = judgeHpas([{ ...base, currentReplicas: 10, maxReplicas: 10, currentUtilization: 95 }])
    expect(f[0].verdict).toBe('at-ceiling')
    expect(f[0].because).toContain('nothing left to do')
  })

  it('does not call it at-ceiling merely for being at the ceiling', () => {
    // At max and comfortably under target is an autoscaler that is fine.
    expect(judgeHpas([{ ...base, currentReplicas: 10, maxReplicas: 10, currentUtilization: 10 }])).toEqual([])
  })

  it('names an autoscaler pinned so it can never scale', () => {
    const f = judgeHpas([{ ...base, minReplicas: 4, maxReplicas: 4, currentReplicas: 4 }])
    expect(f[0].verdict).toBe('pinned')
    expect(f[0].because).toContain('never scale')
  })
})

describe('rows that are not nine columns', () => {
  // I wrote a test for an empty trailing column first. It cannot happen:
  // kubectl's custom-columns prints `<none>` for an absent value, which both
  // fixtures show, and the parser trims — so a "trailing empty column" is
  // simply a row with eight fields.
  //
  // What that row does is worth pinning anyway: it is SKIPPED, not read with
  // the last value missing. Half a row of an autoscaler's numbers is worse
  // than none.
  it('skips a row it cannot read in full rather than half-reading it', () => {
    expect(parseHpas('default web web 2 10 2 0 80')).toEqual([])
  })

  it('reads kubectl’s own empty marker as unmeasured', () => {
    // Which is what actually arrives, and is covered by the fixtures above —
    // asserted here directly so the `<none>` handling is not only implicit.
    const h = parseHpas('default web web 2 10 2 0 80 <none>')[0]
    expect(h.currentUtilization).toBeNull()
    expect(hpaUtilisationText(h)).toBe('not measured')
  })
})
