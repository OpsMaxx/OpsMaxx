/**
 * cURL in and out. Flags that would grant trust (`-k`, `--cacert`, proxies) or
 * read local files are noted, never honoured.
 *
 * IN. The parser never runs anything, but a mapping can still do damage
 * (review SEC-M6). A stored `@file` path invites a later "helpful" read of it,
 * so a file reference becomes a basename and "Choose the file again". A proxy
 * flag would bring back the third-party-proxy concept this client removed. A
 * certificate flag would read a file or set `caPem` behind the user's back, and
 * `-k` would switch verification off without the confirm that switch has. Each
 * is dropped with a note saying so.
 *
 * OUT. The text is pasted into a shell, and header values, URLs and bodies can
 * come from an imported spec or a response — text a stranger wrote. Every
 * argument is single-quoted with `'` written as `'\''`, which is the one quoting
 * that no shell expands inside; `$'…'` is never emitted (review SEC-M5).
 */

import {
  isSensitiveName,
  newId,
  stableId,
  defaults,
  type Body,
  type GraphQlRequest,
  type HttpRequest,
  type MultipartRow,
  type Row,
  type SentView
} from './apiModel'
import { userinfoSpan, type HttpRequestSpec } from './httpClient'
import { userinfoIsReference } from './httpHistory'

// ---------------------------------------------------------------- tokenise

interface Tokens {
  args: string[]
  expansion: boolean
}

/**
 * Split a command line the way a POSIX shell would, without expanding
 * anything. `$(…)`, backticks and `$VAR` are kept as written, and remembered so
 * the import can say they were not run.
 */
function tokenize(input: string): Tokens | { error: string } {
  const args: string[] = []
  let expansion = false
  let cur = ''
  let has = false
  let i = 0
  const s = input.replace(/\r\n?/g, '\n')
  const push = (): void => {
    if (has) args.push(cur)
    cur = ''
    has = false
  }
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2
      continue
    }
    if (/\s/.test(c)) {
      push()
      i++
      continue
    }
    has = true
    if (c === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) return { error: 'A single quote is not closed.' }
      cur += s.slice(i + 1, end)
      i = end + 1
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting, which browsers' "Copy as cURL (bash)" emits.
      i += 2
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1]
          const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' }
          if (n === 'x' && /^[0-9a-fA-F]{1,2}/.test(s.slice(i + 2))) {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2))![0]
            cur += String.fromCharCode(parseInt(hex, 16))
            i += 2 + hex.length
          } else if (n === 'u' && /^[0-9a-fA-F]{4}/.test(s.slice(i + 2))) {
            cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16))
            i += 6
          } else {
            cur += Object.hasOwn(simple, n) ? simple[n] : `\\${n}`
            i += 2
          }
        } else cur += s[i++]
      }
      if (i >= s.length) return { error: "A $'…' quote is not closed." }
      i++
    } else if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && '"\\$`\n'.includes(s[i + 1] ?? '')) {
          if (s[i + 1] !== '\n') cur += s[i + 1]
          i += 2
        } else {
          if (s[i] === '`' || (s[i] === '$' && /[({A-Za-z_]/.test(s[i + 1] ?? ''))) expansion = true
          cur += s[i++]
        }
      }
      if (i >= s.length) return { error: 'A double quote is not closed.' }
      i++
    } else if (c === '\\') {
      if (i + 1 < s.length) cur += s[i + 1]
      i += 2
    } else {
      if (c === '`' || (c === '$' && /[({A-Za-z_]/.test(s[i + 1] ?? ''))) expansion = true
      cur += c
      i++
    }
  }
  push()
  return { args, expansion }
}

// ---------------------------------------------------------------- parse

