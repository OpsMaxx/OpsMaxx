import { isSensitiveName, type Id, type SentView } from '../../../../../shared/apiModel'
import type { HttpResponseOk } from '../../../../../shared/httpClient'
import { maskUrlsIn } from '../../../../../shared/httpErrors'
import { useHttpCookies } from '../../../store/httpCookies'
import { bytes } from '../../../lib/format'
import { useT } from '../../../lib/i18n'
import type { MessageKey } from '../../../../../shared/i18n'

// The response's Headers, Cookies and Timeline tabs. Everything the server
// sent is rendered as React text: no markup, no links.

export function HeadersView({ headers }: { headers: Record<string, string> }): React.JSX.Element {
  const t = useT()
  const rows = Object.entries(headers)
  if (rows.length === 0) return <p className="hc-rv-empty">{t('http.responseTables.noHeaders')}</p>
  return (
    <table className="hc-rv-table" aria-label={t('http.responseTables.responseHeaders')}>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export interface ParsedCookie {
  name: string
  value: string
  attrs: Record<string, string>
}

export function parseSetCookie(line: string): ParsedCookie {
  const [pair, ...rest] = line.split(';')
  const eq = pair.indexOf('=')
  const attrs: Record<string, string> = {}
  for (const part of rest) {
    const i = part.indexOf('=')
    const key = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase()
    if (key) attrs[key] = i === -1 ? '' : part.slice(i + 1).trim()
  }
  return { name: (eq === -1 ? pair : pair.slice(0, eq)).trim(), value: eq === -1 ? '' : pair.slice(eq + 1).trim(), attrs }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Cookie names the request carried. The values were masked in `sentAs`, and stay so. */
function sentCookieNames(sent: SentView): string[] {
  const header = sent.headers.find(([k]) => k.toLowerCase() === 'cookie')?.[1] ?? ''
  return header.includes('=') ? header.split(';').map((p) => p.split('=')[0].trim()).filter(Boolean) : []
}

export function CookiesView({
  response,
  sent,
  workspaceId
}: {
  response: HttpResponseOk
  sent: SentView
  workspaceId: Id
}): React.JSX.Element {
  const t = useT()
  const set = (response.setCookie ?? []).map(parseSetCookie)
  const sentNames = sentCookieNames(sent)
  const host = hostOf(sent.url)
  return (
    <div className="hc-rv-cookies">
      <h4 className="ui-label">{t('http.responseTables.setByResponse')}</h4>
      {set.length === 0 ? (
        <p className="hc-rv-empty">{t('http.responseTables.none')}</p>
      ) : (
        <table className="hc-rv-table" aria-label={t('http.responseTables.cookiesSet')}>
          <thead>
            <tr>
              <th>{t('http.responseTables.name')}</th>
              <th>{t('http.responseTables.value')}</th>
              <th>{t('http.responseTables.domain')}</th>
              <th>{t('http.responseTables.path')}</th>
              <th>{t('http.responseTables.expires')}</th>
              <th>{t('http.responseTables.flags')}</th>
            </tr>
          </thead>
          <tbody>
            {set.map((c, i) => (
              <tr key={`${c.name}-${i}`}>
                <td>{c.name}</td>
                <td>{c.value}</td>
                <td>{c.attrs.domain ?? host}</td>
                <td>{c.attrs.path ?? '/'}</td>
                <td>
                  {c.attrs['max-age'] !== undefined
                    ? t('http.responseTables.inSeconds', { seconds: c.attrs['max-age'] })
                    : (c.attrs.expires ?? t('http.responseTables.session'))}
                </td>
                <td>{['secure', 'httponly', 'samesite'].filter((f) => f in c.attrs).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 className="ui-label">{t('http.responseTables.sentFromJar')}</h4>
      <p className="hc-rv-empty">{sentNames.length === 0 ? t('http.responseTables.none') : sentNames.join(', ')}</p>
      {host && (
        <button
          className="btn sm"
          onClick={() => useHttpCookies.getState().clearDomain(`${workspaceId}|${sent.route.key}`, host)}
        >
          {t('http.responseTables.clearJar', { host })}
        </button>
      )}
      <p className="hc-rv-note">{t('http.cookies.subtitle')}</p>
    </div>
  )
}

/** `Bearer •••` rather than `•••`: the scheme is not the secret, and it is what you check. */
export function maskHeaderValue(name: string, value: string): string {
  if (!isSensitiveName(name) || value.includes('•••')) return value
  const scheme = /^\s*(Bearer|Basic|Token|Digest)\s+/i.exec(value)?.[0] ?? ''
  return `${scheme}•••`
}

const TLS_LINE: Record<SentView['tls'], MessageKey> = {
  verified: 'http.responseTables.tlsVerified',
  'custom-ca': 'http.responseTables.tlsCustomCa',
  unverified: 'http.responseTables.tlsUnverified'
}

/**
 * The request as it went out. `sent` is already masked by the build; the
 * headers are masked again here by name, so a gap in one place is not a leak.
 */
export function TimelineView({ sent, response }: { sent: SentView; response: HttpResponseOk }): React.JSX.Element {
  const t = useT()
  const facts: [string, string][] = [
    [t('http.responseTables.method'), sent.method],
    [t('http.responseTables.url'), maskUrlsIn(sent.url)],
    [t('http.responseTables.sentFrom'), sent.route.label],
    [t('http.responseTables.certificates'), t(TLS_LINE[sent.tls])],
    [
      t('http.responseTables.redirects'),
      sent.maxRedirects === 0
        ? t('http.responseTables.notFollowed')
        : t('http.responseTables.upTo', { count: sent.maxRedirects })
    ],
    [t('http.responseTables.timeout'), t('http.response.seconds', { value: sent.timeoutMs / 1000 })],
    [t('http.responseTables.bodySent'), bytes(sent.bodyBytes)],
    [t('http.responseTables.duration'), t('http.response.ms', { value: Math.round(response.durationMs) })],
    ...(response.decodedFrom ? [[t('http.responseTables.decodedFrom'), response.decodedFrom] as [string, string]] : []),
    [
      t('http.responseTables.truncated'),
      response.truncated ? t('http.responseTables.truncatedYes') : t('common.no')
    ]
  ]
  return (
    <div className="hc-rv-timeline">
      <dl className="hc-rv-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h4 className="ui-label">{t('http.request.requestHeaders')}</h4>
      <table className="hc-rv-table" aria-label={t('http.responseTables.requestHeadersSent')}>
        <tbody>
          {sent.headers.map(([name, value], i) => (
            <tr key={`${name}-${i}`}>
              <th scope="row">{name}</th>
              <td>{maskHeaderValue(name, value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
