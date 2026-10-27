---
docgov:
  id: mount-a-folder-from-this-computer
  type: user.guide
  authority: audience
  audience:
    - users
  visibility: public
  status: active
  generation:
    mode: human-maintained
---
# Mount a folder from this computer

Make a folder on your computer part of a server's connection: it is mounted on the server while you have a terminal open to it, and unmounted when you close the last one.

## Goal

You have a folder here, such as a project, a set of config files or a build output, and you want it on a server while you work there, without copying it. You define it once in the server's connection settings: a folder on this computer, a path on the server, read-only or read-write. From then on it is mounted whenever a terminal to that server is open, and unmounted when the last one closes.

Under the hood it is **sshfs** over your SSH connection; Docker is not involved. Programs on the server see an ordinary folder, and every read and write travels back over your SSH connection to the folder on this computer.

**What the server needs.** sshfs installed, and a usable `/dev/fuse`. Most containers have neither, so this usually works on a VM or a physical machine and not inside a container. OpsMaxx checks both before mounting. When something is missing it tells you what, and what to run.

**What sharing means.** While a share is mounted, anyone who can act as your account on that server, or as root there, can read every file in it. With read-write, they can also change and delete those files. That includes an AI agent you have allowed to run commands on that server: it can read a mounted folder the same way it reads anything else there. Share the folder you mean to share, not your home folder.

**Shares stay on this computer.** They are saved on this computer only. They are not part of the server's connection profile that syncs to your other devices, and they are not in backups or exports. A share set up here never mounts a folder from another computer.

## Steps

### 1. Add a share to the server

1. Open the server's connection settings: right-click it, then **Edit server**.
2. Under **Folder shares**, click **Add folder share** and pick a folder.
3. Check the row:
   - **Mount point.** The path on the server, after the arrow. It defaults to `~/opsmaxx/<folder name>` in your home folder there. A path without a leading `/` is in your home folder too, so `site`, `~/site` and `$HOME/site` are the same place and only one folder can be shared there. It is created if it does not exist, and it must be empty: mounting over files would hide them, so OpsMaxx refuses.
   - **Access.** Defaults to **Read-only**. Choose **Read-write** only if the server should be able to change these files.
   - **Mount on connect.** On by default. Turn it off to keep the share defined but mount it only when you ask.
4. Click **Save Changes**. If something in the shares is wrong, such as two folders at one mount point, the reason is shown beside the button and that row's mount point is outlined in red.

If a terminal to the server is already open, a share set to mount on connect mounts straight away. Otherwise it mounts the next time you connect.

The section is not offered for a server that only speaks RDP, and is switched off for a *files only* account, because that kind of account cannot run sshfs.

### 2. Connect

Open a terminal to the server as usual. When it is ready, each share set to mount on connect is mounted. There is nothing to click and nothing is typed into the terminal: the mount runs over its own channel on the same connection, including through jump hosts.

### 3. Use it on the server

```bash
ls ~/opsmaxx/site
```

The files are those on this computer. On a read-only share, any attempt to write fails with *Read-only file system*.

### 4. Check, unmount or retry from the tab

The tab's view bar, next to the server's address, has a **Folder shares** button. It shows how many shares are mounted, and turns into a warning sign reading **Share failed** (or **2 shares failed**, and so on) or **Shares paused** when one has failed or is paused. A share that fails to mount on connect raises no pop-up, so look here first. Click it to see each share's state (**Mounting…**, **Mounted**, **Unmounting…**, **Failed** with the reason and the fix, or **No terminal open**), with:

- **Unmount** to take a share off the server until the next connect.
- **Retry** after a failure, or **Mount** for a share that is not set to mount on connect. With no terminal open, these say so instead of doing anything.
- **Edit shares…** (or **Add a share…** when there are none), which opens the server's settings with focus on the Folder shares section.

### When shares come and go

