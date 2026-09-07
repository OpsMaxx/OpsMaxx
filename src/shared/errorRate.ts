// How many error-priority journal lines a host is writing, per minute.
//
// The logging feature could tail, and now search. Neither NOTICES. An error
// rate is the one logging fact worth alerting on: a host that starts writing
// errors at forty a minute is a host something changed on, and nobody is
// watching the journal at three in the morning.
//
// ======================================================================
// THIS FILE DOES NOT READ ANYTHING
// ======================================================================
//
// The read lives in posture.ts beside the OOM and failed-login probes, and
// that is deliberate rather than incidental. Those two already answer the hard
// half of asking a journal anything -- WHICH journalctl, and whether this
// account may read it unprivileged, with root as a stated fallback -- and a
// second command builder here would be a second place that decision is made
// and therefore a second place it can be made differently. The same duplicate
// cost a bug earlier in this codebase, where the kind-to-engine mapping existed
// in two copies and one of them learned about MongoDB.
//
// So: posture reads and reports a COUNT and a WINDOW. This file turns those
// into a rate and a verdict, and owns nothing else.
//
// ======================================================================
// THE TRAP, MEASURED ON systemd 255
// ======================================================================
//
// `journalctl` writes `-- No entries --` TO STDERR when nothing matched. A
// count taken with the streams merged -- `2>&1`, which several readers in this
// codebase do, quite reasonably -- is therefore ONE for a host with no errors
// at all:
//
//     journalctl -p err --since -1sec --no-pager 2>&1     | wc -l   ->  1
//     journalctl -p err --since -1sec --no-pager 2>/dev/null | grep -c .  ->  0
//
// Measured both ways against an empty window and against one holding three real
// errors (every form answered 3). "One error a minute on every host, forever"
// is exactly the permanent low-grade noise that teaches people to ignore an
// alert, so the collector discards stderr AND passes `-q`, and counts with
// `grep -c .` so a blank line cannot be an error either.
//
// ======================================================================
// A COUNT NOBODY TOOK IS NOT ZERO
// ======================================================================
//
// The rate is `number | null`. Null is a host that could not be asked, and it
// must never render as "0 errors a minute" -- the most reassuring possible way
// to say nothing was measured.

/**
 * The window the collector asks for, in minutes.
 *
 * SIXTY, and it is tied to the posture sweep's hourly cadence rather than
 * chosen for its own sake: a window shorter than the interval between reads
 * leaves time nobody looked at, so an hourly sweep with a ten-minute window
 * would see one minute in six and still present its answer as this host's error
 * rate. Sixty minutes read hourly leaves no gap.
 *
 * Affordable, measured: the 60-minute read costs 0.213s on a real host.
 */
export const ERROR_RATE_WINDOW_MINUTES = 60

/**
 * Above this many a minute is worth saying.
 *
 * Stated as what it is -- a default somebody will change -- rather than dressed
 * up as a discovered constant. Nothing was measured to produce it, because the
 * number that matters is per-estate: a busy application server writes errors
 * all day and a quiet database does not.
 */
export const ERROR_RATE_DEFAULT_THRESHOLD = 5

/**
 * Lines per minute, or null.
 *
 * Null in, null out, and a window of zero is also null rather than a division
 * that returns Infinity -- an alert reading "Infinity a minute" is a bug
 * wearing a measurement's clothes.
 */
export function errorRatePerMinute(count: number | null, windowMinutes: number): number | null {
  if (count === null || !Number.isFinite(count) || count < 0) return null
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null
  return count / windowMinutes
}

export type ErrorRateVerdict = 'ok' | 'high' | 'unknown'

export interface ErrorRateReport {
  verdict: ErrorRateVerdict
  perMinute: number | null
  detail: string
}

/**
 * Whether a rate is worth saying out loud.
 *
 * `unknown` is its own verdict rather than folded into `ok`, because "we did
 * not look" and "we looked and it is fine" are the two answers an operator has
 * to be able to tell apart -- and only one of them is a reason to stop
 * worrying. Folding them is how a read that never happened becomes an
 * all-clear.
 */
export function errorRateReport(
  perMinute: number | null,
  windowMinutes: number,
  threshold = ERROR_RATE_DEFAULT_THRESHOLD,
  reason = ''
): ErrorRateReport {
  if (perMinute === null) {
    return {
      verdict: 'unknown',
      perMinute: null,
      detail: `The error rate was not measured${reason === '' ? '' : `: ${reason}`}. That is not the same as no errors.`
    }
  }
  const rounded = Math.round(perMinute * 10) / 10
  const lines = Math.round(perMinute * windowMinutes)
  const body = `${lines} line${lines === 1 ? '' : 's'} at error or worse in ${windowMinutes} minutes — ${rounded} a minute`
  return perMinute > threshold
    ? { verdict: 'high', perMinute, detail: `${body}, against a threshold of ${threshold}.` }
    : { verdict: 'ok', perMinute, detail: `${body}.` }
}
