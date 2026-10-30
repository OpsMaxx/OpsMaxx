import { Info, X } from 'lucide-react'
import type { MigrationReport } from '../../../../shared/apiMigration'
import { useApi } from '../../store/api'
import { useHttp } from '../../store/http'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { Translate } from '../../../../shared/i18n'

/** "a, b and c", or "" for nothing. Never more than three parts. */
const listed = (t: Translate, [a, b, c]: string[]): string =>
  c !== undefined ? t('http.upgrade.listThree', { a, b, c }) : b !== undefined ? t('http.upgrade.listTwo', { a, b }) : (a ?? '')

/**
 * What moved over, from the non-zero counts. A collection that needs its
 * OpenAPI description imported again did not move over in any useful sense,
 * so it is not counted here; the Re-import list says what happened to it.
 */
export function movedSentence(r: MigrationReport, t: Translate): string | null {
  const collections = r.collections - r.needsReimport.length
  const parts = [
    collections > 0 && t('http.upgrade.collections', { count: collections }),
    r.requests > 0 && t('http.upgrade.requests', { count: r.requests }),
    r.environments > 0 && t('http.upgrade.environments', { count: r.environments })
  ].filter((p): p is string => !!p)
  return parts.length ? t('http.upgrade.movedOver', { items: listed(t, parts) }) : null
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
  const t = useT()
  if (!reportHasNews(report) || dismissed === report.id) return null

  const nameOf = (id: string): string =>
    collections.find((c) => c.id === id)?.name ?? t('http.upgrade.aCollection')
  const reimport = (id: string): void => useHttp.getState().openImport(id)
  const moved = movedSentence(report, t)

  return (
    <div className="hc-banner" role="status">
      <Info size={16} aria-hidden />
      <div className="hc-banner-body">
        <div>
          {t('http.upgrade.rebuilt')}
          {moved && (
            <>
              {' '}
              <strong>{moved}</strong>
            </>
          )}
          {report.dropped.includes('cookies') && ` ${t('http.upgrade.cookiesCleared')}`}
        </div>
        {report.needsReimport.length > 0 && (
          <div>
            {report.needsReimport.length === 1
              ? t('http.upgrade.needsReimportOne')
              : t('http.upgrade.needsReimportMany')}
            <ul className="hc-banner-list">
              {report.needsReimport.map((c) => (
                <li key={c.id}>
                  {c.name}{' '}
                  <button className="btn sm" onClick={() => reimport(c.id)}>
                    {t('http.upgrade.reimport')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.baseUrlCollisions.map((c) => (
          <div key={`${c.collectionId}|${c.environment}`}>
            <Trans
              i18nKey="http.upgrade.baseUrlCollision"
              values={{ environment: c.environment, collection: nameOf(c.collectionId), value: c.value }}
              components={{ em: <em />, code: <code /> }}
            />
          </div>
        ))}
        {report.rejected.length > 0 && (
          <div>
            {t('http.upgrade.rejected', { count: report.rejected.length })}
          </div>
        )}
        {onRecover && (
          <div className="hc-banner-actions">
            <button className="btn sm" onClick={onRecover}>
              {t('http.upgrade.recover')}
            </button>
          </div>
        )}
      </div>
      <button
        className="icon-btn sm"
        aria-label={t('common.dismiss')}
        title={t('common.dismiss')}
        onClick={() => useHttp.getState().dismissBanner(report.id)}
      >
        <X size={14} />
      </button>
    </div>
  )
}