// Flags that take a value, by every spelling this parser recognises. A flag not
// here is treated as taking none, so an unknown flag cannot swallow the URL.
const SHORT_WITH_ARG = new Set('XHdubAmxTKEFeocDwrzQtYyU'.split(''))
const LONG_WITH_ARG = new Set([
  'request', 'header', 'data', 'data-ascii', 'data-raw', 'data-binary', 'data-urlencode', 'json',
  'form', 'form-string', 'user', 'url', 'cookie', 'max-redirs', 'max-time', 'user-agent', 'referer',
  'proxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'preproxy', 'proxy-user', 'proxy-header',
  'proxy-cacert', 'proxy-cert', 'proxy-key', 'cacert', 'capath', 'cert', 'key', 'cert-type', 'key-type',
  'resolve', 'connect-to', 'unix-socket', 'abstract-unix-socket', 'interface', 'upload-file', 'config',
  'output', 'cookie-jar', 'dump-header', 'write-out', 'range', 'connect-timeout', 'retry', 'limit-rate',
  'oauth2-bearer', 'aws-sigv4', 'pass', 'ciphers', 'dns-servers', 'local-port', 'noproxy', 'trace',
  'trace-ascii', 'stderr', 'variable', 'expand-data', 'expand-url', 'expand-header'
])
const SHORT_LONG: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', u: 'user', b: 'cookie', A: 'user-agent', m: 'max-time',
  x: 'proxy', T: 'upload-file', K: 'config', E: 'cert', F: 'form', e: 'referer', o: 'output',
  c: 'cookie-jar', D: 'dump-header', w: 'write-out', r: 'range', L: 'location', G: 'get', I: 'head',
  k: 'insecure', s: 'silent', S: 'show-error', v: 'verbose', i: 'include', Q: 'quote', t: 'telnet-option',
  Y: 'speed-limit', y: 'speed-time', U: 'proxy-user', z: 'time-cond'
}
/** Output and progress only: they change nothing about the request. */
const SILENT = new Set(['compressed', 'silent', 'show-error', 'verbose', 'include', 'no-progress-meter', 'progress-bar'])

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

function fileNote(flag: string, path: string): string {
  return `${flag} @${baseName(path)}: files are not read. Choose the file again.`
}

interface Draft {
  method?: string
  url?: string
  headers: [string, string][]
  data: string[]
  urlencoded: [string, string][]
  form: { key: string; value: string; file?: string }[]
  json?: string
  binaryFile?: string
  user?: string
  get: boolean
  head: boolean
  location: boolean
  maxRedirs?: number
  maxTime?: number
}

function parseQuery(url: string): Row[] {
  const q = url.indexOf('?')
  if (q < 0) return []
  const hash = url.indexOf('#', q)
  return url
    .slice(q + 1, hash < 0 ? undefined : hash)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=')
      const dec = (x: string): string => {
        try {
          return decodeURIComponent(x.replace(/\+/g, ' '))
        } catch {
          return x
        }
      }
      return eq < 0 ? [dec(pair), ''] : [dec(pair.slice(0, eq)), dec(pair.slice(eq + 1))]
    })
    .map(([key, value], i) => ({ id: stableId('row', url, 'params', String(i)), enabled: true, key, value }))
}

