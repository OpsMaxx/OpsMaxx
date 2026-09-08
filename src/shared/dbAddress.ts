// The one-line address a saved database shows in its tab header and sidebar.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
//
// A database can be entered as discrete fields or as one connection string. In
// field mode the header shows `host:port` and there is nothing to get wrong. In
// string mode the app has to derive a host from the string, and the derivation
// used to be:
//
//     uri.match(/@([^/:?,]+)/)?.[1]
//       ?? uri.replace(/^\w+(\+\w+)?:\/\//, '').split(/[/:?]/)[0]
//
// which is a URI parser with a fallback that returns THE WHOLE STRING when the
// string is not a URI. An ADO.NET / SQL Server connection string —
//
//     Server=db01,11433;Database=master;User Id=sa;Password=hunter2;Encrypt=false
//
// has no scheme, no `@`, and none of `/ : ?`. So the match failed, the fallback
// split found no separator, and the derived "host" was the entire string. That
// value was then PERSISTED to `host` and rendered permanently in the tab
// chrome, above the fold, password included, for as long as the tab was open.
//
// The bug is not that the URI branch was wrong. It is that the fallback treated
// "I could not parse this" as "here is your host". That is the same mistake the
// rest of this app refuses to make about server reads: a parse that did not
// succeed must never render as though it did. So `parseDbAddress` returns an
// explicit `unparsed` outcome and the caller shows a neutral label, and there
// is NO code path that puts unparsed input on screen.
//
// ---------------------------------------------------------------------------
// FORMATS, MEASURED RATHER THAN ASSUMED
// ---------------------------------------------------------------------------
//
// Two families reach this function, and they were read off real strings the
// five supported drivers actually accept rather than off documentation:
//
//   URI          postgresql://user:pass@host:5432/db     (postgres, mysql,
//                mongodb+srv://user:pass@cluster/db       mongodb, redis)
//                redis://:pass@host:6379/0
//
//   Key/value    Server=host,1433;Database=x;User Id=sa;Password=y   (mssql)
//                Data Source=host;Initial Catalog=x;...
//
// Key/value strings are `;`-separated `key=value` pairs, keys are
// case-insensitive and space-insensitive (`User Id` and `userid` are the same
// key to SQL Server), and the SQL Server host carries its port after a COMMA,
// not a colon — `Server=db01,11433`. Getting that comma wrong is how a port
// ends up concatenated onto a host, which is the second half of what the
// screenshot showed (`...Encrypt=false:1433`).
//
// ---------------------------------------------------------------------------
// SANITISING WHAT IS ALREADY SAVED
// ---------------------------------------------------------------------------
//
// Fixing the write path is not enough. Every record saved by an affected build
// already has the connection string sitting in its `host` field, and an upgrade
// that only fixed new saves would keep printing the old password forever.
// `sanitiseStoredHost` re-runs the parse on read, so an existing record heals
// the first time it is displayed, and `looksLikeSecret` is the belt-and-braces
// check that stops anything credential-shaped reaching the screen even if a
// future format slips past the parser.

/** A host we are willing to print, or an explicit admission that we cannot. */
export type DbAddress =
  | { kind: 'parsed'; host: string; port: number | null }
  /** The string did not parse. Callers MUST NOT fall back to showing it. */
  | { kind: 'unparsed' }

/** What the header shows when there is no host to show. Not a hostname. */
export const DB_ADDRESS_UNPARSED_LABEL = 'connection string'

/**
 * Keys that carry the server in a key/value connection string, HIGHEST priority
 * first — the lookup below returns on the first one present, so an explicit
 * `Server=` wins over an aliased `Data Source=` or `Addr=`.
 *
 * Compared after stripping spaces and lowercasing, because `User Id` / `userid`
 * and `Data Source` / `datasource` are the same key to the driver.
 */
const HOST_KEYS = ['server', 'host', 'data source', 'address', 'addr', 'network address']

/** Keys whose VALUE is a credential. Never printed, never used as a host. */
const SECRET_KEYS = ['password', 'pwd', 'secret', 'token', 'apikey', 'api key', 'accountkey']

const normaliseKey = (k: string): string => k.trim().toLowerCase().replace(/\s+/g, '')

/**
 * True when a string looks like it carries a credential.
 *
 * Deliberately generous: this guards the display path, and the cost of a false
 * positive is the neutral label, while the cost of a false negative is a
 * password on screen. It is not an input validator and must never be used as
 * one — a legitimate host is not rejected anywhere, it is only not *printed*.
 */
export function looksLikeSecret(value: string): boolean {
  const v = value.toLowerCase()
  if (SECRET_KEYS.some((k) => v.includes(`${k}=`))) return true
  // `user:pass@host` — credentials in the userinfo of a URI.
  if (/:\/\/[^/@]*:[^/@]*@/.test(value)) return true
  return false
}

/** Strip `[...]` from a bracketed IPv6 literal, leaving the address itself. */
const unbracket = (h: string): string => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h)

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null
  // A port is digits and nothing else. `1433extra` is not a port, and coercing
  // it with Number() would silently yield NaN and then render as "NaN".
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 65535 ? n : null
}

/**
 * Split `host`, `host:port`, `host,port` or `[::1]:port` into its two parts.
 *
 * The comma form is SQL Server's. A bare IPv6 literal without brackets is
 * indistinguishable from a host with several colons, so it is returned whole
 * with no port rather than truncated at the first colon.
 */
