# systemd timers (roadmap item 46, the certbot row generalised)

## Provenance

Recorded from a **real Ubuntu 24.04.4 host, systemd 255**, through the commands
`shared/systemdTimers.ts` builds.

| File | What it is |
|---|---|
| `list-ubuntu-2404.txt` | `systemctl list-timers --all -o json` — eleven timers, three of which have never fired |
| `detail-healthy.txt` | `logrotate.timer` + `logrotate.service`, both fine |
| `detail-never-run.txt` | `ua-timer.timer` — loaded, **inactive**, never triggered |
| `detail-absent.txt` | `certbot.timer` + `certbot.service` on a host with **no certbot at all** |
| `detail-service-failed.txt` | `logrotate.timer` (active) paired with `cloud-init.service` (**genuinely failed** on this host) |

## The five findings

1. **A unit that does not exist reports success.** `detail-absent.txt` is the whole
   argument for this module's shape: `Result=success`, `ExecMainStatus=0`,
   `ActiveState=inactive`, `SubState=dead`, exit 0. Every field says fine on a host
   where certbot was never installed. Only `LoadState=not-found` disagrees, so it is
   checked first and nothing else is believed until it passes.
2. **`left` is not a duration.** The JSON emits `{"next":1788690600000000,
   "left":1788690600000000}` — the same absolute microsecond stamp twice. Rendering
   `left` as a remaining time gives roughly fifty-six thousand years.
3. **`passed` is a monotonic stamp.** Measured: uptime was `1132793` s and
   `logrotate.timer` reported `passed: 1088423204482` µs (1088423 s). It is time
   since boot, not an age. The age is computed from `last`, which *is* realtime.
4. **`last: 0` means never.** Three timers report `last: 0` with `next: null`. Fed
   to a date that renders as 1970 — "56 years ago" — which is the most alarming
   possible way to say "this has never run".
5. **A timer and its service have different normal states.** `logrotate.timer` is
   `active`; `logrotate.service` is `inactive` with `Result=success`, because a
   oneshot that finished is *supposed* to be inactive. So `inactive` means "will
   never fire" on a timer and "is done" on a service — the same word, opposite
   meanings.

And the other half of finding 5 is why the service is read at all: a timer can fire
perfectly every day into a service that fails every time. This host had two services
in exactly that state (`cloud-init`, `systemd-networkd-wait-online`), which is where
`detail-service-failed.txt` comes from.

## What could not be captured

* **certbot itself.** The host runs none, which is why `detail-absent.txt` exists
  and is the more useful fixture. `renewalTimers` is a filter over units the host
  listed rather than a parser, so an unrecognised name produces a **miss** — the
  operator sees no renewal timer — and never a wrong answer about a different unit.
  It is the one thing in the module that is not measured, and it is labelled as such
  in the source.
* **A timer with an explicit `Unit=`** pointing at a service whose name is not the
  timer's stem. The panel derives the service name by replacing `.timer` with
  `.service`; when a unit overrides that, this reads the wrong service. The verdict
  names the unit it actually read so the mismatch is visible rather than silent.
* **A pre-255 systemd**, where `-o json` may not exist. The read reports nothing
  parseable rather than guessing at the column format, whose fields contain spaces
  (`1h 0min`, `3min 10s ago`) and cannot be split reliably.
