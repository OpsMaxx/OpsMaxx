import { Info, X } from 'lucide-react'
import type { MigrationReport } from '../../../../shared/apiMigration'
import { useApi } from '../../store/api'
import { useHttp } from '../../store/http'

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "a, b and c", or "" for nothing. */
const listed = (parts: string[]): string =>
  parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

/**
 * What moved over, from the non-zero counts. A collection that needs its
 * OpenAPI description imported again did not move over in any useful sense,
 * so it is not counted here; the Re-import list says what happened to it.
 */
export function movedSentence(r: MigrationReport): string | null {
  const collections = r.collections - r.needsReimport.length
  const parts = [
    collections > 0 && plural(collections, 'collection'),
    r.requests > 0 && plural(r.requests, 'request'),
    r.environments > 0 && plural(r.environments, 'environment')
  ].filter((p): p is string => !!p)
  return parts.length ? `${listed(parts)} moved over.` : null
}

/** Whether a report says anything the user has to hear about. */
export function reportHasNews(r: MigrationReport | null): r is MigrationReport {
  return (
    !!r &&
    (r.collections > 0 ||
      r.environments > 0 ||
      r.needsReimport.length > 0 ||
      r.baseUrlCollisions.length > 0 ||
      r.rejected.length > 0)
  )
}

/**
 * Shown once after the upgrade, from the MigrationReport (§2.10, UX-M16): what
 * moved over, what did not, and the way back. Dismissal is stored against the
 * report's id, so a later migration shows its own.
 */
export function UpgradeBanner({ onRecover }: { onRecover?: () => void }): React.JSX.Element | null {
  const report = useApi((s) => s.report)
  const collections = useApi((s) => s.collections)
  const dismissed = useHttp((s) => s.bannerDismissed)
  if (!reportHasNews(report) || dismissed === report.id) return null

  const nameOf = (id: string): string => collections.find((c) => c.id === id)?.name ?? 'a collection'
  const reimport = (id: string): void => useHttp.getState().openImport(id)
  const moved = movedSentence(report)

  return (
    <div className="hc-banner" role="status">
      <Info size={16} aria-hidden />
      <div className="hc-banner-body">
        <div>
          The HTTP client was rebuilt.
          {moved && (
            <>
              {' '}
              <strong>{moved}</strong>
            </>
          )}
          {report.dropped.includes('cookies') && ' Cookies from the old client were cleared.'}
        </div>
        {report.needsReimport.length > 0 && (
          <div>
            {report.needsReimport.length === 1
              ? 'This collection was built from an OpenAPI description and needs importing again:'
              : 'These collections were built from OpenAPI descriptions and need importing again:'}
            <ul className="hc-banner-list">
              {report.needsReimport.map((c) => (
                <li key={c.id}>
                  {c.name}{' '}
                  <button className="btn sm" onClick={() => reimport(c.id)}>
                    Re-import
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.baseUrlCollisions.map((c) => (
          <div key={`${c.collectionId}|${c.environment}`}>
            Environment <em>{c.environment}</em> also defines <code>baseUrl</code>. Requests in{' '}
            <em>{nameOf(c.collectionId)}</em> will use the environment’s value (<code>{c.value}</code>) while{' '}
            <em>{c.environment}</em> is active.
          </div>
        ))}
        {report.rejected.length > 0 && (
          <div>
            {report.rejected.length === 1
              ? '1 saved item could not be converted and was kept aside.'
              : `${report.rejected.length} saved items could not be converted and were kept aside.`}
          </div>
        )}
        {onRecover && (
          <div className="hc-banner-actions">
            <button className="btn sm" onClick={onRecover}>
              Recover old data…
            </button>
          </div>
        )}
      </div>
      <button
        className="icon-btn sm"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => useHttp.getState().dismissBanner(report.id)}
      >
        <X size={14} />
      </button>
    </div>
  )
}
