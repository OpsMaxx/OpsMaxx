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

Make a folder on your computer part of a server's connection: mounted on the server while you are connected, unmounted when you leave.

## Goal

You have a folder here, such as a project, a set of config files or a build output, and you want it on a server while you work there, without copying it. A folder share works like `docker -v host:path:ro`. You define it once in the server's connection settings: a folder on this computer, a path on the server, read-only or read-write. From then on it is mounted whenever an SSH session to that server is open, and unmounted when the last session closes.

Under the hood it is **sshfs**. Programs on the server see an ordinary folder, and every read and write travels back over your SSH connection to the folder on this computer.

**What the server needs.** sshfs installed, and a usable `/dev/fuse`. Most containers have neither, so this usually works on a VM or a physical machine and not inside a container. OpsMaxx checks both before mounting. When something is missing it tells you what, and what to run.

**What sharing means.** While a share is mounted, anyone who can act as your account on that server, or as root there, can read every file in it. With read-write, they can also change and delete those files. Share the folder you mean to share, not your home folder.

## Steps

### 1. Add a share to the server

1. Open the server's connection settings: right-click it, then **Edit server**.
2. Under **Folder shares**, click **Add folder share** and pick a folder. Only a folder picked in this dialog can be shared.
3. Check the row:
   - **Mount point.** The path on the server, after the arrow. It defaults to `~/opsmaxx/<folder name>` in your home folder there. It is created if it does not exist, and it must be empty: mounting over files would hide them, so OpsMaxx refuses.
   - **Access.** Defaults to **Read-only**. Choose **Read-write** only if the server should be able to change these files.
   - **Mount on connect.** On by default. Turn it off to keep the share defined but mount it only when you ask.
4. Click **Save Changes**.

If a session to the server is already open, a share set to mount on connect mounts straight away. Otherwise it mounts the next time you connect.

The section is not offered for a server that only speaks RDP, and is switched off for a *files only* account, because that kind of account cannot run sshfs.

### 2. Connect

Open the server as usual. When the terminal is ready, each share set to mount on connect is mounted. There is nothing to click and nothing typed into the terminal: the mount runs over its own channel on the same connection, including through jump hosts.

### 3. Use it on the server

```bash
ls ~/opsmaxx/site
```

The files are those on this computer. On a read-only share, any attempt to write fails with *Read-only file system*.

### 4. Check, unmount or retry from the tab

The tab's view bar, next to the server's address, has a **Folder shares** icon. It shows how many shares are mounted, and turns into a warning sign when one has failed. Click it to see each share's state (**Mounting…**, **Mounted** or **Failed** with the reason and the fix), with:

- **Unmount** to take a share off the server until the next connect.
- **Retry**, or **Mount** for a share that is not set to mount on connect.
- **Edit shares…** (or **Add a share…** when there are none), which opens the server's settings at the Folder shares section.

### When shares come and go

- They mount when an SSH session to the server opens. Several terminals to one server share one mount.
- They unmount when **the last session to that server closes**, or when the connection drops.
- A reconnect mounts them again.
- Removing a share in the server settings, or changing its folder, mount point or access, unmounts the old mount when you save.

## Verification

- **The Folder shares icon shows it mounted.** On the server, `findmnt -t fuse.sshfs` lists the mount point with source `opsmaxx`.
- **Read-only holds.** On the server, `touch ~/opsmaxx/site/x` fails with *Read-only file system*, and nothing appears in the folder on this computer.
- **A failed mount says why.** The row shows **Failed** with the reason, plus the fix when there is one:

  | What you see | What to do |
  |---|---|
  | sshfs is not installed on this server | `sudo apt install sshfs` (Debian, Ubuntu) or `sudo dnf install fuse-sshfs` (Fedora, RHEL) |
  | /dev/fuse is not available on this server | Containers usually lack it. On a full machine, `sudo modprobe fuse` |
  | *account* is not allowed to use /dev/fuse | Add the account to the `fuse` group (`sudo usermod -aG fuse <user>`), then reconnect |
  | The server refused the FUSE mount | Seen inside most containers, which cannot mount filesystems |
  | The mount point already has files in it | Choose an empty or new folder |

  A share that fails to mount on connect shows this under the Folder shares icon. It does not pop up a notice on every reconnect.

## What OpsMaxx enforces

These limits are enforced by OpsMaxx on this computer, not by the server. They hold even if someone with root on the server ignores sshfs and talks to the connection directly:

- **Read-only** refuses every write, create, rename, delete, permission change and new folder that the server asks for. The mount is also made with `-o ro`, but only so that the server shows a clear error. That flag is not what keeps your files safe.
- **The share's edges.** Paths that climb out of the folder with `..`, and symbolic links that lead outside it, are refused. A link that points outside the folder cannot be read or followed. A link that points inside it is shown as a relative link, so the server never learns a path on this computer.
- **No new links, and no ownership changes.** The server cannot create symbolic links in the folder, and requests to change a file's owner are ignored.
- **No AI agents.** Shares are defined only in the server settings and controlled only from the tab. Nothing on the MCP bridge or the command-line bridge can mount, unmount or change a share, or list which folders are shared. An agent that edits a server's connection details cannot add a share to it.

Two things are not done:

- Free space reported for the mount (`df`) is a placeholder, not the free space on this computer.
- Speed depends on the connection: every file operation is a round trip to this computer.

## Related

- [Design note: reverse mount](../../10-internal/reverse-mount-spike.md), covering how it works, the trust boundary, and what was measured
