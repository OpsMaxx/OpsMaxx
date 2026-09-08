import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  GROWABLE_FSTYPES,
  LV_GROW_REFUSAL_HELP,
  LV_MARKERS,
  buildLvGrowPreflightCommand,
  parseLvPreflight,
  planLvGrow
} from '../src/shared/lvGrow'

// Item 46's storage WRITE half, measured on a real LVM stack built for it:
// two loop devices, one volume group, an ext4 volume and an xfs volume, both
// mounted. Every refusal below is a recorded exit code and message.
//
// The generated command was then RUN on that stack: 872415232B -> 1140850688B,
// exactly the requested +268435456, filesystem grown online while mounted.

const FIX = readFileSync(
  fileURLToPath(new URL('./fixtures/host/lvm/preflight-2vg-ext4-xfs.txt', import.meta.url)),
  'utf8'
)
const pre = (): ReturnType<typeof parseLvPreflight> => parseLvPreflight(FIX)

describe('the preflight, off the real stack', () => {
  it('reads the group’s free space in bytes', () => {
    const p = pre()
    expect(p.lvmPresent).toBe(true)
    expect(p.groups).toEqual([
      { name: 'spvg', freeBytes: 2_541_748_224, sizeBytes: 4_286_578_688 }
    ])
  })

  // lsblk names a device-mapper volume `vg-lv`, not by its /dev/vg/lv path,
  // which is the join this had to get right.
  it('joins each volume to its filesystem and mountpoint', () => {
    expect(pre().volumes).toEqual([
      {
        name: 'lvext',
        vg: 'spvg',
        path: '/dev/spvg/lvext',
        sizeBytes: 872_415_232,
        fstype: 'ext4',
        mountpoint: '/mnt/spext'
      },
      {
        name: 'lvxfs',
        vg: 'spvg',
        path: '/dev/spvg/lvxfs',
        sizeBytes: 872_415_232,
        fstype: 'xfs',
        mountpoint: '/mnt/spxfs'
      }
    ])
  })

  // `findmnt <target>` returned nothing for these mounts; lsblk answers in one
  // line. Both were tried.
  it('asks lsblk for the join rather than findmnt', () => {
    expect(buildLvGrowPreflightCommand()).toContain('lsblk -rno NAME,FSTYPE,MOUNTPOINT')
    expect(buildLvGrowPreflightCommand()).not.toContain('findmnt')
  })

  // A REAL state, and the test host's own: LVM installed, zero volume groups.
  // `storageLayout` measured exactly this — `{"report":[{"vg":[]}]}`, exit 0 —
  // and it is a different sentence from "LVM could not be read": there is
  // nothing to extend, and a plain partition cannot be grown this way at all.
  it('separates LVM present with no groups from LVM unreadable', () => {
    const empty = parseLvPreflight(
      `${LV_MARKERS.vgs}\n{"report":[{"vg":[]}]}\n${LV_MARKERS.lvs}\n${LV_MARKERS.blk}\n`
    )
    expect(empty.lvmPresent).toBe(true)
    expect(empty.groups).toEqual([])
    const p = planLvGrow(empty, '/dev/spvg/lvext', 1024)
    expect(p.refusal).toBe('no-lvm')
    expect(LV_GROW_REFUSAL_HELP['no-lvm']).toContain('plain partition cannot be grown')
  })

  it('reads a host with no LVM as unreadable rather than as no volumes', () => {
    const none = parseLvPreflight(`${LV_MARKERS.vgs}\n${LV_MARKERS.lvs}\n${LV_MARKERS.blk}\n`)
    expect(none.lvmPresent).toBe(false)
    expect(planLvGrow(none, '/dev/spvg/lvext', 1024).refusal).toBe('unreadable')
  })
})

describe('the command it builds — verified by running it', () => {
  const plan = (): ReturnType<typeof planLvGrow> =>
    planLvGrow(pre(), '/dev/spvg/lvext', 268_435_456)

  it('is the exact command that grew the real volume', () => {
    const p = plan()
    expect(p.ok).toBe(true)
    expect(p.spec!.steps[0].command).toBe(
      "sudo -n lvextend -r -L +268435456b '/dev/spvg/lvext'"
    )
    expect(p.newSizeBytes).toBe(1_140_850_688)
  })

  // `-r` resizes the filesystem with the volume. The absent flags are the
  // point: the only prompt this command can raise is the one asking to unmount
  // a live filesystem, and it must be allowed to fail rather than be answered.
  it('never passes --yes or -f', () => {
    const cmd = plan().spec!.steps[0].command
    expect(cmd).toContain('-r')
    expect(cmd).not.toContain('--yes')
    expect(cmd).not.toMatch(/\s-y\b/)
    expect(cmd).not.toMatch(/\s-f\b/)
  })

  it('ends with the host saying what the volume is now', () => {
    expect(plan().spec!.steps).toHaveLength(2)
    expect(plan().spec!.steps[1].command).toContain('lvs --units b')
  })

  // A path that is not an LVM volume path is refused rather than escaped.
  it('refuses to build a command for a path that is not a volume', () => {
    const bad = pre()
    bad.volumes[0] = { ...bad.volumes[0], path: '/dev/spvg/lv; rm -rf /' }
    expect(() => planLvGrow(bad, '/dev/spvg/lv; rm -rf /', 1024)).toThrow(/not a logical volume/)
  })
})

