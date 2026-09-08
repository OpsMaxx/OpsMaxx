import type { JobSpec } from './jobs'

// Growing a logical volume and the filesystem on it.
//
// ======================================================================
// MEASURED ON A REAL LVM STACK, BUILT ON LOOPBACK FILES FOR THE PURPOSE
// ======================================================================
//
// Two 2 GB loop devices, one volume group, an ext4 volume and an xfs volume,
// both mounted. Every rule below is a recorded exit code and a recorded
// message, not a reading of the manual.
//
// ======================================================================
// IT ONLY GROWS, AND SHRINKING IS REFUSED BY NAME
// ======================================================================
//
// Not caution. Two measurements:
//
//   lvreduce -r -L 512M /dev/spvg/lvxfs
//     -> fsadm: Xfs filesystem shrinking is unsupported.   exit 5
//
//   lvreduce -r -L 512M /dev/spvg/lvext   (mounted)
//     -> Do you want to unmount "/mnt/spext" ? [Y|n]       INTERACTIVE
//        fsadm: Cannot proceed with mounted filesystem.    exit 5
//
// XFS CANNOT SHRINK AT ALL, ever, by any path. And ext4 can only shrink
// offline -- so the tool ASKS TO UNMOUNT THE FILESYSTEM, interactively, in the
// middle of a command a job runner would be running unattended. Answering that
// prompt automatically is the one thing this must never do: `-y` there means
// "yes, unmount the live filesystem", and the volume somebody wants to shrink
// is by definition one with data on it.
//
// So there is no shrink path, no `--yes`, and no `-f`. The command is
// `lvextend -r` with a POSITIVE size and nothing else.
//
// ======================================================================
// THE THREE FAILURES SHARE ONE EXIT CODE
// ======================================================================
//
// `lvextend`/`lvreduce` exit 5 for all of: xfs shrink, ext4 shrink while
// mounted, and not enough free space --
//
//   Insufficient free space: 2250 extents needed, but only 638 available
//
// -- so the exit code cannot tell an operator which happened, and this plans
// against a PREFLIGHT rather than running the command to find out. The free
// space is read first and the refusal is issued before anything is run.
//
// ======================================================================
// WHAT DOES *NOT* NEED A RULE
// ======================================================================
//
// Being unmounted does not block a grow, which was worth checking rather than
// assuming: `lvextend -r` on an unmounted xfs exited 0 and grew it, because
// fsadm mounts it temporarily to run `xfs_growfs`. (`xfs_growfs` alone on an
// unmounted volume is exit 1, "not a mounted XFS filesystem" -- which is why
// this drives `lvextend -r` rather than calling the per-filesystem tools.)

/** Filesystems this build knows how to grow, because it grew them. */
export const GROWABLE_FSTYPES = ['ext4', 'ext3', 'ext2', 'xfs'] as const
export type GrowableFstype = (typeof GROWABLE_FSTYPES)[number]

export const LV_MARKERS = {
  vgs: '===SP-LV-VGS===',
  lvs: '===SP-LV-LVS===',
  blk: '===SP-LV-BLK==='
} as const

/**
 * The preflight.
 *
 * Read-only and unprivileged where it can be: `vgs`/`lvs` need root on most
 * hosts, so this is expected to run through the same escalation the rest of the
 * fleet reads use, and it changes nothing either way.
 */
export function buildLvGrowPreflightCommand(): string {
  return [
    `echo "${LV_MARKERS.vgs}"; vgs --reportformat json --units b -o vg_name,vg_free,vg_size 2>/dev/null || true`,
    `echo "${LV_MARKERS.lvs}"; lvs --reportformat json --units b -o lv_name,vg_name,lv_size,lv_path 2>/dev/null || true`,
    // `findmnt <target>` returned nothing for these mounts; `lsblk` on the LV
    // path answers name, type and mountpoint in one line. Measured both.
    `echo "${LV_MARKERS.blk}"; lsblk -rno NAME,FSTYPE,MOUNTPOINT 2>/dev/null || true`
  ].join('; ')
}

export interface VolumeGroup {
  name: string
  freeBytes: number
  sizeBytes: number
}

export interface LogicalVolume {
  name: string
  vg: string
  path: string
  sizeBytes: number
  /** From lsblk, or null when it could not be joined. */
  fstype: string | null
  mountpoint: string | null
}

