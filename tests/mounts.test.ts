import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { parseMounts, worstInodeMount, worstMount, PSEUDO_FS } from '../src/shared/mounts'

// Item 47, step 2. Every assertion here corresponds to something a real `df`
// did: Debian 12 and Alpine 3, both through Docker, captured as fixtures.

const DIR = fileURLToPath(new URL('./fixtures/mounts', import.meta.url))
const fixture = (n: string): string => readFileSync(join(DIR, n), 'utf8')

describe('what df says that a naive reader gets wrong', () => {
  // Debian 12 mounts a 4 KB tmpfs on /proc/scsi with one inode, one used,
  // IUse% 100%. Every container and every systemd host has several. A rule
  // that alarmed on a full filesystem without excluding these would fire on
  // every server, for ever, from the first sweep.
  it('drops the tmpfs that is permanently at 100% inodes', () => {
    const raw = fixture('debian12-inodes.txt')
    expect(raw).toContain('100% /proc/scsi')
    const mounts = parseMounts(fixture('debian12-blocks.txt'), raw)
    expect(mounts.map((m) => m.mount)).not.toContain('/proc/scsi')
    expect(mounts.every((m) => !PSEUDO_FS.has(m.type))).toBe(true)
  })

  // Alpine's df lists /dev/vda1 three times -- resolv.conf, hostname, hosts --
  // because a bind mount is a separate row for one device. Summing them
  // triples the estate's apparent disk; alerting per row alerts three times.
  it('reports one filesystem once, however many places it is mounted', () => {
    const raw = fixture('alpine-blocks.txt')
    expect(raw.match(/\/dev\/vda1/g)).toHaveLength(3)
    const mounts = parseMounts(raw)
    expect(mounts.filter((m) => m.device === '/dev/vda1')).toHaveLength(1)
  })

  it('keeps the shortest mount path, because that is the one an operator means', () => {
    // `/etc/hosts` at 61% is true and useless.
    const mounts = parseMounts(fixture('alpine-blocks.txt'))
    const vda = mounts.find((m) => m.device === '/dev/vda1')!
    expect(vda.mount).toBe('/etc/hosts')
    expect(vda.mount.length).toBeLessThanOrEqual('/etc/resolv.conf'.length)
  })

  it('reads busybox df as well as GNU df, which print different column widths', () => {
    for (const f of ['debian12-blocks.txt', 'alpine-blocks.txt']) {
      const mounts = parseMounts(fixture(f))
      expect(mounts.length, f).toBeGreaterThan(0)
      expect(mounts.every((m) => m.totalKb > 0), f).toBe(true)
    }
  })

  it('takes the percentage df printed rather than recomputing it', () => {
    // df rounds its own way, and a number disagreeing with `df` on the server
    // is indefensible in an argument about whether a disk is full.
    const mounts = parseMounts(fixture('debian12-blocks.txt'))
    expect(mounts[0].usedPercent).toBe(61)
  })

  it('joins the inode figures onto the right mount', () => {
    const mounts = parseMounts(fixture('debian12-blocks.txt'), fixture('debian12-inodes.txt'))
    const m = mounts.find((x) => x.device === '/dev/vda1')!
    expect(m.inodesTotal).toBe(3907584)
    expect(m.inodesUsedPercent).toBe(29)
  })

  it('leaves the inode figures null when they were not read, rather than zero', () => {
    // Zero would draw a filesystem as having no inodes used.
    const m = parseMounts(fixture('debian12-blocks.txt'))[0]
    expect(m.inodesTotal).toBeNull()
    expect(m.inodesUsedPercent).toBeNull()
  })
})

describe('the one mount that goes into the series', () => {
  // Forty mounts sampled per server is item A's 5x storage trap. Mounts are
  // facts; the worst of them is the number worth a series.
  it('is whichever fills first', () => {
    const mounts = parseMounts(
      [
        'Filesystem Type 1024-blocks Used Available Capacity Mounted on',
        '/dev/sda1 ext4 1000 100 900 10% /',
        '/dev/sdb1 xfs 1000 910 90 91% /data',
        '/dev/sdc1 ext4 1000 500 500 50% /var'
      ].join('\n')
    )
    expect(worstMount(mounts)!.mount).toBe('/data')
  })

  it('is null for a server with no real filesystem, which is not zero percent', () => {
    // A `df` nobody could read is not a server with an empty disk.
    expect(worstMount([])).toBeNull()
    expect(worstMount(parseMounts('Filesystem Type 1024-blocks Used Available Capacity Mounted on'))).toBeNull()
  })

  // A mail spool or a build cache runs out of inodes at 30% disk used, so the
  // two worsts are asked for separately.
  it('tracks the worst inode mount separately from the worst disk mount', () => {
    const blocks = [
      'Filesystem Type 1024-blocks Used Available Capacity Mounted on',
      '/dev/sda1 ext4 1000 900 100 90% /',
      '/dev/sdb1 ext4 1000 300 700 30% /var/spool'
    ].join('\n')
    const inodes = [
      'Filesystem Type Inodes IUsed IFree IUse% Mounted on',
      '/dev/sda1 ext4 1000 100 900 10% /',
      '/dev/sdb1 ext4 1000 970 30 97% /var/spool'
    ].join('\n')
    const mounts = parseMounts(blocks, inodes)
    expect(worstMount(mounts)!.mount).toBe('/')
    expect(worstInodeMount(mounts)!.mount).toBe('/var/spool')
  })

  it('has no worst inode mount when no inode figures were read', () => {
    expect(worstInodeMount(parseMounts(fixture('debian12-blocks.txt')))).toBeNull()
  })
})
