// What is scheduled by systemd, when it last ran, and whether the thing it runs
// actually worked.
//
// ======================================================================
// MEASURED ON A REAL UBUNTU 24.04.4 HOST, systemd 255
// ======================================================================
//
// FIVE FINDINGS, and four of them are traps that produce a confident wrong
// answer rather than an error.
//
//  1. A UNIT THAT DOES NOT EXIST REPORTS SUCCESS. `systemctl show
//     certbot.service` on a host with no certbot answers `Result=success`,
//     `ActiveState=inactive`, and EXITS 0. Reading `Result` alone says the
//     renewal succeeded on a machine where it was never installed. `LoadState`
//     is the only field that tells them apart -- `not-found` against `loaded` --
//     so it is checked FIRST and nothing else is believed until it passes.
//
//  2. `left` IN THE JSON IS NOT A DURATION. `systemctl list-timers -o json`
//     emits `{"next":1788690000000000,"left":1788690000000000,...}` -- the two
//     fields are the SAME ABSOLUTE MICROSECOND STAMP. Rendering `left` as a
//     remaining time gives about fifty-six thousand years.
//
//  3. `passed` IS A MONOTONIC STAMP, NOT AN AGE. Measured: the host's uptime was
//     1132793 s and `logrotate.timer` reported `passed: 1088423204482` µs
//     (1088423 s). Their difference is the real age; the number itself is time
//     since boot. Subtracting it from now would date every timer to the 1970s.
//     So the age is computed from `last`, which IS a realtime epoch.
//
//  4. `last: 0` MEANS NEVER, NOT 1970. Three timers on the host --
//     `apport-autoreport`, `snapd.snap-repair`, `ua-timer` -- report `last: 0`
//     and `next: null`. A zero fed to a date renders as "56 years ago", which
//     is the most alarming possible way to say "this has never run".
//
//  5. A TIMER AND ITS SERVICE HAVE DIFFERENT NORMAL STATES. `logrotate.timer`
//     is `active`; `logrotate.service` is `inactive` with `Result=success`,
//     because a oneshot that finished is supposed to be inactive. So `inactive`
//     on the timer means it will never fire, and `inactive` on the service
//     means it is done -- the same word, opposite meanings, and reading the
//     service's state as the timer's health is how a stopped timer looks fine.
//
// AND THE WHOLE POINT IS FINDING 5's OTHER HALF: a timer can fire perfectly
// every day while the service it activates fails every time. The host had two
// such services (`cloud-init`, `systemd-networkd-wait-online`) in exactly that
// state. Reading only the timer answers "is it scheduled" when the question is
// "is it working".

export const TIMER_MARKERS = {
  list: '===SP-TIMER-LIST===',
  timer: '===SP-TIMER-UNIT===',
  service: '===SP-TIMER-SERVICE==='
} as const

/** systemd unit names, strictly, because these are interpolated into a shell
 *  command. Letters, digits and the punctuation systemd itself allows. */
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9:_.\\@-]{0,255}\.(timer|service)$/

export function validateUnitName(name: unknown): boolean {
  return typeof name === 'string' && UNIT_RE.test(name)
}

/** Every timer, including ones that will never fire again. `--all` is what
 *  makes finding 4's rows appear at all. */
export function buildTimerListCommand(): string {
  return `echo "${TIMER_MARKERS.list}"; systemctl list-timers --all -o json --no-pager 2>/dev/null || true`
}

/**
 * One timer and the service it activates, in a single round trip.
 *
 * `LoadState` is requested for both, because of finding 1: without it a unit
 * that is not installed is indistinguishable from one that ran and succeeded.
 */
export function buildTimerDetailCommand(timerUnit: string, serviceUnit: string): string {
  if (!validateUnitName(timerUnit) || !validateUnitName(serviceUnit)) {
    throw new Error('refusing to query a unit name that is not one')
  }
  const props = '-p Id -p LoadState -p ActiveState -p SubState -p Result -p ExecMainStatus'
  return [
    `echo "${TIMER_MARKERS.timer}"; systemctl show ${timerUnit} ${props} -p LastTriggerUSec -p NextElapseUSecRealtime 2>/dev/null || true`,
    `echo "${TIMER_MARKERS.service}"; systemctl show ${serviceUnit} ${props} -p ExecMainExitTimestamp 2>/dev/null || true`
  ].join('; ')
}

function section(output: string, marker: string): string {
  const i = output.indexOf(marker)
  if (i === -1) return ''
  const rest = output.slice(i + marker.length)
  const next = rest.search(/^===SP-TIMER-/m)
  return next === -1 ? rest : rest.slice(0, next)
}

/** Split the two `systemctl show` blocks one round trip returns. */
export function parseTimerDetail(output: string): {
  timer: Record<string, string>
  service: Record<string, string>
} {
  return {
    timer: parseUnitShow(section(output, TIMER_MARKERS.timer)),
    service: parseUnitShow(section(output, TIMER_MARKERS.service))
  }
}

export interface TimerRow {
  unit: string
  activates: string
  /** Epoch ms of the next run, or null when it will never fire again. */
  nextMs: number | null
  /** Epoch ms of the last run, or NULL FOR NEVER -- see finding 4. */
  lastMs: number | null
}