export function parseCurl(
  text: string
): { ok: true; request: HttpRequest; notes: string[] } | { ok: false; error: string } {
  const tokens = tokenize(text.trim())
  if ('error' in tokens) return { ok: false, error: tokens.error }
  const args = tokens.args
  if (args.length === 0 || !/(^|[\\/])curl(\.exe)?$/i.test(args[0])) {
    return { ok: false, error: 'That does not start with curl.' }
  }
  const notes: string[] = []
  const note = (n: string): void => {
    if (!notes.includes(n)) notes.push(n)
  }
  if (tokens.expansion) note('Shell expansion is not performed: $(…), backticks and $VAR are kept as written.')

  const d: Draft = { headers: [], data: [], urlencoded: [], form: [], get: false, head: false, location: false }
  const positional: string[] = []

  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    let name: string
    let value: string | undefined
    if (a === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      name = eq < 0 ? a.slice(2) : a.slice(2, eq)
      if (eq >= 0) value = a.slice(eq + 1)
      else if (LONG_WITH_ARG.has(name)) value = args[++i]
    } else if (a.startsWith('-') && a.length > 1) {
      // `-sSL` is three flags; `-XPOST` is -X with POST; `-sXPOST` is both.
      let j = 1
      name = ''
      for (; j < a.length; j++) {
        const ch = a[j]
        const long = SHORT_LONG[ch] ?? `-${ch}`
        if (SHORT_WITH_ARG.has(ch)) {
          name = long
          value = j + 1 < a.length ? a.slice(j + 1) : args[++i]
          break
        }
        if (j < a.length - 1) apply(long, undefined)
        else name = long
      }
    } else {
      positional.push(a)
      continue
    }
    apply(name, value)
  }

  function apply(name: string, value: string | undefined): void {
    const v = value ?? ''
    switch (name) {
      case 'request':
        d.method = v.toUpperCase()
        return
      case 'url':
        d.url = v
        return
      case 'header': {
        if (v.startsWith('@')) return note(fileNote('-H', v.slice(1)))
        const colon = v.indexOf(':')
        // `-H 'X-Empty;'` is curl's spelling of a header with no value.
        if (colon < 0) {
          if (v.endsWith(';')) d.headers.push([v.slice(0, -1).trim(), ''])
          return
        }
        d.headers.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()])
        return
      }
      case 'data':
      case 'data-ascii':
      case 'data-binary':
        if (v.startsWith('@')) {
          d.binaryFile = baseName(v.slice(1))
          return note(fileNote(name === 'data-binary' ? '--data-binary' : '-d', v.slice(1)))
        }
        d.data.push(name === 'data-binary' ? v : v.replace(/[\r\n]/g, ''))
        return
      case 'data-raw':
        d.data.push(v)
        return
      case 'data-urlencode': {
        const at = v.indexOf('@')
        const eq = v.indexOf('=')
        if (at >= 0 && (eq < 0 || at < eq)) {
          d.urlencoded.push([v.slice(0, at), ''])
          return note(fileNote('--data-urlencode', v.slice(at + 1)))
        }
        if (eq < 0) d.urlencoded.push([v, ''])
        else d.urlencoded.push([v.slice(0, eq), v.slice(eq + 1)])
        return
      }
      case 'json':
        if (v.startsWith('@')) return note(fileNote('--json', v.slice(1)))
        d.json = (d.json ?? '') + v
        return
      case 'form':
      case 'form-string': {
        const eq = v.indexOf('=')
        if (eq < 0) return note(`-F ${v}: not a name=value pair, left out.`)
        const key = v.slice(0, eq)
        const rest = v.slice(eq + 1)
        if (name === 'form' && (rest.startsWith('@') || rest.startsWith('<'))) {
          const path = rest.slice(1).split(';')[0]
          d.form.push({ key, value: '', file: baseName(path) })
          return note(`-F ${key}=${rest[0]}${baseName(path)}: files are not read. Choose the file again.`)
        }
        d.form.push({ key, value: rest })
        return
      }
      case 'user':
        d.user = v
        return
      case 'get':
        d.get = true
        return
      case 'head':
        d.head = true
        return
      case 'location':
        d.location = true
        return
      case 'location-trusted':
        d.location = true
        return note('--location-trusted: credentials are never sent to a redirect on another host. Redirects are followed without them.')
      case 'max-redirs':
        d.maxRedirs = Math.max(0, Math.min(10, Math.floor(Number(v)) || 0))
        return
      case 'max-time':
        if (Number(v) > 0) d.maxTime = Number(v)
        return
      case 'user-agent':
        d.headers.push(['User-Agent', v])
        return
      case 'referer':
        d.headers.push(['Referer', v])
        return
      case 'cookie':
        if (!v.includes('=')) return note(`-b ${baseName(v)}: a cookie file is not read.`)
        d.headers.push(['Cookie', v])
        return
      case 'upload-file':
        d.binaryFile = baseName(v)
        d.method ??= 'PUT'
        return note(fileNote('-T', v))
      case 'config':
        return note(`-K ${baseName(v)}: a config file is not read.`)
      case 'insecure':
        return note(
          "This command skipped certificate checks. OpsMaxx still checks; change it in the collection's Connection settings if you mean it."
        )
      case 'cacert':
      case 'capath':
      case 'cert':
      case 'key':
      case 'cert-type':
      case 'key-type':
        return note(`--${name}: certificates are not imported. Set a custom CA in the collection's Connection settings.`)
      case 'resolve':
      case 'connect-to':
      case 'unix-socket':
      case 'abstract-unix-socket':
      case 'interface':
        return note(`--${name}: not used. Choose Send from to pick where the request leaves from.`)
      default:
        if (SILENT.has(name)) return
        if (/^(proxy|socks|preproxy)/.test(name)) return note('Proxies are not used; choose Send from instead.')
        return note(`${name.startsWith('-') ? name : `--${name}`}: not supported, left out.`)
    }
  }

  const url = d.url ?? positional[0]
  if (!url) return { ok: false, error: 'There is no URL in that command.' }
  if (positional.length > (d.url ? 0 : 1)) note('Only the first URL is imported.')

  const req = defaults.http()
  const id = newId('req')
  const rowId = (section: string, i: number): string => stableId('row', id, section, String(i))
  req.id = id
  req.name = url.replace(/^[a-z]+:\/\//i, '').slice(0, 80) || 'Imported request'
  req.url = url
  req.auth = { type: 'none' }
  req.settings = {
    followRedirects: d.location,
    maxRedirects: d.location ? (d.maxRedirs ?? 5) : 0,
    ...(d.maxTime ? { timeoutMs: Math.round(d.maxTime * 1000) } : {})
  }
  req.headers = d.headers.map(([key, value], i) => ({ id: rowId('headers', i), enabled: true, key, value }))
  if (d.user !== undefined) {
    const colon = d.user.indexOf(':')
    req.auth = {
      type: 'basic',
      username: colon < 0 ? d.user : d.user.slice(0, colon),
      password: colon < 0 ? '' : d.user.slice(colon + 1)
    }
  }

  const contentType = d.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  const joined = [...d.data, ...d.urlencoded.map(([k, v]) => (k ? `${k}=${encodeURIComponent(v)}` : encodeURIComponent(v)))].join('&')
  let body: Body = { mode: 'none' }
  if (d.json !== undefined) {
    body = { mode: 'json', text: d.json }
    if (!contentType) req.headers.push({ id: rowId('headers', req.headers.length), enabled: true, key: 'Content-Type', value: 'application/json' })
    if (!d.headers.some(([k]) => k.toLowerCase() === 'accept')) {
      req.headers.push({ id: rowId('headers', req.headers.length), enabled: true, key: 'Accept', value: 'application/json' })
    }
  } else if (d.form.length > 0) {
    body = {
      mode: 'multipart',
      rows: d.form.map(
        (f, i): MultipartRow => ({
          id: rowId('body', i),
          enabled: true,
          key: f.key,
          value: f.value,
          kind: f.file ? 'file' : 'text',
          ...(f.file ? { fileName: f.file } : {})
        })
      )
    }
  } else if (d.binaryFile !== undefined && joined === '') {
    body = { mode: 'binary', fileName: d.binaryFile }
  } else if (joined !== '') {
    if (d.get) {
      req.url = `${url}${url.includes('?') ? '&' : '?'}${joined}`
    } else if (/json/i.test(contentType) || /^\s*[[{]/.test(joined)) {
      body = { mode: 'json', text: joined }
    } else if (/xml/i.test(contentType)) {
      body = { mode: 'xml', text: joined }
    } else if (d.urlencoded.length > 0 || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(joined)) {
      body = { mode: 'urlencoded', rows: parseQuery(`?${joined}`).map((r, i) => ({ ...r, id: rowId('body', i) })) }
    } else {
      body = { mode: 'text', text: joined }
    }
  }
  req.body = body
  req.params = parseQuery(req.url).map((r, i) => ({ ...r, id: rowId('params', i) }))
  // curl's own rule: -I is HEAD, -G is GET, then -X, then POST when there is
  // data (-T already set PUT above).
  req.method = d.head ? 'HEAD' : d.get ? 'GET' : (d.method ?? (body.mode === 'none' ? 'GET' : 'POST'))
  return { ok: true, request: req, notes }
}

// ---------------------------------------------------------------- emit

/** One shell word: single-quoted, `'` as `'\''`. Safe in sh, bash and zsh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const SECRET = '<secret>'
const TEMPLATE = /\{\{[^{}]*\}\}/g
const VAULT_REF = /vault:[A-Za-z0-9_-]{1,64}#(?:password|username)/g
const referenceOnly = (v: string): boolean =>
  v.replace(TEMPLATE, '').replace(VAULT_REF, '').replace(/^\s*(?:bearer|basic|token)\b/i, '').trim() === ''

/**
 * What a masked value is shown as: the template it came from, when that is a
 * reference (`{{token}}`), and `<secret>` otherwise.
 */
function maskedFrom(template: string | undefined): string {
  return template !== undefined && template !== '' && referenceOnly(template) ? template : SECRET
}

function maskUrlForCurl(url: string, req: HttpRequest | GraphQlRequest): string {
  const params = req.kind === 'http' ? req.params : []
  const span = userinfoSpan(url)
  let out = span && !userinfoIsReference(url.slice(span.start, span.end))
    ? `${url.slice(0, span.start)}${SECRET}${url.slice(span.end)}`
    : url
  const q = out.indexOf('?')
  if (q < 0) return out
  const hash = out.indexOf('#', q)
  const end = hash < 0 ? out.length : hash
  const query = out
    .slice(q + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      let name = pair.slice(0, eq)
      try {
        name = decodeURIComponent(name)
      } catch {
        /* checked as written */
      }
      if (!isSensitiveName(name)) return pair
      return `${pair.slice(0, eq)}=${maskedFrom(params.find((p) => p.key === name)?.value)}`
    })
    .join('&')
  out = `${out.slice(0, q)}?${query}${out.slice(end)}`
  return out
}

function maskJsonBody(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  let changed = false
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64) return v
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) {
        if (isSensitiveName(k) && x !== null && x !== '' && !(typeof x === 'string' && referenceOnly(x))) {
          out[k] = SECRET
          changed = true
        } else out[k] = walk(x, depth + 1)
      }
      return out
    }
    return v
  }
  const masked = walk(parsed, 0)
  return changed ? JSON.stringify(masked) : text
}

