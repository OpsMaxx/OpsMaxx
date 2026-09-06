// What this host's disks and filesystems actually are.
//
// ======================================================================
// MEASURED ON A REAL UBUNTU 24.04.4 HOST RUNNING BOTH DOCKER AND k3s
// ======================================================================
//
// THE FINDING THAT DECIDES THE SHAPE: `df` on that host lists TWENTY-ONE
// filesystems, of which EIGHT are container overlays and every one of those
// eight reports the same size, the same used figure and the same 14% as `/`,
// because that is the filesystem underneath them. Three are real:
//
//     /dev/sda1   ext4  202051056  14%  /
//     /dev/sda16  ext4     901520  15%  /boot
//     /dev/sda15  vfat     106832   6%  /boot/efi
//
// So a panel that renders `df` renders eighty-five per cent noise, and worse,
// it renders "nine filesystems at 14%" for one filesystem at 14%. Any single
// alert threshold applied to that list fires nine times for one problem.
//
// THE FILTERING HAPPENS HERE, NOT IN THE SHELL. `df -x overlay` would have been
// one flag, and it would have made the exclusion invisible: the operator would
// see three rows and have no way to know that eighteen were dropped or why.
// The command reads everything and this file removes what it can name, and
// `excluded` carries the count and the reasons out to the UI.
//
// AND "NO LVM" IS A MEASUREMENT, NOT AN ABSENCE. On that host `vgs
// --reportformat json` runs, exits 0 and returns `{"report":[{"vg":[]}]}` -- the
// tools are installed and there are no volume groups. That is a different fact
// from a host with no LVM tooling at all, and only the first one licenses the
// sentence "there is no LVM here". A missing binary is `no-tool`.
//
// `/boot` IS ITS OWN HAZARD and is why this read matters beside the kernel one.
// The measured host's `/boot` is a separate 913 MB partition at 15%, and a
// `/boot` that fills is the classic way an apt upgrade half-installs a kernel.
// A read that only knows about `/` cannot see it coming.

export const STORAGE_MARKERS = {
  df: '===SP-STORE-DF===',
  lsblk: '===SP-STORE-LSBLK===',
  findmnt: '===SP-STORE-FINDMNT===',
  vgs: '===SP-STORE-VGS===',
  lvs: '===SP-STORE-LVS===',
  mdstat: '===SP-STORE-MDSTAT==='
} as const

/** Enough for a large host, and bounded so a pathological mount table cannot
 *  make this process hold a megabyte of overlay paths. */
export const STORAGE_MAX_ROWS = 400

export function buildStorageLayoutCommand(): string {
  return [
    // Everything, unfiltered. The exclusions are this file's job so that they
    // can be counted and explained -- see the header.
    //
    // NO `-P`: measured, `df` refuses with "options -P and --output are
    // mutually exclusive" and prints nothing at all. The first recording of the
    // fixture had an empty section for exactly that reason, which is the whole
    // argument for recording fixtures through the builder rather than by hand.
    `echo "${STORAGE_MARKERS.df}"; df --output=source,fstype,size,used,avail,pcent,ipcent,target 2>/dev/null | head -n ${STORAGE_MAX_ROWS} || true`,
    `echo "${STORAGE_MARKERS.lsblk}"; lsblk -J -o NAME,KNAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,ROTA,PKNAME 2>/dev/null || true`,
    `echo "${STORAGE_MARKERS.findmnt}"; findmnt -J -o TARGET,SOURCE,FSTYPE,OPTIONS 2>/dev/null || true`,
    // `command -v` first: a missing binary and an empty report are different
    // answers and only one of them means "there is no LVM here".
    `echo "${STORAGE_MARKERS.vgs}"; command -v vgs >/dev/null 2>&1 && (vgs --reportformat json 2>/dev/null || echo FAILED) || echo NOTOOL`,
    `echo "${STORAGE_MARKERS.lvs}"; command -v lvs >/dev/null 2>&1 && (lvs --reportformat json 2>/dev/null || echo FAILED) || echo NOTOOL`,
    `echo "${STORAGE_MARKERS.mdstat}"; cat /proc/mdstat 2>/dev/null || true`
  ].join('; ')
}

