// Item 42's scanner consumer: run a vulnerability scanner if the host has one,
// and report what it said. NEVER install one -- a security tool arriving on a
// server because a panel wanted a number is not a decision this app gets to
// make.
//
// TRIVY ONLY, and that is a stated limit rather than an oversight. `grype` and
// `docker scout cves` are named in the roadmap row and neither was measured, so
// neither is parsed here: a parser written from documentation is a parser that
// reports whatever it guessed. `SCANNER_UNMEASURED` says so on screen.
//
// THREE THINGS CAME OUT OF THE MEASUREMENT AND THEY SHAPE THE WHOLE MODULE.
//
//  1. `alpine:3.18` REPORTS ZERO VULNERABILITIES AND IS PAST END OF SUPPORT.
//     Trivy says both, the second on stderr:
//       WARN This OS version is no longer supported by the distribution
//       WARN The vulnerability detection may be insufficient because security
//            updates are not provided
//     Zero there means nobody is issuing advisories any more, not that nothing
//     is wrong. Printing "0 vulnerabilities" for that image tells an operator
//     the opposite of the truth, so an EOSL image never renders as clean.
//
//  2. `debian:12` REPORTS 221 VULNERABILITIES OF WHICH 5 HAVE A FIX -- and all
//     five are `UNKNOWN` severity. Every one of its 4 CRITICAL and 52 HIGH has
//     NO FIXED VERSION. A summary reading "4 critical, 52 high" invites an
//     `apt upgrade` that changes nothing at all, so the fixable count is
//     reported beside every severity rather than derived from it.
//
//  3. `UNKNOWN` IS A REAL SEVERITY AND THERE WERE SIX OF THEM. Folding it into
//     `low` understates, dropping it loses findings, so it is its own bucket.
//     Trivy also warns `Using severities from other vendors for some
//     vulnerabilities` -- the severities are not all the distribution's own.

export type ScanSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'

export const SCAN_SEVERITIES: readonly ScanSeverity[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNKNOWN'
]

const SEVERITY = new Set<string>(SCAN_SEVERITIES)

/** Named in the roadmap row, never measured, therefore never parsed. */
export const SCANNER_UNMEASURED =
  'Only trivy is read. `grype` and `docker scout cves` print something different and neither was measured against a real image, so this build does not claim to understand them rather than guessing at their output.'

/**
 * The read.
 *
 * `--format template` and not `--format json`: the JSON for one Debian image is
 * 589 KB, which is not a thing to pull over SSH to count five numbers. The
 * template receives `types.Results` and NOT the report, so `Metadata.OS.EOSL`
 * is unreachable from it -- measured, it fails with "can't evaluate field
 * ArtifactName in type types.Results". That fact is why `2>&1` is here rather
 * than for tidiness: trivy prints the end-of-support warning on stderr, and it
 * is the single most important thing the scan can say.
 */
export const TRIVY_TEMPLATE =
  '{{- range . }}{{- range .Vulnerabilities }}{{ .Severity }}|{{ if .FixedVersion }}fix{{ else }}nofix{{ end }}|{{ .VulnerabilityID }}|{{ .PkgName }}{{ println }}{{- end }}{{- end }}'

/** Image references are validated by `validateImageRef` in `shared/docker.ts`
 *  before they reach here; this only assembles. */
export function buildTrivyCommand(ref: string): string {
  return `trivy image --scanners vuln --format template --template '${TRIVY_TEMPLATE}' ${ref} 2>&1`
}

/** Whether a scanner is on the host at all. `command -v` and nothing else: this
 *  never installs one. */
export function buildScannerProbeCommand(): string {
  return 'command -v trivy 2>/dev/null || true'
}

export interface ScanRow {
  severity: ScanSeverity
  fixed: boolean
  id: string
  pkg: string
}

export interface TrivyReading {
  rows: ScanRow[]
  /** The distribution has stopped issuing advisories for this image's OS. */
  endOfSupport: boolean
  /** Trivy's own warnings, verbatim, in order. */
  warnings: string[]
  /** Set when trivy could not scan at all. Rows are then meaningless. */
  failure: string | null
}

/** Trivy's log lines: an RFC3339 stamp, a tab, a level, a tab, a message. */
const LOG_RE = /^\d{4}-\d\d-\d\dT[\d:.+-]+\s+(INFO|WARN|ERROR|FATAL|DEBUG)\s+(.*)$/
const EOSL_RE = /no longer supported by the distribution|security updates are not provided/i

/** Colour codes and the update notice trivy prints on a bare terminal. Stripped
 *  because they are not the host saying anything about the image. */
