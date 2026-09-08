import { describe, it, expect } from 'vitest'
import { execFileSync, } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ERROR_RATE_DEFAULT_THRESHOLD,
  ERROR_RATE_WINDOW_MINUTES,
  errorRatePerMinute,
  errorRateReport
} from '../src/shared/errorRate'
import {
  POSTURE_INTERVAL_MS,
  POSTURE_STATUS_MARKER,
  buildPostureCommand,
  parsePosture,
  postureAlertReadings,
  postureSource
} from '../src/shared/posture'

// The journal error rate — how much a host is complaining, per minute.
//
// Two things had to be measured rather than read out of a manual, and both are
// pinned here against the REAL collector rather than against a description of
// it: the tests below build the actual posture command and run it with a fake
// journalctl on PATH.

const NOW = Date.UTC(2026, 8, 6, 20, 0, 0)

/** A host with one tool on it: a journalctl that behaves how we say. */
function withJournal(body: string): ReturnType<typeof parsePosture> {
  const root = mkdtempSync(join(tmpdir(), 'sp-errrate-'))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const f = join(bin, 'journalctl')
  writeFileSync(f, `#!/bin/sh\n${body}\n`)
  chmodSync(f, 0o755)
  // Everything except journalctl is hidden, exactly as the posture harness
  // does it, so the only thing that can answer is the one under test.
  let cmd = buildPostureCommand({ sudo: false, firewallRules: false })
  for (const name of ['ufw', 'firewall-cmd', 'nft', 'iptables', 'getenforce', 'aa-status', 'sshd', 'lastb', 'dmesg']) {
    cmd = cmd
      .replace(new RegExp(`for c in ${name}[^;]*;`), `for c in sp-absent-${name};`)
      .replace(new RegExp(`SP_BIN=${name}(?=[\\s;]|$)`), `SP_BIN=sp-absent-${name}`)
  }
  const out = execFileSync('/bin/sh', ['-c', cmd], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, SP_ROOTONLY: '' }
  })
  return parsePosture(out, NOW)
}

/** Answers the readability probe, then prints `lines` for the -p err read. */
const journalWith = (lines: number): string =>
  [
    'case " $* " in *" -n 0 "*) exit 0 ;; esac',
    'case " $* " in *" -p err "*)',
    `  i=0; while [ $i -lt ${lines} ]; do echo "Sep 06 20:00:00 h x[1]: boom"; i=$((i+1)); done`,
    // THE MEASURED BEHAVIOUR: journald writes this to STDERR, not stdout.
    `  [ ${lines} -eq 0 ] && echo "-- No entries --" >&2`,
    '  exit 0 ;;',
    'esac',
    'exit 0'
  ].join('\n')

describe('the trap that was measured, pinned against the real collector', () => {
  // `journalctl` writes `-- No entries --` TO STDERR when nothing matched. A
  // count taken with the streams merged is therefore ONE for a host with no
  // errors at all — a permanent low-grade false alert on every quiet machine
  // in the estate, which is exactly how people learn to ignore an alert.
  it('counts a host with no errors as zero, not as the “no entries” line', () => {
    const p = withJournal(journalWith(0))
    expect(postureSource(p, 'error-rate').status).toBe('ok')
    expect(p.errorRate?.count).toBe(0)
    expect(postureAlertReadings(p).errorPerMinute).toBe(0)
  })

  it('counts real errors as themselves', () => {
    const p = withJournal(journalWith(180))
    expect(p.errorRate?.count).toBe(180)
    expect(postureAlertReadings(p).errorPerMinute).toBe(180 / ERROR_RATE_WINDOW_MINUTES)
  })

  // All three guards, because the failure is silent and each is cheap. `-q`
  // and the redirect both suppress the sentinel; `grep -c .` refuses to count
  // a blank line as an error even if one arrives.
  it('discards journald’s stderr, passes -q, and counts non-empty lines only', () => {
    const c = buildPostureCommand({ sudo: false, firewallRules: false })
    const read = c.split('SP_ERRA=')[1]?.split('sp_val err-window')[0] ?? ''
    expect(read).toContain('-q')
    expect(read).toContain('-p err')
    expect(read).toContain('2>/dev/null')
    expect(read).toContain('grep -c .')
    expect(read).not.toContain('2>&1')
  })

  // `grep -c` exits 1 when it counts none and still PRINTS 0. A probe reading
  // the exit status would turn every quiet host into one that could not be
  // asked — the mistake the other counts in this file already avoid.
  it('takes the count from the output rather than from the exit status', () => {
    // Anchored to THIS line. `grep -c . || true` appears elsewhere in the
    // collector, so an unanchored search finds the OOM probe's copy and passes
    // whatever this one says — which is how the first version of this
    // assertion checked nothing at all.
    const c = buildPostureCommand({ sudo: false, firewallRules: false })
    expect(c).toContain('err-count "$($SP_ERRUN $SP_ERRA 2>/dev/null | grep -c . || true)"')
  })
})

