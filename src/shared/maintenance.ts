import { STORE_ALERT_KINDS, type StoreAlertKind } from './webhook'

// Item 44's maintenance window.
//
// A window is not a new suppression mechanism. It is "snooze every kind on
// these servers until T", written as the snooze rows the alert store already
// has -- which are durable, carry an ABSOLUTE `until`, and are replayed at
// launch. A second mechanism would be a second thing that can silence an
// estate, and only one of them would have been thought about.
//
// THREE THINGS A WINDOW MUST NOT DO, each of which has a reason older than this
// file:
//
//  1. It must not pause the sampler. A gap in the history store reads as "could
//     not tell", and the patch gate needs samples NEWER than the wave it is
//     gating -- a window that stopped sampling would make every gate in it
//     fail open or fail closed, and neither is what the operator asked for.
//
//  2. It must not suppress `webhookNotify`. That is the silent discard the
//     webhook module refuses by name: an endpoint that stops receiving cannot
//     tell a deliberate silence from a OpsMaxx that died.
//
//  3. It must not clear the chips. A snooze deliberately leaves them up,
//     because the condition is still true -- the window stops the ANNOUNCING,
//     not the observing.
//
// WHY IT IS NOT AGENT-REACHABLE. A window is a standing authorisation to be
// silent across an estate for a period. That is the same shape of decision as
// revoking a key, and it stays with a person.

export interface MaintenanceWindow {
  serverIds: string[]
  /** Absolute epoch ms. Absolute rather than a duration, for the reason a
   *  snoozed row is: a duration would restart at every launch. */
  until: number
  /** What it is for, in the operator's words. Shown, never parsed. */
  note: string
}

export type WindowCheck = { ok: true } | { ok: false; reason: string }

/** The longest a window may run. Not a technical limit: a silence nobody has
 *  to renew is a silence nobody remembers setting, and the estate goes quiet
 *  for a month because somebody meant to patch on Tuesday. */
export const MAX_WINDOW_HOURS = 24

export function checkMaintenanceWindow(w: MaintenanceWindow, now = Date.now()): WindowCheck {
  if (w.serverIds.length === 0) {
    return { ok: false, reason: 'Choose the servers this window covers. A window over nothing silences nothing.' }
  }
  if (!Number.isFinite(w.until)) return { ok: false, reason: 'That is not a time.' }
  if (w.until <= now) {
    return { ok: false, reason: 'That time has already passed, so the window would end before it began.' }
  }
  const hours = (w.until - now) / 3_600_000
  if (hours > MAX_WINDOW_HOURS) {
    return {
      ok: false,
      reason: `A window can run for at most ${MAX_WINDOW_HOURS} hours. A longer silence is one nobody remembers setting — open another when this one ends.`
    }
  }
  if (w.note.trim() === '') {
    return { ok: false, reason: 'Say what the window is for. Somebody reading the alert log in three weeks will want to know why it went quiet.' }
  }
  return { ok: true }
}

export interface PlannedSnooze {
  serverId: string
  kind: StoreAlertKind
  /** Milliseconds from now, because that is what `snoozeAlert` takes. Derived
   *  from the ABSOLUTE end, so every row in the window ends at the same
   *  moment however long the loop takes to run. */
  ms: number
}

/**
 * Every row a window writes.
 *
 * Every kind, not a chosen subset. An operator opening a window for a reboot
 * is not asking to keep being told about the disk on the machine they are
 * rebooting, and a window that covered some kinds and not others would be a
 * window they have to reason about while they are busy.
 */
export function maintenanceSnoozes(w: MaintenanceWindow, now = Date.now()): PlannedSnooze[] {
  const ms = Math.max(0, w.until - now)
  return w.serverIds.flatMap((serverId) =>
    STORE_ALERT_KINDS.map((kind) => ({ serverId, kind, ms }))
  )
}

/** What the operator is told they are about to do, before they do it. */
export function describeMaintenanceWindow(w: MaintenanceWindow, serverNames: string[], now = Date.now()): string {
  const hours = Math.round(((w.until - now) / 3_600_000) * 10) / 10
  return (
    `${serverNames.length} server(s) — ${serverNames.join(', ')} — stop announcing alerts for ${hours}h. ` +
    'They keep being sampled and their chips stay up; what stops is the notifications. Webhook endpoints still receive everything.'
  )
}

// ---------------------------------------------------------------------------
// WHETHER A WINDOW IS OPEN RIGHT NOW
// ---------------------------------------------------------------------------
//
// Opening a window was well built — the confirmation names every server it will
// silence and draws a precise line between what stops and what does not. What
// happened next was that the panel went back to looking exactly as it had
// before. Same composer, same "2 hours", same empty reason field, same "Open a
// window" button. The header still read "3 outstanding", the tab badge still
// read 3, and the status bar still read "3 alerts". The only trace anywhere was
// one line inside each alert card saying it was snoozed.
//
// Fleet-wide alert suppression is the single easiest way to miss a production
// outage, and the app forgot to mention it was on. A colleague arriving at the
// console could not tell that alerting was muted.
//
// This derives the answer from what is actually true — which alerts are
// currently snoozed — rather than from a stored "a window is open" flag. A flag
// would be a second copy of the truth: it would survive the snoozes expiring,
// it would survive somebody unsnoozing every alert by hand, and it would then
// claim a window was open when nothing was silenced. There is nothing to keep
// in step here because there is only one source.

/** The minimum a caller must supply per alert. */
export interface SnoozableAlert {
  serverId: string
  /** Epoch ms when this alert's snooze ends, or undefined when it is not snoozed. */
  snoozedUntil?: number
}

export interface ActiveMaintenance {
  /** Distinct servers with at least one silenced alert. */
  serverCount: number
  /** Alerts currently silenced. */
  alertCount: number
  /** When the LAST of them wakes up — the honest "until", since the window is
   *  not over while anything is still quiet. */
  until: number
  /** True when nothing outstanding is announcing. The header says so. */
  all: boolean
}

/**
 * What is silenced right now, or null when nothing is.
 *
 * `now` is a parameter so the caller's clock is the one that decides, and so a
 * test does not have to move the system clock to describe an expiry.
 */
export function activeMaintenance(
  alerts: readonly SnoozableAlert[],
  now = Date.now()
): ActiveMaintenance | null {
  const silenced = alerts.filter((a) => a.snoozedUntil !== undefined && a.snoozedUntil > now)
  if (silenced.length === 0) return null
  return {
    serverCount: new Set(silenced.map((a) => a.serverId)).size,
    alertCount: silenced.length,
    until: Math.max(...silenced.map((a) => a.snoozedUntil as number)),
    all: silenced.length === alerts.length
  }
}

/** "1h 47m", "12m", "under a minute" — how long is left, for the banner. */
export function remainingText(until: number, now = Date.now()): string {
  const ms = until - now
  if (ms <= 0) return 'ending now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'under a minute'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
