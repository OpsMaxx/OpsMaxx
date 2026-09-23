import { jsonLanguage } from '@codemirror/lang-json'
import type { SyntaxNode } from '@lezer/common'
import { charsetOf } from '../../../../../shared/httpClient'

// Pure helpers behind the response body: decoding, the 2 MiB window, the view
// a content type gets, the Preview document, and the JSON node under a caret.
// No DOM and no store here, so all of it runs in the node test environment.

/** Above this, CodeMirror gets a hard-wrapped window instead of the whole body (ARCH-M8). */
export const PRETTY_MAX_BYTES = 2 * 1024 * 1024
export const HARD_WRAP_CHARS = 4 * 1024
export const PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024

export type BodyKind = 'json' | 'xml' | 'html' | 'yaml' | 'text' | 'svg' | 'image' | 'binary'

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.entries(headers).find(([k]) => k.toLowerCase() === lower)?.[1]
}

/** What a body is, from its Content-Type, or from its first bytes when there is none. */
export function bodyKind(contentType: string | undefined, bytes: Uint8Array): BodyKind {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'image/svg+xml') return 'svg'
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/json' || type.endsWith('+json')) return 'json'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type.endsWith('/xml') || type.endsWith('+xml')) return 'xml'
  if (type.includes('yaml')) return 'yaml'
  if (type.startsWith('text/') || /javascript|ecmascript|x-www-form-urlencoded|graphql/.test(type)) return 'text'
  if (type !== '') return 'binary'
  // No Content-Type: a NUL in the first KiB is binary; JSON-looking text is JSON.
  const head = bytes.subarray(0, 1024)
  if (head.includes(0)) return 'binary'
  const first = new TextDecoder().decode(head).trimStart()[0]
  return first === '{' || first === '[' ? 'json' : 'text'
}

export function languageFor(kind: BodyKind): 'json' | 'xml' | 'html' | 'yaml' | 'text' {
  if (kind === 'json' || kind === 'html' || kind === 'yaml' || kind === 'xml') return kind
  return kind === 'svg' ? 'xml' : 'text'
}

function decoder(contentType: string | undefined): TextDecoder {
  try {
    return new TextDecoder(charsetOf(contentType) ?? 'utf-8')
  } catch {
    // A charset TextDecoder has never heard of: UTF-8 is what it almost certainly is.
    return new TextDecoder()
  }
}

export function decodeText(bytes: Uint8Array, contentType?: string): string {
  return decoder(contentType).decode(bytes)
}

/** Lines longer than `width` are split, so no single line can stall the editor. */
export function hardWrap(text: string, width: number): string {
  if (text.length <= width && !text.includes('\n')) return text
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= width) return line
      const parts: string[] = []
      for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width))
      return parts.join('\n')
    })
    .join('\n')
}

export interface BodyWindow {
  text: string
  /** True when the body was cut to `max` bytes and hard-wrapped. */
  windowed: boolean
  shownBytes: number
  totalBytes: number
}

/**
 * At most `max` bytes of text. Above it the text is hard-wrapped at `hardWrap`
 * characters, because a 31 MB minified line is what freezes an editor, not
 * its byte count. A multi-byte character cut at the edge is dropped rather
 * than shown as U+FFFD.
 */
export function bodyWindow(
  bytes: Uint8Array,
  opts: { max: number; hardWrap: number; contentType?: string }
): BodyWindow {
  if (bytes.length <= opts.max) {
    return { text: decodeText(bytes, opts.contentType), windowed: false, shownBytes: bytes.length, totalBytes: bytes.length }
  }
  const text = decoder(opts.contentType).decode(bytes.subarray(0, opts.max), { stream: true })
  return { text: hardWrap(text, opts.hardWrap), windowed: true, shownBytes: opts.max, totalBytes: bytes.length }
}

/** JSON indented by two; anything else, or JSON that does not parse, as it came. */
export function prettyText(text: string, kind: BodyKind): string {
  if (kind !== 'json') return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/**
 * The HTML Preview document. It goes in `<iframe sandbox="" srcdoc>`, which
 * already inherits the app's CSP; this meta policy keeps it offline even if
 * that CSP is ever widened (SEC-L3).
 */
export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

/** A page with no background of its own renders as a light page, not as text on the app's dark panel. */
const PREVIEW_BASE = '<style>html{background:#fff;color:#000}</style>'

export function previewDoc(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${PREVIEW_BASE}${html}`
}

/** A `data:` URL for an image, SVG included: an `<img>` never runs an SVG's scripts. */
export function imageDataUrl(bytes: Uint8Array, contentType: string): string {
  const type = contentType.split(';')[0].trim().toLowerCase()
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${type};base64,${btoa(binary)}`
}

/** `.state-dot` shape per status class: disc, ring, triangle, square. */
export function statusShape(status: number): 'is-ok' | 'is-unknown' | 'is-watch' | 'is-alarm' {
  if (status >= 200 && status < 300) return 'is-ok'
  if (status >= 400 && status < 500) return 'is-watch'
  if (status >= 500) return 'is-alarm'
  return 'is-unknown'
}

const VALUE_NODES = new Set(['String', 'Number', 'True', 'False', 'Null', 'Object', 'Array'])

function valueOf(text: string, node: SyntaxNode): string {
  const raw = text.slice(node.from, node.to)
  if (node.name !== 'String' && node.name !== 'PropertyName') return raw
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

/**
 * The JSON value under `pos`, with its property name when it has one. The
 * caret on a key means that key's value. A string comes back unquoted; an
 * object or array as its JSON text.
 */
export function jsonNodeAt(text: string, pos: number): { key?: string; value: string } | null {
  const tree = jsonLanguage.parser.parse(text)
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'PropertyName' && node.parent) {
      const value = node.parent.lastChild
      if (!value || !VALUE_NODES.has(value.name)) return null
      return { key: valueOf(text, node), value: valueOf(text, value) }
    }
    if (VALUE_NODES.has(node.name)) {
      const prop = node.parent?.name === 'Property' ? node.parent.firstChild : null
      return prop?.name === 'PropertyName'
        ? { key: valueOf(text, prop), value: valueOf(text, node) }
        : { value: valueOf(text, node) }
    }
  }
  return null
}

/** A file name for Save: the URL's last segment, with an extension the type implies. */
export function suggestedFileName(url: string, contentType: string | undefined): string {
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    path = url.split(/[?#]/)[0]
  }
  const last = (path.split('/').filter(Boolean).at(-1) ?? '').replace(/[^\w.-]/g, '').replace(/^\.+/, '')
  const base = last || 'response'
  if (/\.[a-z0-9]{1,5}$/i.test(base)) return base
  const ext: Record<BodyKind, string> = {
    json: 'json', xml: 'xml', html: 'html', yaml: 'yaml', text: 'txt', svg: 'svg', image: '', binary: 'bin'
  }
  const kind = bodyKind(contentType, new Uint8Array())
  const imageExt = kind === 'image' ? (contentType ?? '').split(';')[0].split('/')[1]?.replace(/[^a-z0-9]/gi, '') : ''
  return `${base}.${ext[kind] || imageExt || 'bin'}`
}
