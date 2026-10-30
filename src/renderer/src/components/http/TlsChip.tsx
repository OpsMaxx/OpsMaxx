import { AlertTriangle, BadgeCheck, ShieldAlert } from 'lucide-react'
import type { Id } from '../../../../shared/apiModel'
import { useHttp } from '../../store/http'
import { useApi } from '../../store/api'
import { clsx } from '../../lib/format'
import { useTabOrGhost } from './RouteChip'
import { useT } from '../../lib/i18n'

export interface TlsChipProps {
  tabId: Id
  compact: boolean
}

/**
 * The owning collection's certificate mode, in the URL row (§2.11, SEC-M4).
 * Verification off is a `--danger` chip, a custom CA a quieter `--info` one.
 * `compact` shrinks either to its icon; nothing hides it. A certificate change
 * from another device waiting for review outranks both. A scratch request
 * always verifies, so it has no chip.
 */
export function TlsChip({ tabId, compact }: TlsChipProps): React.JSX.Element | null {
  const tab = useTabOrGhost(tabId)
  const t = useT()
  const collection = useApi((s) => (tab?.ref ? s.collections.find((c) => c.id === tab.ref!.collectionId) : undefined))
  if (!collection) return null
  const open = (): void => {
    useHttp.getState().openCollectionTab(collection.id, 'connection')
  }

  // A certificate change that arrived by sync is held until someone here
  // accepts it (§2.16, SEC-M4), and every request tab says so, not only the
  // collection: it is the request that would be sent under it.
  if (collection.tlsReview) {
    const label = t('http.tls.reviewLabel', { name: collection.name })
    return (
      <button
        className={clsx('hc-chip hc-chip-danger', compact && 'hc-chip-icon')}
        aria-label={label}
        title={t('http.tls.reviewTitle', { label })}
        onClick={open}
      >
        <ShieldAlert size={14} aria-hidden />
        {!compact && <span className="hc-chip-text">{t('http.tls.reviewChip')}</span>}
      </button>
    )
  }
  if (!collection.insecureTls && !collection.caPem) return null

  const off = collection.insecureTls
  const text = off ? t('http.tls.unverified') : t('http.tls.customCa')
  const label = off
    ? t('http.tls.unverifiedLabel', { name: collection.name })
    : t('http.tls.customCaLabel', { name: collection.name })
  const Icon = off ? AlertTriangle : BadgeCheck
  return (
    <button
      className={clsx('hc-chip', off ? 'hc-chip-danger' : 'hc-chip-info', compact && 'hc-chip-icon')}
      aria-label={label}
      title={t('http.tls.changeTitle', { label })}
      onClick={open}
    >
      <Icon size={14} aria-hidden />
      {!compact && <span className="hc-chip-text">{text}</span>}
    </button>
  )
}