function maskFormBody(text: string): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      let name = pair.slice(0, eq)
      try {
        name = decodeURIComponent(name.replace(/\+/g, ' '))
      } catch {
        /* as written */
      }
      return isSensitiveName(name) ? `${pair.slice(0, eq)}=${encodeURIComponent(SECRET)}` : pair
    })
    .join('&')
}

/** The auth-derived header value as a template, when the request's auth names a reference. */
function authTemplate(req: HttpRequest | GraphQlRequest): string | undefined {
  const a = req.auth
  if (a.type === 'bearer') return referenceOnly(a.token) ? `Bearer ${a.token.trim()}` : undefined
  if (a.type === 'apikey') return a.value
  return undefined
}

function bodyFromTemplate(req: HttpRequest | GraphQlRequest): { text?: string; form?: MultipartRow[]; file?: string } {
  if (req.kind === 'graphql') {
    let variables: unknown
    try {
      variables = req.variables.trim() ? JSON.parse(req.variables) : undefined
    } catch {
      variables = undefined
    }
    return {
      text: JSON.stringify({
        query: req.query,
        ...(variables !== undefined ? { variables } : {}),
        ...(req.operationName ? { operationName: req.operationName } : {})
      })
    }
  }
  const b = req.body
  switch (b.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { text: b.text }
    case 'urlencoded':
      return {
        text: b.rows
          .filter((r) => r.enabled)
          .map((r) => `${encodeURIComponent(r.key)}=${encodeURIComponent(r.value)}`)
          .join('&')
      }
    case 'multipart':
      return { form: b.rows.filter((r) => r.enabled) }
    case 'binary':
      return { file: b.fileName ?? 'file' }
    default:
      return {}
  }
}

