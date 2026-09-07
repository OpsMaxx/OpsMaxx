import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { parseStaleJobs, parseStalePods, staleFindings } from '../src/shared/k8sStale'

// Item 39's stale objects, against a real k3s v1.31.5 with two Jobs run to
// completion: one exiting 0 and one exiting 7.

const DIR = fileURLToPath(new URL('./fixtures/k8s/stale', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const pods = (): ReturnType<typeof parseStalePods> => parseStalePods(read('pods.txt'))
const jobs = (): ReturnType<typeof parseStaleJobs> => parseStaleJobs(read('jobs.txt'))

// Both jobs started at this instant on the fixture cluster.
const STARTED = Date.parse('2026-09-05T19:23:19Z')
const later = (days: number): number => STARTED + days * 86_400_000

describe('the two vocabularies for one pod', () => {
  // `kubectl get pods` prints Completed and Error in its STATUS column; the
  // API's `.status.phase` says Succeeded and Failed. A parser keying on one
  // while a comment describes the other is how somebody later "fixes" it to
  // match the docs and breaks it.
  it('uses the phase, and the fixtures show the column says something else', () => {
    expect(read('pods-status-column.txt')).toContain('Completed')
    expect(read('pods-status-column.txt')).toContain('Error')
    const byName = Object.fromEntries(pods().map((p) => [p.name.split('-')[0], p.phase]))
    expect(byName.ok).toBe('Succeeded')
    expect(byName.bad).toBe('Failed')
  })
})

describe('a failed job records no completion time', () => {
  // `ok-job` carries one; `bad-job` reports `<none>`. Age from completionTime
  // would be null for exactly the jobs most worth noticing.
  it('is true of the real fixture', () => {
    const byName = Object.fromEntries(jobs().map((j) => [j.name, j]))
    expect(byName['ok-job'].completedAt).not.toBeNull()
    expect(byName['bad-job'].completedAt).toBeNull()
    expect(byName['bad-job'].failed).toBe(1)
  })

  it('dates a failed job from when it started, and says so', () => {
    const f = staleFindings([], jobs(), 1, later(3))
    const bad = f.find((x) => x.name === 'bad-job')!
    expect(bad.ageDays).toBe(3)
    expect(bad.because).toContain('measured from when it started')
  })

  it('does not say that about a job that did record one', () => {
    const f = staleFindings([], jobs(), 1, later(3))
    expect(f.find((x) => x.name === 'ok-job')!.because).not.toContain('measured from when it started')
  })
})

describe('what counts as finished', () => {
  it('reports both jobs once they are older than the window', () => {
    expect(staleFindings([], jobs(), 1, later(2)).map((f) => f.name).sort()).toEqual([
      'bad-job',
      'ok-job'
    ])
  })

  it('reports neither while they are inside it', () => {
    expect(staleFindings([], jobs(), 7, later(1))).toEqual([])
  })

  it('leaves a running job alone however long it has been running', () => {
    // Not stale — a different finding, and not this one's.
    const running = [{ ...jobs()[0], succeeded: 0, failed: 0 }]
    expect(staleFindings([], running, 1, later(90))).toEqual([])
  })

  // A pod owned by a Job is not its own row: deleting the Job removes it, so
  // the Job is the actionable line and listing both says one thing twice.
  it('does not list a job’s pods beside the job', () => {
    const f = staleFindings(pods(), jobs(), 1, later(2))
    expect(f.every((x) => x.kind === 'job')).toBe(true)
  })

  it('lists a bare finished pod, which nothing else will clean up', () => {
    const bare = pods().map((p) => ({ ...p, ownerKind: '' }))
    const f = staleFindings(bare, [], 1, later(2))
    expect(f.map((x) => x.name).length).toBe(2)
    expect(f[0].kind).toBe('pod')
  })

  it('leaves Running and Pending pods out entirely', () => {
    const running = pods().filter((p) => p.phase === 'Running').map((p) => ({ ...p, ownerKind: '' }))
    expect(running.length).toBeGreaterThan(0)
    expect(staleFindings(running, [], 1, later(90))).toEqual([])
  })
})

describe('an evicted pod did not crash', () => {
  // Its phase is `Failed` too, so the reason is the only thing separating "the
  // node pushed it off" from "the process exited non-zero".
  it('says the node pushed it off rather than calling it a failure', () => {
    const evicted = [{ ...pods()[0], ownerKind: '', phase: 'Failed' as const, reason: 'Evicted' }]
    const f = staleFindings(evicted, [], 1, later(2))
    expect(f[0].because).toContain('pushed it off')
  })
})
