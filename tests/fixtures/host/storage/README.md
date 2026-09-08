# Storage layout (roadmap item 46)

## Provenance

| File | Source |
|---|---|
| `ubuntu-2404-docker-k3s.txt` | A **real Ubuntu 24.04.4 host running both Docker and k3s** |
| `debian12-container-bind-mounts.txt` | A `debian:12` container whose root is an overlay |
| `macos-bsd-df.txt` | A **BSD userland**, standing in for the `freebsd`/`netbsd`/`openbsd` targets in this build's distro allow-list |

## What the BSD reading found

**BSD `df` rejects `--output`**, exactly as it rejected `-P` beside it. Before this
fixture the GNU section came back empty and the whole read reported *no
filesystems* on every BSD target. `df -Y -k` is the form that carries a Type
column, which is what all the filtering is built on. Both forms are always sent:
each engine rejects the other's flag with "invalid option" and writes nothing, so
exactly one section fills.

**One listing contained both parsing failures at once**, which is why the fields are
now located by anchoring on the first run of digits rather than counted from either
end:

```
map auto_home   autofs   0 0 0 100% 0 0 -   /System/Volumes/Data/home
/dev/disk10s1   hfs      406196 ...         /Volumes/OpsMaxx 0.14.0-arm64
```

The first has a **source** containing a space; the second has a **target**
containing spaces.

**`devfs` reports 382 blocks at 100%** — permanently full, and nothing anyone can do
about it. Every BSD host would have raised an alert on it, so the BSD pseudo names
are excluded alongside the Linux ones.

**Six APFS volumes report the same total AND the same available** (482797652 and
11531876 blocks) with different used figures, because they are volumes in one
container. They are real filesystems, so they are not dropped — but six rows each
saying "11 GB free" reads as 66 GB, and filling any one fills all six. `sharedPools`
groups on total *and* available together; grouping on size alone would call two
ordinary same-model disks a pool, which is covered by a constructed row.

Both are the verbatim output of `buildStorageLayoutCommand()`.

## The finding that decided the shape

That host's `df` lists **21 filesystems**. Eight are container overlays and every
one reports the same size, the same used figure and the same `14%` as `/`, because
that is the filesystem underneath them. Ten are tmpfs. **Three are real:**

```
/dev/sda1   ext4  202051056  14%  /
/dev/sda16  ext4     901520  15%  /boot
/dev/sda15  vfat     106832   6%  /boot/efi
```

So rendering `df` renders 85% noise, and worse, renders *one* filesystem at 14% as
*nine* filesystems at 14% — any threshold fires nine times for one problem.

**The filtering happens in the parser, not the shell.** `df -x overlay` would have
been one flag and would have made the exclusion invisible: three rows, and no way
to know eighteen were dropped or why. The headline always carries the count.

## A bug this fixture caught

The first version of the builder passed `df -P --output=…`. `df` refuses that —
*"options -P and --output are mutually exclusive"* — and prints **nothing**, so the
first recording had an empty section. That is the whole argument for recording
fixtures by running the builder rather than by hand.

## LVM

`vgs --reportformat json` runs, exits 0 and returns `{"report":[{"vg":[]}]}`. The
tools are installed and there are no volume groups — a **measurement**, and a
different fact from a host with no LVM tooling. Only the first licenses the
sentence "there is no LVM here", which is why `command -v` runs first and a missing
binary reports `no-tool`.

## What could not be captured

* **A duplicate device source.** Neither host has one: the Ubuntu host lists
  `sda1`/`sda15`/`sda16` exactly once each, and Docker Desktop *deduplicates* a
  doubled bind mount, so `-v /tmp:/mnt/a -v /tmp:/mnt/b` shows only `/mnt/a`. A
  bind mount on an ordinary Linux host does list the same device twice and would
  double that host's apparent capacity, so the rule is kept and tested with a
  CONSTRUCTED row, labelled in the test.
* **Software RAID.** No array on either host — `/proc/mdstat` has the personalities
  line and `unused devices: <none>`. The array cases, including the indented
  `resync=DELAYED` line that a loose pattern misreads as a second array, are
  CONSTRUCTED and labelled.
* **`/boot` under real pressure.** It sits at 15%. The promotion rule is tested
  with a CONSTRUCTED pair where `/` is the fuller of the two, because the real host
  has `/boot` higher anyway and would prove nothing.
* **LVM in use.** No volume groups here, so the `present` branch is exercised with
  a constructed report.