function section(output: string, marker: string): string {
  const i = output.indexOf(marker)
  if (i === -1) return ''
  const rest = output.slice(i + marker.length)
  const next = rest.search(/^===SP-STORE-/m)
  return next === -1 ? rest : rest.slice(0, next)
}

/**
 * Filesystem types that are never a disk somebody can fill.
 *
 * `overlay` is the one that matters and is the reason this list exists: eight
 * of the measured host's twenty-one rows were container overlays reporting the
 * underlying filesystem's numbers. The rest are memory or kernel-backed.
 */
export const PSEUDO_FSTYPES = new Set([
  'overlay',
  'tmpfs',
  'devtmpfs',
  'squashfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'bpf',
  'configfs',
  'fusectl',
  'ramfs',
  'autofs',
  'mqueue',
  'hugetlbfs',
  'binfmt_misc',
  'efivarfs',
  'nsfs',
  'fuse.lxcfs'
])

export interface MountRow {
  source: string
  fstype: string
  sizeKb: number | null
  usedKb: number | null
  availKb: number | null
  /** 0-100, or null when df printed `-` (which vfat does for inodes). */
  usePct: number | null
  inodePct: number | null
  target: string
}

export interface ExcludedGroup {
  fstype: string
  count: number
}

export interface DfRead {
  mounts: MountRow[]
  /** What was dropped, by type and count. Never silent: see the header. */
  excluded: ExcludedGroup[]
  /** Rows df printed that this could not parse at all. */
  unreadable: number
}

/**
 * A percentage column, or null.
 *
 * vfat prints `-` for inodes, and there is deliberately NO special case for it:
 * `Number('-')` is NaN and the finiteness check below already returns null. A
 * separate `t === '-'` branch would read as though it were the thing keeping
 * that promise, and mutating it away changed nothing -- so it is documented
 * here instead of asserted twice.
 */
const pct = (v: string): number | null => {
  const t = v.trim().replace('%', '')
  const n = Number(t)
  return t !== '' && Number.isFinite(n) ? n : null
}

const kb = (v: string): number | null => {
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/**
 * Parse `df`, keeping only filesystems that are a real place to put bytes.
 *
 * A duplicate SOURCE is dropped too, and that is separate from the type rule: a
 * bind mount shows the same device twice with identical numbers, and counting
 * it twice would double a host's apparent capacity.
 */
export function parseDf(text: string): DfRead {
  const mounts: MountRow[] = []
  const excludedBy = new Map<string, number>()
  const seenSource = new Set<string>()
  let unreadable = 0

  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('Filesystem')) continue
    // The target is last and may contain spaces; everything before it does not.
    const f = t.split(/\s+/)
    if (f.length < 8) {
      unreadable += 1
      continue
    }
    const [source, fstype, size, used, avail, use, iuse] = f
    const target = f.slice(7).join(' ')
    if (PSEUDO_FSTYPES.has(fstype)) {
      excludedBy.set(fstype, (excludedBy.get(fstype) ?? 0) + 1)
      continue
    }
    if (seenSource.has(source)) {
      excludedBy.set('duplicate', (excludedBy.get('duplicate') ?? 0) + 1)
      continue
    }
    seenSource.add(source)
    mounts.push({
      source,
      fstype,
      sizeKb: kb(size),
      usedKb: kb(used),
      availKb: kb(avail),
      usePct: pct(use),
      inodePct: pct(iuse),
      target
    })
  }
  const excluded = [...excludedBy]
    .map(([fstype, count]) => ({ fstype, count }))
    .sort((a, b) => b.count - a.count)
  return { mounts, excluded, unreadable }
}

export type LvmState = 'present' | 'none' | 'no-tool' | 'failed' | 'unknown'

export interface LvmRead {
  state: LvmState
  groups: string[]
  detail: string
}

/**
 * Whether this host uses LVM.
 *
 * FIVE WORDS, and the distinctions are the point. `none` is a MEASUREMENT --
 * the tools ran and reported no volume groups, which is what the test host did
 * -- while `no-tool` means nothing could be asked and `failed` means the tool
 * refused. Only `none` licenses "there is no LVM here"; the other two are
 * blind spots and say so.
 */
