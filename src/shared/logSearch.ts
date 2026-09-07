import { LOG_PRIORITIES, type LogPriority } from './logtail'

// Searching the journal across hosts, over history rather than the live tail.
//
// The tailer follows what is happening now. This answers "when did this last
// happen, and on which of these machines" -- the question an incident starts
// with, and the one thing the logging feature could not do.
//
// ======================================================================
// THE DEFAULT IS A TRAP, MEASURED
// ======================================================================
//
// `journalctl -g` is SMART-CASE: an all-lowercase pattern matches
// case-insensitively, and a pattern with any capital in it matches exactly.
// Measured on systemd 255 against one day of a real journal:
//
//     -g session   ->  1135 matches
//     -g Session   ->   253
//     -g SESSION   ->     1
//     -g sEsSion   ->     1
//     -g SESSION --case-sensitive=false  ->  1135
//
// So an operator searching for `ERROR` is told there is one, on a host with
// over a thousand. That is not a surprising result, it is a WRONG ANSWER
// delivered confidently, and which answer they get depends on how they happened
// to type the word.
//
// This therefore ALWAYS passes `--case-sensitive` explicitly. The behaviour is
// then a property of the request rather than of the spelling, and the default
// is insensitive because "I searched for ERROR and it said none" is the failure
// nobody catches.
//
// ======================================================================
// THE PATTERN GOES INTO A SHELL, AND IS A REGULAR EXPRESSION
// ======================================================================
//
// It cannot be an allow-list of characters the way `--since` is: a regex needs
// `[ ] . * + ( ) | ^ $` and refusing those refuses the feature. What makes it
// safe is where it is placed. Inside SINGLE QUOTES a shell expands nothing --
// not `$`, not a backtick, not a backslash -- so the only character that can
// end the quoted word is a single quote itself. That one is refused, along with
// control characters, and nothing else needs to be.
//
// A bad regex is journalctl's to report rather than this parser's to predict:
// measured, `-g '['` exits 1 with `Bad pattern "[": missing terminating ]`.

export const LOG_SEARCH_MARKER = '===SP-LOGSEARCH==='

/** Bounded because this runs on several hosts at once and every line crosses
 *  the wire. Well above what anyone reads, far below what would matter. */
export const LOG_SEARCH_MAX_LINES = 500

/** The longest pattern worth sending. A regex this long is a mistake. */
export const LOG_SEARCH_MAX_PATTERN = 200

/**
 * Whether this pattern may be placed inside single quotes.
 *
 * See the header: the single quote is the only character that can escape them,
 * so it is the only one refused. Control characters go too -- a newline would
 * split the command, and the rest cannot be typed deliberately.
 */
export function validateSearchPattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false
  const p = pattern.trim()
  if (p === '' || p.length > LOG_SEARCH_MAX_PATTERN) return false
  if (p.includes("'")) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(p)
}

export interface LogSearchRequest {
  pattern: string
  /** journald `--since`, validated the way the tailer validates its own. */
  since?: string
  until?: string
  /** Narrow to one unit. */
  unit?: string
  priority?: LogPriority
  /**
   * Default FALSE, and always sent. See the header: leaving it out makes the
   * result depend on how the operator capitalised the word.
   */
  caseSensitive?: boolean
  limit?: number
}

const UNIT_RE = /^[A-Za-z0-9@._:-]{1,128}$/
const SINCE_RE = /^[A-Za-z0-9 :,._+-]{1,48}$/

export type LogSearchBuild = { ok: true; command: string } | { ok: false; reason: string }

