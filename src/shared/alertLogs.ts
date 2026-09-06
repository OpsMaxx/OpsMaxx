import type { LogPriority, LogSource } from './logtail'
import type { AlertKind } from './webhook'

// From an alert to the log that explains it.
//
// The incident path already has both halves — an inbox with a chip per
// condition, and a tailer that follows units, files and containers across
// hosts — and nothing joins them. An operator reading "nginx.service failed"
// has to remember the unit name, open the log drawer, pick the source kind,
// type the name and set a window.
//
// ======================================================================
// MOST ALERTS HAVE NO LOG, AND SAYING SO IS THE FEATURE
// ======================================================================
//
// The tempting version of this opens the journal for every alert. It is worse
// than nothing: an operator sent to a general journal for a disk alert reads
// four hundred unrelated lines and concludes the tool is noise. Worse, for
// `host-unreachable` there is no host to read from, and offering the button at
// all invites somebody to sit watching a tail that can never connect.
//
// So each kind is decided on its own and most of them REFUSE:
//
//  * `unit-failed` is the one that maps exactly. systemd knows the unit, the
//    tailer takes a unit, and `journalctl -u <unit>` is what a person would
//    type. This is the case the join exists for.
//  * The RESOURCE kinds — cpu, memory, disk, inode, load — have no unit. The
//    tailer has three source kinds (`unit`, `file`, `container`) and none of
//    them is "the whole journal", so there is nothing to open that would be
//    about the alert rather than about the host in general.
//  * `host-unreachable` is refused on the strongest ground available: the
//    log lives on a machine that is not answering.
//  * `job-failed` has output, and it is not on the host. It is in the job
//    record this app already keeps.
//  * `oom-kill` is the near miss. The evidence is in the KERNEL ring buffer,
//    which `journalctl -k` reads and which is not a unit — so it cannot be
//    expressed as a source this tailer accepts, and it is refused rather than
//    pointed at some file that may or may not exist on this distribution.
//
// ======================================================================
// THE WINDOW STARTS BEFORE THE ALERT
// ======================================================================
//
// A unit that failed at 14:03 wrote the reason at 14:02. Opening the log AT
// the alert shows the aftermath and not the cause, so the window is anchored
// before it. Journald takes `--since` as free text and the tailer already
// validates it against a character class; this emits the ISO stamp, which that
// class admits.

/** How far before the alert to start reading. */
export const ALERT_LOG_LEAD_MINUTES = 15

export type AlertLogRefusal =
  | 'no-unit'
  | 'host-down'
  | 'not-on-the-host'
  | 'not-a-unit-log'
  | 'no-log'

export const ALERT_LOG_REFUSAL_HELP: Record<AlertLogRefusal, string> = {
  'no-unit':
    'This alert is about the host as a whole, not about one service, so there is no unit whose log would be about it. Opening the journal here would show everything that happened on the machine and nothing that explains the alert.',
  'host-down':
    'The log for this alert is on a machine that is not answering — which is the alert. There is nothing to open until it is back.',
  'not-on-the-host':
    'This did not fail on the host, so the host’s journal has nothing to say about it. The output is in the record this app already keeps for it.',
  'not-a-unit-log':
    'The evidence for this is in the kernel ring buffer, which `journalctl -k` reads and which is not a unit. This build’s tailer follows units, files and containers, and none of those is that — so it refuses rather than pointing at a file that may not exist on this distribution.',
  'no-log':
    'Nothing on the host records this. It is a fact this app worked out, not an event a service logged.'
}

export type AlertLogTarget =
  | { ok: true; source: LogSource; why: string }
  | { ok: false; refusal: AlertLogRefusal }

export interface AlertLogInput {
  kind: AlertKind
  /**
   * Epoch ms the condition started, or NULL when nobody recorded one.
   *
   * Null is the ordinary case for a failed unit: `systemctl list-units` reports
   * name, state and description and no time, so the list this is called from
   * genuinely does not know when the unit failed. A window is then OMITTED
   * rather than anchored on `now` -- "the last fifteen minutes" is the wrong
   * answer for a unit that failed this morning, and it is wrong in the
   * direction of showing nothing at all.
   */
  since: number | null
  /**
   * The failed units, when the caller has them.
   *
   * `unit-failed` is raised from a set the monitor holds, and the ACTIVE alert
   * does not carry it — so it is passed in rather than parsed back out of the
   * alert's summary text, which is a sentence built for a person.
   */
  units?: string[]
}

/** journald reads this; the tailer's own character class admits it. */
export function sinceStampFor(atMs: number, leadMinutes = ALERT_LOG_LEAD_MINUTES): string {
  const d = new Date(atMs - leadMinutes * 60_000)
  // `YYYY-MM-DD HH:MM:SS`, which is journald's documented form and contains
  // nothing the tailer's SINCE_RE rejects. Deliberately not an ISO string:
  // the `T` and `Z` are accepted by journald but the space form is what a
  // person reads back in the field.
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
}

/**
 * Which log, if any, explains this alert.
 *
 * The refusals are the substance. See the header for why a general journal is
 * not offered as a fallback.
 */
export function alertLogTarget(a: AlertLogInput): AlertLogTarget {
  switch (a.kind) {
    case 'unit-failed': {
      const unit = (a.units ?? []).find((u) => u.trim() !== '')
      // The alert fired because a unit failed, so a missing name here is the
      // caller not passing one rather than a host with nothing to show. Still
      // refused: guessing a unit name would open somebody else's log.
      if (unit === undefined) return { ok: false, refusal: 'no-unit' }
      return {
        ok: true,
        source: {
          kind: 'unit',
          target: unit.trim(),
          // `err` and worse. A failed unit's reason is at err or crit, and
          // warning-and-below on a busy unit is the noise that makes people
          // stop opening the log at all.
          priority: 'err' as LogPriority,
          ...(a.since !== null ? { since: sinceStampFor(a.since) } : {})
        },
        why:
          a.since !== null
            ? `${unit.trim()}, from ${ALERT_LOG_LEAD_MINUTES} minutes before it failed, at err and worse.`
            : `${unit.trim()}, at err and worse. No window: nothing recorded when it failed, and guessing one would hide the reason.`
      }
    }
    case 'host-unreachable':
      return { ok: false, refusal: 'host-down' }
    case 'job-failed':
      return { ok: false, refusal: 'not-on-the-host' }
    case 'oom-kill':
      return { ok: false, refusal: 'not-a-unit-log' }
    case 'cpu':
    case 'memory':
    case 'disk':
    case 'inode':
    case 'load':
      return { ok: false, refusal: 'no-unit' }
    default:
      // Everything else — certificate dates, backup assessments, tunnel and
      // database states — is something this app computed or observed through
      // its own channel, not something a service on the host wrote down.
      return { ok: false, refusal: 'no-log' }
  }
}
