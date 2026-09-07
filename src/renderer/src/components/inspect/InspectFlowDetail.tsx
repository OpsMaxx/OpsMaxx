import { useEffect, useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'
import { clsx } from '../../lib/format'
import { formatBytes, maskHeaderValue } from './InspectView'
import type { InspectFlow, InspectHeader } from '../../../../shared/inspect'

/**
 * One exchange, in full.
 *
 * The body is the interesting part and the dangerous one. What arrives with
 * the flow is a capped preview; anything past it is fetched from main on
 * demand, one page at a time, and never held for a flow the user is not
 * looking at. That is the difference between a panel that survives someone
 * downloading a container image through it and one that does not.
 */
export function InspectFlowDetail({
  flow,
  onClose
}: {
  flow: InspectFlow
  onClose: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'request' | 'response'>('response')
  const [revealed, setRevealed] = useState(false)

  // A new flow is a new body: showing the previous one's while the next loads
  // is how someone ends up reading the wrong request.
  useEffect(() => {
    setTab('response')
    setRevealed(false)
  }, [flow.id])

  const headers = tab === 'request' ? flow.request.headers : (flow.responseHeaders ?? [])
  const hasSensitive = headers.some((h) => maskHeaderValue(h.name, h.value, false) !== h.value)

  return (
    <aside className="detail-pane" style={{ width: 460, minWidth: 340, overflow: 'auto' }}>
      <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center', padding: 'var(--sp-2)' }}>
        <div style={{ minWidth: 0 }}>
          <div className="mono ellipsis" title={`${flow.request.method} ${flow.request.host}${flow.request.path}`}>
            {flow.request.method} {flow.request.path}
          </div>
          <div className="sub ellipsis">
            {flow.request.scheme}://{flow.request.host}:{flow.request.port}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn ghost size-24" onClick={onClose} aria-label="Close details">
          <X size={14} />
        </button>
      </div>

      {flow.error && (
        <div className="banner danger" role="alert">
          {flow.error}
        </div>
      )}

      <div className="segment" style={{ margin: 'var(--sp-2)' }}>
        <button
          className={clsx('seg-btn', tab === 'request' && 'active')}
          onClick={() => setTab('request')}
        >
          Request <span className="count">{formatBytes(flow.requestBytes ?? 0)}</span>
        </button>
        <button
          className={clsx('seg-btn', tab === 'response' && 'active')}
          onClick={() => setTab('response')}
        >
          Response <span className="count">{formatBytes(flow.responseBytes ?? 0)}</span>
        </button>
      </div>

      <section style={{ padding: '0 var(--sp-2)' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: '8px 0' }}>Headers</h3>
          <div className="spacer" />
          {hasSensitive && (
            <button className="btn ghost size-24" onClick={() => setRevealed((v) => !v)}>
              {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
              {revealed ? 'Hide credentials' : 'Reveal credentials'}
            </button>
          )}
        </div>
        {headers.length === 0 ? (
          <div className="sub">None recorded.</div>
        ) : (
          <HeaderList headers={headers} revealed={revealed} />
        )}
        {tab === 'request' && flow.request.headersTruncated && (
          <div className="sub">
            The header list was longer than ShellPilot records. The request itself was forwarded
            whole.
          </div>
        )}
      </section>

      <section style={{ padding: 'var(--sp-2)' }}>
        <h3 style={{ margin: '8px 0' }}>Body</h3>
        <BodyView flow={flow} side={tab} />
      </section>
    </aside>
  )
}

function HeaderList({
  headers,
  revealed
}: {
  headers: InspectHeader[]
  revealed: boolean
}): React.JSX.Element {
  return (
    <div className="col" style={{ gap: 2 }}>
      {headers.map((h, i) => (
        <div className="row mono" key={`${h.name}-${i}`} style={{ gap: 8, fontSize: 12 }}>
          <span className="sub" style={{ minWidth: 140, flexShrink: 0 }}>
            {h.name}
          </span>
          <span style={{ wordBreak: 'break-all' }}>{maskHeaderValue(h.name, h.value, revealed)}</span>
        </div>
      ))}
    </div>
  )
}

/** How much of a body is rendered at once. A megabyte of JSON in a <pre> is a
 *  frozen window; the rest is one click away. */
const PAGE = 64 * 1024

function BodyView({
  flow,
  side
}: {
  flow: InspectFlow
  side: 'request' | 'response'
}): React.JSX.Element {
  const preview = side === 'request' ? flow.requestPreview : flow.responsePreview
  const spilled = side === 'request' ? flow.requestSpilled : flow.responseSpilled
  const size = (side === 'request' ? flow.requestBytes : flow.responseBytes) ?? 0
  const truncated = side === 'request' ? flow.requestTruncated : flow.responseTruncated

  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setFull(null)
    setError(null)
  }, [flow.id, side])

  const text = full ?? (preview ? decode(preview) : '')
  const binary = looksBinary(text)

  if (!preview && size === 0) {
    return <div className="sub">No body.</div>
  }
  if (!preview) {
    return <div className="sub">{formatBytes(size)} not recorded.</div>
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      {binary ? (
        <div className="sub">
          {formatBytes(size)} of binary data ({flow.contentType ?? 'unknown type'}). Not shown as
          text.
        </div>
      ) : (
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 8,
            maxHeight: 320,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            background: 'var(--bg-input)',
            borderRadius: 4,
            fontSize: 12
          }}
        >
          {text}
        </pre>
      )}

      {error && <div className="sub danger">{error}</div>}

      {spilled && !full && !binary && (
        <button
          className="btn secondary size-24"
          disabled={loading}
          onClick={() => {
            setLoading(true)
            setError(null)
            void window.shellpilot?.inspect
              .body(flow.id, side, 0, PAGE)
              .then((page) => setFull(decode(page.base64)))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setLoading(false))
          }}
        >
          {loading ? 'Loading…' : `Load more (${formatBytes(size)} total)`}
        </button>
      )}

      {truncated && (
        <div className="sub">
          This body was larger than the capture limit. It reached its destination in full; only the
          recording stops here.
        </div>
      )}
    </div>
  )
}

function decode(base64: string): string {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/** A cheap, honest test: a body with NUL bytes or a lot of unprintable
 *  characters is not text, and rendering it as text produces a screenful of
 *  replacement characters that helps nobody. */
function looksBinary(text: string): boolean {
  if (!text) return false
  const sample = text.slice(0, 2048)
  if (sample.includes('\u0000')) return true
  let odd = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0xfffd || (code < 9) || (code > 13 && code < 32)) odd++
  }
  return odd / sample.length > 0.1
}