export function buildLogSearchCommand(req: LogSearchRequest): LogSearchBuild {
  if (!validateSearchPattern(req.pattern)) {
    return {
      ok: false,
      reason:
        'A search pattern may not contain a single quote or a control character, and must be 1 to 200 characters. Everything else -- including regular expression syntax -- is passed through untouched.'
    }
  }
  for (const [name, v] of [
    ['since', req.since],
    ['until', req.until]
  ] as const) {
    if (v !== undefined && !SINCE_RE.test(v.trim())) {
      return { ok: false, reason: `That is not a time journalctl will take for --${name}.` }
    }
  }
  if (req.unit !== undefined && !UNIT_RE.test(req.unit.trim())) {
    return { ok: false, reason: 'That is not a unit name.' }
  }
  if (req.priority !== undefined && !(LOG_PRIORITIES as readonly string[]).includes(req.priority)) {
    return { ok: false, reason: 'That is not a journald priority.' }
  }
  const limit = Math.min(
    Math.max(1, Math.floor(req.limit ?? LOG_SEARCH_MAX_LINES)),
    LOG_SEARCH_MAX_LINES
  )

  const args = [
    '--no-pager',
    // journald prints oldest first, so `-n` keeps the NEWEST lines -- the ones
    // somebody searching an incident wants when the cap bites.
    `-n ${limit}`,
    `-g '${req.pattern.trim()}'`,
    // ALWAYS present. The whole point of the header.
    `--case-sensitive=${req.caseSensitive === true ? 'true' : 'false'}`
  ]
  if (req.since !== undefined) args.push(`--since '${req.since.trim()}'`)
  if (req.until !== undefined) args.push(`--until '${req.until.trim()}'`)
  if (req.unit !== undefined) args.push(`-u '${req.unit.trim()}'`)
  if (req.priority !== undefined) args.push(`-p ${req.priority}`)

  return {
    ok: true,
    // `command -v` first: a host with no journald must say so rather than
    // producing an empty result that reads as "nothing matched".
    command:
      `echo "${LOG_SEARCH_MARKER}"; ` +
      `command -v journalctl >/dev/null 2>&1 || { echo "NOJOURNAL"; exit 0; }; ` +
      `journalctl ${args.join(' ')} 2>&1`
  }
}

export type LogSearchFailure = 'no-journal' | 'bad-pattern' | 'denied' | 'unknown'

export type LogSearchOutcome =
  | { ok: true; lines: string[]; truncated: boolean }
  | { ok: false; reason: LogSearchFailure; detail: string }

export const LOG_SEARCH_FAILURE_HELP: Record<LogSearchFailure, string> = {
  'no-journal':
    'This host has no journalctl, so its history cannot be searched this way. Its logs may still be readable as files.',
  'bad-pattern':
    'journalctl refused the pattern as a regular expression. The message below is its own.',
  denied: 'This account may not read the journal on this host.',
  unknown: 'The search returned something that could not be read as a result.'
}

/** journald's own words for the two failures worth naming. */
const BAD_PATTERN = /^Bad pattern /m
const DENIED = /permission denied|Failed to (open|add) journal/i

/**
 * Read one host's answer.
 *
 * `-- No entries --` is journald saying it looked and found nothing, which is a
 * RESULT rather than a failure -- and is why the no-journal case is signalled by
 * its own token rather than inferred from an empty list.
 */
export function parseLogSearch(output: string, limit = LOG_SEARCH_MAX_LINES): LogSearchOutcome {
  const i = output.indexOf(LOG_SEARCH_MARKER)
  const body = i === -1 ? output : output.slice(i + LOG_SEARCH_MARKER.length)
  const text = body.trim()

  if (text === 'NOJOURNAL') {
    return { ok: false, reason: 'no-journal', detail: 'journalctl is not installed here' }
  }
  const bad = body.split('\n').find((l) => BAD_PATTERN.test(l))
  if (bad !== undefined) return { ok: false, reason: 'bad-pattern', detail: bad.trim() }
  const denied = body.split('\n').find((l) => DENIED.test(l))
  if (denied !== undefined) return { ok: false, reason: 'denied', detail: denied.trim() }

  const lines = body
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() !== '')
    // journald's own "I looked and found nothing" line is not a match.
    .filter((l) => l.trim() !== '-- No entries --')
  return { ok: true, lines, truncated: lines.length >= limit }
}