/** What goes out, masked as asked: the shared input of Copy as cURL and the snippet drawer. */
export interface Outgoing {
  method: string
  url: string
  headers: [string, string][]
  body?: { text: string; contentType: string } | { form: MultipartRow[] } | { file: string }
  insecure: boolean
  notes: string[]
}

export function outgoing(
  req: HttpRequest | GraphQlRequest,
  spec: SentView | HttpRequestSpec,
  opts: { secrets: 'mask' | 'include' }
): Outgoing {
  const notes: string[] = []
  const mask = opts.secrets === 'mask'
  const rawHeaders: [string, string][] = Array.isArray(spec.headers) ? spec.headers : Object.entries(spec.headers)
  const headers: [string, string][] = []
  let contentType = ''
  for (const [name, rawValue] of rawHeaders) {
    if (/[\r\n\0]/.test(rawValue) || /[\r\n\0]/.test(name)) {
      notes.push(`The ${name} header contains a line break or NUL and was left out.`)
      continue
    }
    if (name.toLowerCase() === 'content-type') contentType = rawValue
    let value = rawValue
    if (mask && isSensitiveName(name)) {
      const template =
        req.headers.find((h) => h.enabled && h.key.toLowerCase() === name.toLowerCase())?.value ??
        (name.toLowerCase() === 'authorization' || req.auth.type === 'apikey' ? authTemplate(req) : undefined)
      value = maskedFrom(template)
    }
    headers.push([name, value])
  }

  let body: Outgoing['body']
  const bytes = 'body' in spec && spec.body instanceof ArrayBuffer ? spec.body : undefined
  const template = bodyFromTemplate(req)
  if (template.form) {
    // Multipart is re-described from its rows: the encoded bytes are no use in
    // a command line. Values are shown as written.
    body = {
      form: template.form.map((row) =>
        row.kind === 'text' && mask && isSensitiveName(row.key) ? { ...row, value: maskedFrom(row.value) } : row
      )
    }
    if (template.form.some((r) => r.kind === 'file')) notes.push('File fields name the file; pick its path when you run it.')
  } else if (template.file !== undefined) {
    body = { file: template.file }
    notes.push('The body is a file; the command names it, and the path is yours to fill in.')
  } else {
    let text = bytes ? new TextDecoder().decode(bytes) : template.text
    if (bytes && text?.includes('\0')) {
      notes.push('The body is binary and was left out.')
      text = undefined
    }
    if (text !== undefined && text !== '') {
      if (mask) {
        text =
          /x-www-form-urlencoded/i.test(contentType) || (req.kind === 'http' && req.body.mode === 'urlencoded')
            ? maskFormBody(text)
            : maskJsonBody(text)
      }
      body = { text, contentType }
    }
  }

  let insecure = false
  if ('tls' in spec) {
    insecure = spec.tls === 'unverified'
    if (spec.tls === 'custom-ca') notes.push('This request trusts a custom CA; add --cacert with that certificate.')
  } else {
    insecure = spec.insecureTls === true
    if (spec.caPem) notes.push('This request trusts a custom CA; add --cacert with that certificate.')
  }
  if ('via' in spec ? spec.via.kind !== 'direct' : spec.route.key !== 'direct') {
    notes.push('This request is sent through a server or VPN in OpsMaxx; the command sends it from wherever you run it.')
  }
  return {
    method: (spec.method || 'GET').toUpperCase(),
    url: mask ? maskUrlForCurl(spec.url, req) : spec.url,
    headers,
    ...(body ? { body } : {}),
    insecure,
    notes
  }
}

