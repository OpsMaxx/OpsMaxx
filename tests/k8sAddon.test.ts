import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  ADDON_DS_COLS,
  ADDON_EVENT_COLS,
  ADDON_WARNING_NOISE,
  daemonSetVerdict,
  groupWarnings,
  parseAddonDaemonSets,
  parseRolloutStatus,
  parseWarnings,
  rolloutStatusCommand,
  type AddonDaemonSet
} from '../src/shared/k8sAddon'

// Item 39's add-on verification view. The fixtures are one k3s v1.31.5 cluster
// carrying a healthy DaemonSet, a DaemonSet whose container exits immediately,
// and a Deployment pulling an image that does not exist.

const DIR = fileURLToPath(new URL('./fixtures/k8s/addon', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const sets = (): AddonDaemonSet[] => parseAddonDaemonSets(read('daemonsets.txt'))
const ds = (n: string): AddonDaemonSet => sets().find((d) => d.name === n)!

describe('reading the DaemonSets', () => {
  it('was captured with the specs the parsers are written against', () => {
    const cmds = read('command.txt')
    expect(cmds).toContain(ADDON_DS_COLS)
    expect(cmds).toContain(ADDON_EVENT_COLS)
  })

  // Measured: `numberAvailable` and `numberUnavailable` are both `omitempty`,
  // so each is ABSENT when zero -- and they are absent on DIFFERENT rows of the
  // one fixture. Reading either as unmeasured would refuse to grade the row it
  // matters on.
  it('reads an absent availability as zero, on both of the two fields', () => {
    expect(ds('broken-addon')).toMatchObject({ available: 0, unavailable: 1 })
    expect(ds('cni-like')).toMatchObject({ available: 1, unavailable: 0 })
  })

  it('drops a row whose non-optional counts did not come through', () => {
    // `numberReady` is not optional. A `<none>` there means the row was not
    // read, and a row that was not read must not be graded at all.
    const half = 'default broken 1 1 <none> 1 <none> 1 0 1 1'
    expect(parseAddonDaemonSets(half)).toEqual([])
  })
})

describe('a finished rollout is not a working add-on', () => {
  // THE finding. broken-addon has UP-TO-DATE 1 of DESIRED 1 -- complete by the
  // column every rollout check reads -- and its container has never started.
  it('alarms on the DaemonSet that rolled out to every node and works on none', () => {
    const v = daemonSetVerdict(ds('broken-addon'))
    expect(v.level).toBe('alarm')
    expect(v.because).toContain('The rollout is complete and the add-on is not running.')
  })

  it('passes the one that is actually running', () => {
    expect(daemonSetVerdict(ds('cni-like'))).toMatchObject({ level: 'ok' })
  })

  it('separates part way through from finished-and-broken', () => {
    const mid: AddonDaemonSet = { ...ds('broken-addon'), desired: 3, updated: 1, available: 0 }
    expect(daemonSetVerdict(mid).because).toContain('part way through')
  })

  // Every count zero, every ratio satisfied: this reads as a clean rollout to
  // any check that compares columns, and it means the add-on is installed
  // nowhere.
  it('does not call a DaemonSet scheduled onto nothing a success', () => {
    const none: AddonDaemonSet = {
      ...ds('cni-like'),
      desired: 0,
      current: 0,
      ready: 0,
      updated: 0,
      available: 0
    }
    const v = daemonSetVerdict(none)
    expect(v.level).toBe('watch')
    expect(v.because).toContain('no nodes at all')
  })

  it('refuses to grade numbers the controller has not caught up with', () => {
    const stale: AddonDaemonSet = { ...ds('broken-addon'), generation: 4, observedGeneration: 3 }
    const v = daemonSetVerdict(stale)
    expect(v.level).toBe('unknown')
    expect(v.because).toContain("previous version's")
  })

  it('mentions misscheduled pods on an otherwise healthy set', () => {
    const mis: AddonDaemonSet = { ...ds('cni-like'), misscheduled: 2 }
    expect(daemonSetVerdict(mis)).toMatchObject({ level: 'watch' })
  })
})

describe('warnings, which are not one per problem', () => {
  const warnings = (): ReturnType<typeof parseWarnings> => parseWarnings(read('warnings.txt'))

  it('keeps a message containing spaces, quotes and commas whole', () => {
    const pull = warnings().find((w) => w.message.startsWith('Failed to pull image'))!
    expect(pull.message).toContain('docker.io/library/busybox:1.36-does-not-exist: not found')
    expect(pull.reason).toBe('Failed')
    expect(pull.kind).toBe('Pod')
  })

  // Measured: two pods failing on ONE image produced six rows -- the pull
  // error, ErrImagePull and ImagePullBackOff for each -- all reason `Failed`.
  it('collapses one cause reported many ways into one line per object', () => {
    const groups = groupWarnings(warnings())
    const perPod = groups.filter((g) => g.reason === 'Failed')
    expect(perPod).toHaveLength(2)
    expect(perPod[0].messages.length).toBeGreaterThan(1)
  })

  // Three rows for this pod, each carrying the cluster's own count of 4.
  it('sums the counts the cluster kept rather than counting rows', () => {
    const g = groupWarnings(warnings()).find((x) => x.reason === 'Failed')!
    expect(g.count).toBe(12)
  })

  // Emitted by the kubelet against the node at startup and never withdrawn. It
  // sat above both real failures in the raw fixture.
  it('drops the warning every cluster of this shape always has', () => {
    expect(ADDON_WARNING_NOISE.has('InvalidDiskCapacity')).toBe(true)
    expect(groupWarnings(warnings()).some((g) => g.reason === 'InvalidDiskCapacity')).toBe(false)
    expect(groupWarnings(warnings(), true).some((g) => g.reason === 'InvalidDiskCapacity')).toBe(true)
  })

  it('puts the most recent group first', () => {
    const g = groupWarnings(warnings())
    expect(g[0].last >= g[g.length - 1].last).toBe(true)
  })
})

describe('the one-shot rollout status', () => {
  it('never builds a command that could block forever', () => {
    expect(rolloutStatusCommand('ds/cni-like', 20)).toBe('rollout status ds/cni-like --timeout=20s')
    // A non-positive deadline is not a deadline, so it is floored rather than
    // passed through. Not measured against kubectl: the point is that this
    // builder cannot emit one, whatever kubectl would do with it.
    expect(rolloutStatusCommand('ds/x', 0)).toContain('--timeout=1s')
    expect(rolloutStatusCommand('ds/x', -5)).toContain('--timeout=1s')
  })

  const shot = (f: string): { out: string; code: number } => {
    const lines = read(f).trim().split('\n')
    const last = lines[lines.length - 1]
    return { out: lines.slice(0, -1).join('\n'), code: Number(last.replace('exit=', '')) }
  }

  it('reads a clean finish as done', () => {
    const s = shot('rollout-ok.txt')
    expect(parseRolloutStatus(s.out, s.code)).toMatchObject({ done: true, timedOut: false })
  })

  it('reads a timeout as neither done nor a verdict on the add-on', () => {
    const s = shot('rollout-timedout.txt')
    expect(parseRolloutStatus(s.out, s.code)).toMatchObject({ done: false, timedOut: true })
  })

  // Measured, and the reason `done` is not just `exitCode === 0`: with
  // `--watch=false` kubectl printed "Waiting for ... 0 of 1 updated pods are
  // available..." and exited 0. Trusting the exit code alone reports a success
  // for an add-on that has never started.
  it('does not call an unfinished rollout done just because kubectl exited 0', () => {
    const s = shot('rollout-nowatch.txt')
    expect(s.code).toBe(0)
    expect(parseRolloutStatus(s.out, s.code).done).toBe(false)
  })
})