/** kubectl-style: a line that is not JSON is a message, and a message read as
 *  data would invent a timer. */
export function parseTimerList(text: string): TimerRow[] {
  const t = text.trim()
  if (t === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(t)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: TimerRow[] = []
  for (const e of raw as Record<string, unknown>[]) {
    const unit = typeof e.unit === 'string' ? e.unit : ''
    if (unit === '') continue
    out.push({
      unit,
      activates: typeof e.activates === 'string' ? e.activates : '',
      // `next` is null for a timer with nothing scheduled. `left` is NOT used
      // at all: finding 2 -- it is the same absolute stamp as `next`.
      nextMs: usToMs(e.next),
      // Zero is never. Finding 4.
      lastMs: usToMs(e.last)
    })
  }
  return out
}

function usToMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  return Math.round(v / 1000)
}

/** `systemctl show` prints `Key=Value`, one per line, in no fixed order. */
export function parseUnitShow(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

export type TimerVerdict =
  | 'absent'
  | 'inactive'
  | 'never-run'
  | 'failing'
  | 'ok'
  | 'unknown'

export interface TimerHealth {
  verdict: TimerVerdict
  detail: string
  /** Epoch ms, or null. */
  lastRunMs: number | null
  nextRunMs: number | null
}

export interface TimerHealthInput {
  timer: Record<string, string>
  service: Record<string, string>
  row?: TimerRow
  nowMs: number
}

/**
 * Is this timer doing its job?
 *
 * ORDER IS THE DESIGN. `LoadState` first (finding 1), then whether the TIMER is
 * active (finding 5 -- `inactive` on a timer means it will never fire), then
 * whether the SERVICE last failed, and only then success. Each earlier answer
 * makes the later ones meaningless, and reporting a later one first is how a
 * host with no certbot gets told its renewals are fine.
 */
export function timerHealth(i: TimerHealthInput): TimerHealth {
  const lastRunMs = i.row?.lastMs ?? null
  const nextRunMs = i.row?.nextMs ?? null
  const base = { lastRunMs, nextRunMs }
  const name = i.timer.Id ?? 'this timer'

  if (i.timer.LoadState === 'not-found') {
    return {
      ...base,
      verdict: 'absent',
      // NOT "no renewals are failing". The unit is not installed, and the
      // `Result=success` beside it is systemd answering about nothing.
      detail: `${name} is not installed on this host, so nothing is scheduled. systemd reports success for a unit it does not have, which is not the same as a job that worked.`
    }
  }
  if (i.timer.LoadState === undefined || i.timer.LoadState === '') {
    return { ...base, verdict: 'unknown', detail: `${name} could not be read.` }
  }
  if (i.timer.ActiveState !== 'active') {
    return {
      ...base,
      verdict: 'inactive',
      detail: `${name} is installed but not active, so it will not fire. Whatever it runs is not being run on a schedule.`
    }
  }

  const svcName = i.service.Id ?? 'the service it activates'
  if (i.service.LoadState === 'not-found') {
    return {
      ...base,
      verdict: 'failing',
      detail: `${name} is active, but ${svcName} is not installed, so every run fails with nothing to start.`
    }
  }
  // Finding 5: `inactive` on a SERVICE is the normal end state of a oneshot and
  // is not consulted. What matters is how it last ended.
  if (i.service.ActiveState === 'failed' || (i.service.Result ?? 'success') !== 'success') {
    const code = i.service.ExecMainStatus
    const why = i.service.Result ?? 'unknown'
    return {
      ...base,
      verdict: 'failing',
      detail: `${name} is firing, but ${svcName} last ended in failure (${why}${code !== undefined && code !== '' ? `, exit ${code}` : ''}). A timer that runs a job that fails is not a job that is getting done.`
    }
  }
  if (lastRunMs === null) {
    return {
      ...base,
      verdict: 'never-run',
      // Zero is never, and never is not "56 years ago".
      detail: `${name} is active but has never run. It is scheduled${nextRunMs === null ? ', though nothing is currently scheduled to fire' : ''}.`
    }
  }
  return {
    ...base,
    verdict: 'ok',
    detail: `${name} is active, last ran ${describeAge(i.nowMs - lastRunMs)}, and ${svcName} finished successfully.`
  }
}

/** Rounded to something a person reads. Never a bare millisecond count. */
export function describeAge(ms: number): string {
  if (ms < 0) return 'in the future, which means a clock moved'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} second(s) ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} minute(s) ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour(s) ago`
  return `${Math.round(h / 24)} day(s) ago`
}

/**
 * Timers that look like certificate renewal.
 *
 * MATCHED AGAINST WHAT THE HOST LISTED, not against a list of names from
 * documentation. A name this does not recognise produces a MISS -- the operator
 * sees no renewal timer -- and never a wrong answer about a different unit,
 * which is the only failure mode worth accepting when the set of names cannot
 * be measured here. The test host runs no certbot, so this specific match is
 * the one thing in this file that is not measured, and it is a filter over
 * measured data rather than a parser.
 */
export function renewalTimers(rows: TimerRow[]): TimerRow[] {
  return rows.filter((r) => /certbot|acme|lego|dehydrated|letsencrypt/i.test(r.unit))
}
