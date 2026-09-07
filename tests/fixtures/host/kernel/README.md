# Kernel: running vs installed (roadmap item 46)

## Provenance

| File | Source |
|---|---|
| `ubuntu-2404-pending-reboot.txt` | A **real Ubuntu 24.04.4 host**, running `6.8.0-136-generic` with `6.8.0-138-generic` installed and a restart already pending |
| `debian12-container-no-kernel.txt` | A `debian:12` container — **has dpkg, owns no kernel** |

Both are the verbatim output of `buildKernelStatusCommand()`, re-recorded after the
command changed rather than hand-edited. The first version of this fixture was
captured with ad-hoc markers and did not parse; recording the builder's own output
is the rule, and it is cheap to keep.

## What the Ubuntu host settled

It contains **two traps at once**, which is why it is worth keeping verbatim:

* `linux-image-unsigned-6.8.0-136-generic  unknown ok not-installed` — a
  version-bearing name on a package the host does **not** have. Counting names
  reports four kernels where there are two.
* `linux-image-virtual 6.8.0-138.138 install ok installed` — installed, and **not a
  kernel**. Its version tracks what the meta package wants, not what is on disk.

And a third: `dpkg-query` answered *"no packages found matching
linux-image-generic"* on this host, whose meta package is `linux-image-virtual`. So
nothing may assume a meta package name.

## What the container settled

`dpkg --print-architecture` answers `arm64`, `dpkg-query` finds **zero** kernel
packages, `/boot` is empty, and `uname -r` reports `6.12.76-linuxkit` — the Docker
VM's kernel, not one the container owns. Every input looks plausible and the only
honest verdict is that the question was not answered. That is why `dpkg` is a field
on `KernelStatus`: an empty installed list is otherwise indistinguishable from an
RPM host that was never asked in its own language.

## Version ordering

`compareKernelVersions` is pinned against `dpkg --compare-versions` run on the
Ubuntu host, which answered `lt` for all of:

```
6.8.0-99-generic  <  6.8.0-100-generic
6.8.0-136         <  6.8.0-138
1.0~rc1           <  1.0
6.8.0-136.136     <  6.8.0-138.138
5.15.0-generic    <  6.8.0-generic
```

The first pair is why this cannot be a string comparison, and the same host
confirmed the consequence: `sort` places `6.8.0-99-generic` **after**
`6.8.0-136-generic`, so the order `ls -1 /boot/vmlinuz-*` returns is not the order
these belong in.

## What could not be captured

* **An RPM host.** There is none here, so `rpm -q kernel` and `needs-restarting -r`
  are not parsed at all — the read reports `unknown` and says why. That is the call
  `engineUpgrade` made about the installed set, for the same reason.
* **A purged kernel** whose name still carries a version (`deinstall ok
  config-files`). The Ubuntu host has none; the case is covered by a CONSTRUCTED
  row, labelled as such in the test.
* **A host with a `-99` and a `-100` kernel**, which is where the ordering matters
  most. Also CONSTRUCTED, and labelled.