// eslint-disable-next-line no-control-regex -- ESC is exactly what is being matched
const ANSI_RE = /\u001b\[[0-9;]*m/g

export function parseTrivyOutput(output: string): TrivyReading {
  const rows: ScanRow[] = []
  const warnings: string[] = []
  let endOfSupport = false
  let failure: string | null = null

  for (const raw of output.replace(ANSI_RE, '').split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const log = LOG_RE.exec(line)
    if (log) {
      const [, level, message] = log
      if (level === 'FATAL' || level === 'ERROR') {
        // The FIRST one. Trivy's later lines are the same failure unwinding,
        // and the first names what it could not do.
        if (failure === null) failure = message.replace(/^Fatal error\s+/, '').trim()
        continue
      }
      if (level === 'WARN') {
        warnings.push(message.trim())
        if (EOSL_RE.test(message)) endOfSupport = true
      }
      continue
    }
    const f = line.split('|')
    if (f.length < 4) continue
    if (!SEVERITY.has(f[0])) continue
    rows.push({ severity: f[0] as ScanSeverity, fixed: f[1] === 'fix', id: f[2], pkg: f[3] })
  }

  return { rows, endOfSupport, warnings, failure }
}

export interface SeverityCount {
  severity: ScanSeverity
  total: number
  /** How many of them have a fixed version. The number that decides whether an
   *  upgrade is worth running. */
  fixable: number
}

export type ScanStatus = 'ok' | 'no-scanner' | 'failed'

/** The scan as it crosses IPC. `scannerPresent` is carried separately from the
 *  reading, because "no scanner" is not a failed scan and must not render as
 *  one. */
export type ImageScanProbe =
  | { ok: true; scannerPresent: boolean; reading: TrivyReading | null }
  | { ok: false; detail: string }

export interface ScanSummary {
  status: ScanStatus
  counts: SeverityCount[]
  total: number
  fixable: number
  endOfSupport: boolean
  level: 'ok' | 'watch' | 'alarm' | 'unknown'
  headline: string
}

export function summariseScan(
  reading: TrivyReading | null,
  scannerPresent: boolean
): ScanSummary {
  const empty = SCAN_SEVERITIES.map((severity) => ({ severity, total: 0, fixable: 0 }))
  if (!scannerPresent) {
    return {
      status: 'no-scanner',
      counts: empty,
      total: 0,
      fixable: 0,
      endOfSupport: false,
      // NOT `ok`. No scanner is not a clean image, and this build will not
      // install one to find out.
      level: 'unknown',
      headline: 'No vulnerability scanner on this server, so nothing was checked. Nothing here installs one.'
    }
  }
  if (reading === null || reading.failure !== null) {
    return {
      status: 'failed',
      counts: empty,
      total: 0,
      fixable: 0,
      endOfSupport: reading?.endOfSupport === true,
      level: 'unknown',
      headline:
        reading?.failure === null || reading?.failure === undefined
          ? 'The scan did not run.'
          : `The scan did not run: ${reading.failure}`
    }
  }

  const counts = SCAN_SEVERITIES.map((severity) => {
    const of = reading.rows.filter((r) => r.severity === severity)
    return { severity, total: of.length, fixable: of.filter((r) => r.fixed).length }
  })
  const total = reading.rows.length
  const fixable = reading.rows.filter((r) => r.fixed).length
  const bad = counts.filter((c) => c.severity === 'CRITICAL' || c.severity === 'HIGH')
  const badTotal = bad.reduce((n, c) => n + c.total, 0)
  const badFixable = bad.reduce((n, c) => n + c.fixable, 0)

  if (reading.endOfSupport) {
    // BEFORE the count, deliberately. A zero here is the most misleading number
    // the scan can produce.
    return {
      status: 'ok',
      counts,
      total,
      fixable,
      endOfSupport: true,
      level: 'alarm',
      headline:
        total === 0
          ? 'This image runs an OS the distribution no longer supports. It reports no vulnerabilities because nobody is issuing advisories for it any more, which is not the same as having none.'
          : `This image runs an OS the distribution no longer supports, so the ${total} finding(s) below are a floor rather than a total: no more advisories are being issued for it.`
    }
  }
  if (badTotal === 0) {
    return {
      status: 'ok',
      counts,
      total,
      fixable,
      endOfSupport: false,
      level: total === 0 ? 'ok' : 'watch',
      headline:
        total === 0
          ? 'The scanner found nothing.'
          : `${total} finding(s), none of them critical or high; ${fixable} have a fix.`
    }
  }
  return {
    status: 'ok',
    counts,
    total,
    fixable,
    endOfSupport: false,
    level: 'alarm',
    headline:
      badFixable === 0
        ? `${badTotal} critical or high finding(s), and NONE of them has a fixed version yet — upgrading the packages in this image will not clear them. The fix is a newer base image or waiting for the distribution.`
        : `${badTotal} critical or high finding(s), ${badFixable} of which have a fix available.`
  }
}
