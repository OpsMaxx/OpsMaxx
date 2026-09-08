# LVM grow (roadmap item 46, the storage write half)

## Provenance

Built for the purpose on the test host and **torn down afterwards**: two 2 GB
loopback files, one volume group `spvg`, an ext4 volume and an xfs volume, both
mounted. `preflight-2vg-ext4-xfs.txt` is the verbatim output of
`buildLvGrowPreflightCommand()` against it, with the host's own `sda`/`loop` rows
filtered out of the `lsblk` section so the fixture is about the stack under test.

## The command was not just built — it was run

```
sudo -n lvextend -r -L +268435456b '/dev/spvg/lvext'
```

`872415232B → 1140850688B`, exactly the requested +256 MB, filesystem grown
**online while mounted**. The test asserts that exact string.

## Why it only grows

Two measurements, not caution:

```
lvreduce -r -L 512M /dev/spvg/lvxfs
  -> fsadm: Xfs filesystem shrinking is unsupported.       exit 5

lvreduce -r -L 512M /dev/spvg/lvext        (mounted)
  -> Do you want to unmount "/mnt/spext" ? [Y|n]           INTERACTIVE
     fsadm: Cannot proceed with mounted filesystem.        exit 5
```

**XFS cannot shrink at all, by any path.** And ext4 shrinks only offline — so the
tool asks, *interactively*, whether to unmount a live filesystem, in the middle of
a command a job runner would be running unattended. `-y` there means "yes, unmount
the mounted filesystem", and the volume somebody wants to shrink is by definition
one with data on it. So there is no shrink path, no `--yes`, and no `-f`.

## Three failures, one exit code

`lvextend`/`lvreduce` exit **5** for all of: xfs shrink, ext4 shrink while mounted,
and not enough space —

```
Insufficient free space: 2250 extents needed, but only 638 available
```

— so the exit code cannot tell an operator which happened. Everything is decided
from the preflight and refused *before* anything runs.

## What did not need a rule

Being unmounted does **not** block a grow, which was checked rather than assumed:
`lvextend -r` on an unmounted xfs exited 0 and grew it, because fsadm mounts it
briefly to run `xfs_growfs`. (`xfs_growfs` alone on an unmounted volume is exit 1,
`not a mounted XFS filesystem` — which is why this drives `lvextend -r` rather than
calling the per-filesystem tools.)

## What could not be captured

* **A thin pool**, and **RAID or cached LVs.** Only linear volumes on plain PVs were
  built. `lvextend -r` behaves differently on a thin volume whose pool is full, and
  nothing here claims to have tried it.
* **ext2/ext3.** Listed as growable alongside ext4 because they share `resize2fs`,
  but only ext4 was actually grown.
* **A shrink that succeeds.** Deliberately: there is no code path to test.
