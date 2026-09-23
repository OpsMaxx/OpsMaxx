import { isSensitiveName, type Id, type SentView } from '../../../../../shared/apiModel'
import type { HttpResponseOk } from '../../../../../shared/httpClient'
import { maskUrlsIn } from '../../../../../shared/httpErrors'
import { useHttpCookies } from '../../../store/httpCookies'
import { bytes } from '../../../lib/format'

// The response's Headers, Cookies and Timeline tabs. Everything the server
// sent is rendered as React text: no markup, no links.

export function HeadersView({ headers }: { headers: Record<string, string> }): React.JSX.Element {
  const rows = Object.entries(headers)
  if (rows.length === 0) return <p className="hc-rv-empty">No headers.</p>
  return (
    <table className="hc-rv-table" aria-label="Response headers">
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
  const set = (response.setCookie ?? []).map(parseSetCookie)
  const sentNames = sentCookieNames(sent)
  const host = hostOf(sent.url)
  return (
    <div className="hc-rv-cookies">
      <h4 className="ui-label">Set by this response</h4>
      {set.length === 0 ? (
        <p className="hc-rv-empty">None.</p>
      ) : (
        <table className="hc-rv-table" aria-label="Cookies set by this response">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Domain</th>
              <th>Path</th>
              <th>Expires</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {set.map((c, i) => (
              <tr key={`${c.name}-${i}`}>
                <td>{c.name}</td>
                <td>{c.value}</td>
                <td>{c.attrs.domain ?? host}</td>
                <td>{c.attrs.path ?? '/'}</td>
                <td>{c.attrs['max-age'] !== undefined ? `in ${c.attrs['max-age']} s` : (c.attrs.expires ?? 'Session')}</td>
                <td>{['secure', 'httponly', 'samesite'].filter((f) => f in c.attrs).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 className="ui-label">Sent from the jar</h4>
      <p className="hc-rv-empty">{sentNames.length === 0 ? 'None.' : sentNames.join(', ')}</p>
      {host && (
        <button
          className="btn sm"
          onClick={() => useHttpCookies.getState().clearDomain(`${workspaceId}|${sent.route.key}`, host)}
        >
          Clear jar for {host}
        </button>
      )}
      <p className="hc-rv-note">Cookies are kept until OpsMaxx quits.</p>
    </div>
  )
}

/** `Bearer •••` rather than `•••`: the scheme is not the secret, and it is what you check. */
export function maskHeaderValue(name: string, value: string): string {
  if (!isSensitiveName(name) || value.includes('•••')) return value
  const scheme = /^\s*(Bearer|Basic|Token|Digest)\s+/i.exec(value)?.[0] ?? ''
  return `${scheme}•••`
}

const TLS_LINE = {
  verified: 'Verified',
  'custom-ca': 'Verified with a custom CA',
  unverified: 'NOT verified'
} as const

/**
 * The request as it went out. `sent` is already masked by the build; the
 * headers are masked again here by name, so a gap in one place is not a leak.
 */
export function TimelineView({ sent, response }: { sent: SentView; response: HttpResponseOk }): React.JSX.Element {
  const facts: [string, string][] = [
    ['Method', sent.method],
    ['URL', maskUrlsIn(sent.url)],
    ['Sent from', sent.route.label],
    ['Certificates', TLS_LINE[sent.tls]],
    ['Redirects', sent.maxRedirects === 0 ? 'Not followed' : `Up to ${sent.maxRedirects}`],
    ['Timeout', `${sent.timeoutMs / 1000} s`],
    ['Body sent', bytes(sent.bodyBytes)],
    ['Duration', `${Math.round(response.durationMs)} ms`],
    ...(response.decodedFrom ? [['Decoded from', response.decodedFrom] as [string, string]] : []),
    ['Truncated', response.truncated ? 'Yes, at the 32 MiB limit' : 'No']
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
      <h4 className="ui-label">Request headers</h4>
      <table className="hc-rv-table" aria-label="Request headers as sent">
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
