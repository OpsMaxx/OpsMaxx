import { describe, it, expect } from 'vitest'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ALERT_LOG_LEAD_MINUTES,
  ALERT_LOG_REFUSAL_HELP,
  alertLogTarget,
  sinceStampFor
} from '../src/shared/alertLogs'
import { validateSince, validatePriority } from '../src/shared/logtail'
import { ALERT_KINDS } from '../src/shared/webhook'

// The alert -> log join. Both halves already existed and nothing connected
// them, and the substance of the join is what it REFUSES: most alert kinds have
// no log that would be about them.
//
// The `--since` form was verified against a real journalctl: a past stamp
// returned entries, a future one returned none, and a malformed one exited 1
// with `Failed to parse timestamp`. So the stamp this emits is one journald
// actually honours, not merely one it tolerates.

const AT = Date.UTC(2026, 8, 6, 12, 30, 0)

describe('the one kind that maps', () => {
  it('opens the failed unit’s own log', () => {
    const t = alertLogTarget({ kind: 'unit-failed', since: AT, units: ['nginx.service'] })
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.source.kind).toBe('unit')
    expect(t.source.target).toBe('nginx.service')
  })

  // A unit that failed at 14:03 wrote the reason at 14:02. Opening AT the alert
  // shows the aftermath, not the cause.
  // `systemctl list-units` reports name, state and description and NO time, so
  // the failed-unit list genuinely does not know when it failed. A window is
  // omitted rather than anchored on `now`: "the last fifteen minutes" is the
  // wrong answer for a unit that failed this morning, and wrong in the
  // direction of showing nothing at all.
  it('omits the window when nothing recorded a failure time', () => {
    const t = alertLogTarget({ kind: 'unit-failed', since: null, units: ['nginx.service'] })
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect('since' in t.source).toBe(false)
    expect(t.source.priority).toBe('err')
    expect(t.why).toContain('No window')
    expect(t.why).toContain('guessing one would hide the reason')
  })

  it('starts the window before the alert, not at it', () => {
    const t = alertLogTarget({ kind: 'unit-failed', since: AT, units: ['nginx.service'] })
    expect(t.ok && t.source.since).toBe('2026-09-06 12:15:00 UTC')
    expect(ALERT_LOG_LEAD_MINUTES).toBe(15)
  })

  // The tailer quotes `since` into a shell and defends that with a character
  // class rather than by escaping. Anything this emits has to pass it.
  it('emits a stamp the tailer’s own validator accepts', () => {
    for (const at of [AT, 0, Date.UTC(1999, 11, 31, 23, 59, 59), Date.now()]) {
      expect(validateSince(sinceStampFor(at)), String(at)).toBe(true)
    }
  })

  it('pads every field, so the stamp is always the same shape', () => {
    expect(sinceStampFor(Date.UTC(2026, 0, 2, 3, 4, 5), 0)).toBe('2026-01-02 03:04:05 UTC')
  })

  // A failed unit's reason is at err or crit. Warning-and-below on a busy unit
  // is the noise that makes people stop opening the log at all.
  it('filters to err and worse, with a priority the tailer knows', () => {
    const t = alertLogTarget({ kind: 'unit-failed', since: AT, units: ['a.service'] })
    expect(t.ok && t.source.priority).toBe('err')
    expect(validatePriority(t.ok ? (t.source.priority ?? '') : '')).toBe(true)
  })

  // Guessing a unit name would open somebody else's log.
  it('refuses rather than guessing when no unit name was passed', () => {
    for (const units of [undefined, [], ['  ']]) {
      const t = alertLogTarget({ kind: 'unit-failed', since: AT, units })
      expect(t.ok, JSON.stringify(units)).toBe(false)
      expect(t.ok === false && t.refusal).toBe('no-unit')
    }
  })

  it('takes the first named unit when several failed together', () => {
    const t = alertLogTarget({ kind: 'unit-failed', since: AT, units: ['a.service', 'b.service'] })
    expect(t.ok && t.source.target).toBe('a.service')
  })
})