describe('what it refuses, and why', () => {
  // MEASURED: `lvreduce -r` on the xfs volume answered
  // `fsadm: Xfs filesystem shrinking is unsupported` and exited 5.
  // On the mounted ext4 volume it asked, INTERACTIVELY,
  // `Do you want to unmount "/mnt/spext" ? [Y|n]`.
  it('refuses every shrink, including zero', () => {
    for (const add of [-1, 0, -268_435_456]) {
      expect(planLvGrow(pre(), '/dev/spvg/lvext', add).refusal, String(add)).toBe('not-a-grow')
    }
    const help = LV_GROW_REFUSAL_HELP['not-a-grow']
    expect(help).toContain('XFS CANNOT BE SHRUNK AT ALL')
    expect(help).toContain('INTERACTIVELY')
    expect(help).toContain('unattended job must never do')
  })

  // Three different failures share exit 5, so the exit code cannot tell an
  // operator which happened — which is why free space is checked first.
  it('refuses a grow larger than the group has, before running anything', () => {
    const p = planLvGrow(pre(), '/dev/spvg/lvext', 2_541_748_225)
    expect(p.refusal).toBe('insufficient-space')
    expect(p.spec).toBeNull()
    expect(LV_GROW_REFUSAL_HELP['insufficient-space']).toContain('exits 5')
    expect(LV_GROW_REFUSAL_HELP['insufficient-space']).toContain('before anything runs')
  })

  it('allows exactly the free space and no more', () => {
    expect(planLvGrow(pre(), '/dev/spvg/lvext', 2_541_748_224).ok).toBe(true)
    expect(planLvGrow(pre(), '/dev/spvg/lvext', 2_541_748_225).ok).toBe(false)
  })

  it('refuses a filesystem this build has not grown', () => {
    const odd = pre()
    odd.volumes[0] = { ...odd.volumes[0], fstype: 'btrfs' }
    expect(planLvGrow(odd, '/dev/spvg/lvext', 1024).refusal).toBe('unknown-filesystem')
    // And one it could not read at all is the same refusal, not a guess.
    const blank = pre()
    blank.volumes[0] = { ...blank.volumes[0], fstype: null }
    expect(planLvGrow(blank, '/dev/spvg/lvext', 1024).refusal).toBe('unknown-filesystem')
    expect(GROWABLE_FSTYPES).toContain('xfs')
    expect(GROWABLE_FSTYPES).not.toContain('btrfs')
  })

  it('refuses a volume the host did not list', () => {
    expect(planLvGrow(pre(), '/dev/spvg/nope', 1024).refusal).toBe('unknown-volume')
  })
})

describe('what the operator is told first', () => {
  // The thing they have not thought about: this cannot be undone by running it
  // backwards.
  it('leads with the grow being one-way, in the filesystem’s own terms', () => {
    const ext = planLvGrow(pre(), '/dev/spvg/lvext', 1024).caveats[0]
    expect(ext).toContain('one-way')
    expect(ext).toContain('unmounted')

    const xfs = planLvGrow(pre(), '/dev/spvg/lvxfs', 1024).caveats[0]
    expect(xfs).toContain('never be shrunk again')
  })

  it('says how much of the group it spends', () => {
    expect(planLvGrow(pre(), '/dev/spvg/lvext', 1024).caveats[1]).toContain('2541748224 bytes free')
  })

  // Measured rather than assumed: `lvextend -r` on an UNMOUNTED xfs exited 0
  // and grew it, because fsadm mounts it briefly.
  it('says an unmounted volume is still grown, and how', () => {
    const un = pre()
    un.volumes[0] = { ...un.volumes[0], mountpoint: null }
    const c = planLvGrow(un, '/dev/spvg/lvext', 1024).caveats[2]
    expect(c).toContain('not mounted')
    expect(c).toContain('fsadm mounts it briefly')
    expect(c).toContain('measured rather than assumed')
  })

  it('says a mounted volume stays mounted', () => {
    expect(planLvGrow(pre(), '/dev/spvg/lvext', 1024).caveats[2]).toContain('stays mounted')
  })
})