export function parseLvm(vgsText: string, lvsText: string): LvmRead {
  const raw = vgsText.trim()
  if (raw === '') return { state: 'unknown', detail: 'the volume-group read produced nothing', groups: [] }
  if (raw === 'NOTOOL') {
    return {
      state: 'no-tool',
      detail: 'LVM tools are not installed here, so whether this host uses LVM was not established.',
      groups: []
    }
  }
  if (raw === 'FAILED') {
    return { state: 'failed', detail: 'the volume-group read was refused', groups: [] }
  }
  let groups: string[]
  try {
    const parsed = JSON.parse(raw) as { report?: { vg?: { vg_name?: string }[] }[] }
    const vgs = parsed.report?.flatMap((r) => r.vg ?? []) ?? []
    groups = vgs.map((v) => v.vg_name ?? '').filter((n) => n !== '')
  } catch {
    return { state: 'unknown', detail: 'the volume-group read could not be parsed', groups: [] }
  }
  if (groups.length === 0) {
    return {
      state: 'none',
      // The measured case: tools present, `{"report":[{"vg":[]}]}`, exit 0.
      detail: 'LVM is installed and this host has no volume groups.',
      groups: []
    }
  }
  void lvsText
  return {
    state: 'present',
    detail: `This host has ${groups.length} volume group(s): ${groups.join(', ')}.`,
    groups
  }
}

export interface StorageLayout {
  df: DfRead
  lvm: LvmRead
  /** Software RAID arrays, by name. Empty with `mdstat` present means the
   *  module is loaded and nothing is assembled -- the measured host's case. */
  raidArrays: string[]
  mdstatRead: boolean
}

export function parseStorageLayout(output: string): StorageLayout {
  const mdstatText = section(output, STORAGE_MARKERS.mdstat)
  return {
    df: parseDf(section(output, STORAGE_MARKERS.df)),
    lvm: parseLvm(section(output, STORAGE_MARKERS.vgs), section(output, STORAGE_MARKERS.lvs)),
    raidArrays: parseMdstat(mdstatText),
    mdstatRead: mdstatText.trim() !== ''
  }
}

/** `/proc/mdstat` lists arrays as `md0 : active raid1 ...`. The measured host
 *  has the personalities line and `unused devices: <none>`, i.e. no arrays. */
export function parseMdstat(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(md\d+)\s*:/)
    if (m !== null) out.push(m[1])
  }
  return out
}

/**
 * The one line.
 *
 * IT ALWAYS SAYS WHAT WAS LEFT OUT. Three filesystems out of twenty-one is a
 * correct answer and an alarming-looking one, and an operator who is not told
 * that eighteen were container overlays will reasonably assume the read is
 * broken.
 */
export function storageHeadline(s: StorageLayout): string {
  const n = s.df.mounts.length
  if (n === 0) {
    return s.df.unreadable > 0
      ? 'No filesystem could be read from this host.'
      : 'This host reported no real filesystems, which means the read did not work rather than that it has none.'
  }
  const parts = [`${n} filesystem(s) that can actually fill up`]
  const dropped = s.df.excluded.reduce((a, e) => a + e.count, 0)
  if (dropped > 0) {
    const how = s.df.excluded.map((e) => `${e.count} ${e.fstype}`).join(', ')
    parts.push(`${dropped} excluded as pseudo or duplicate (${how})`)
  }
  parts.push(s.lvm.state === 'present' ? `LVM in use` : s.lvm.detail.replace(/\.$/, ''))
  if (s.raidArrays.length > 0) parts.push(`software RAID: ${s.raidArrays.join(', ')}`)
  return `${parts.join('. ')}.`
}

/**
 * Which mounts deserve attention, worst first.
 *
 * `/boot` IS PROMOTED. It is small, it is the one filesystem an unattended
 * upgrade can fill on its own, and a full `/boot` half-installs a kernel --
 * which is the failure the kernel read next door exists to describe. At 85% it
 * matters more than `/` at 85%, because `/` on the measured host has 174 GB
 * free at 14% and `/boot` has 719 MB.
 */
export function pressingMounts(s: StorageLayout, threshold = 85): MountRow[] {
  return s.df.mounts
    .filter((m) => (m.usePct ?? 0) >= threshold || (m.inodePct ?? 0) >= threshold)
    .sort((a, b) => {
      const boot = (m: MountRow): number => (m.target === '/boot' ? 1 : 0)
      if (boot(a) !== boot(b)) return boot(b) - boot(a)
      return (b.usePct ?? 0) - (a.usePct ?? 0)
    })
}
