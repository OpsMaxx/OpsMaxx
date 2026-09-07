import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  PSEUDO_FSTYPES,
  sharedPools,
  STORAGE_MARKERS,
  buildStorageLayoutCommand,
  parseDf,
  parseLvm,
  parseMdstat,
  parseStorageLayout,
  pressingMounts,
  storageHeadline
} from '../src/shared/storageLayout'

// Item 46's storage row, measured on a REAL Ubuntu 24.04.4 host that runs both
// Docker and k3s -- which is what makes it worth recording: that host's `df`
// lists 21 filesystems and only 3 of them are somewhere bytes can go.

const read = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/host/storage/${n}`, import.meta.url)), 'utf8')

const HOST = read('ubuntu-2404-docker-k3s.txt')

describe('against the real host', () => {
  const s = parseStorageLayout(HOST)

  // THE finding. Eight container overlays all report the underlying
  // filesystem's numbers, so rendering `df` renders one filesystem nine times.
  it('keeps the three filesystems that can fill and drops eighteen that cannot', () => {
    expect(s.df.mounts.map((m) => m.target)).toEqual(['/', '/boot', '/boot/efi'])
    expect(s.df.excluded).toEqual([
      { fstype: 'tmpfs', count: 10 },
      { fstype: 'overlay', count: 8 }
    ])
    expect(s.df.unreadable).toBe(0)
  })

  it('reads the real numbers off the real rows', () => {
    const root = s.df.mounts.find((m) => m.target === '/')!
    expect(root.fstype).toBe('ext4')
    expect(root.usePct).toBe(14)
    expect(root.inodePct).toBe(2)
    expect(root.sizeKb).toBe(202051056)
  })

  // vfat prints `-` for inodes. That is not zero per cent.
  it('reads an inode column of `-` as unknown rather than zero', () => {
    const efi = s.df.mounts.find((m) => m.target === '/boot/efi')!
    expect(efi.fstype).toBe('vfat')
    expect(efi.inodePct).toBeNull()
    expect(efi.usePct).toBe(6)
  })

  // The measured LVM case: tools installed, `{"report":[{"vg":[]}]}`, exit 0.
  it('says LVM is installed with no volume groups, which is a measurement', () => {
    expect(s.lvm.state).toBe('none')
    expect(s.lvm.detail).toContain('no volume groups')
  })

  it('reads /proc/mdstat and finds no assembled array', () => {
    expect(s.mdstatRead).toBe(true)
    expect(s.raidArrays).toEqual([])
  })

  // Three out of twenty-one is correct and alarming-looking. An operator who is
  // not told why will assume the read is broken.
  it('always says what was left out', () => {
    const h = storageHeadline(s)
    expect(h).toContain('3 filesystem(s)')
    expect(h).toContain('18 excluded')
    expect(h).toContain('10 tmpfs, 8 overlay')
  })

  // /boot is 913MB with 719MB free; / is 200GB with 174GB free. At the same
  // percentage they are not the same problem, and a full /boot half-installs a
  // kernel -- which is what the kernel read next door describes.
  it('puts /boot ahead of / at the same pressure', () => {
    expect(pressingMounts(s, 10).map((m) => m.target)).toEqual(['/boot', '/'])
  })

  it('reports nothing pressing at a real threshold on this host', () => {
    expect(pressingMounts(s)).toEqual([])
  })

  // CONSTRUCTED, because the real host has /boot at 15% and / at 14% -- so
  // ordinary descending order already puts /boot first there and proves
  // nothing. Promotion only shows when / is the FULLER of the two.
  it('still puts /boot first when / is the fuller filesystem', () => {
    const df = [
      'Filesystem     Type    1K-blocks     Used     Avail Use% IUse% Mounted on',
      '/dev/sda1      ext4    202051056 27705568 174329104  97%    2% /',
      '/dev/sda16     ext4       901520   119384    719008  88%    2% /boot'
    ].join('\n')
    const one = parseStorageLayout(`${STORAGE_MARKERS.df}\n${df}\n`)
    expect(pressingMounts(one, 85).map((m) => m.target)).toEqual(['/boot', '/'])
  })
})

describe('what df is asked for', () => {
  // MEASURED: `df` refuses with "options -P and --output are mutually
  // exclusive" and prints NOTHING. The first recording of the fixture had an
  // empty section for exactly this reason.
  it('does not pass -P, which df refuses alongside --output', () => {
    expect(buildStorageLayoutCommand()).not.toContain('df -P')
    expect(buildStorageLayoutCommand()).toContain('df --output=')
  })

  // Filtering in the shell would make the exclusion invisible: three rows and
  // no way to know eighteen were dropped.
  it('excludes nothing in the shell, so the parser can count what it drops', () => {
    const cmd = buildStorageLayoutCommand()
    expect(cmd).not.toContain('-x overlay')
    expect(cmd).not.toContain('-x tmpfs')
  })

  it('never escalates and lets each section fail alone', () => {
    const cmd = buildStorageLayoutCommand()
    expect(cmd).not.toContain('sudo')
    for (const m of Object.values(STORAGE_MARKERS)) expect(cmd).toContain(m)
  })

  // A missing binary and an empty report are different answers.
  it('checks the LVM tools exist before believing an empty report', () => {
    expect(buildStorageLayoutCommand()).toContain('command -v vgs')
    expect(buildStorageLayoutCommand()).toContain('NOTOOL')
  })
})

describe('LVM, in five words', () => {
  const empty = '{"report":[{"vg":[]}]}'

  it('separates no volume groups from no tooling', () => {
    expect(parseLvm(empty, '').state).toBe('none')
    expect(parseLvm('NOTOOL', '').state).toBe('no-tool')
    // Only the first licenses "there is no LVM here".
    expect(parseLvm('NOTOOL', '').detail).toContain('not established')
  })

  it('separates a refusal and unparseable output from an absence', () => {
    expect(parseLvm('FAILED', '').state).toBe('failed')
    expect(parseLvm('not json at all', '').state).toBe('unknown')
    expect(parseLvm('', '').state).toBe('unknown')
  })

  it('names the groups when there are some', () => {
    const vg = '{"report":[{"vg":[{"vg_name":"ubuntu-vg"},{"vg_name":"data"}]}]}'
    const r = parseLvm(vg, '')
    expect(r.state).toBe('present')
    expect(r.groups).toEqual(['ubuntu-vg', 'data'])
    expect(r.detail).toContain('ubuntu-vg, data')
  })
})

describe('rows the measured hosts could not supply', () => {
  // CONSTRUCTED. Neither the Ubuntu host nor a Docker Desktop container has a
  // duplicate device source: Docker Desktop deduplicates a doubled bind mount,
  // and the Ubuntu host has each of sda1/15/16 exactly once. A bind mount on an
  // ordinary Linux host DOES list the same device twice, and counting it twice
  // would double that host's apparent capacity.
  it('drops a repeated device rather than counting its bytes twice', () => {
    const df = [
      'Filesystem     Type    1K-blocks     Used     Avail Use% IUse% Mounted on',
      '/dev/sda1      ext4    202051056 27705568 174329104  14%    2% /',
      '/dev/sda1      ext4    202051056 27705568 174329104  14%    2% /var/lib/docker'
    ].join('\n')
    const r = parseDf(df)
    expect(r.mounts.map((m) => m.target)).toEqual(['/'])
    expect(r.excluded).toEqual([{ fstype: 'duplicate', count: 1 }])
  })

  // CONSTRUCTED: /proc/mdstat on a host with an assembled array.
  it('names software RAID arrays when there are any', () => {
    const md = [
      'Personalities : [raid1]',
      'md0 : active raid1 sdb1[1] sda1[0]',
      '      976630464 blocks super 1.2 [2/2] [UU]',
      'unused devices: <none>'
    ].join('\n')
    expect(parseMdstat(md)).toEqual(['md0'])
  })

  // CONSTRUCTED, and the reason the pattern is ANCHORED to the start of a line.
  // An array declaration begins the line; mdadm's continuation lines are
  // indented and can name OTHER arrays -- `resync=DELAYED` says which array it
  // is queued behind. Matching anywhere reports that one as assembled here too,
  // so a host with one array in resync and one delayed reads as three.
  it('ignores an array named on an indented continuation line', () => {
    const md = [
      'Personalities : [raid1]',
      'md0 : active raid1 sdb1[1] sda1[0]',
      '      976630464 blocks super 1.2 [2/2] [UU]',
      '      [>....................]  resync =  0.4% (4194304/976630464)',
      'md2 : active raid1 sdd1[1] sdc1[0]',
      '      976630464 blocks super 1.2 [2/2] [UU]',
      '      resync=DELAYED, waiting for md0',
      'unused devices: <none>'
    ].join('\n')
    expect(parseMdstat(md)).toEqual(['md0', 'md2'])
  })
})

describe('what it refuses to say', () => {
  // An empty df is a read that did not work. A host always has a root
  // filesystem while it is answering an SSH command.
  it('does not report a host with no filesystems as a host with none', () => {
    const s = parseStorageLayout(`${STORAGE_MARKERS.df}\n${STORAGE_MARKERS.vgs}\nNOTOOL\n`)
    expect(s.df.mounts).toEqual([])
    expect(storageHeadline(s)).toContain('read did not work')
  })

  it('counts a row it could not parse rather than dropping it silently', () => {
    const r = parseDf('Filesystem Type\ndf: /broken: Permission denied')
    expect(r.mounts).toEqual([])
    expect(r.unreadable).toBe(1)
  })

  // overlay is the one that matters; the rest are memory or kernel backed.
  it('names overlay among the types that are never a disk', () => {
    expect(PSEUDO_FSTYPES.has('overlay')).toBe(true)
    expect(PSEUDO_FSTYPES.has('tmpfs')).toBe(true)
    expect(PSEUDO_FSTYPES.has('ext4')).toBe(false)
    expect(PSEUDO_FSTYPES.has('xfs')).toBe(false)
  })
})

describe('a container, measured', () => {
  const s = parseStorageLayout(read('debian12-container-bind-mounts.txt'))

  // Its root IS an overlay, so the filtering removes the container's own
  // filesystem -- correctly: it is the host's disk underneath.
  it('drops the container’s overlay root and keeps what is really backed', () => {
    expect(s.df.mounts.map((m) => m.target)).not.toContain('/')
    expect(s.df.excluded.some((e) => e.fstype === 'overlay')).toBe(true)
  })
})

// A BSD USERLAND. `freebsd`, `netbsd` and `openbsd` are all in this build's
// distro allow-list, and BSD `df` rejects `--output` exactly as it rejected `-P`
// beside it -- so before this fixture the GNU section came back empty and the
// whole read reported no filesystems on every one of them.
describe('BSD df, which the allow-listed BSD targets use', () => {
  const s = parseStorageLayout(read('macos-bsd-df.txt'))

  it('falls back to the form that carries a Type column', () => {
    expect(s.df.flavour).toBe('bsd')
    expect(s.df.mounts.length).toBeGreaterThan(10)
    expect(buildStorageLayoutCommand()).toContain('df -Y -k')
  })

  // Both engines reject the other's flag with "invalid option" and write
  // nothing, so exactly one section fills on any given host.
  it('still prefers the GNU read where there is one', () => {
    expect(parseStorageLayout(read('ubuntu-2404-docker-k3s.txt')).df.flavour).toBe('gnu')
  })

  // BSD puts iused and ifree between the capacity and the inode percentage, so
  // the inode column is at a different offset from GNU's.
  it('reads the inode percentage from BSD’s own column', () => {
    const root = s.df.mounts.find((m) => m.target === '/')!
    expect(root.fstype).toBe('apfs')
    expect(root.usePct).toBeGreaterThan(0)
    expect(root.inodePct).toBe(0)
  })

  // `devfs` reports 382 blocks at 100% -- permanently full, and nothing anyone
  // can do about it. Every BSD host would have fired an alert on it.
  it('excludes the BSD pseudo filesystems by their own names', () => {
    expect(s.df.excluded.map((e) => e.fstype)).toContain('devfs')
    expect(s.df.mounts.some((m) => m.target === '/dev')).toBe(false)
  })

  // ONE listing, both failure modes. `map auto_home` has a SOURCE containing a
  // space, which shifts every field if you count from the left; the mounted
  // disk images have TARGETS containing spaces, which shift them if you count
  // from the right. Anchoring on the size column is what survives both.
  it('parses a row whose source has a space and one whose target has spaces', () => {
    expect(read('macos-bsd-df.txt')).toContain('map auto_home')
    // The autofs row is recognised well enough to be excluded as pseudo, which
    // only happens if `autofs` was read as the TYPE and not as the source.
    expect(s.df.excluded.map((e) => e.fstype)).toContain('autofs')

    const dmg = s.df.mounts.find((m) => m.target.startsWith('/Volumes/ShellPilot'))!
    expect(dmg.target).toMatch(/^\/Volumes\/ShellPilot \S+$/)
    expect(dmg.source).toMatch(/^\/dev\/disk\d+s\d+$/)
    expect(dmg.fstype).toBe('hfs')
  })

  // MEASURED: six APFS volumes report the same total AND the same available,
  // with different used figures, because they are volumes in one container.
  // They are real filesystems, so they are not dropped -- but six rows each
  // saying "11 GB free" reads as 66 GB, and filling any one fills all six.
  it('says which mounts share one pool of free space', () => {
    const pools = sharedPools(s.df.mounts)
    expect(pools[0].length).toBe(6)
    expect(pools[0].map((m) => m.target)).toContain('/')
    expect(storageHeadline(s)).toContain('share one pool of free space')
    expect(storageHeadline(s)).toContain('filling any one fills all of them')
  })

  // CONSTRUCTED: no mount on either measured host has a size twin with
  // different free space. Grouping on size ALONE would call these a pool, and
  // they are two ordinary disks that happen to be the same model.
  it('does not call two same-sized disks a pool when their free space differs', () => {
    const df = [
      'Filesystem     Type  1024-blocks     Used     Avail Use% IUse% Mounted on',
      '/dev/sdb1      ext4    500000000 10000000 490000000   2%    1% /data1',
      '/dev/sdc1      ext4    500000000 90000000 410000000  18%    1% /data2'
    ].join('\n')
    const two = parseStorageLayout(`${STORAGE_MARKERS.df}\n${df}\n`)
    expect(two.df.mounts).toHaveLength(2)
    expect(sharedPools(two.df.mounts)).toEqual([])
  })

  it('claims no shared pool on a host that has none', () => {
    expect(sharedPools(parseStorageLayout(read('ubuntu-2404-docker-k3s.txt')).df.mounts)).toEqual([])
    expect(storageHeadline(parseStorageLayout(read('ubuntu-2404-docker-k3s.txt')))).not.toContain(
      'share one pool'
    )
  })

  // Neither `df` answering is a failed read, not a host with no disks.
  it('reports no flavour at all as a failed read', () => {
    const none = parseStorageLayout(`${STORAGE_MARKERS.df}\n${STORAGE_MARKERS.dfBsd}\n`)
    expect(none.df.flavour).toBeNull()
    expect(storageHeadline(none)).toContain('read did not work')
  })
})

describe('the wiring', () => {
  const code = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

  it('is asked for per server rather than added to the hourly sweep', () => {
    expect(code('../src/main/index.ts')).toContain("ipcMain.handle('fleet:storage'")
    const svc = code('../src/main/services/hostFacts.ts')
    expect(svc).toContain('async storage(')
    // A transport failure is not a host answer, and must not become "no
    // filesystems".
    expect(svc).toContain("return { error: r.error ?? 'could not reach the server' }")
  })

  // The trend above it is the ROOT filesystem only, which is the gap this read
  // closes. Saying so is the point of putting them together.
  it('says on screen that the trend beside it is root only', () => {
    const panel = code('../src/renderer/src/components/monitor/CapacityPanel.tsx')
    expect(panel).toContain('the root filesystem')
    expect(panel).toContain('storageHeadline(storage)')
  })

  // The panel already documents this hazard for its trends: a read landing
  // under a heading that has since changed.
  it('clears the filesystems when the server changes', () => {
    const panel = code('../src/renderer/src/components/monitor/CapacityPanel.tsx')
    const onChange = panel.slice(panel.indexOf('setServerId(e.target.value)'))
    expect(onChange.slice(0, 400)).toContain('setStorage(null)')
  })

  // An SSH channel opened because somebody used a dropdown is a probe nobody
  // asked for.
  it('does not read on mount or on every server change', () => {
    const panel = code('../src/renderer/src/components/monitor/CapacityPanel.tsx')
    expect(panel).toContain('onClick={() => void loadStorage()}')
    expect(panel).not.toMatch(/useEffect\([^)]*loadStorage/)
  })

  it('renders a failed read as an alarm rather than an empty table', () => {
    const panel = code('../src/renderer/src/components/monitor/CapacityPanel.tsx')
    expect(panel).toContain("'error' in storage")
    expect(panel).toContain('The filesystems could not be read')
  })
})
