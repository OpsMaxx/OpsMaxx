import { describe, it, expect } from 'vitest'
import {
  HARD_WRAP_CHARS,
  PRETTY_MAX_BYTES,
  bodyKind,
  bodyWindow,
  hardWrap,
  imageDataUrl,
  jsonNodeAt,
  prettyText,
  previewDoc,
  statusShape,
  suggestedFileName
} from '../src/renderer/src/components/http/response/bodyWindow'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('bodyWindow (ARCH-M8)', () => {
  it('passes a body at or under the cap through whole', () => {
    const w = bodyWindow(enc('{"a":1}'), { max: PRETTY_MAX_BYTES, hardWrap: HARD_WRAP_CHARS })
    expect(w).toEqual({ text: '{"a":1}', windowed: false, shownBytes: 7, totalBytes: 7 })
  })

  it('above 2 MiB gives the first 2 MiB, no line over 4 KiB', () => {
    const big = new Uint8Array(PRETTY_MAX_BYTES + 5_000_000).fill(0x61) // one 7 MB line of "a"
    const w = bodyWindow(big, { max: PRETTY_MAX_BYTES, hardWrap: HARD_WRAP_CHARS })
    expect(w.windowed).toBe(true)
    expect(w.shownBytes).toBe(PRETTY_MAX_BYTES)
    expect(w.totalBytes).toBe(big.length)
    const lines = w.text.split('\n')
    expect(lines.join('').length).toBe(PRETTY_MAX_BYTES)
    expect(Math.max(...lines.map((l) => l.length))).toBe(HARD_WRAP_CHARS)
  })

  it('drops a multi-byte character cut at the edge instead of showing U+FFFD', () => {
    const w = bodyWindow(enc('ab€'), { max: 3, hardWrap: 100 })
    expect(w.text).toBe('ab')
  })

  it('hardWrap leaves short lines alone', () => {
    expect(hardWrap('ab\ncdefg', 3)).toBe('ab\ncde\nfg')
  })

  it('honours the declared charset', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    expect(bodyWindow(latin1, { max: 10, hardWrap: 10, contentType: 'text/plain; charset=iso-8859-1' }).text).toBe('café')
  })
})

describe('bodyKind', () => {
  it.each([
    ['application/json; charset=utf-8', 'json'],
    ['application/problem+json', 'json'],
    ['text/html; charset=utf-8', 'html'],
    ['application/xml', 'xml'],
    ['application/atom+xml', 'xml'],
    ['application/yaml', 'yaml'],
    ['text/plain', 'text'],
    ['application/javascript', 'text'],
    ['image/png', 'image'],
    ['image/svg+xml', 'svg'],
    ['application/octet-stream', 'binary']
  ])('%s → %s', (type, kind) => {
    expect(bodyKind(type, new Uint8Array())).toBe(kind)
  })

  it('sniffs a body with no Content-Type', () => {
    expect(bodyKind(undefined, enc('  [1,2]'))).toBe('json')
    expect(bodyKind(undefined, enc('hello'))).toBe('text')
    expect(bodyKind(undefined, new Uint8Array([1, 0, 2]))).toBe('binary')
  })
})

describe('prettyText', () => {
  it('indents JSON, leaves broken JSON and other types as they came', () => {
    expect(prettyText('{"a":[1]}', 'json')).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(prettyText('{"a":', 'json')).toBe('{"a":')
    expect(prettyText('<p>x</p>', 'html')).toBe('<p>x</p>')
  })
})

describe('Preview safety (SEC-L3)', () => {
  it('prepends a CSP that allows nothing but data: images and inline styles', () => {
    const doc = previewDoc('<img src="https://tracker.example/x.gif">')
    expect(doc.startsWith(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`
    )).toBe(true)
    expect(doc).toContain('<img src="https://tracker.example/x.gif">')
  })

  it('an image becomes a base64 data: URL, SVG included', () => {
    expect(imageDataUrl(enc('<svg/>'), 'image/svg+xml; charset=utf-8')).toBe(`data:image/svg+xml;base64,${btoa('<svg/>')}`)
    const big = new Uint8Array(100_000).fill(7)
    expect(atob(imageDataUrl(big, 'image/png').split(',')[1]).length).toBe(100_000)
  })
})

describe('statusShape', () => {
  it.each([
    [200, 'is-ok'],
    [204, 'is-ok'],
    [301, 'is-unknown'],
    [404, 'is-watch'],
    [503, 'is-alarm'],
    [101, 'is-unknown']
  ])('%i → %s', (code, shape) => expect(statusShape(code)).toBe(shape))
})

describe('jsonNodeAt', () => {
  const doc = '{\n  "access_token": "eyJ.abc",\n  "n": 42,\n  "user": {"id": 7, "roles": ["a"]}\n}'
  it('the caret in a string value gives its key and the unquoted value', () => {
    expect(jsonNodeAt(doc, doc.indexOf('eyJ') + 2)).toEqual({ key: 'access_token', value: 'eyJ.abc' })
  })
  it('the caret on a key gives that key and its value', () => {
    expect(jsonNodeAt(doc, doc.indexOf('"n"') + 1)).toEqual({ key: 'n', value: '42' })
  })
  it('an object value comes back as its JSON text', () => {
    expect(jsonNodeAt(doc, doc.indexOf('"user"') + 2)).toEqual({ key: 'user', value: '{"id": 7, "roles": ["a"]}' })
  })
  it('an array element has no key', () => {
    expect(jsonNodeAt(doc, doc.indexOf('"a"]') + 1)).toEqual({ value: 'a' })
  })
})

describe('suggestedFileName', () => {
  it.each([
    ['https://api.example.test/v1/users?x=1', 'application/json', 'users.json'],
    ['https://api.example.test/report.csv', 'text/csv', 'report.csv'],
    ['https://api.example.test/', 'text/html', 'response.html'],
    ['https://api.example.test/logo', 'image/png', 'logo.png'],
    ['https://api.example.test/blob', undefined, 'blob.txt'],
    ['https://api.example.test/../../x', 'application/octet-stream', 'x.bin']
  ])('%s', (url, type, name) => expect(suggestedFileName(url, type)).toBe(name))
})
