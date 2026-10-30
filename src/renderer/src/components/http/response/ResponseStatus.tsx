import { useEffect, useState } from 'react'
import { Lock, LockOpen, AlertTriangle, Loader2 } from 'lucide-react'
import type { Id, ResponseState } from '../../../../../shared/apiModel'
import { presentError } from '../../../../../shared/httpErrors'
import { useHttp } from '../../../store/http'
import { cancel } from '../../../lib/httpSend'
import { bytes, clsx } from '../../../lib/format'
import { statusShape } from './bodyWindow'
import { useT } from '../../../lib/i18n'
import type { MessageKey } from '../../../../../shared/i18n'

const IDLE: ResponseState = { status: 'idle' }

export function useResponse(tabId: Id): ResponseState {
  return useHttp((s) => s.responses[tabId]) ?? IDLE
}

/** Seconds since `startedAt`, ticking while mounted. */
export function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  const t = useT()
  useEffect(() => {
    if (startedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? '' : t('http.response.seconds', { value: (Math.max(0, now - startedAt) / 1000).toFixed(1) })
}

const TLS_TEXT: Record<'verified' | 'custom-ca' | 'unverified', MessageKey> = {
  verified: 'http.response.tlsVerified',
  'custom-ca': 'http.response.tlsCustomCa',
  unverified: 'http.response.tlsUnverified'
}

/**
 * The response in one line: status, time, size, lock, route. It is the status
 * row's left half and the collapsed response bar's whole content, so it has to
 * read on its own.
 */
export function ResponseStatus({ tabId }: { tabId: Id }): React.JSX.Element {
  const r = useResponse(tabId)
  const elapsed = useElapsed(r.status === 'sending' ? r.startedAt : null)
  const t = useT()

  if (r.status === 'idle') return <span className="hc-rs hc-rs-idle">{t('http.response.noResponse')}</span>

  if (r.status === 'sending') {
    return (
      <span className="hc-rs">
        <Loader2 size={13} className="spin" aria-hidden />
        <span>{t('http.response.waiting', { elapsed })}</span>
        <button className="btn sm danger" onClick={() => cancel(tabId)} title={t('http.urlBar.cancelEsc')}>
          {t('common.cancel')}
        </button>
      </span>
    )
  }

  if (r.status === 'error') {
    if (r.errorClass === 'prod-declined') return <span className="hc-rs hc-rs-idle">{t('http.response.notSent')}</span>
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
    t('http.response.bodySize', { size: bytes(res.body.byteLength), bytes: res.body.byteLength }),
    res.decodedFrom && t('http.response.decoded', { encoding: res.decodedFrom }),
    res.truncated && t('http.response.truncated')
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="hc-rs">
      <span className={clsx('hc-rs-code', `hc-rs-${statusShape(res.status)}`)}>
        <span className={clsx('state-dot', statusShape(res.status))} aria-hidden />
        {res.status} {res.statusText}
      </span>
      <span className="hc-rs-metric">{t('http.response.ms', { value: Math.round(res.durationMs) })}</span>
      <span className="hc-rs-metric" title={size}>
        {bytes(res.body.byteLength)}
        {res.truncated ? ` ${t('http.response.cut')}` : ''}
      </span>
      {secure && (
        <span
          className={clsx('hc-rs-lock', sentAs.tls === 'unverified' && 'hc-danger')}
          title={t(TLS_TEXT[sentAs.tls])}
          aria-label={t(TLS_TEXT[sentAs.tls])}
          role="img"
        >
          {sentAs.tls === 'unverified' ? <LockOpen size={13} /> : <Lock size={13} />}
        </span>
      )}
      {sentAs.route.key !== 'direct' && <span className="hc-rs-metric">{t('http.response.via', { route: sentAs.route.label })}</span>}
    </span>
  )
}
