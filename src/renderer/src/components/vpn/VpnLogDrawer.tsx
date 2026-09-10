import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Modal } from '../common/Modal'
import type { VpnLogLine } from '../../types'
import { clsx } from '../../lib/format'
import { bridgeHas } from '../../lib/bridge'

// The renderer's own cap. Main already rings its buffer, but a drawer left open
// through a reconnect loop would otherwise grow an unbounded React list in a
// process that also has terminals to render.
const MAX_LINES = 500

// stderr is not automatically an error — most engines log routine progress
// there — so the class comes from the stream, and only stderr gets emphasis.
const STREAM_CLASS: Record<VpnLogLine['stream'], string> = {
  stdout: '',
  stderr: 'warn',
  ctl: 'info',
  app: 'info'
}

type Collapsed = VpnLogLine & { repeats: number }

/**
 * Consecutive identical lines become one row with a count.
 *
 * Engines repeat themselves on a timer. Tailscale reprints "to start this
 * tsnet server … go to <url>" every five seconds for as long as the node is
 * unauthorised, so a drawer holding 500 lines held about forty minutes of the
 * same sentence and nothing else — the log became unreadable exactly while it
 * was carrying the one line somebody needed.
 *
 * Only CONSECUTIVE runs collapse, and the timestamp kept is the FIRST of the
 * run: the question a repeated line answers is when it started, not that it is
 * still going, which the count already says. Nothing is discarded — the row is
 * still one line of output, counted.
 */
function collapse(lines: VpnLogLine[]): Collapsed[] {
  const out: Collapsed[] = []
  for (const l of lines) {
    const prev = out[out.length - 1]
    if (prev && prev.text === l.text && prev.stream === l.stream) prev.repeats++
    else out.push({ ...l, repeats: 1 })
  }
  return out
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false })
}

interface VpnLogDrawerProps {
  profileId: string
  profileName: string
  onClose: () => void
}

export function VpnLogDrawer({
  profileId,
  profileName,
  onClose
}: VpnLogDrawerProps): React.JSX.Element {
  const [lines, setLines] = useState<VpnLogLine[]>([])
  const [copied, setCopied] = useState(false)

  /** The whole log as text, timestamps included, in the order it is read. */
  const copyAll = (): void => {
    window.opsmaxx?.clipboard?.write(
      collapse(lines)
        .map((l) => `${clock(l.at)} ${l.stream} ${l.text}${l.repeats > 1 ? ` (x${l.repeats})` : ''}`)
        .join('\n')
    )
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Subscribing here and only here is what keeps `vpn:log:<id>` off the wire the
  // rest of the time: preload sends log-subscribe on attach and log-unsubscribe
  // from the teardown it returns, and main ref-counts those. Mounting this
  // drawer is the subscription, unmounting it is the unsubscribe.
  useEffect(() => {
    let live = true
    const vpn = window.opsmaxx?.vpn
    const ns = vpn as Record<string, unknown> | undefined

    // Backfill first: lines that arrived before the drawer opened stopped at
    // main's ring buffer, and they are usually the ones explaining the failure
    // this was opened to read.
    if (bridgeHas(ns, 'logs')) {
      void vpn?.logs(profileId, MAX_LINES).then((history) => {
        if (live && history) setLines(history.slice(-MAX_LINES))
      })
    }

    const off = bridgeHas(ns, 'onLog')
      ? vpn?.onLog(profileId, (l) => {
          setLines((prev) => {
            const next =
              prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice()
            next.push(l)
            return next
          })
        })
      : undefined

    return () => {
      live = false
      off?.()
    }
  }, [profileId])

  // Follow the tail, but stop following the moment the user scrolls up to read
  // something — nothing is more annoying than a log that yanks itself away.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <Modal
      title={`${profileName} — log`}
      subtitle="Live output from the tunnel engine, with known secrets redacted"
      size="lg"
      onClose={onClose}
      // In the sticky footer, like every other modal in the app. Inside
      // `children` these buttons sit in the scrolling body, and a long log puts
      // Close below the fold of the very view that scrolls.
      footer={
        <>
          <span className="faint" style={{ fontSize: 11 }}>
            Showing the last {MAX_LINES} lines.
          </span>
          <span className="spacer" />
          {/* Because the thing people come here for is usually one line — an
              authorisation URL, a peer address, an error to paste into a
              search — and until now the view offered no way to get any of it
              out. Text selection is enabled too; this covers the whole log,
              which selection by hand does badly across 500 wrapped rows. */}
          <button className="btn" disabled={lines.length === 0} onClick={copyAll}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copied' : 'Copy all'}
          </button>
          <button className="btn" onClick={() => setLines([])}>
            Clear view
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div
        ref={scroller}
        className="logview"
        style={{ height: 380, overflowY: 'auto', borderRadius: 'var(--r-md)', padding: '6px 0' }}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {lines.length === 0 ? (
          <div className="log-line faint">No output yet.</div>
        ) : (
          collapse(lines).map((l, i) => (
            <div key={`${l.at}-${i}`} className={clsx('log-line', STREAM_CLASS[l.stream])}>
              <span className="ts">{clock(l.at)}</span>
              <span className="lvl">{l.stream}</span>
              <span className="log-text selectable">{l.text}</span>
              {/* A count rather than N identical rows. An engine that reprints
                  the same reminder every five seconds otherwise buries every
                  other line in the log under it — which is what the one line
                  worth reading was buried under. */}
              {l.repeats > 1 && <span className="log-repeat">×{l.repeats}</span>}
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}
