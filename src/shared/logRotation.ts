// Whether this host's logs are actually being rotated, and how close the
// journal is to its ceiling.
//
// The tailer reads logs and the search reads history. Neither answers the
// question that precedes a full disk: is anything trimming these, and when did
// it last happen. `/var/log/journal` was the largest thing under `/var/log` on
// the measured host, at 203 MB.
//
// ======================================================================
// MEASURED ON UBUNTU 24.04, systemd 255
// ======================================================================
//
// THREE FINDINGS, and the middle one is why this module exists at all.
//
//  1. THE LOGROTATE STATE FILE'S DATES ARE NOT PADDED. It holds lines like
//
//         "/var/log/syslog" 2026-9-6-0:0:2
//
//     -- month, day, hour, minute and second all written without a leading
//     zero, in a format that is neither ISO nor anything `Date.parse` reads
//     correctly. Twenty-one of the twenty-one entries on the measured host are
//     that shape.
//
//  2. `journalctl --disk-usage` DOES NOT SAY WHAT THE LIMIT IS. It answers
//     "Archived and active journals take up 198.3M in the file system" and
//     stops. The configured cap was `#SystemMaxUse=` -- COMMENTED OUT -- which
//     does not mean unlimited: journald then computes a default from the
//     filesystem. The effective number exists in exactly one place, a line
//     journald writes to its OWN journal at startup:
//
//         System Journal (/var/log/journal/93af...) is 161.0M, max 4.0G, 3.9G free.
//
//     So "198.3M used" on its own is a number with no scale. 198 MB of a 4 GB
//     ceiling is nothing; 198 MB of a 256 MB ceiling is a journal about to
//     start dropping the oldest thing an operator was looking for.
//
//  3. A COMMENTED-OUT `SystemMaxUse` IS A DEFAULT, NOT AN ABSENCE. Reading the
//     config file alone and finding nothing set would justify the sentence
//     "there is no limit", which is false and is the most dangerous available
//     wrong answer here.

export const ROTATION_MARKERS = {
  logrotate: '===SP-ROT-LOGROTATE===',
  state: '===SP-ROT-STATE===',
  usage: '===SP-ROT-USAGE===',
  cap: '===SP-ROT-CAP==='
} as const

/** A rotation older than this is worth naming. Two weeks: a daily rotation
 *  that stopped a fortnight ago has missed thirteen turns, and a weekly one
 *  has missed one -- which is the earliest point the two are distinguishable
 *  without knowing each file's schedule, which the state file does not say. */
export const ROTATION_STALE_DAYS = 14

export function buildLogRotationCommand(): string {
  return [
    `echo "${ROTATION_MARKERS.logrotate}"; command -v logrotate >/dev/null 2>&1 && echo yes || echo no; systemctl is-active logrotate.timer 2>/dev/null || true`,
    // Both paths: Debian moved it under a directory, RHEL keeps the file.
    `echo "${ROTATION_MARKERS.state}"; cat /var/lib/logrotate/status /var/lib/logrotate.status 2>/dev/null || true`,
    `echo "${ROTATION_MARKERS.usage}"; journalctl --disk-usage 2>/dev/null || true`,
    // Finding 2: the effective cap is in journald's own log and nowhere else.
    // Newest last, so the parser takes the most recent announcement.
    `echo "${ROTATION_MARKERS.cap}"; journalctl -u systemd-journald --no-pager -n 200 2>/dev/null | grep -F "System Journal" | tail -n 3 || true`
  ].join('; ')
}

function section(output: string, marker: string): string {
  const i = output.indexOf(marker)
  if (i === -1) return ''
  const rest = output.slice(i + marker.length)
  const next = rest.search(/^===SP-ROT-/m)
  return next === -1 ? rest : rest.slice(0, next)
}

export interface RotatedFile {
  path: string
  /** Epoch ms of the last rotation, or null when the date could not be read. */
  lastMs: number | null
}

/**
 * The logrotate state file.
 *
 * Finding 1: the fields are NOT zero padded, so this is parsed as numbers
 * rather than handed to `Date.parse`. The date is also local to the host and
 * carries no zone, so it is read as UTC and treated as approximate -- which it
 * is: it exists to answer "roughly when", not to timestamp an event.
 */
export function parseRotationState(text: string): RotatedFile[] {
  const out: RotatedFile[] = []
  for (const line of text.split('\n')) {
    const m = line
      .trim()
      .match(/^"(.+)"\s+(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2}):(\d{1,2}):(\d{1,2})$/)
    if (m === null) continue
    const [, path, y, mo, d, h, mi, s] = m
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
    out.push({ path, lastMs: Number.isFinite(ms) ? ms : null })
  }
  return out
}