describe('what it refuses, which is most of it', () => {
  // The tailer has three source kinds and none is "the whole journal", so there
  // is nothing to open that would be about the alert rather than the host.
  it('refuses every resource kind for want of a unit', () => {
    for (const kind of ['cpu', 'memory', 'disk', 'inode', 'load'] as const) {
      const t = alertLogTarget({ kind, since: AT })
      expect(t.ok, kind).toBe(false)
      expect(t.ok === false && t.refusal, kind).toBe('no-unit')
    }
    expect(ALERT_LOG_REFUSAL_HELP['no-unit']).toContain('everything that happened on the machine')
  })

  // The strongest ground there is: the log is on a machine that is not
  // answering, and that IS the alert.
  it('refuses an unreachable host rather than offering a tail that cannot connect', () => {
    expect(alertLogTarget({ kind: 'host-unreachable', since: AT })).toEqual({
      ok: false,
      refusal: 'host-down'
    })
    expect(ALERT_LOG_REFUSAL_HELP['host-down']).toContain('which is the alert')
  })

  it('sends a failed job to its own record rather than to the host journal', () => {
    expect(alertLogTarget({ kind: 'job-failed', since: AT }).ok).toBe(false)
    expect(ALERT_LOG_REFUSAL_HELP['not-on-the-host']).toContain('record this app already keeps')
  })

  // The near miss: the evidence IS in the journal, but `journalctl -k` reads
  // the kernel ring buffer and that is not a unit.
  it('refuses oom-kill because a kernel buffer is not a unit', () => {
    const t = alertLogTarget({ kind: 'oom-kill', since: AT })
    expect(t.ok === false && t.refusal).toBe('not-a-unit-log')
    expect(ALERT_LOG_REFUSAL_HELP['not-a-unit-log']).toContain('journalctl -k')
    expect(ALERT_LOG_REFUSAL_HELP['not-a-unit-log']).toContain('may not exist on this distribution')
  })

  // A kind added later must not silently acquire a log link. The default is a
  // refusal, and this is what keeps it that way.
  it('has an answer for every alert kind, and only one of them opens a log', () => {
    const opens = ALERT_KINDS.filter(
      (k) => alertLogTarget({ kind: k, since: AT, units: ['x.service'] }).ok
    )
    expect(opens).toEqual(['unit-failed'])
    for (const k of ALERT_KINDS) {
      const t = alertLogTarget({ kind: k, since: AT })
      if (t.ok) continue
      // Every refusal has a sentence; none falls through to an empty string.
      expect(ALERT_LOG_REFUSAL_HELP[t.refusal], k).toBeTruthy()
    }
  })
})


describe('where it is actually used', () => {
  const code = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

  // The failed-unit list, NOT the alert inbox. The inbox's kinds are
  // `StoreAlertKind`, which has no `unit-failed` in it at all -- unit failures
  // are notified and webhooked but never become a chip -- so a button there
  // would have refused on every kind and never rendered.
  it('filters the failed-unit jump that already existed', () => {
    const fh = code('../src/renderer/src/components/monitor/FleetHealth.tsx')
    expect(fh).toContain("alertLogTarget({ kind: 'unit-failed', since: null, units: [u.name] })")
    expect(fh).toContain('priority: t.source.priority')
  })

  it('is not wired into the alert inbox, whose kinds all refuse', () => {
    expect(code('../src/renderer/src/components/monitor/AlertsPanel.tsx')).not.toContain(
      'alertLogTarget'
    )
  })

  it('applies the jump’s filters in the panel', () => {
    const panel = code('../src/renderer/src/components/monitor/LogTailPanel.tsx')
    expect(panel).toContain('if (jump.priority !== undefined) setPriority(jump.priority)')
  })
})
