// What is listening on this host, and which process owns it.
//
// Asked for rather than sampled, like the rest of hostFacts: a listening socket
// changes when somebody deploys, not every two seconds.
//
// Three tools, because no single one is present-and-sufficient everywhere:
// `ss` on modern Linux, `netstat` on macOS and older Linux, and `lsof` on macOS
// for the owning process. The parsers below all feed one list, and the SOURCE is
// reported so the panel can say when owners are missing rather than implying
// nobody owns the socket.
//
// Everything a host prints here is free text until it parses. A process name is
// drawn in a panel, and a panel is not a safe place to render an arbitrary
// string a remote host chose — so names are shape-checked and truncated.

export interface ListeningPort {
  proto: 'tcp' | 'udp'
  /** As the host printed it: `0.0.0.0`, `::`, `127.0.0.1`, `*`. */
  address: string
  port: number
  /** Absent when the tool that answered could not see the owner. */
  process?: string
  pid?: number
}

export interface ListeningPortsInfo {
  ports: ListeningPort[]
  /**
   * True when at least one row has no owning process.
   *
   * This is the honest half of the macOS story: unprivileged `lsof` cannot see
   * other users' sockets, so without joining `netstat` the LIST ITSELF would be
   * short rather than merely missing a column. Joining them makes the list
   * complete and the owners partial, which is a thing the UI can state.
   */
  partialOwners: boolean
  /** Which tool(s) answered. `null` when none of the three exist. */
  source: 'ss' | 'netstat' | 'lsof' | 'mixed' | null
}

/**
 * Section markers, and why they do not start with `#`.
 *
 * They did, and that made the whole read return nothing: `#` begins a comment
 * in every POSIX shell, so `echo #__om_ss__` prints an empty line and the
 * marker never reaches the output at all. `section()` then found -1 three
 * times, handed every parser an empty string, and the panel rendered as "no
 * ports" on every host — silently, because an empty list is a legitimate
 * answer.
 *
 *   $ bash -c 'echo #__om_ss__' | od -c
 *   0000000  \n
 *
 * `=` is not special to the shell in this position, and the triple makes the
 * marker distinctive enough not to collide with a socket line.
 */
const SS = '===OM_PORTS_SS==='
const NETSTAT = '===OM_PORTS_NETSTAT==='
const LSOF = '===OM_PORTS_LSOF==='

/**
 * One compound read, every step guarded.
 *
 * All three are asked for unconditionally rather than chained with `||`,
 * because on macOS the useful answer is the JOIN of two of them: `netstat`
 * knows every listener, `lsof` knows the owners of the ones this user can see.
 * A host with none of the three answers with three empty sections, which parses
 * to no ports rather than to an error.
 *
 * `ss -H` suppresses the header; older `ss` does not support it, which is why
 * the parser skips a header line rather than relying on the flag.
 */
export function buildListeningPortsCommand(): string {
  return [
    `echo ${SS}`,
    'ss -tulpnH 2>/dev/null || ss -tulpn 2>/dev/null || true',
    `echo ${NETSTAT}`,
    // -p tcp is required on macOS (its netstat has no -t/-u); the Linux form
    // is tried first and its failure falls through.
    'netstat -tulpn 2>/dev/null || { netstat -an -p tcp 2>/dev/null; netstat -an -p udp 2>/dev/null; } || true',
    `echo ${LSOF}`,
    /**
     * `+c 0` means "do not truncate the command name".
     *
     * lsof's default is nine characters, which turned `JavaApplicationStub`
     * into `JavaAppli` and `codebase-memory-mcp` into `codebase-` — so the
     * owner column named something the user could not search for and could not
     * recognise.
     *
     * Chained with a plain `lsof` fallback rather than assumed: `+c` is not
     * universal, and a build without it would otherwise fail the whole
     * invocation and lose the owner column altogether. A truncated name beats
     * no name.
     */
    'lsof +c 0 -nP -iTCP -sTCP:LISTEN 2>/dev/null || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true'
  ].join('\n')
}

