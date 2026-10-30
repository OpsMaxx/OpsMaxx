import { Trash2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useHttpCookies, type JarKey, type StoredCookie } from '../../store/httpCookies'
import { useApp } from '../../store/app'
import { useT } from '../../lib/i18n'
import type { Translate } from '../../../../shared/i18n'

/** A jar's route, as the route chip names it. */
function routeLabel(t: Translate, routeKey: string): string {
  if (routeKey === 'direct') return t('http.cookies.thisMachine')
  const [kind, id] = [routeKey.slice(0, routeKey.indexOf(':')), routeKey.slice(routeKey.indexOf(':') + 1)]
  const app = useApp.getState()
  if (kind === 'server')
    return t('http.cookies.throughServer', {
      name: app.servers.find((s) => s.id === id)?.name ?? t('http.cookies.removedServer')
    })
  return t('http.cookies.throughServer', { name: app.vpns.find((v) => v.id === id)?.name ?? t('http.cookies.removedVpn') })
}

function byDomain(cookies: StoredCookie[]): [string, StoredCookie[]][] {
  const out = new Map<string, StoredCookie[]>()
  for (const c of cookies) out.set(c.domain, [...(out.get(c.domain) ?? []), c])
  return [...out].sort(([a], [b]) => a.localeCompare(b))
}

const expiry = (t: Translate, c: StoredCookie): string =>
  c.expiresAt === undefined
    ? t('http.cookies.session')
    : t('http.cookies.until', { date: new Date(c.expiresAt).toLocaleString() })

/**
 * The cookie jar (§2.17): this workspace's cookies grouped by the route they
 * arrived through, then by domain. Values are not shown: a cookie is usually a
 * credential, and deleting one does not need it.
 */
export function CookiesPopover({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  const ws = useApp((s) => s.activeWorkspaceId)
  const jars = useHttpCookies((s) => s.jars)
  const mine = (Object.entries(jars) as [JarKey, StoredCookie[]][]).filter(
    ([key, cookies]) => key.startsWith(`${ws}|`) && cookies.length > 0
  )
  const { remove, clearDomain, clearAll } = useHttpCookies.getState()

  return (
    <Modal
      title={t('http.cookies.title')}
      subtitle={t('http.cookies.subtitle')}
      onClose={onClose}
      cancelLabel={t('common.close')}
      footer={
        mine.length > 0 ? (
          <button className="btn danger" onClick={() => clearAll()}>
            {t('http.cookies.clearAll')}
          </button>
        ) : undefined
      }
    >
      <div className="hc-cookies">
        {mine.length === 0 && <div className="faint">{t('http.cookies.empty')}</div>}
        {mine.map(([key, cookies]) => (
          <section className="hc-cookie-group" key={key} aria-label={routeLabel(t, key.slice(ws.length + 1))}>
            <div className="ui-label">{routeLabel(t, key.slice(ws.length + 1))}</div>
            {byDomain(cookies).map(([domain, list]) => (
              <div className="hc-cookie-group" key={domain}>
                <div className="hc-cookie-row">
                  <span className="hc-cookie-name">{domain}</span>
                  <button className="btn sm" onClick={() => clearDomain(key, domain)}>
                    {t('http.cookies.clearDomain')}
                  </button>
                </div>
                {list.map((c) => (
                  <div className="hc-cookie-row" key={`${c.name}|${c.path}`}>
                    <span className="hc-cookie-name" title={`${c.name} · ${c.path} · ${expiry(t, c)}`}>
                      {c.name}
                      <span className="faint">
                        {' '}
                        {c.path} · {expiry(t, c)}
                        {c.secure ? ` · ${t('http.cookies.secure')}` : ''}
                      </span>
                    </span>
                    <button
                      className="icon-btn xs"
                      aria-label={t('http.cookies.deleteCookie', { name: c.name, domain })}
                      title={t('common.delete')}
                      onClick={() => remove(key, c.name, c.domain, c.path)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  )
}