function splitHostPort(raw: string): { host: string; port: number | null } | null {
  const s = raw.trim()
  if (!s) return null

  // Bracketed IPv6, with or without a port: [::1] / [::1]:5432
  const bracketed = /^(\[[^\]]+\])(?::(\d+))?$/.exec(s)
  if (bracketed) return { host: unbracket(bracketed[1]), port: parsePort(bracketed[2]) }

  // SQL Server's comma form takes precedence: `db01,11433`.
  const comma = s.indexOf(',')
  if (comma !== -1) {
    const host = s.slice(0, comma).trim()
    return host ? { host: unbracket(host), port: parsePort(s.slice(comma + 1).trim()) } : null
  }

  const colons = (s.match(/:/g) ?? []).length
  if (colons === 1) {
    const [h, p] = s.split(':')
    // `host:` with nothing after it still names a host.
    return h ? { host: h, port: parsePort(p) } : null
  }
  // Zero colons, or several (an unbracketed IPv6 literal). Take it whole.
  return { host: s, port: null }
}

/**
 * Derive the address to display from a connection string.
 *
 * Returns `unparsed` rather than guessing. That is the whole point of the
 * module: there is no branch here that can return attacker- or user-supplied
 * text verbatim as a hostname.
 */
export function parseDbAddress(raw: string): DbAddress {
  const s = (raw ?? '').trim()
  if (!s) return { kind: 'unparsed' }

  // ---- URI family -------------------------------------------------------
  // `scheme://` is what makes this a URI. Matching on it first means a
  // key/value string containing a stray `//` is not mistaken for one.
  const uri = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(s)
  if (uri) {
    // Authority ends at the first `/`, `?` or `#`.
    const authority = uri[1].split(/[/?#]/)[0]
    // Userinfo is everything before the LAST `@` — a password may itself
    // contain an `@`, and splitting on the first one would leave half a
    // credential in the host.
    const at = authority.lastIndexOf('@')
    const hostPart = at === -1 ? authority : authority.slice(at + 1)
    // A comma-separated seed list (mongodb, redis cluster). The first entry is
    // the one worth naming; showing all of them is not an address.
    const first = hostPart.split(',')[0]
    const split = splitHostPort(first)
    if (!split) return { kind: 'unparsed' }
    // Belt and braces: nothing credential-shaped ever leaves this function.
    if (looksLikeSecret(split.host)) return { kind: 'unparsed' }
    return { kind: 'parsed', host: split.host, port: split.port }
  }

  // ---- key/value family -------------------------------------------------
  // Only treated as key/value when it actually looks like it: at least one
  // `key=value` pair. Otherwise a bare hostname would fall through to here and
  // be reported unparsed, which is handled below instead.
  if (s.includes('=')) {
    const pairs = new Map<string, string>()
    for (const part of s.split(';')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const key = normaliseKey(part.slice(0, eq))
      // First occurrence wins, matching how the drivers themselves resolve a
      // duplicated key, and stopping a later `Server=` from overriding.
      if (!pairs.has(key)) pairs.set(key, part.slice(eq + 1).trim())
    }
    for (const key of HOST_KEYS) {
      const value = pairs.get(normaliseKey(key))
      if (!value) continue
      // `tcp:db01,1433` — SQL Server allows a network-protocol prefix.
      const withoutProtocol = /^(tcp|np|lpc):(.+)$/i.exec(value)
      const split = splitHostPort(withoutProtocol ? withoutProtocol[2] : value)
      if (!split || looksLikeSecret(split.host)) continue
      // An explicit `Port=` beats a port inside the server value only when the
      // server value did not carry one.
      const explicit = parsePort(pairs.get('port'))
      return { kind: 'parsed', host: split.host, port: split.port ?? explicit }
    }
    return { kind: 'unparsed' }
  }

  // ---- bare host --------------------------------------------------------
  // `db01`, `db01:5432`, `10.0.0.4`. Accepted only when it contains none of the
  // punctuation that would make it a fragment of something larger — a value
  // with a space or a `;` in it is not a hostname somebody typed.
  if (/[\s;=@]/.test(s)) return { kind: 'unparsed' }
  const split = splitHostPort(s)
  if (!split || looksLikeSecret(split.host)) return { kind: 'unparsed' }
  return { kind: 'parsed', host: split.host, port: split.port }
}

/**
 * The host to persist for a connection-string record.
 *
 * Empty string when the string did not parse — the record then has no host,
 * which is honest, rather than a host that is really a password.
 */
export function displayHostFromUri(raw: string): string {
  const a = parseDbAddress(raw)
  return a.kind === 'parsed' ? a.host : ''
}

/**
 * Repair a `host` read back from the store.
 *
 * Records written by an affected build already carry the whole connection
 * string here. Re-running the parse on READ means such a record heals the first
 * time it is displayed, without a migration and without ever printing the value
 * it was carrying. A host that is already a plain host passes through unchanged.
 */
export function sanitiseStoredHost(host: string | undefined | null): string | null {
  const s = (host ?? '').trim()
  if (!s) return null
  // The common case: already a clean host. Cheap check first.
  if (!/[\s;=]/.test(s) && !looksLikeSecret(s)) {
    const split = splitHostPort(s)
    if (split && !looksLikeSecret(split.host)) return split.host
  }
  const a = parseDbAddress(s)
  return a.kind === 'parsed' ? a.host : null
}

/**
 * The full string the tab header and sidebar print.
 *
 * `port` is the record's own port column, which exists in both entry modes.
 * It is only appended when the host is real: gluing a port onto the neutral
 * label produced the `...Encrypt=false:1433` in the original screenshot.
 */
export function formatDbAddress(host: string | undefined | null, port?: number | null): string {
  const clean = sanitiseStoredHost(host)
  if (!clean) return DB_ADDRESS_UNPARSED_LABEL
  return port ? `${clean}:${port}` : clean
}
