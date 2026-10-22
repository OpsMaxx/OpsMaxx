---
docgov:
  id: reverse-mount-spike
  type: note.internal
  authority: historical
  audience:
    - engineering
  visibility: internal
  status: draft
  generation:
    mode: human-maintained
---
# Reverse mount spike

> Internal Note. Historical record. Correct only factual errors. Keep it under 400 lines; 1000 triggers review.

> **Status: shipped as a feature, 2026-10-22.** The spike became **Folder shares**. They are defined in the
> server editor like `docker -v host:path:ro`, mounted when a terminal to the server connects, and shown on
> the tab's view bar. User guide: [Mount a folder from this computer](../08-user/guides/mount-a-folder-from-this-computer.md).
> Code: `src/main/services/reverseMount.ts` and `src/shared/localMounts.ts`. Tests: `tests/reverseMount.test.ts`,
> `tests/localMounts.test.ts`, `tests/localMountsDialog.test.tsx` and `tests/reverseMountNotExposed.test.ts`.
> The sections below record the spike as it was measured. **What changed after the spike** lists where the
> feature differs.

**The ask:** mount folders from the user's own machine (where OpsMaxx runs) onto the server a
session is connected to, each read-only or read-write.

## How it works

An SSH client has no way to export a local folder, so this is reverse sshfs:

1. On the session's pooled connection, OpsMaxx opens an exec channel running
   `sh -c '… exec sshfs -f -o passive -o idmap=user [-o ro] :/ <mountpoint>'`.
   `passive` is what sshfs 3.7.2+ calls `slave`; the script picks whichever the server's
   sshfs knows. In that mode sshfs speaks SFTP on its stdin/stdout instead of starting ssh.
2. OpsMaxx is the SFTP **server** on the other end of that channel. It uses ssh2's own
   SFTP state machine in server mode, fed from the channel (`sftpOverStream`). No local
   `sftp-server` binary is involved, so Windows works the same as macOS and Linux.
3. `/` in the SFTP namespace is the shared folder. Every request is answered by
   `serveShare` from files under that folder, or refused.

Nothing before the `exec` may write to stdout, because stdout is the SFTP stream. A login
shell rc file that prints something on a non-interactive shell breaks this the same way it
breaks `sftp`.

## What the server needs

| Need | Check | Ubuntu 24.04 (measured) |
|---|---|---|
| `sshfs` | `command -v sshfs`, else the mount fails with *sshfs is not installed on this server* | not installed by default; `apt install sshfs` pulls in only `sshfs`, since `fuse3` is already there |
| `/dev/fuse` readable and writable by the login user | `[ -r /dev/fuse ] && [ -w /dev/fuse ]` | `crw-rw-rw- root root`: any user |
| `fusermount3` or `fusermount`, setuid | used for the unmount | both present |
| `mountpoint` (util-linux) | used to confirm the mount appeared | present |

**The `fuse` group** only matters where `/dev/fuse` is `0660 root:fuse`: older Debian, some
hardened images. There the login user must be in `fuse` (`usermod -aG fuse <user>`, then log
in again). Ubuntu 24.04 has no `fuse` group at all. Containers need `/dev/fuse` passed in and
usually `CAP_SYS_ADMIN`, so a server that is itself a container will usually fail the
`/dev/fuse` check.

## The trust boundary

The **server is the untrusted side.** Anyone who is root on it, or can run as the login user,
can speak SFTP on that channel directly, or remount without `-o ro`. So nothing the server
does is trusted. Every limit is enforced in `serveShare`, in this app:

- **Read-only** refuses `WRITE`, `SETSTAT`, `FSETSTAT`, `MKDIR`, `RMDIR`, `REMOVE` and `RENAME`,
  and refuses `OPEN` with any of WRITE, APPEND, CREAT, TRUNC or EXCL. The refusal happens before
  any path is looked at. `-o ro` is passed as well, but only so the server reports a clean
  `EROFS` instead of `EACCES`. It is not what keeps the share read-only.
