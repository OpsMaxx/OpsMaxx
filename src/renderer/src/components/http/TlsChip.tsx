import { AlertTriangle, BadgeCheck, ShieldAlert } from 'lucide-react'
import type { Id } from '../../../../shared/apiModel'
import { useHttp } from '../../store/http'
import { useApi } from '../../store/api'
import { clsx } from '../../lib/format'
import { useTabOrGhost } from './RouteChip'

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
  const collection = useApi((s) => (tab?.ref ? s.collections.find((c) => c.id === tab.ref!.collectionId) : undefined))
  if (!collection) return null
  const open = (): void => {
    useHttp.getState().openCollectionTab(collection.id, 'connection')
  }

  // A certificate change that arrived by sync is held until someone here
  // accepts it (§2.16, SEC-M4), and every request tab says so, not only the
  // collection: it is the request that would be sent under it.
  if (collection.tlsReview) {
    const label = `Connection settings for ${collection.name} changed on another device — Review`
    return (
      <button
        className={clsx('hc-chip hc-chip-danger', compact && 'hc-chip-icon')}
        aria-label={label}
        title={`${label}. The change is not used until it is accepted in the collection's Connection settings.`}
        onClick={open}
      >
        <ShieldAlert size={14} aria-hidden />
        {!compact && <span className="hc-chip-text">Review TLS change</span>}
      </button>
    )
  }
  if (!collection.insecureTls && !collection.caPem) return null

  const off = collection.insecureTls
  const text = off ? 'TLS unverified' : 'Custom CA'
  const label = off
    ? `Certificate verification is off for this collection (${collection.name})`
    : `Certificates are checked against a custom CA from ${collection.name}`
  const Icon = off ? AlertTriangle : BadgeCheck
  return (
    <button
      className={clsx('hc-chip', off ? 'hc-chip-danger' : 'hc-chip-info', compact && 'hc-chip-icon')}
      aria-label={label}
      title={`${label}. Change it in the collection's Connection settings.`}
      onClick={open}
    >
      <Icon size={14} aria-hidden />
      {!compact && <span className="hc-chip-text">{text}</span>}
    </button>
  )
}