- They mount when a terminal to the server connects. Several terminals to one server share one mount.
- They unmount when **the last terminal to that server closes**, and when OpsMaxx quits.
- If the connection drops, sshfs on the server stops. A mount point left behind is cleared the next time the share mounts, and a reconnect mounts the share again.
- A failure from the server's setup, such as no sshfs, no `/dev/fuse` or a mount point that is not empty, is **not** retried on every reconnect. Fix the cause, then press **Retry**.
- Removing a share in the server settings, or changing its folder, mount point or access, unmounts the old mount when you save.
- A share only mounts over a connection to the server it was given to. If the server's address, port or account changes after a share was set up, the share is **paused** and does not mount. This applies whoever changed it, whether you, a synced edit from another device or an AI agent. The Folder shares dialog says so. **Re-enable for this address** (or saving the server's settings yourself) starts it again.

## Verification

- **The Folder shares button shows it mounted.** On the server, `findmnt -t fuse.sshfs` lists the mount point with source `opsmaxx`.
- **Read-only holds.** On the server, `touch ~/opsmaxx/site/x` fails with *Read-only file system*, and nothing appears in the folder on this computer.
- **A failed mount says why.** The row shows **Failed** with the reason, plus the fix when there is one:

  | What you see | What to do |
  |---|---|
  | sshfs is not installed on this server | `sudo apt install sshfs` (Debian, Ubuntu) or `sudo dnf install fuse-sshfs` (Fedora, RHEL) |
  | /dev/fuse is not available on this server | Containers usually lack it. On a full machine, `sudo modprobe fuse` |
  | *account* is not allowed to use /dev/fuse | On systems where `/dev/fuse` belongs to a `fuse` group (some older or hardened ones; not Ubuntu or Debian, which have no such group), add the account on the server with `sudo usermod -aG fuse <user>`, then press **Retry**. Retry opens a new connection for the mount, which is what picks up the new group; an existing connection keeps the account's old groups |
  | The server refused the FUSE mount | Seen inside most containers, which cannot mount filesystems |
  | The mount point already has files in it | Choose an empty or new folder |

  A share that fails to mount on connect shows this under the Folder shares button. It does not pop up a notice on every reconnect.

## What OpsMaxx enforces

These limits are enforced by OpsMaxx on this computer, not by the server. They hold even if someone with root on the server ignores sshfs and talks to the connection directly:

- **Read-only** refuses every write, create, rename, delete, permission change and new folder that the server asks for. The mount is also made with `-o ro`, but only so that the server shows a clear error. That flag is not what keeps your files safe.
- **The share's edges.** Paths that climb out of the folder with `..`, and symbolic links that lead outside it, are refused, with the same answer whether or not the place they point to exists. A link that points outside the folder cannot be read or followed. A link that points inside it is shown as a relative link. Error messages the server sees are fixed words, never a path on this computer.
- **Limits.** One read returns at most 256 KiB, a share can hold a bounded number of files open at once, and a server that sends requests faster than they can be answered is disconnected. Only regular files can be opened: a named pipe or a device inside a share is refused, because opening one could wait forever.
- **No new links, and no ownership changes.** The server cannot create symbolic links in the folder, and requests to change a file's owner are ignored.
- **No AI agents.** Shares are defined only in the server settings and controlled only from the tab. Nothing on the MCP bridge or the command-line bridge can mount, unmount or change a share, or list which folders are shared. An agent that edits a server's connection details cannot add a share, and changing the address pauses the ones already there. An agent with command access on the server can still read a mounted folder, as described above.

Two things are not done:

- Free space reported for the mount (`df`) is a placeholder, not the free space on this computer.
- Speed depends on the connection: every file operation is a round trip to this computer, and OpsMaxx answers one file operation at a time across all shares. That is part of how the share's edges are kept. It also means a file on a network drive that stops responding, inside any share, holds up every share until it answers.

## Related

- [Design note: reverse mount](../../10-internal/reverse-mount-spike.md), covering how it works, the trust boundary, and what was measured
