---
name: fleet-audit
description: Answer a question spanning every server the user administers at once rather than one host — inventory, configuration drift from a reviewed baseline, alerts that have fired, backup health, and which machines have pending security updates or are waiting on a reboot. Use for "which of my servers are unpatched", "is anything drifting", "are my backups actually running", "what has alerted this week".
---

# Auditing the whole fleet

One rule first: **these tools read across the whole workspace, not one server.** A single call
can return data from every machine in it, so the reach is the workspace rather than the host you
had in mind. That is the point, and it is also why the permission is separate.

## Pick the tool by the shape of the question

| Question | Tool |
|---|---|
| What do I have, and what is on it? | `fleet_inventory` |
| Has anything changed from its baseline? | `fleet_drift` (fleet) / `get_config_drift` (one server) |
| What has already gone wrong? | `list_alerts` |
| Are the backups working? | `backup_status` |
| Which machines are unpatched? | `get_host_facts` per server |

`fleet_inventory` answers from what OpsMaxx has **already collected** — it does not go and ask
each server now. So say how old the data is rather than presenting it as this minute's truth.

## What is not here

Running a backup and restoring one are absent at every permission level: a run outlives the
approval that started it, and a restore overwrites data. Firewall rules and sudoers are never
exposed to an agent at any setting — if the question needs them, say so and point at Security
posture in the app rather than trying to read them with a shell command.

Pending-update counts are only as good as the package metadata behind them, which OpsMaxx never
refreshes because that is a network operation that can break a server. `get_host_facts` reports
that age; quote it alongside the count.