function section(output: string, marker: string): string {
  const start = output.indexOf(marker)
  if (start === -1) return ''
  const from = start + marker.length
  const next = [SS, NETSTAT, LSOF]
    .filter((m) => m !== marker)
    .map((m) => output.indexOf(m, from))
    .filter((i) => i !== -1)
  const end = next.length ? Math.min(...next) : output.length
  return output.slice(from, end)
}

/**
 * A process name is rendered, so it is constrained rather than trusted.
 *
 * Spaces ARE allowed: lsof legitimately prints `Google Ch`, `Adobe Desk` and
 * `Microsoft`, and rejecting those threw away the name of exactly the processes
 * a person is most likely to be looking for. What is rejected is anything that
 * is not printable-and-boring — control characters, angle brackets, quotes —
 * because this string is drawn in a panel and a remote host chose it.
 */
function cleanName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const name = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/:$/, '')
    // lsof escapes non-printables in the command name as `\x20` — a space
    // becomes four characters. Decoded here, because `Burp\x20Browser` is not
    // a name anybody recognises, and because the backslash would otherwise fail
    // the allowlist below and throw the name away entirely. Only printable
    // ASCII is decoded: the point is to recover a space, not to reconstruct
    // arbitrary bytes into something that then gets rendered.
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_m, hex) => {
      const code = parseInt(hex, 16)
      return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : ''
    })
    .trim()
  if (!name || name.length > 64) return undefined
  if (!/^[A-Za-z0-9 ._@:+()/-]+$/.test(name)) return undefined
  return name
}

/**
 * Split a `host:port` or macOS `host.port` into parts.
 *
 * The trailing group is the port either way; splitting on the LAST separator is
 * what makes `[::]:22`, `::1.5432` and `0.0.0.0:22` all land correctly, where
 * splitting on the first would cut an IPv6 address in half.
 */
function splitAddress(raw: string): { address: string; port: number } | null {
  const at = Math.max(raw.lastIndexOf(':'), raw.lastIndexOf('.'))
  if (at <= 0) return null
  const port = Number(raw.slice(at + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null
  let address = raw.slice(0, at)
  // `[::]` and `[::1]` — the brackets are syntax, not part of the address.
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  return { address: address || '*', port }
}

/** `ss -tulpn`: Netid State Recv-Q Send-Q Local Peer [Process] */
export function parseSs(text: string): ListeningPort[] {
  const out: ListeningPort[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^Netid/i.test(line)) continue
    const cols = line.split(/\s+/)
    if (cols.length < 5) continue
    const proto = cols[0].startsWith('udp') ? 'udp' : cols[0].startsWith('tcp') ? 'tcp' : null
    if (!proto) continue
    // UDP has no LISTEN state, so a udp row counts as listening by being here;
    // a tcp row must actually say LISTEN or it is an established connection.
    if (proto === 'tcp' && !/LISTEN/i.test(cols[1])) continue
    const addr = splitAddress(cols[4])
    if (!addr) continue
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line)
    out.push({
      proto,
      ...addr,
      process: cleanName(users?.[1]),
      pid: users ? Number(users[2]) : undefined
    })
  }
  return out
}

/**
 * `netstat`, in either flavour.
 *
 * Linux: `tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 812/sshd`
 * macOS: `tcp4 0 0 *.22 *.* LISTEN`
 *
 * The macOS form carries no owner at all, which is the reason lsof is joined.
 */
export function parseNetstat(text: string): ListeningPort[] {
  const out: ListeningPort[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^(Active|Proto)/i.test(line)) continue
    const cols = line.split(/\s+/)
    if (cols.length < 4) continue
    const proto = /^udp/i.test(cols[0]) ? 'udp' : /^tcp/i.test(cols[0]) ? 'tcp' : null
    if (!proto) continue
    if (proto === 'tcp' && !/LISTEN/i.test(line)) continue
    const addr = splitAddress(cols[3])
    if (!addr) continue
    /**
     * `812/sshd` — the Linux `-p` column, absent on macOS.
     *
     * NOT anchored to end of line. nginx, postgres and php-fpm all print a
     * process title with a space in it — `1140/nginx: master` — and an
     * `$`-anchored pattern matched none of them, so exactly the daemons someone
     * is most likely to be looking for lost their name and were then reported
     * as having no visible owner.
     */
    const owner = /(?:^|\s)(\d+)\/(\S+)/.exec(line)
    out.push({
      proto,
      ...addr,
      process: cleanName(owner?.[2]?.replace(/:$/, '')),
      pid: owner ? Number(owner[1]) : undefined
    })
  }
  return out
}