describe('a journal nobody read is not a quiet journal', () => {
  // The whole reason this kind is the most dangerous of the numeric ones: an
  // unreadable journal produces no lines, and "no lines" and "no errors" are
  // the same empty output.
  it('says denied, and reports no rate, when the journal refuses to be read', () => {
    const p = withJournal('case " $* " in *" -n 0 "*) exit 1 ;; esac\nexit 1')
    expect(postureSource(p, 'error-rate').status).toBe('denied')
    expect(postureAlertReadings(p).errorPerMinute).toBeNull()
    expect(postureSource(p, 'error-rate').detail).toContain('NOT a report of no errors')
  })

  it('separates a journal that is absent from one that is refused', () => {
    // A host with no journalctl at all is `no-tool`, which is a different
    // sentence with a different fix from "there is one and you may not read it".
    const p = withJournal('exit 127')
    expect(['no-tool', 'denied']).toContain(postureSource(p, 'error-rate').status)
    expect(postureAlertReadings(p).errorPerMinute).toBeNull()
  })

  it('gives a reason whenever it gives no number', () => {
    const p = withJournal('case " $* " in *" -n 0 "*) exit 1 ;; esac\nexit 1')
    expect(postureAlertReadings(p).errorDetail).not.toBe('')
    expect(postureAlertReadings(null).errorPerMinute).toBeNull()
    expect(postureAlertReadings(null).errorDetail).not.toBe('')
  })
})

describe('a status and a count that disagree', () => {
  // The collector's output is HOST-CONTROLLED text. Today's script cannot emit
  // a count under a `denied` status, but the parser will happily read one from
  // a host whose script is older, patched, or broken — and a count trusted on
  // the strength of its own presence would turn a server that said out loud it
  // could not be read into the quietest machine in the fleet.
  //
  // `confirm()` can also downgrade an `ok` to `unknown` when a value is
  // missing, so the status a reading is checked against is not the one the
  // collector announced. Reading it back is what makes that downgrade mean
  // something.
  it('trusts the status over the number when the two disagree', () => {
    const out = [
      'V err-tool journal',
      'V err-count 0',
      `V err-window the last ${ERROR_RATE_WINDOW_MINUTES} minutes of the journal`,
      POSTURE_STATUS_MARKER,
      'error-rate denied - this account may not read the journal'
    ].join('\n')
    const p = parsePosture(out, NOW)
    expect(p.errorRate?.count).toBe(0)
    expect(postureSource(p, 'error-rate').status).toBe('denied')
    // ZERO IS ON THE POSTURE, AND NO RATE REACHES THE ALERT.
    expect(postureAlertReadings(p).errorPerMinute).toBeNull()
  })

  it('reports no rate when the count went missing under an ok status', () => {
    const out = ['V err-tool journal', POSTURE_STATUS_MARKER, 'error-rate ok - -'].join('\n')
    const p = parsePosture(out, NOW)
    // confirm() downgrades: the probe claimed success and returned no count.
    expect(postureSource(p, 'error-rate').status).toBe('unknown')
    expect(postureAlertReadings(p).errorPerMinute).toBeNull()
  })
})

describe('the window is tied to the sweep, not chosen for itself', () => {
  // A window shorter than the interval between collections leaves time nobody
  // looked at, and the answer would still be presented as this host's error
  // rate. This is the assertion that stops the two drifting apart.
  it('never leaves time unobserved between hourly collections', () => {
    expect(ERROR_RATE_WINDOW_MINUTES * 60_000).toBeGreaterThanOrEqual(POSTURE_INTERVAL_MS)
  })

  it('asks the host for exactly that window, and says so in the reading', () => {
    expect(buildPostureCommand({ sudo: false, firewallRules: false })).toContain(
      `--since -${ERROR_RATE_WINDOW_MINUTES}min`
    )
    expect(withJournal(journalWith(1)).errorRate?.window).toContain(
      `${ERROR_RATE_WINDOW_MINUTES} minutes`
    )
  })
})

describe('the arithmetic', () => {
  it('divides the count by the window', () => {
    expect(errorRatePerMinute(120, 60)).toBe(2)
    expect(errorRatePerMinute(0, 60)).toBe(0)
  })

  // A count nobody took is not zero, and a window of zero is not infinity.
  it('answers null for anything it cannot divide', () => {
    expect(errorRatePerMinute(null, 60)).toBeNull()
    expect(errorRatePerMinute(60, 0)).toBeNull()
    expect(errorRatePerMinute(60, -1)).toBeNull()
    expect(errorRatePerMinute(-1, 60)).toBeNull()
    expect(errorRatePerMinute(Number.NaN, 60)).toBeNull()
  })
})

describe('the verdict', () => {
  it('raises strictly above the threshold, matching what the sentence says', () => {
    expect(errorRateReport(ERROR_RATE_DEFAULT_THRESHOLD, 60).verdict).toBe('ok')
    expect(errorRateReport(ERROR_RATE_DEFAULT_THRESHOLD + 0.1, 60).verdict).toBe('high')
  })

  // "We did not look" and "we looked and it is fine" are the two answers an
  // operator must be able to tell apart, and only one is a reason to stop
  // worrying. Folding them is how a read that never happened becomes an
  // all-clear.
  it('keeps unknown apart from ok, and never prints a rate it does not have', () => {
    const u = errorRateReport(null, 60, 5, 'the journal refused')
    expect(u.verdict).toBe('unknown')
    expect(u.perMinute).toBeNull()
    expect(u.detail).toContain('the journal refused')
    expect(u.detail).toContain('not the same as no errors')
    expect(u.detail).not.toMatch(/\b0 a minute\b/)
  })

  // The hour is what somebody will actually go and read, so the sentence
  // carries it as well as the rate.
  it('says how many lines that is, as well as the rate', () => {
    expect(errorRateReport(2, 60).detail).toContain('120 lines')
    expect(errorRateReport(1 / 60, 60).detail).toContain('1 line at error')
  })
})
