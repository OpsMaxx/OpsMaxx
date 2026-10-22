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

Make a folder on your computer appear on a server, as a folder on the server's own disk, while you are connected to it.

## Goal

You have a folder here, such as a project, a set of config files or a build output, and you want to use it on a server without copying it there. OpsMaxx mounts it at a path on the server with **sshfs**. Programs on the server then read it, and if you allow it change it, as if it were local. Every read and write travels back over your SSH connection to the folder on this computer.

Each folder is shared either **read-only** (the default) or **read-write**.

**What the server needs.** sshfs installed, and a usable `/dev/fuse`. Most containers have neither, so this usually works on a VM or a physical machine and not inside a container. OpsMaxx checks both before mounting. When something is missing it tells you what, and what to run.

**What sharing means.** For as long as the folder is mounted, anyone who can act as your account on that server, or as root there, can read every file in it. With read-write, they can also change and delete those files. Share the folder you mean to share, not your home folder.

## Steps

### 1. Open a terminal and the Files view

1. Open the server. The folder is mounted over the terminal's own SSH connection, so **a terminal to this server has to be open**. If it is not, mounting says *Open a terminal to this server first*.
2. Switch the tab to **Files**. The toolbar has a **Local folders** button.

   The button is not there for a server marked *files only* (that kind of account cannot run sshfs), or for the Files view of this computer.

### 2. Share a folder

1. Click **Local folders**, then **Choose…**, and pick the folder in the dialog. Only a folder picked here, or one already saved, can be shared.
2. **Mount point on the server.** This defaults to `~/opsmaxx/<folder name>` in your home folder on the server. You can change it. It is created if it does not exist, and it must be empty: mounting over files would hide them, so OpsMaxx refuses.
3. **Access.** This defaults to **Read-only**. Choose **Read-write** only if the server should be able to change these files.
4. **Mount automatically when a terminal to this server connects.** This is on by default. Leave it on to have the folder come back whenever you connect.
5. Click **Share and mount**.

The folder is saved on this server's connection profile and appears in the list as **Mounting…**, then **Mounted**. The toolbar button shows how many folders are mounted.

### 3. Use it on the server

In the terminal:

```bash
ls ~/opsmaxx/site
```

The files are those on this computer. On a read-only share, any attempt to write fails with *Read-only file system*.

### 4. Unmount, or stop sharing

- **Unmount** removes the mount from the server and keeps the folder in the list, so you can mount it again.
- **Remove** unmounts the folder and deletes it from the list.
- Turning off **Mount automatically on connect** keeps the folder in the list without mounting it each time.

Mounts also end on their own when **the last terminal to that server closes**, or when the connection drops. A folder set to mount automatically comes back the next time a terminal connects. One that is not stays unmounted until you click **Mount**.

## Verification

- **The list shows Mounted.** On the server, `findmnt -t fuse.sshfs` lists the mount point with source `opsmaxx`.
- **Read-only holds.** On the server, `touch ~/opsmaxx/site/x` fails with *Read-only file system*, and nothing appears in the folder on this computer.
- **A failed mount says why.** The row shows **Failed** with the reason, plus the fix when there is one:

  | What you see | What to do |
  |---|---|
  | sshfs is not installed on this server | `sudo apt install sshfs` (Debian, Ubuntu) or `sudo dnf install fuse-sshfs` (Fedora, RHEL) |
  | /dev/fuse is not available on this server | Containers usually lack it. On a full machine, `sudo modprobe fuse` |
  | *account* is not allowed to use /dev/fuse | Add the account to the `fuse` group (`sudo usermod -aG fuse <user>`), then reconnect |
  | The server refused the FUSE mount | Seen inside most containers, which cannot mount filesystems |
  | The mount point already has files in it | Choose an empty or new folder |

  A folder that fails to mount automatically shows this in the list. It does not pop up a notice on every reconnect.

## What OpsMaxx enforces

These limits are enforced by OpsMaxx on this computer, not by the server. They hold even if someone with root on the server ignores sshfs and talks to the connection directly:

- **Read-only** refuses every write, create, rename, delete, permission change and new folder that the server asks for. The mount is also made with `-o ro`, but only so that the server shows a clear error. That flag is not what keeps your files safe.
- **The share's edges.** Paths that climb out of the folder with `..`, and symbolic links that lead outside it, are refused. A link that points outside the folder cannot be read or followed. A link that points inside it is shown as a relative link, so the server never learns a path on this computer.
- **No new links, and no ownership changes.** The server cannot create symbolic links in the folder, and requests to change a file's owner are ignored.
- **No AI agents.** Mounting is only available here in the Files view. Nothing on the MCP bridge or the command-line bridge can mount, unmount or change a share, or list which folders are shared.

Two things are not done:

- Free space reported for the mount (`df`) is a placeholder, not the free space on this computer.
- Speed depends on the connection: every file operation is a round trip to this computer.

## Related

- [Design note: reverse mount](../../10-internal/reverse-mount-spike.md), covering how it works, the trust boundary, and what was measured
