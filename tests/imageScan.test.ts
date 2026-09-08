import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  buildScannerProbeCommand,
  buildTrivyCommand,
  parseTrivyOutput,
  SCAN_SEVERITIES,
  SCANNER_UNMEASURED,
  summariseScan,
  TRIVY_TEMPLATE
} from '../src/shared/imageScan'

// Item 42's scanner row. Three real trivy runs: an image whose OS is past end
// of support, a supported one with 221 findings, and a reference that does not
// exist.

const DIR = fileURLToPath(new URL('./fixtures/scan', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, `${n}.txt`), 'utf8')
const reading = (n: string): ReturnType<typeof parseTrivyOutput> => parseTrivyOutput(read(n))
const summary = (n: string): ReturnType<typeof summariseScan> => summariseScan(reading(n), true)

describe('the read', () => {
  it('was captured with the template this builds', () => {
    expect(read('command')).toContain(TRIVY_TEMPLATE)
    expect(buildTrivyCommand('nginx:1.27')).toContain(TRIVY_TEMPLATE)
  })

  it('keeps stderr, because the most important line is on it', () => {
    // Trivy prints the end-of-support warning to stderr, and the template
    // cannot reach `Metadata.OS.EOSL` at all -- it receives `types.Results`.
    expect(buildTrivyCommand('nginx:1.27')).toContain('2>&1')
  })

  it('never installs a scanner', () => {
    const probe = buildScannerProbeCommand()
    expect(probe).toContain('command -v trivy')
    for (const verb of ['install', 'apt', 'yum', 'apk', 'brew', 'curl']) {
      expect(probe).not.toContain(verb)
    }
  })

  it('says which scanners it does not claim to understand', () => {
    expect(SCANNER_UNMEASURED).toContain('grype')
    expect(SCANNER_UNMEASURED).toContain('docker scout')
  })
})

describe('an image whose OS nobody supports any more', () => {
  // THE finding. alpine:3.18 reports zero vulnerabilities and trivy warns that
  // the distribution has stopped issuing advisories for it.
  it('reads zero findings and the end-of-support warning together', () => {
    const r = reading('trivy-alpine-eosl')
    expect(r.rows).toHaveLength(0)
    expect(r.endOfSupport).toBe(true)
    expect(r.warnings.join(' ')).toContain('security updates are not provided')
  })

  it('never renders that as a clean image', () => {
    const s = summary('trivy-alpine-eosl')
    expect(s.total).toBe(0)
    expect(s.level).toBe('alarm')
    expect(s.headline).toContain('nobody is issuing advisories for it any more')
    expect(s.headline).not.toBe('The scanner found nothing.')
  })

  it('calls the findings a floor when an unsupported image has some', () => {
    const r = { ...reading('trivy-debian'), endOfSupport: true }
    expect(summariseScan(r, true).headline).toContain('a floor rather than a total')
  })
})

describe('counts that would invite a pointless upgrade', () => {
  // Measured: 221 findings, 5 with a fix, and all five are UNKNOWN severity.
  // Every one of the 4 CRITICAL and 52 HIGH has no fixed version.
  it('reads the fixable split, not just the totals', () => {
    const s = summary('trivy-debian')
    expect(s.total).toBe(221)
    expect(s.fixable).toBe(5)
    const by = Object.fromEntries(s.counts.map((c) => [c.severity, c]))
    expect(by.CRITICAL).toEqual({ severity: 'CRITICAL', total: 4, fixable: 0 })
    expect(by.HIGH).toEqual({ severity: 'HIGH', total: 52, fixable: 0 })
    expect(by.UNKNOWN).toEqual({ severity: 'UNKNOWN', total: 6, fixable: 5 })
  })

  it('says an upgrade will not clear them when nothing has a fix', () => {
    const s = summary('trivy-debian')
    expect(s.level).toBe('alarm')
    expect(s.headline).toContain('NONE of them has a fixed version')
    expect(s.headline).toContain('will not clear them')
  })

  it('says how many are fixable when some are', () => {
    const r = reading('trivy-debian')
    const patched = {
      ...r,
      rows: r.rows.map((x) => (x.severity === 'CRITICAL' ? { ...x, fixed: true } : x))
    }
    expect(summariseScan(patched, true).headline).toContain('4 of which have a fix available')
  })

  // Six of them, and folding UNKNOWN into LOW would understate while dropping
  // it would lose findings outright.
  it('keeps UNKNOWN as its own bucket', () => {
    expect(SCAN_SEVERITIES).toContain('UNKNOWN')
    expect(summary('trivy-debian').counts.map((c) => c.severity)).toEqual([...SCAN_SEVERITIES])
  })

  it('keeps trivy’s note that the severities are not all the distro’s own', () => {
    expect(reading('trivy-debian').warnings.join(' ')).toContain('severities from other vendors')
  })
})

describe('a scan that did not happen', () => {
  it('reports the failure rather than an empty result', () => {
    const s = summary('trivy-missing-image')
    expect(s.status).toBe('failed')
    expect(s.level).toBe('unknown')
    expect(s.headline).toContain('unable to find the specified image')
    expect(s.total).toBe(0)
  })

  it('ignores the update notice trivy prints on a bare terminal', () => {
    expect(read('trivy-missing-image')).toContain('Notices')
    expect(reading('trivy-missing-image').rows).toHaveLength(0)
  })

  // CONSTRUCTED. The recorded fixture only carries colour on the notices
  // block, which is skipped for being neither a log line nor a row -- so no
  // measured output distinguishes stripping from not. The requirement is still
  // real: `warnings` goes on screen, and escape codes rendered as text are
  // gibberish in the middle of a sentence.
  it('keeps escape codes out of a warning it will show, on constructed input', () => {
    const coloured = '2026-09-06T01:00:00+04:00\tWARN\t\u001b[33mThis OS version is no longer supported by the distribution\u001b[0m\n'
    const r = parseTrivyOutput(coloured)
    expect(r.warnings[0]).toBe('This OS version is no longer supported by the distribution')
    expect(r.endOfSupport).toBe(true)
  })

  it('names the first failure, not the last line of it unwinding', () => {
    expect(reading('trivy-missing-image').failure).toContain('image scan error')
  })

  // CONSTRUCTED, and labelled as such: every trivy failure measured emitted
  // exactly ONE FATAL line, so no fixture distinguishes first from last. The
  // choice is still a real one -- the first names what could not be done and
  // the later ones are it unwinding -- so it is pinned here rather than left to
  // whichever happened to be tested.
  it('keeps the first of several errors, on constructed input', () => {
    const two =
      '2026-09-06T01:00:00+04:00\tERROR\tcould not read the image\n' +
      '2026-09-06T01:00:01+04:00\tFATAL\tFatal error\tgiving up\n'
    expect(parseTrivyOutput(two).failure).toContain('could not read the image')
  })

  // No scanner is not a clean image, and nothing here installs one to find out.
  it('does not report a host with no scanner as ok', () => {
    const s = summariseScan(null, false)
    expect(s.status).toBe('no-scanner')
    expect(s.level).toBe('unknown')
    expect(s.headline).toContain('Nothing here installs one')
  })
})
