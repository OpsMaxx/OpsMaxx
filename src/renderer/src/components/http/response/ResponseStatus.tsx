import { useEffect, useState } from 'react'
import { Lock, LockOpen, AlertTriangle, Loader2 } from 'lucide-react'
import type { Id, ResponseState } from '../../../../../shared/apiModel'
import { presentError } from '../../../../../shared/httpErrors'
import { useHttp } from '../../../store/http'
import { cancel } from '../../../lib/httpSend'
import { bytes, clsx } from '../../../lib/format'
import { statusShape } from './bodyWindow'

const IDLE: ResponseState = { status: 'idle' }

export function useResponse(tabId: Id): ResponseState {
  return useHttp((s) => s.responses[tabId]) ?? IDLE
}

/** Seconds since `startedAt`, ticking while mounted. */
export function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const t = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(t)
  }, [startedAt])
  return startedAt === null ? '' : `${(Math.max(0, now - startedAt) / 1000).toFixed(1)} s`
}

const TLS_TEXT = {
  verified: 'Certificate verified',
  'custom-ca': 'Certificate verified with a custom CA',
  unverified: 'Certificate NOT verified'
} as const

/**
 * The response in one line: status, time, size, lock, route. It is the status
 * row's left half and the collapsed response bar's whole content, so it has to
 * read on its own.
 */
export function ResponseStatus({ tabId }: { tabId: Id }): React.JSX.Element {
  const r = useResponse(tabId)
  const elapsed = useElapsed(r.status === 'sending' ? r.startedAt : null)

  if (r.status === 'idle') return <span className="hc-rs hc-rs-idle">No response yet</span>

  if (r.status === 'sending') {
    return (
      <span className="hc-rs">
        <Loader2 size={13} className="spin" aria-hidden />
        <span>Waiting… {elapsed}</span>
        <button className="btn sm danger" onClick={() => cancel(tabId)} title="Cancel (Esc)">
          Cancel
        </button>
      </span>
    )
  }

  if (r.status === 'error') {
    if (r.errorClass === 'prod-declined') return <span className="hc-rs hc-rs-idle">Not sent</span>
    return (
      <span className="hc-rs hc-rs-error">
        <AlertTriangle size={13} aria-hidden />
        <span>{presentError(r.errorClass, r.message).message}</span>
      </span>
    )
  }

  const { response: res, sentAs } = r
  const secure = /^https:/i.test(sentAs.url)
  const size = [
    `Body ${bytes(res.body.byteLength)} (${res.body.byteLength} bytes)`,
    res.decodedFrom && `${res.decodedFrom}, decoded`,
    res.truncated && 'truncated at the 32 MiB limit'
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="hc-rs">
      <span className={clsx('hc-rs-code', `hc-rs-${statusShape(res.status)}`)}>
        <span className={clsx('state-dot', statusShape(res.status))} aria-hidden />
        {res.status} {res.statusText}
      </span>
      <span className="hc-rs-metric">{Math.round(res.durationMs)} ms</span>
      <span className="hc-rs-metric" title={size}>
        {bytes(res.body.byteLength)}
        {res.truncated ? ' (cut)' : ''}
      </span>
      {secure && (
        <span
          className={clsx('hc-rs-lock', sentAs.tls === 'unverified' && 'hc-danger')}
          title={TLS_TEXT[sentAs.tls]}
          aria-label={TLS_TEXT[sentAs.tls]}
          role="img"
        >
          {sentAs.tls === 'unverified' ? <LockOpen size={13} /> : <Lock size={13} />}
        </span>
      )}
      {sentAs.route.key !== 'direct' && <span className="hc-rs-metric">via {sentAs.route.label}</span>}
    </span>
  )
}