- **`..`** is resolved lexically, and climbing above the share root is **refused** rather
  than clamped to the root (`confine`). The same goes for NUL, and for `\` (or `:` on Windows)
  inside a segment, since either would be a separator to the local filesystem.
- **Symlinks** are resolved with `realpath` on the parent of every path, and on the leaf too
  unless the operation acts on the link itself (lstat, readlink, remove, rename). The result
  must sit inside the realpath of the root. A dangling leaf link is refused, because creating
  through it would write wherever it points. Listing a link that points outside the share
  shows the link's own metadata and nothing more.
- **The remote cannot create symlinks.** `SYMLINK` and every `EXTENDED` request get
  `OP_UNSUPPORTED`, which shows up as `ln: … Operation not supported`.
- **One request at a time.** The path check and the operation that follows are two
  syscalls. If requests ran concurrently, a read-write remote could rename a checked
  directory away and put a link in its place between them. A serial queue closes that race
  for anything the remote can do. A local process racing the share is outside this model.
- `chown` is never applied: uid and gid in `SETSTAT` are ignored.

The unit test drives this with ssh2's SFTP **client** over an in-memory pipe, which is the
"remote skips sshfs" case. It proves the read-only refusals, `..` and symlink escapes, and that
the files on disk are unchanged afterwards.

**Link targets** (fixed after the spike): the spike's `readlink` handed over a link's literal target, so a
link to an absolute local path revealed it. `shareLinkTarget` now rewrites a target that lands inside the share
as a path relative to the link, and refuses one that lands outside.

## Teardown

As shipped (the spike's version differed; see the end of this note).

Each mount holds its own reference on the pooled connection, taken before the first await of the mount,
so closing the terminal that started it cannot destroy the connection under a mount still being set up.

- **The last terminal to a server closes:** `ssh.ts` `cleanup()` calls the `onServerSession` listener with
  `closed`, which `wireFolderShares` routes to `unmountServer`. Each mount's `teardown` closes the sshfs
  channel (sshfs exits and libfuse unmounts), waits up to 3 s for it, then runs
  `fusermount3 -uz <mp> || fusermount -uz <mp>; ! mountpoint -q <mp>` to clear and check whatever is
  left. `-z` is a lazy unmount, so a remote shell sitting inside the mount does not pin it. If the mount
  point is still a mount afterwards, the share shows **Failed** with that reason instead of vanishing.
- **Mid-mount:** mount and teardown of one `serverId:mountpoint` are serialised. A teardown asked for while
  the mount is being set up wakes it (`wake`) and then undoes whatever it got to, so a mount that lands
  after its terminal closed is still unmounted, and a late unmount cannot remove a newer mount.
- **Quit:** `before-quit` runs `unmountAll` first, bounded at 2 s, then the usual teardown, so fusermount
  runs while the pool is still up.
- **Connection lost:** sshfs reads EOF and exits. On sshfs 3.7.3 / libfuse 3.14 the mount was gone
  afterwards (measured below). Older sshfs may leave *Transport endpoint is not connected* behind. The
  mount script clears that at the start of the next mount.
- The mount point directory is created with `mkdir -p` and left in place after unmount. It is not removed,
  because it may be a directory the user already had.

## Measured on the test host

Ubuntu 24.04, sshfs 3.7.3, libfuse 3.14.0, over a link with about 255 ms RTT, logged in as root.
sshfs was installed for the run and removed after it.

- **Read-only:** `cat` works. `touch`, `>>` and `rm` fail with *Read-only file system*.
  `cat <mp>/../x` stays on the server, and `cat <mp>/out/secret` through a link that
  points out of the share fails with *No such file or directory*.
- **Read-write:** create, `mkdir`, `mv`, `chmod 600` and `rm` all landed on the local disk as
  expected, with mode 600 preserved. `ln -s` was refused. A 20 MiB `dd` wrote at 2.2 MB/s and
  the sha256 matched on both sides. At this RTT the network bound is sshfs's write
  pipelining, not the serial queue, which spends sub-millisecond local time per op.
- **Teardown:** after `unmountShare`, after the spike's per-session unmount (now `unmountServer`), and after the connection was
  dropped with the mount up, `mountpoint` reported *not a mountpoint* and no `sshfs`
  process was left.
- `df` on the mount shows 1000G free, because `statvfs@openssh.com` is not implemented, so
  sshfs makes up a size.

## What changed after the spike

- **Per server, not per terminal.** Mounts are keyed by server id, shared by every pane on that server, and
  torn down when the last terminal to it closes. `ssh.ts` reports session start and end through
  `onServerSession`. It does **not** import the manager: the spike's import put `reverseMount.ts` into the MCP
  bridge's import closure, and `tests/reverseMountNotExposed.test.ts` now forbids that.
- **Bound to the session.** At the requester's ask ("can't we bind it to the SSH session?"), a share is part
  of the server's connection settings: a **Folder shares** section in the server editor, one row per share.
  It mounts with the session and unmounts with the last one. The tab's view bar carries an indicator with
  state, Unmount and Retry, and a shortcut back to that section (`openServerEditor(id, 'shares')`).
- **Per-machine shares, never on the server record** (after expert review). Server records sync between
  devices (addy) and ride inside every backup, so a share on one would arrive on another machine and mount
  that machine's folder there. Shares now live in main's `opsmaxx-folder-shares.json`, which is not in the
  backup payload or any addy collection. backup.ts lists it only in `ALL_DATA_FILES`, so "delete everything"
  removes it. The editor reads and writes them over `mounts:view` / `mounts:set-shares`, and main reconciles
  live mounts on save.
- **Identity.** Each share stores `serverIdentity` (account, address, port, cloud target) as saved. If the
  server record changes, whether by the user, a synced edit or an agent's `update_server`, the share is
  *stale*: it does not auto-mount or mount until re-enabled (`mounts:reenable`, or saving the editor).
- **Retry policy.** A setup failure (no sshfs, no /dev/fuse, the mount point not empty, the local folder
  gone) is kept and not retried by auto-mount, even across reconnects; Retry is manual. A failure because the
  connection dropped is cleared with the session and remounts on reconnect.
- **The folder is the renderer's to choose.** The UI offers the OS folder dialog, but main does not check
  where a folder came from. The renderer is the app's own UI, and agents cannot reach these IPC channels.
- **Agents.** `mcpDataCache` never reads `shares`, and the renderer applies an `update_server` patch by
  named field (`agentServerFields`) instead of spreading it.
- **SFTP server hardening** (after expert review): READ clamped to 256 KiB as OpenSSH does; at most 256
  open handles per share; more than 1024 queued requests closes the channel; one serial queue across ALL
  shares (two shares of one folder could otherwise race a check against an open); READDIR re-resolves its
  directory on every call; status messages are fixed per code, never `err.message`, which carries local
  paths; a link out of the share is refused identically whether or not its target exists; containment by
  `path.relative`, so a share of `/` or `C:\` works; open flags mapped to numeric `O_*`, because ssh2's
  string table has no `WRITE|CREAT`, `WRITE|CREAT|EXCL` or `READ|WRITE|CREAT`, which broke `touch`, `cp`,
  sqlite and git on read-write shares; an append handle writes at the end, as sftp-server does.
- **The script.** `~/` is expanded by the shell without quoting the rest away. A non-empty mount point is
  refused, because libfuse 3 would mount over it and hide the files. A stale `Transport endpoint is not
  connected` mount point is cleared first. Each failure it can name has its own exit code, which
  `explainMountFailure` turns into a sentence and a fix.

## Not done

- Performance work beyond the serial queue: the `posix-rename`, `statvfs` and `fsync` extensions.
- Windows as the local side has not been run. The SFTP server is pure Node, but nothing on Windows has
  exercised it yet.