export interface LvPreflight {
  groups: VolumeGroup[]
  volumes: LogicalVolume[]
  /** True when LVM answered at all. False is "no LVM here", which is not the
   *  same as "this host has no volumes to grow" only in the sense that both
   *  end in a refusal -- but they get different sentences. */
  lvmPresent: boolean
}

function section(output: string, marker: string): string {
  const i = output.indexOf(marker)
  if (i === -1) return ''
  const rest = output.slice(i + marker.length)
  const next = rest.search(/^===SP-LV-/m)
  return next === -1 ? rest : rest.slice(0, next)
}

/** `805306368B` -> 805306368. LVM's `--units b` suffixes every number. */
function lvmBytes(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = v.match(/^(\d+(?:\.\d+)?)B?$/)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n) : null
}

export function parseLvPreflight(output: string): LvPreflight {
  const groups: VolumeGroup[] = []
  const volumes: LogicalVolume[] = []
  let lvmPresent = false

  try {
    const raw = JSON.parse(section(output, LV_MARKERS.vgs).trim()) as {
      report?: { vg?: Record<string, string>[] }[]
    }
    lvmPresent = true
    for (const vg of raw.report?.flatMap((r) => r.vg ?? []) ?? []) {
      const freeBytes = lvmBytes(vg.vg_free)
      const sizeBytes = lvmBytes(vg.vg_size)
      if (typeof vg.vg_name !== 'string' || freeBytes === null || sizeBytes === null) continue
      groups.push({ name: vg.vg_name, freeBytes, sizeBytes })
    }
  } catch {
    // Not JSON: no LVM, or the read was refused. Either way nothing is planned.
  }

  // `NAME FSTYPE MOUNTPOINT`, where an LVM volume's NAME is `vg-lv`.
  const blk = new Map<string, { fstype: string | null; mountpoint: string | null }>()
  for (const line of section(output, LV_MARKERS.blk).split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 1 || f[0] === '') continue
    blk.set(f[0], {
      fstype: f[1] !== undefined && f[1] !== '' ? f[1] : null,
      mountpoint: f[2] !== undefined && f[2] !== '' ? f[2] : null
    })
  }

  try {
    const raw = JSON.parse(section(output, LV_MARKERS.lvs).trim()) as {
      report?: { lv?: Record<string, string>[] }[]
    }
    for (const lv of raw.report?.flatMap((r) => r.lv ?? []) ?? []) {
      const sizeBytes = lvmBytes(lv.lv_size)
      if (
        typeof lv.lv_name !== 'string' ||
        typeof lv.vg_name !== 'string' ||
        typeof lv.lv_path !== 'string' ||
        sizeBytes === null
      ) {
        continue
      }
      // lsblk names a device-mapper volume `vg-lv`, not by its /dev/vg/lv path.
      const joined = blk.get(`${lv.vg_name}-${lv.lv_name}`)
      volumes.push({
        name: lv.lv_name,
        vg: lv.vg_name,
        path: lv.lv_path,
        sizeBytes,
        fstype: joined?.fstype ?? null,
        mountpoint: joined?.mountpoint ?? null
      })
    }
  } catch {
    /* same */
  }
  return { groups, volumes, lvmPresent }
}

export type LvGrowRefusal =
  | 'no-lvm'
  | 'unknown-volume'
  | 'not-a-grow'
  | 'insufficient-space'
  | 'unknown-filesystem'
  | 'unreadable'

export const LV_GROW_REFUSAL_HELP: Record<LvGrowRefusal, string> = {
  'no-lvm':
    'This host reports no LVM volume groups, so there is nothing to extend. A plain partition cannot be grown this way — it has to be repartitioned first, which is not something this does.',
  'unknown-volume': 'That logical volume is not in this host’s own list of volumes.',
  'not-a-grow':
    'This only grows. XFS CANNOT BE SHRUNK AT ALL — measured: `fsadm: Xfs filesystem shrinking is unsupported`. ext4 can be shrunk only while unmounted, and the tool asks INTERACTIVELY whether to unmount the live filesystem to do it. Answering that automatically is the one thing an unattended job must never do, so there is no shrink path here at all.',
  'insufficient-space':
    'The volume group does not have that much free space. Measured, `lvextend` reports this as `Insufficient free space: N extents needed, but only M available` and exits 5 — the same exit code it uses for a refused shrink — so this is checked before anything runs rather than discovered afterwards.',
  'unknown-filesystem':
    'This build only grows ext2/3/4 and xfs, because those are the ones it has grown. Anything else would be running an unverified resize on somebody’s data.',
  unreadable:
    'The volume groups could not be read, so neither the free space nor the filesystem is known. Nothing is planned from a failed read.'
}

