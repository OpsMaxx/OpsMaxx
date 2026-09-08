# Log rotation (roadmap item 43)

Recorded from a real Ubuntu 24.04 server, systemd 255, through
`buildLogRotationCommand()`. **Two fields were replaced**, because this
repository is public: the hostname and the journal's machine-id directory.
Nothing else was altered.

## What it settled

* **The logrotate state file's dates are not padded** — `"/var/log/syslog"
  2026-9-6-0:0:2`. Month, day, hour, minute and second all lack a leading zero,
  in a format that is neither ISO nor anything `Date.parse` reads correctly. All
  21 entries on this host are that shape.
* **`journalctl --disk-usage` does not say what the limit is.** It answers
  *"Archived and active journals take up 198.3M in the file system"* and stops.
  The configured cap here was `#SystemMaxUse=` — **commented out**, which does
  not mean unlimited: journald computes a default from the filesystem instead.
* **The effective ceiling exists in exactly one place**, a line journald writes
  to its own journal at startup:

  ```
  System Journal (/var/log/journal/…) is 161.0M, max 4.0G, 3.9G free.
  ```

  So the read asks `journalctl -u systemd-journald` for it, takes the most
  recent (journald announces it at every restart), and a ceiling it cannot find
  is reported as **unread rather than absent** — the most dangerous available
  wrong answer here is "there is no limit".

## What could not be captured

* **A host where rotation has actually stalled.** This one rotates normally, so
  the stale branch is exercised with constructed entries, labelled in the test.
* **A journal near its ceiling.** 198 MB of 4 GB is 5%.
* **A RHEL-family state file** at `/var/lib/logrotate.status` rather than under
  the directory. Both paths are read; only the Debian one was seen.
