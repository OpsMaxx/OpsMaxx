import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  crashloopReading,
  looksLikeCrashloop,
  parseCrashPods,
  type CrashPodRow
} from '../src/shared/k8sCrashloop'

// Item 40. Both fixtures are the SAME pod on a real k3s v1.31.5 cluster, three
// seconds apart: a container that exits 1 after two seconds. What they show is
// the whole reason this file is shaped the way it is.

const DIR = fileURLToPath(new URL('./fixtures/k8s/crashloop', import.meta.url))
const fixture = (n: string): CrashPodRow[] => parseCrashPods(readFileSync(join(DIR, n), 'utf8'))

describe('what a crashlooping pod actually reports', () => {
  const backoff = fixture('pods-backoff.txt')
  const between = fixture('pods-between.txt')
  const crash = (rows: CrashPodRow[]): CrashPodRow => rows.find((p) => p.name === 'sp-crash')!

  // Measured, not assumed. A probe keyed on phase reports a crashlooping pod
  // as healthy for ever.
  it('is phase Running in both samples, so phase says nothing', () => {
    expect(crash(backoff).phase).toBe('Running')
    expect(crash(between).phase).toBe('Running')
  })

  // The trap. Between restarts the container is briefly up and the waiting
  // reason is EMPTY, with terminated.reason Error instead. A probe keyed only
  // on CrashLoopBackOff misses the pod on a fair share of samples, which on a
  // self-resolving alert means it flaps.
  it('is not CrashLoopBackOff in every sample', () => {
    expect(crash(backoff).waiting).toBe('CrashLoopBackOff')
    expect(crash(between).waiting).toBe('')
    expect(crash(between).terminated).toBe('Error')
  })

  it('is recognised in both spellings', () => {
    expect(looksLikeCrashloop(crash(backoff))).toBe(true)
    expect(looksLikeCrashloop(crash(between))).toBe(true)
    expect(looksLikeCrashloop(backoff.find((p) => p.name === 'sp-ok')!)).toBe(false)
  })

  it('reads the healthy pods beside it without inventing a reason', () => {
    const ok = backoff.find((p) => p.name === 'sp-ok')!
    expect(ok).toMatchObject({ phase: 'Running', waiting: '', terminated: '', restarts: 0 })
  })
})

describe('a count is not a rate', () => {
  const p = (restarts: number): CrashPodRow[] => [
    { namespace: 'default', name: 'sp-crash', phase: 'Running', waiting: '', terminated: 'Error', restarts, node: 'n1' }
  ]

  // Four restarts means "restarted four times", which a pod that crashed four
  // times an hour ago and has been up since also reports. Only the delta
  // separates them.
  it('says unknown on the first sample rather than alarming on a number', () => {
    const r = crashloopReading('ok', p(4), null)
    expect(r.bad).toBeNull()
    expect(r.detail).toContain('cannot yet be told from a restart rate')
  })

  it('is false when a pod has restarts but is not gaining any', () => {
    expect(crashloopReading('ok', p(4), p(4)).bad).toBe(false)
  })

  it('is true when the count went up, and says by how much', () => {
    const r = crashloopReading('ok', p(6), p(4))
    expect(r.bad).toBe(true)
    expect(r.restarting[0].by).toBe(2)
    expect(r.detail).toContain('restarted 2 time(s)')
  })

  it('does not count a pod that was not in the previous sample', () => {
    // It may have been recreated with a fresh count; a new pod's restarts are
    // not evidence of anything yet.
    expect(crashloopReading('ok', p(3), []).bad).toBe(false)
  })
})

describe('the readings that must never be false', () => {
  // `bad: false` says "nothing is crashlooping in this cluster". Each of these
  // is a case where we do not know that.
  it('is null, not false, when the read could not be made', () => {
    for (const s of ['forbidden', 'no-cluster', 'unauthorized'] as const) {
      expect(crashloopReading(s, [], []).bad, s).toBeNull()
    }
  })

  it('is null when only one namespace could be listed', () => {
    // "Nothing is crashlooping" would then be a claim about a fraction of the
    // cluster stated as a claim about all of it.
    const r = crashloopReading('one-namespace', [], [])
    expect(r.bad).toBeNull()
    expect(r.detail).toContain('not a claim about the cluster')
  })
})

