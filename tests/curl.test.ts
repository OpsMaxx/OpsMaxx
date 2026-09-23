import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { parseCurl, shellQuote, toCurl } from '../src/shared/curl'
import type { HttpRequest, MultipartRow, SentView } from '../src/shared/apiModel'
import type { HttpRequestSpec } from '../src/shared/httpClient'

const parse = (text: string): { request: HttpRequest; notes: string[] } => {
  const r = parseCurl(text)
  if (!r.ok) throw new Error(r.error)
  return r
}
const header = (req: HttpRequest, name: string): string | undefined =>
  req.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value

describe('parseCurl: honoured flags', () => {
  it('reads method, headers, data, continuations and both quotings', () => {
    const { request, notes } = parse(`curl -X PUT 'https://h.example/a?x=1' \\
      -H "Content-Type: application/json" -H 'X-Empty;' \\
      --data-raw '{"a":"it'\\''s"}' --compressed`)
    expect(request.method).toBe('PUT')
    expect(request.url).toBe('https://h.example/a?x=1')
    expect(request.params.map((p) => [p.key, p.value])).toEqual([['x', '1']])
    expect(header(request, 'Content-Type')).toBe('application/json')
    expect(header(request, 'X-Empty')).toBe('')
    expect(request.body).toEqual({ mode: 'json', text: `{"a":"it's"}` })
    expect(notes).toEqual([])
  })

  it('reads combined short flags, -XPOST, --url, -u, -A, -e, -b name=value, -L, --max-redirs, -m', () => {
    const { request } = parse(
      "curl -sSL -XPOST --url https://h/x -u alice:pw -A agent/1 -e https://ref -b 'a=1; b=2' --max-redirs 3 -m 2.5 -d a=1"
    )
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://h/x')
    expect(request.auth).toEqual({ type: 'basic', username: 'alice', password: 'pw' })
    expect(header(request, 'User-Agent')).toBe('agent/1')
    expect(header(request, 'Referer')).toBe('https://ref')
    expect(header(request, 'Cookie')).toBe('a=1; b=2')
    expect(request.settings).toEqual({ followRedirects: true, maxRedirects: 3, timeoutMs: 2500 })
  })

  it('joins -d and --data-urlencode into a form body, and -G moves it to the query', () => {
    const { request } = parse("curl https://h/x -d a=1 --data-urlencode 'q=a b&c' -d b=2")
    expect(request.method).toBe('POST')
    expect(request.body).toMatchObject({ mode: 'urlencoded' })
    const rows = (request.body as { rows: { key: string; value: string }[] }).rows
    expect(rows.map((r) => [r.key, r.value])).toEqual([['a', '1'], ['b', '2'], ['q', 'a b&c']])
    const get = parse('curl -G https://h/x -d a=1 -d b=2').request
    expect(get.method).toBe('GET')
    expect(get.url).toBe('https://h/x?a=1&b=2')
    expect(get.body).toEqual({ mode: 'none' })
  })

  it('reads -F text fields, --json, -I and ANSI-C quoting', () => {
    const form = parse("curl https://h/up -F name=pic -F 'caption=a b'").request
    expect(form.body).toMatchObject({ mode: 'multipart', rows: [{ key: 'name', value: 'pic', kind: 'text' }, { key: 'caption', value: 'a b' }] })
    const json = parse(`curl https://h/j --json '{"a":1}'`).request
    expect(json.method).toBe('POST')
    expect(json.body).toEqual({ mode: 'json', text: '{"a":1}' })
    expect(header(json, 'Accept')).toBe('application/json')
    expect(parse('curl -I https://h/').request.method).toBe('HEAD')
    expect(parse("curl https://h/ -H $'X-A: 1\\tb'").request.headers[0].value).toBe('1\tb')
  })

  it('keeps $(…), backticks and $VAR literally, with a note', () => {
    const { request, notes } = parse('curl "https://h/$(whoami)" -H "X-U: `id`" -H "X-T: $TOKEN"')
    expect(request.url).toBe('https://h/$(whoami)')
    expect(header(request, 'X-U')).toBe('`id`')
    expect(header(request, 'X-T')).toBe('$TOKEN')
    expect(notes.join(' ')).toMatch(/shell expansion is not performed/i)
  })
})

