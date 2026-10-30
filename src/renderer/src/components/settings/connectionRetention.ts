import { t } from '../../lib/i18n'

// Why "Keep authenticated connection" stops meaning anything while background
// checking is on.
//
// The pool arms a connection's idle timer only when its reference count reaches
// zero (see release() in main/services/ssh.ts). The metrics layer acquires one
// connection per server and holds it until that server stops being watched, so
// a server being sampled never reaches zero and its idle timer is never armed.
// Releasing after each pass would not help, though not for the reason an
// earlier version of this comment gave. That version said every interval is
// shorter than every non-zero retention choice, which is simply false — the
// 15-minute interval is longer than the 5-minute retention. The actual reason
// is that both cases are bad:
//
//   interval < retention  the next pass re-acquires before the timer fires, so
//                         nothing changes.
//   interval >= retention the connection really is torn down between passes, so
//                         the next background pass has to authenticate again —
//                         unattended. On a server with two-factor auth that is
//                         a prompt with nobody present to answer it, which is
//                         the failure mode verifyHostKey's allowPrompt exists
//                         to avoid.
//
// That is defensible as behaviour — reconnecting to fifteen hosts through a
// bastion every couple of minutes is worse — and indefensible as a silence.
// The retention setting's stated purpose is how often a two-factor code is
// requested, so turning background checking on quietly extends an authenticated
// session to the lifetime of the app. A user who chose "Immediately" chose it
// for a reason.
//
// This is a pure function so the condition can be tested without a DOM.

/** Human form of a background-checking interval. */
export function intervalLabel(ms: number): string {
  if (ms < 60_000) return t('settings.retention.intervalSeconds', { count: Math.round(ms / 1000) })
  return t('settings.retention.intervalMinutes', { count: Math.round(ms / 60_000) })
}

/**
 * The sentence to show under the retention choices, or null when the setting
 * means what it says.
 *
 * Null rather than an empty string: an empty description still renders a row of
 * blank space, and "nothing to say" should look like nothing.
 */
export function retentionOverrideNotice(
  fleetSamplingEnabled: boolean,
  intervalMs: number
): string | null {
  if (!fleetSamplingEnabled) return null
  const contacted =
    intervalMs < 60_000
      ? t('settings.retention.contactedSeconds', { count: Math.round(intervalMs / 1000) })
      : t('settings.retention.contactedMinutes', { count: Math.round(intervalMs / 60_000) })
  return `${contacted} ${t('settings.retention.overrideNotice')}`
}