describe('which thing the alert is about', () => {
  it('is the cluster, not the server the kubeconfig happens to be on', async () => {
    const { crashloopSubject, CRASHLOOP_SUBJECT_PREFIX } = await import(
      '../src/shared/k8sCrashloop'
    )
    // Three admin boxes holding a kubeconfig for one cluster is three alerts
    // about one problem if this keys on the server.
    expect(crashloopSubject('prod')).toBe('k8s:prod')
    expect(crashloopSubject('prod')).not.toContain('srv-')
    // Prefixed so it cannot collide with a server id in the same subject:kind
    // keyspace.
    expect(crashloopSubject('prod').startsWith(CRASHLOOP_SUBJECT_PREFIX)).toBe(true)
  })

  it('names the current context rather than an empty subject', () => {
    // An alert keyed on `k8s:` would merge every unnamed cluster into one.
    return import('../src/shared/k8sCrashloop').then(({ crashloopSubject }) => {
      expect(crashloopSubject('')).toBe('k8s:current-context')
    })
  })

  it('stays free of imports, which is the constraint that placed it here', async () => {
    // fleetSampler is inside the agent-reachable closure, and importing
    // shared/kubernetes into anything it reaches fails jobsNotExposed. This
    // module declares only the summary shape and imports nothing at all.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '..', 'src/shared/k8sCrashloop.ts'), 'utf8')
    expect(src).not.toMatch(/^import /m)
  })
})

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------
//
// Every module in this stretch of work has been a parser with no caller, so
// this asserts the poll exists and asks for the right things. Read off the
// source for the reason moduleBoundaries reads its tab guards that way:
// mounting FleetWatcher pulls in the whole app store.

describe('the crashloop poll is actually wired', () => {
  const src = (): string => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { resolve } = require('node:path') as typeof import('node:path')
    return readFileSync(
      resolve(__dirname, '..', 'src/renderer/src/components/monitor/FleetWatcher.tsx'),
      'utf8'
    )
  }

  it('calls the reading and raises the kind', () => {
    expect(src()).toContain('crashloopReading(')
    expect(src()).toContain("'pod-crashloop'")
  })

  it('keys the alert on the cluster subject, never on a server id', () => {
    // A cluster reachable from three admin boxes is one thing to watch.
    expect(src()).toContain('crashloopSubject(')
    expect(src()).toMatch(/checkStateAlert\(\s*subject,/)
  })

  it('polls only the clusters the operator named', () => {
    // Nothing else can know which server holds a kubeconfig, and trying every
    // server would run kubectl across the estate every two minutes.
    expect(src()).toContain('settings.k8sWatch')
  })

  it('passes the PREVIOUS sample to the reading, because it is a delta', () => {
    // Asserting that `lastPods` merely appears is not enough: the `.set` that
    // stores it satisfies that while the read passes the current sample
    // instead, which would compare every pod against itself and never alarm.
    expect(src()).toMatch(/crashloopReading\(\s*state,\s*pods,\s*lastPods\.current\.get\(/)
  })

  it('says nothing rather than "fine" when the reading could not be made', () => {
    // `r.bad === null` must not reach checkStateAlert as `false`.
    expect(src()).toContain('if (r.bad !== null)')
  })
})

describe('a watch can be added, or the alert fires for nobody', () => {
  // A setting with no UI is a feature that alerts on nothing, for every user,
  // for ever. This is the other half of the poll.
  const panel = (): string => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { resolve } = require('node:path') as typeof import('node:path')
    return readFileSync(
      resolve(__dirname, '..', 'src/renderer/src/components/kubernetes/KubernetesPanel.tsx'),
      'utf8'
    )
  }

  it('writes the same setting the poll reads', () => {
    expect(panel()).toContain('k8sWatch')
    expect(panel()).toContain('setSettings({ k8sWatch')
  })

  it('keys the watch on the context, matching how the alert is keyed', () => {
    // Keyed on the server instead would watch one cluster three times from
    // three admin boxes.
    expect(panel()).toMatch(/w\.context !== watchContext/)
  })

  it('says what watching does and what it does not', () => {
    // Specifically that a restart COUNT is not a restart RATE, since that is
    // the whole reason the first sweep says nothing.
    expect(panel()).toContain('restart count goes up between checks')
  })
})