/** `198.3M`, `4.0G`, `512K` -> bytes. journald's own formatting. */
export function parseJournalSize(v: string): number | null {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT])?B?$/i)
  if (m === null) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const mult: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
  return Math.round(n * (m[2] ? mult[m[2].toUpperCase()] : 1))
}

export interface JournalUsage {
  usedBytes: number | null
  /**
   * The effective ceiling, or NULL when journald has not announced one.
   *
   * Null is not "no limit". Finding 3: journald always has a limit -- an unset
   * `SystemMaxUse` means it computed one from the filesystem -- so a null here
   * means this build could not find the announcement, and the UI must say that
   * rather than imply the journal can grow without bound.
   */
  maxBytes: number | null
}

export function parseJournalUsage(usageText: string, capText: string): JournalUsage {
  const used = usageText.match(/take up ([\d.]+[KMGT]?) in the file system/i)
  // `is 161.0M, max 4.0G, 3.9G free` -- the last such line is the most recent
  // announcement, which is why the command asks for the tail.
  const caps = [...capText.matchAll(/is\s+([\d.]+[KMGT]?),\s*max\s+([\d.]+[KMGT]?)/gi)]
  const last = caps.length > 0 ? caps[caps.length - 1] : null
  return {
    usedBytes: used ? parseJournalSize(used[1]) : null,
    maxBytes: last ? parseJournalSize(last[2]) : null
  }
}

export type LogrotatePresence = 'running' | 'installed-not-scheduled' | 'absent' | 'unknown'

export interface RotationReport {
  logrotate: LogrotatePresence
  files: RotatedFile[]
  /** Rotated longer ago than `ROTATION_STALE_DAYS`. */
  stale: RotatedFile[]
  journal: JournalUsage
  /** 0-100, or null when either half is unknown. Never assumed. */
  journalPct: number | null
}

export function parseLogRotation(output: string, nowMs: number): RotationReport {
  const lr = section(output, ROTATION_MARKERS.logrotate)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const present = lr[0]
  const timer = lr[1]
  const logrotate: LogrotatePresence =
    present === 'no'
      ? 'absent'
      : present === 'yes'
        ? timer === 'active'
          ? 'running'
          : 'installed-not-scheduled'
        : 'unknown'

  const files = parseRotationState(section(output, ROTATION_MARKERS.state))
  const cutoff = nowMs - ROTATION_STALE_DAYS * 86_400_000
  const stale = files.filter((f) => f.lastMs !== null && f.lastMs < cutoff)
  const journal = parseJournalUsage(
    section(output, ROTATION_MARKERS.usage),
    section(output, ROTATION_MARKERS.cap)
  )
  return {
    logrotate,
    files,
    stale,
    journal,
    journalPct:
      journal.usedBytes !== null && journal.maxBytes !== null && journal.maxBytes > 0
        ? (journal.usedBytes / journal.maxBytes) * 100
        : null
  }
}

/**
 * The one line.
 *
 * IT NEVER GIVES A SIZE WITHOUT ITS CEILING. "198.3M of journal" is a number
 * with no scale -- nothing against 4 GB, and an emergency against 256 MB -- and
 * a ceiling this build could not read is said to be unread rather than absent.
 */
export function rotationHeadline(r: RotationReport): string {
  const parts: string[] = []
  if (r.logrotate === 'absent') {
    parts.push('logrotate is not installed, so nothing here is trimming the files under /var/log')
  } else if (r.logrotate === 'installed-not-scheduled') {
    parts.push('logrotate is installed but its timer is not active, so it is not running on its own')
  } else if (r.logrotate === 'unknown') {
    parts.push('whether logrotate runs here could not be read')
  } else {
    parts.push(`logrotate is running and has rotated ${r.files.length} file(s)`)
  }
  if (r.stale.length > 0) {
    parts.push(
      `${r.stale.length} of them last rotated over ${ROTATION_STALE_DAYS} days ago (${r.stale
        .slice(0, 3)
        .map((f) => f.path)
        .join(', ')})`
    )
  }
  if (r.journal.usedBytes !== null) {
    parts.push(
      r.journal.maxBytes !== null
        ? `the journal is at ${Math.round(r.journalPct ?? 0)}% of the ceiling journald reported`
        : 'the journal size was read but journald has not announced its ceiling here, so how close it is cannot be said — it is not unlimited, it is unread'
    )
  }
  return `${parts.join('. ')}.`
}