describe('parseCurl: never honoured, always noted (SEC-M6)', () => {
  const PATH = '/Users/someone/secret-dir'
  it.each([
    [`-d @${PATH}/body.json`, 'body.json'],
    [`--data-binary @${PATH}/blob.bin`, 'blob.bin'],
    [`--data-urlencode n@${PATH}/v.txt`, 'v.txt'],
    [`-F f=@${PATH}/pic.png`, 'pic.png'],
    [`-F 'f=<${PATH}/pic.txt'`, 'pic.txt'],
    [`-T ${PATH}/up.tar`, 'up.tar'],
    [`-H @${PATH}/headers.txt`, 'headers.txt'],
    [`-K ${PATH}/curlrc`, 'curlrc'],
    [`--json @${PATH}/j.json`, 'j.json'],
    [`-b ${PATH}/cookies.txt`, 'cookies.txt']
  ])('%s: basename at most, no path anywhere', (flags, base) => {
    const { request, notes } = parse(`curl https://h/x ${flags}`)
    const all = JSON.stringify({ request, notes })
    expect(all).not.toContain(PATH)
    expect(notes.join(' ')).toContain(base)
    expect(notes).toHaveLength(1)
  })

  it('keeps a file row as a basename with "choose again"', () => {
    const { request, notes } = parse(`curl https://h/x -F f=@${PATH}/pic.png`)
    expect((request.body as { rows: MultipartRow[] }).rows[0]).toMatchObject({ kind: 'file', fileName: 'pic.png', value: '' })
    expect(notes[0]).toMatch(/Choose the file again/)
    expect(parse(`curl https://h/x -d @${PATH}/b.json`).request.body).toEqual({ mode: 'binary', fileName: 'b.json' })
  })

  it.each([
    ['-k', /skipped certificate checks/],
    ['--insecure', /skipped certificate checks/],
    ['-x http://proxy:3128', /Proxies are not used/],
    ['--proxy http://proxy:3128', /Proxies are not used/],
    ['--socks5 127.0.0.1:1080', /Proxies are not used/],
    ['--socks5-hostname 127.0.0.1:1080', /Proxies are not used/],
    ['--preproxy socks5://p', /Proxies are not used/],
    ['--proxy-user a:b', /Proxies are not used/],
    ['--cacert /etc/ca.pem', /certificates are not imported/],
    ['--capath /etc/ssl', /certificates are not imported/],
    ['--cert c.pem', /certificates are not imported/],
    ['-E c.pem', /certificates are not imported/],
    ['--key k.pem', /certificates are not imported/],
    ['--location-trusted', /never sent to a redirect/],
    ['--resolve h:443:10.0.0.1', /Send from/],
    ['--connect-to h:443:x:443', /Send from/],
    ['--unix-socket /var/run/docker.sock', /Send from/],
    ['--interface eth0', /Send from/],
    ['--frobnicate', /not supported/]
  ])('%s is noted and changes no trust setting', (flag, why) => {
    const { request, notes } = parse(`curl https://h/x ${flag}`)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(why)
    expect(request.url).toBe('https://h/x')
    const all = JSON.stringify(request)
    expect(all).not.toMatch(/caPem|insecureTls|proxy/i)
  })

  it('refuses what is not a curl command', () => {
    expect(parseCurl('wget https://h').ok).toBe(false)
    expect(parseCurl("curl 'unterminated").ok).toBe(false)
    expect(parseCurl('curl -s').ok).toBe(false)
  })
})

