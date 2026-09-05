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