export function toCurl(
  req: HttpRequest | GraphQlRequest,
  spec: SentView | HttpRequestSpec,
  opts: { secrets: 'mask' | 'include' }
): { text: string; notes: string[] } {
  const out = outgoing(req, spec, opts)
  const parts: string[] = ['curl']
  if (out.method !== 'GET') parts.push(`-X ${shellQuote(out.method)}`)
  parts.push(shellQuote(out.url))
  for (const [name, value] of out.headers) parts.push(`-H ${shellQuote(`${name}: ${value}`)}`)
  const b = out.body
  if (b && 'form' in b) {
    for (const row of b.form) {
      parts.push(`-F ${shellQuote(row.kind === 'file' ? `${row.key}=@${row.fileName ?? 'file'}` : `${row.key}=${row.value}`)}`)
    }
  } else if (b && 'file' in b) parts.push(`--data-binary ${shellQuote(`@${b.file}`)}`)
  else if (b) parts.push(`--data-raw ${shellQuote(b.text)}`)
  if (out.insecure) parts.push('-k')
  const redirects = spec.maxRedirects ?? 0
  if (redirects > 0) parts.push(`-L --max-redirs ${redirects}`)
  const timeout = spec.timeoutMs
  if (timeout && timeout !== 30_000) parts.push(`--max-time ${Math.ceil(timeout / 1000)}`)
  return { text: parts.join(' \\\n  '), notes: out.notes }
}