describe('toCurl (SEC-M5)', () => {
  it('shellQuote survives a shell byte-for-byte, with no expansion', () => {
    for (const value of ["a'$(touch /tmp/pwn)'b", '`id`', '$HOME', "it's", '\\n', '"x"', 'a\nb']) {
      const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`]).toString()
      expect(out).toBe(value)
    }
  })

  const req: HttpRequest = {
    id: 'req_1',
    name: 'x',
    kind: 'http',
    method: 'POST',
    url: 'https://{{user}}:pw@h/x?api_key=LIT&token={{tok}}&page=1',
    headers: [
      { id: 'r1', enabled: true, key: 'X-Api-Key', value: 'sk_live_LITERAL' },
      { id: 'r2', enabled: true, key: 'X-Evil', value: "a'$(touch /tmp/pwn)'b" }
    ],
    params: [
      { id: 'p1', enabled: true, key: 'api_key', value: 'LIT' },
      { id: 'p2', enabled: true, key: 'token', value: '{{tok}}' }
    ],
    pathParams: [],
    auth: { type: 'bearer', token: '{{token}}' },
    body: { mode: 'json', text: '{"password":"hunter2","n":1}' },
    settings: { followRedirects: true, maxRedirects: 5 }
  }
  const spec: HttpRequestSpec = {
    url: 'https://alice:pw@h/x?api_key=LIT&token=resolved-tok&page=1',
    method: 'POST',
    headers: {
      'X-Api-Key': 'sk_live_LITERAL',
      'X-Evil': "a'$(touch /tmp/pwn)'b",
      Authorization: 'Bearer resolved-bearer',
      'Content-Type': 'application/json'
    },
    body: new TextEncoder().encode('{"password":"hunter2","n":1}').buffer as ArrayBuffer,
    via: { kind: 'direct' },
    maxRedirects: 5,
    insecureTls: true
  }

  it('masks by default: no literal key, no userinfo, references shown as templates', () => {
    const { text } = toCurl(req, spec, { secrets: 'mask' })
    for (const secret of ['sk_live_LITERAL', 'alice', ':pw@', 'resolved-tok', 'resolved-bearer', 'hunter2', 'api_key=LIT']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain("'Authorization: Bearer {{token}}'")
    expect(text).toContain('token={{tok}}')
    expect(text).toContain('page=1')
    expect(text).toContain('-k')
    expect(text).toContain('-L --max-redirs 5')
  })

  it('includes secrets only when asked, and still quotes everything', () => {
    const { text } = toCurl(req, spec, { secrets: 'include' })
    expect(text).toContain('sk_live_LITERAL')
    expect(text).toContain('resolved-bearer')
    // Every argument goes through the shell unchanged.
    const echoed = execFileSync('sh', ['-c', text.replace(/^curl/, 'printf "%s\\n"').replace(/\\\n\s*/g, ' ')]).toString()
    expect(echoed).toContain("X-Evil: a'$(touch /tmp/pwn)'b")
  })

  it('round-trips through parseCurl', () => {
    const { text } = toCurl(req, spec, { secrets: 'include' })
    const back = parse(text).request
    expect(back.method).toBe('POST')
    expect(header(back, 'X-Evil')).toBe("a'$(touch /tmp/pwn)'b")
    expect(back.body).toEqual({ mode: 'json', text: '{"password":"hunter2","n":1}' })
  })

  it('refuses a header value with a newline or NUL, with a note', () => {
    const { text, notes } = toCurl(req, { ...spec, headers: { 'X-Bad': 'a\nb', 'X-Nul': 'a\0b' } }, { secrets: 'include' })
    expect(text).not.toContain('X-Bad')
    expect(text).not.toContain('X-Nul')
    expect(notes).toHaveLength(2)
  })

  it('accepts the Timeline view, and describes multipart from its rows', () => {
    const sent: SentView = {
      method: 'POST',
      url: 'https://h/up',
      headers: [['Authorization', '•••']],
      route: { key: 'server:srv_1', label: 'bastion' },
      tls: 'custom-ca',
      maxRedirects: 0,
      timeoutMs: 60_000,
      bodyBytes: 10
    }
    const multipart: HttpRequest = {
      ...req,
      auth: { type: 'basic', username: 'a', password: 'LIT' },
      body: {
        mode: 'multipart',
        rows: [
          { id: 'm1', enabled: true, key: 'pic', value: '', kind: 'file', fileName: 'p.png' },
          { id: 'm2', enabled: true, key: 'password', value: 'LIT', kind: 'text' }
        ]
      }
    }
    const { text, notes } = toCurl(multipart, sent, { secrets: 'mask' })
    expect(text).toContain("-F 'pic=@p.png'")
    expect(text).toContain("-F 'password=<secret>'")
    expect(text).toContain("'Authorization: <secret>'")
    expect(text).toContain('--max-time 60')
    expect(notes.join(' ')).toMatch(/custom CA/)
    expect(notes.join(' ')).toMatch(/server or VPN/)
  })

  it.each([
    ' https://u:LEAK_A@h.example/x',
    'https://u:LEAK_B@ss@h.example/x',
    'https://ghp_LEAK_C@github.com/o/r'
  ])('masks the whole userinfo of %j (L4)', (url) => {
    const { text } = toCurl({ ...req, url }, { ...spec, url, headers: {} }, { secrets: 'mask' })
    expect(text).not.toMatch(/LEAK|ss@/)
    expect(text).toContain('<secret>@')
  })
})
