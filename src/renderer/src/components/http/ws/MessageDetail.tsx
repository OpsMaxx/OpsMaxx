import { useMemo, useState } from 'react'
import { Copy, X } from 'lucide-react'
import { bytes, clsx } from '../../../lib/format'
import type { WsFrame } from '../../../store/wsSessions'
import { dirLabel, frameText, prettyJson, stamp } from './frames'

/** One frame, whole. Text only: a frame is whatever the far end chose to send. */
export function MessageDetail({
  frame,
  placement,
  onClose
}: {
  frame: WsFrame
  placement: 'right' | 'below'
  onClose: () => void
}): React.JSX.Element {
  const [pretty, setPretty] = useState(true)
  const [wrap, setWrap] = useState(true)
  const text = frameText(frame)
  const shown = useMemo(() => (pretty ? (prettyJson(text) ?? text) : text), [pretty, text])
  const partial = frame.text === undefined && !frame.binary && frame.dir !== 'system'

  return (
    <section
      className={clsx('hc-ws-detail', `is-${placement}`)}
      aria-label="Message detail"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="hc-ws-detail-head">
        <span className="hc-ws-detail-title">
          {dirLabel(frame)} · {stamp(frame.at)} · {bytes(frame.size)}
        </span>
        <span className="hc-ws-spacer" />
        <div className="hc-ws-seg" role="radiogroup" aria-label="View">
          <button type="button" role="radio" aria-checked={pretty} className={clsx('btn ghost sm', pretty && 'is-on')} onClick={() => setPretty(true)}>
            Pretty
          </button>
          <button type="button" role="radio" aria-checked={!pretty} className={clsx('btn ghost sm', !pretty && 'is-on')} onClick={() => setPretty(false)}>
            Raw
          </button>
        </div>
        <label className="hc-ws-check">
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
        </label>
        <button type="button" className="btn ghost sm" aria-label="Copy message" title="Copy message" onClick={() => window.opsmaxx?.clipboard?.write(text)}>
          <Copy size={13} />
        </button>
        <button type="button" className="btn ghost sm" aria-label="Close detail (Esc)" title="Close detail (Esc)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {(partial || frame.truncated) && (
        <p className="hc-ws-note">
          {frame.truncated
            ? 'OpsMaxx cut this frame before it reached the window; what arrived is shown.'
            : `Showing the first 64 KiB of ${bytes(frame.size)}.`}
        </p>
      )}
      <pre className={clsx('hc-ws-detail-body mono selectable', wrap && 'is-wrap')}>{shown}</pre>
    </section>
  )
}
