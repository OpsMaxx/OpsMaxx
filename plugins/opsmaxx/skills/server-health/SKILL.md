---
name: server-health
description: Check the health of a remote server the user administers — CPU, memory, disk, swap, load, uptime, failed systemd units, listening ports, pending security updates, or capacity headroom. Use for questions like "is my box running out of disk", "why is prod slow", "what is eating memory on the web server", "does anything need a reboot". For remote hosts the user reaches over SSH, not the local machine and not a local dev server.
---

# Checking a server's health

Two rules first, because getting them wrong wastes a turn:

- **Servers are addressed by friendly name only.** Call `list_servers` first; the names it
  returns are the only valid `serverName` values. A hostname, an IP or an SSH string will not
  resolve, and you never get to see one.
- **Ask before you assume.** `describe_capabilities` says what this session may actually do.
  Reading it beats discovering a boundary by tripping over it — a denied call is not a call to
  retry in a different shape.

## Order to work in

1. `list_servers` — get the name.
2. `get_server_metrics` — CPU, memory, disk, uptime, **failed units and listening ports**. This
   is usually the whole answer. Do not reach for `execute_command` to run `top`, `free` or `df`:
   the dedicated tool states its intent exactly, so the user's path rules apply precisely instead
   of being guessed at from a command string, and it is less likely to need an approval prompt.
3. `get_host_facts` — only when the question is what the server *is* rather than how it is
   doing: distro, arch, virtualisation, pending and security updates, reboot-pending.
4. `get_capacity_trends` — only when the question is about direction ("will it fill up"), not
   the current number. It forecasts over a window of days and answers in sentences, one per
   metric. Every number it states carries the window it came from AND how much of that window
   was sampled: OpsMaxx only collects while it is running, so "from 21 days of data" can mean
   nine parts of ten, or two. A refusal names the rule that stopped it — pass it on rather than
   reading it as "there is room".
5. `list_alerts` — what already fired, so you are not re-diagnosing something known.

`execute_command` is for work that genuinely needs a shell. Reach for it after the tools above,
not instead of them.

## Reading the result

`get_host_facts` dates itself twice — when the facts were collected, and when the package
metadata behind the update counts was last refreshed. Both can be stale independently, and a
fresh reading off a months-old package cache is worthless. Say which one you relied on.

Escalation shells (`sudo -i`, `su`, `sudo bash`) are refused whatever the permissions say.
`sudo -n` is used for privileged reads and is normally available.