/** `lsof -nP -iTCP -sTCP:LISTEN`: COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME */
export function parseLsof(text: string): ListeningPort[] {
  const out: ListeningPort[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || /^COMMAND/i.test(line)) continue

    /**
     * Parsed from both ends, never by column index.
     *
     * lsof's COMMAND column contains spaces — macOS prints `Google Ch`,
     * `Adobe Desk`, `Microsoft` — so splitting on whitespace shifts every
     * subsequent field: the pid was read from the second word of the process
     * name and came out `NaN`, and the address was read one column early.
     *
     * What IS reliable: the pid is the first run of digits, and the address is
     * the last field that parses as one (the `(LISTEN)` suffix is optional —
     * `-sTCP:LISTEN` already filtered, and some builds omit it).
     */
    const head = /^(.+?)\s+(\d+)\s/.exec(line)
    if (!head) continue

    const fields = line.split(/\s+/)
    let addr: { address: string; port: number } | null = null
    for (let i = fields.length - 1; i >= 0 && !addr; i--) {
      if (/^\(.*\)$/.test(fields[i])) continue
      addr = splitAddress(fields[i])
    }
    if (!addr) continue

    out.push({
      proto: 'tcp',
      ...addr,
      process: cleanName(head[1]),
      pid: Number(head[2]) || undefined
    })
  }
  return out
}

/**
 * The dedup key, with wildcard addresses normalised.
 *
 * The same socket is spelled differently by different tools: Linux `netstat`
 * prints `0.0.0.0:22` and `lsof` prints `*:22`, and macOS `netstat` prints
 * `*.22`. Keying on the literal address listed port 22 twice — once from each
 * tool — which is worse than either tool alone.
 */
const WILDCARD = new Set(['*', '0.0.0.0', '::', '[::]', ''])

const keyOf = (p: ListeningPort): string =>
  `${p.proto}/${WILDCARD.has(p.address) ? '*' : p.address}/${p.port}`

export function parseListeningPorts(output: string): ListeningPortsInfo {
  const ss = parseSs(section(output, SS))
  const netstat = parseNetstat(section(output, NETSTAT))
  const lsof = parseLsof(section(output, LSOF))

  /**
   * `ss` wins outright where it answered: it is the only one of the three that
   * reports both every socket and its owner in one pass.
   */
  if (ss.length > 0) {
    return {
      ports: sorted(ss),
      partialOwners: ss.some((p) => !p.process),
      source: 'ss'
    }
  }

  // Otherwise: netstat for the complete list, lsof for the owners it can see.
  // This is the macOS path, and the join is what keeps the LIST complete when
  // lsof alone would silently omit other users' sockets.
  const owners = new Map<string, ListeningPort>()
  for (const p of lsof) owners.set(keyOf(p), p)

  const merged: ListeningPort[] = []
  const seen = new Set<string>()
  for (const p of netstat) {
    const key = keyOf(p)
    if (seen.has(key)) continue
    seen.add(key)
    const owner = p.process ? undefined : owners.get(key)
    merged.push(owner ? { ...p, process: owner.process, pid: owner.pid } : p)
  }
  // A socket lsof saw and netstat did not — possible when netstat is absent
  // entirely, in which case lsof is the whole answer.
  for (const p of lsof) {
    const key = keyOf(p)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(p)
  }

  if (merged.length === 0) return { ports: [], partialOwners: false, source: null }

  const source: ListeningPortsInfo['source'] =
    netstat.length && lsof.length ? 'mixed' : netstat.length ? 'netstat' : 'lsof'

  return { ports: sorted(merged), partialOwners: merged.some((p) => !p.process), source }
}

/** Port ascending, then protocol, so the same host reads the same way twice. */
function sorted(ports: ListeningPort[]): ListeningPort[] {
  return [...ports].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.address.localeCompare(b.address))
}
