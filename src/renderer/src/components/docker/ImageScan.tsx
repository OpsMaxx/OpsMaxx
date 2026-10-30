import { useState } from 'react'
import { ShieldAlert, TriangleAlert } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import {
  SCANNER_UNMEASURED,
  summariseScan,
  type ImageScanProbe,
  type ScanSummary
} from '../../../../shared/imageScan'

// Item 42's scanner consumer on screen.
//
// Two things this must not do, both measured.
//
// It must not render zero as clean. `alpine:3.18` reports zero vulnerabilities
// AND is past its distribution's end of support, so nobody is issuing
// advisories for it any more. `summariseScan` returns `alarm` for that; this
// renders the level it is given rather than deciding from the count.
//
// It must not render "no scanner" as anything but unknown. On `debian:12` the
// scanner found 221 findings of which 5 had a fix -- a host with no scanner
// looks identical to a clean one from here, and only one of those is true.

export function ImageScanPanel({
  image,
  scan
}: {
  image: string
  scan: (ref: string) => Promise<ImageScanProbe>
}): React.JSX.Element {
  const t = useT()
  const [probe, setProbe] = useState<ImageScanProbe | null>(null)
  const [loading, setLoading] = useState(false)

  const run = async (): Promise<void> => {
    setLoading(true)
    try {
      setProbe(await scan(image))
    } catch (e) {
      setProbe({ ok: false, detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  const summary: ScanSummary | null =
    probe === null || !probe.ok ? null : summariseScan(probe.reading, probe.scannerPresent)

  return (
    <div style={{ marginTop: 6 }}>
      <button className="btn ghost sm" disabled={loading} onClick={() => void run()}>
        <ShieldAlert size={12} /> {probe === null ? t('docker.scan.scan') : t('docker.scan.scanAgain')}
        {loading && <span className="faint"> {t('docker.scan.reading')}</span>}
      </button>

      {probe !== null && !probe.ok && (
        <div className="s-note is-alarm">
          <TriangleAlert size={12} /> {t('docker.scan.failed')} <span className="mono">{probe.detail}</span>
        </div>
      )}

      {summary !== null && (
        <>
          <div
            className={clsx(
              's-note',
              summary.level === 'alarm' ? 'is-alarm' : summary.level === 'ok' ? '' : 'state-unknown'
            )}
          >
            {summary.headline}
          </div>
          {summary.status === 'ok' && (
            <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
              {summary.counts.map((c) => (
                <span
                  key={c.severity}
                  className={clsx('chip', c.total > 0 && (c.severity === 'CRITICAL' || c.severity === 'HIGH') && 'danger')}
                  // The fixable count is on the chip and not derived from the
                  // total: on the measured Debian image every critical and high
                  // had NO fix, so a total alone invites an upgrade that clears
                  // nothing.
                  title={t('docker.scan.fixableTitle', { fixable: c.fixable, total: c.total })}
                >
                  {c.severity.toLowerCase()} {c.total}
                  {c.total > 0 && ` ${t('docker.scan.fixable', { fixable: c.fixable })}`}
                </span>
              ))}
            </div>
          )}
          {summary.status === 'no-scanner' && (
            <div className="faint" style={{ fontSize: 11 }}>
              {SCANNER_UNMEASURED}
            </div>
          )}
          {probe?.ok === true &&
            probe.reading?.warnings.map((w) => (
              <div key={w} className="faint" style={{ fontSize: 11 }}>
                {w}
              </div>
            ))}
        </>
      )}
    </div>
  )
}