export interface LvGrowPlan {
  ok: boolean
  refusal?: LvGrowRefusal
  spec: JobSpec | null
  /** What the operator is told before they confirm. */
  caveats: string[]
  volume?: LogicalVolume
  /** Bytes the volume would be after the grow. */
  newSizeBytes?: number
}

/** LVM takes a size suffix; bytes are exact and need no rounding decision. */
const addArg = (bytes: number): string => `+${bytes}b`

/**
 * Plan a grow.
 *
 * Everything is decided from the preflight. Nothing here runs a command to find
 * out whether it will work, because the three ways it fails share exit 5 and
 * two of them are irreversible questions asked of a live filesystem.
 */
export function planLvGrow(
  pre: LvPreflight | null,
  lvPath: string,
  addBytes: number
): LvGrowPlan {
  const no = (refusal: LvGrowRefusal): LvGrowPlan => ({ ok: false, refusal, spec: null, caveats: [] })

  if (pre === null) return no('unreadable')
  if (!pre.lvmPresent) return no('unreadable')
  if (pre.groups.length === 0) return no('no-lvm')
  // Zero is not a grow either: it would run a command that changes nothing and
  // report success, which reads as "it worked" for a request that did nothing.
  if (!Number.isFinite(addBytes) || addBytes <= 0) return no('not-a-grow')

  const volume = pre.volumes.find((v) => v.path === lvPath)
  if (volume === undefined) return no('unknown-volume')

  const group = pre.groups.find((g) => g.name === volume.vg)
  if (group === undefined) return no('unreadable')
  if (addBytes > group.freeBytes) {
    return { ...no('insufficient-space'), volume }
  }
  if (
    volume.fstype === null ||
    !(GROWABLE_FSTYPES as readonly string[]).includes(volume.fstype)
  ) {
    return { ...no('unknown-filesystem'), volume }
  }

  const caveats = [
    // First, because it is the thing an operator has not thought about: this
    // cannot be undone by running it backwards.
    `Growing is one-way. ${volume.fstype === 'xfs' ? 'XFS can never be shrunk again by any means' : 'ext4 can only be shrunk again with the filesystem unmounted'}, so the volume group loses this space to ${volume.name} permanently.`,
    `${volume.vg} has ${group.freeBytes} bytes free and this takes ${addBytes} of them.`,
    volume.mountpoint !== null
      ? `${volume.name} is mounted at ${volume.mountpoint} and stays mounted: the resize is online.`
      : `${volume.name} is not mounted. It is still grown — fsadm mounts it briefly to resize the filesystem, which was measured rather than assumed.`
  ]

  return {
    ok: true,
    spec: {
      kind: 'command',
      title: `Grow ${volume.vg}/${volume.name} by ${addBytes} bytes`,
      steps: [
        {
          // `-r` resizes the filesystem with the volume. NO `--yes` and NO
          // `-f`: the only prompt this command can raise is the one that asks
          // to unmount a live filesystem, and it must be allowed to fail
          // rather than be answered.
          command: `sudo -n lvextend -r -L ${addArg(addBytes)} ${shellQuote(volume.path)}`
        },
        // Ends with the host saying what the volume is now, which is the only
        // honest way to end a resize.
        { command: `sudo -n lvs --units b -o lv_name,vg_name,lv_size ${shellQuote(volume.path)}` }
      ]
    },
    caveats,
    volume,
    newSizeBytes: volume.sizeBytes + addBytes
  }
}

/** LVM paths are `/dev/vg/lv`; anything else is refused rather than escaped. */
function shellQuote(path: string): string {
  if (!/^\/dev\/[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+$/.test(path)) {
    throw new Error('refusing to build a command for a path that is not a logical volume')
  }
  return `'${path}'`
}
