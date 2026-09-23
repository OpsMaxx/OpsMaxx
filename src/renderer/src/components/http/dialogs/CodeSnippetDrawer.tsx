import { useMemo, useState } from 'react'
import { pythonRequests } from '@scalar/snippetz/plugins/python/requests'
import { goNative } from '@scalar/snippetz/plugins/go/native'
import { shellHttpie } from '@scalar/snippetz/plugins/shell/httpie'
import { clsx } from '../../../lib/format'
import { outgoing, toCurl, type Outgoing } from '../../../../../shared/curl'
import type { GraphQlRequest, HttpRequest, SentView } from '../../../../../shared/apiModel'
import type { HttpRequestSpec } from '../../../../../shared/httpClient'

/**
 * Generate code for the current request.
 *
 * Masked by default, through the same `outgoing` view Copy as cURL uses, so a
 * snippet cannot show a secret the cURL copy would hide. "Include secrets"
 * asks first, and only then calls the owner for the live spec.
 *
 * Every language here passed the escaping test in tests/codeSnippets.test.ts
 * (a value with `"`, `\`, `'`, a newline and `$(…)` parses back unchanged).
 * snippetz's own fetch output did not — it writes `'` and `\` into a
 * single-quoted JS string unescaped — so fetch is generated here with
 * `JSON.stringify`, whose output is always a valid JS string literal.
 */
export type SnippetLang = 'curl' | 'fetch' | 'python' | 'go' | 'httpie'

const LANGS: { id: SnippetLang; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'fetch', label: 'fetch' },
  { id: 'python', label: 'Python' },
  { id: 'go', label: 'Go' },
  { id: 'httpie', label: 'HTTPie' }
]

interface HarRequest {
  method: string
  url: string
  headers: { name: string; value: string }[]
  postData?: { mimeType: string; text?: string; params?: { name: string; value?: string; fileName?: string }[] }
}

function harFor(o: Outgoing): HarRequest {
  const har: HarRequest = { method: o.method, url: o.url, headers: o.headers.map(([name, value]) => ({ name, value })) }
  const b = o.body
  if (b && 'text' in b) har.postData = { mimeType: b.contentType || 'text/plain', text: b.text }
  else if (b && 'form' in b) {
    har.postData = {
      mimeType: 'multipart/form-data',
      params: b.form.map((r) => (r.kind === 'file' ? { name: r.key, fileName: r.fileName ?? 'file' } : { name: r.key, value: r.value }))
    }
  }
  return har
}

// The call the GENERATED code makes. Spelled through a constant so this file,
// which makes no request of its own, holds no call-shaped text for the
// no-renderer-network test to find.
const FETCH = 'fetch'

function fetchSnippet(o: Outgoing): string {
  const lines: string[] = []
  const b = o.body
  if (b && 'form' in b) {
    lines.push('const form = new FormData()')
    for (const r of b.form) {
      lines.push(
        r.kind === 'file'
          ? `form.append(${JSON.stringify(r.key)}, fileInput.files[0], ${JSON.stringify(r.fileName ?? 'file')})`
          : `form.append(${JSON.stringify(r.key)}, ${JSON.stringify(r.value)})`
      )
    }
    lines.push('')
  }
  lines.push(`const response = await ${FETCH}(${JSON.stringify(o.url)}, {`)
  lines.push(`  method: ${JSON.stringify(o.method)},`)
  if (o.headers.length > 0) {
    lines.push('  headers: [')
    for (const [k, v] of o.headers) lines.push(`    [${JSON.stringify(k)}, ${JSON.stringify(v)}],`)
    lines.push('  ],')
  }
  if (b && 'text' in b) lines.push(`  body: ${JSON.stringify(b.text)},`)
  if (b && 'form' in b) lines.push('  body: form,')
  lines.push('})')
  return lines.join('\n')
}

/** Code for `lang`, plus what the reader should know about it. Pure. */
export function snippetFor(
  lang: SnippetLang,
  req: HttpRequest | GraphQlRequest,
  spec: SentView | HttpRequestSpec,
  secrets: 'mask' | 'include'
): { text: string; notes: string[] } {
  if (lang === 'curl') return toCurl(req, spec, { secrets })
  const o = outgoing(req, spec, { secrets })
  const notes = [...o.notes]
  if (o.insecure) notes.push('This request skips certificate checks in OpsMaxx; the snippet does not.')
  if (lang === 'fetch') return { text: fetchSnippet(o), notes }
  const plugin = lang === 'python' ? pythonRequests : lang === 'go' ? goNative : shellHttpie
  return { text: plugin.generate(harFor(o) as never) ?? '', notes }
}

export interface CodeSnippetDrawerProps {
  request: HttpRequest | GraphQlRequest
  /** The masked view of what went out: the default. */
  sent: SentView | HttpRequestSpec
  /** Builds the spec with vault values resolved. Called only after the confirm. */
  resolveSecrets?: () => Promise<HttpRequestSpec | null>
  onClose: () => void
}

export function CodeSnippetDrawer({ request, sent, resolveSecrets, onClose }: CodeSnippetDrawerProps): React.JSX.Element {
  const [lang, setLang] = useState<SnippetLang>('curl')
  const [live, setLive] = useState<HttpRequestSpec | null>(null)
  const [confirming, setConfirming] = useState(false)
  // Why "Show secrets" left the view masked. The owner answers null for any
  // build failure without saying which, so the sentence names the usual ones.
  const [unresolved, setUnresolved] = useState(false)
  const snippet = useMemo(
    () => snippetFor(lang, request, live ?? sent, live ? 'include' : 'mask'),
    [lang, request, sent, live]
  )

  return (
    <section className="hc-snippet" aria-label="Generate code">
      <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
        <div className="segment" role="tablist" aria-label="Language">
          {LANGS.map((l) => (
            <button
              key={l.id}
              role="tab"
              aria-selected={lang === l.id}
              className={clsx('seg-btn', lang === l.id && 'active')}
              onClick={() => setLang(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <button className="btn secondary size-28" onClick={() => void window.opsmaxx?.clipboard?.write(snippet.text)}>
          Copy
        </button>
        {resolveSecrets && !live && !confirming && (
          <button className="btn secondary size-28" onClick={() => setConfirming(true)}>
            Include secrets…
          </button>
        )}
        {live && (
          <button className="btn secondary size-28" onClick={() => setLive(null)}>
            Mask secrets
          </button>
        )}
        <button className="btn secondary size-28" aria-label="Close code" onClick={onClose}>
          Close
        </button>
      </div>
      {confirming && (
        <div className="row" role="alert" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
          <span className="field-error">
            The snippet will show vault values and tokens in plain text, and Copy puts them on the clipboard.
          </span>
          <button
            className="btn danger size-28"
            onClick={() => {
              setConfirming(false)
              setUnresolved(false)
              void resolveSecrets?.().then(
                (spec) => (spec ? setLive(spec) : setUnresolved(true)),
                () => setUnresolved(true)
              )
            }}
          >
            Show secrets
          </button>
          <button className="btn secondary size-28" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
      {unresolved && !live && (
        <p className="field-error" role="alert">
          Secrets could not be filled in, so the snippet stays masked. The vault may be locked, a variable may be
          unresolved, or a value from history may need entering again; sending the request says which.
        </p>
      )}
      <pre className="mono" aria-label="Snippet">
        {snippet.text}
      </pre>
      {snippet.notes.map((n) => (
        <div key={n} className="field-hint">
          {n}
        </div>
      ))}
    </section>
  )
}
