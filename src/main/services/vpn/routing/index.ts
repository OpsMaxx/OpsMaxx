import { isIPv4, isIPv6 } from 'node:net'

import { VpnError } from '../errors'
import type { NetApplyContext } from '../netstate'
import { DarwinRouteManager } from './darwin'
import { LinuxRouteManager } from './linux'
import { Win32RouteManager } from './win32'

// System-mode routing. Only reached when a profile explicitly opts into system
// mode — the default WireGuard mode is entirely userspace and never touches a
// route table, which is why none of this is on the common path.
//
// Commands are named without a directory. The elevation module owns the
// environment privileged commands are spawned into, and duplicating a PATH
// policy here would mean two places to get it wrong; `ip` in particular lives
// in /sbin, /usr/sbin or /bin depending on the distribution.

export interface RouteSpec {
  /** CIDR. `0.0.0.0/0` and `::/0` are accepted but never inferred: a full
   *  tunnel is applied only when the caller asked for one (E13). */
  destination: string
  gateway?: string
  interfaceName: string
  metric?: number
}

export interface RouteEntry {
  destination: string
  gateway?: string
  interfaceName?: string
  interfaceIndex?: number
  metric?: number
  family: 'inet' | 'inet6'
}

export interface RouteSnapshot {
  platform: NodeJS.Platform
  capturedAt: number
  /** The default routes as they were before anything was applied, per family.
   *  Kept so a revert can put back a default that something else removed
   *  while we were up. */
  defaults: RouteEntry[]
  /** Every route the caller intends to add. Filled in by `netstate.ts` before
   *  the snapshot is persisted, because a revert has to be able to undo an
   *  apply that never finished. `snapshot()` leaves it empty. */
  planned: RouteSpec[]
  /** win32 only: connection name -> interface index at snapshot time. */
  interfaceIndex?: Record<string, number>
}

export type RouteConflictKind = 'prefix-claimed' | 'ipv6-leak'

export interface RouteConflict {
  kind: RouteConflictKind
  destination: string
  existing: RouteEntry
  /** Names the route that is already there, so the caller can refuse with
   *  something the user can act on rather than silently winning or losing. */
  message: string
}

export interface RouteManager {
  snapshot(): Promise<RouteSnapshot>
  apply(routes: RouteSpec[], ctx: NetApplyContext): Promise<void>
  /** `ctx` falls back to the one the last `apply` used. The startup restore
   *  pass has no such call behind it and always passes one explicitly. */
  revert(snapshot: RouteSnapshot, ctx?: NetApplyContext): Promise<void>
  conflicts(routes: RouteSpec[]): Promise<RouteConflict[]>
}

export function routeManagerFor(platform: NodeJS.Platform = process.platform): RouteManager {
  switch (platform) {
    case 'darwin':
      return new DarwinRouteManager()
    case 'win32':
      return new Win32RouteManager()
    case 'linux':
      return new LinuxRouteManager()
    default:
      throw new VpnError('unsupported', `System-mode routing is not implemented for ${platform}.`)
  }
}

// ------------------------------------------------------------------ helpers
// Declared as functions, not consts: the platform modules import them from
// here while this module imports their classes, and only function
// declarations are initialised early enough for that cycle to be safe.

/** Everything a failed command said, for matching against.
 *
 *  Paired with `firstOutputLine`, which answers a different question: that one
 *  picks the single line worth showing a person, and this one is what a matcher
 *  has to look at. The two are not interchangeable.
 *
 *  Matching the first line alone breaks two ways, and both end with a working
 *  tunnel torn down. A leading warning hides the cause — `sudo: unable to
 *  resolve host box` arrives before `RTNETLINK answers: Network is
 *  unreachable`, so `classifyEngineLine` sees only the warning, finds nothing,
 *  and the specific code degrades to `internal`. And where the privileged
 *  channel carries no output at all, the first line IS the fallback sentence, so
 *  `file exists` and `object already exists` — the lines that make a retried add
 *  harmless — can never match anything.
 *
 *  That second case is not hypothetical and is not fixed by matching more text:
 *  on Windows the elevated command is started through ShellExecute, which has no
 *  handles to redirect, so there is never any output here. Both route appliers
 *  therefore confirm an "already exists" collision against the route table as
 *  well, and that — not this — is what keeps a retry from tearing down a working
 *  tunnel. Matching the whole output is what makes this worth anything on the
 *  platforms that do talk. */
export function commandOutput(res: { stdout?: string; stderr?: string }): string {
  return `${res.stderr ?? ''}\n${res.stdout ?? ''}`
}

export function familyOf(destination: string): 'inet' | 'inet6' {
  return destination.includes(':') ? 'inet6' : 'inet'
}

/** A dotted quad masked down to the network address for `bits`. Integer
 *  arithmetic rather than string surgery, because a prefix length that does not
 *  land on an octet boundary (/12, /1) cannot be done any other way. */
function maskIpv4(addr: string, bits: number): string {
  const n = addr.split('.').reduce((acc, o) => acc * 256 + Number(o), 0)
  // `<< 32` is `<< 0` in JavaScript — the shift count is taken mod 32 — so /0
  // cannot share the expression with every other length.
  const masked = bits === 0 ? 0 : (n & (0xffffffff << (32 - bits))) >>> 0
  return [masked >>> 24, (masked >>> 16) & 255, (masked >>> 8) & 255, masked & 255].join('.')
}

/** RFC 5952 form, or null when the parser would not have it. The URL parser is
 *  the canonicaliser already shipping in the platform: it lowercases, drops
 *  leading zeroes and compresses the longest run of zero groups, which is the
 *  whole of 5952. Same trick `canonicalServer` uses for DNS servers. */
function canonicalIpv6(addr: string): string | null {
  try {
    return new URL(`http://[${addr}]`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/** The eight groups of an IPv6 address with `::` expanded. */
function groupsOf(addr: string): number[] | null {
  const [head, tail, extra] = addr.split('::')
  if (extra !== undefined) return null
  const lead = head ? head.split(':') : []
  const trail = tail ? tail.split(':') : []
  const gap = 8 - lead.length - trail.length
  if (tail === undefined ? gap !== 0 : gap < 0) return null
  const parts = [...lead, ...(tail === undefined ? [] : Array(gap).fill('0')), ...trail]
  const out = parts.map((p) => parseInt(p, 16))
  return out.some((n) => !Number.isInteger(n)) ? null : out
}

function maskIpv6(addr: string, bits: number): string | null {
  const groups = groupsOf(addr)
  if (!groups) return null
  const masked = groups.map((g, i) => {
    const keep = Math.min(Math.max(bits - i * 16, 0), 16)
    return keep === 0 ? 0 : g & ((0xffff << (16 - keep)) & 0xffff)
  })
  // Recompressed by the same parser, so the output of this function and the
  // output of canonicalising an already-masked address are the same string.
  return canonicalIpv6(masked.map((n) => n.toString(16)).join(':'))
}

/** Comparable form: the network address for the prefix, lowercased, with IPv6
 *  in RFC 5952 form. Handles `default` and a bare address with no prefix.
 *
 *  The masking is not cosmetic. `AllowedIPs` is copy-pasted from a profile's
 *  Address field often enough that `10.8.0.1/24` is the common spelling of
 *  `10.8.0.0/24`, and the OS route table only ever prints the network address —
 *  so without it the spec and the table never compare equal, and `routeExistsOn`
 *  reads a retry landing on our own leftover route as a real failure and rolls
 *  a working tunnel back. Windows has no command output to fall back on, so
 *  that comparison is the only judge there.
 *
 *  IPv6 is masked as well, for the same reason and no other: a dual-stack
 *  profile's v6 half is pasted from the same field, so `fd00::2/64` arrives by
 *  exactly the route `10.8.0.1/24` does. Doing one family and not the other
 *  would be a function whose contract nobody can hold in their head.
 *
 *  Never throws. Anything this cannot do arithmetic on — a route-type keyword,
 *  a hostname, junk — comes back lowercased and otherwise untouched, because a
 *  malformed `AllowedIPs` must not be the reason a connect dies. */
export function normalizeCidr(destination: string, family?: 'inet' | 'inet6'): string {
  const t = destination.trim().toLowerCase()
  if (!t) return ''
  if (t === 'default') return (family ?? 'inet') === 'inet6' ? '::/0' : '0.0.0.0/0'
  const slash = t.lastIndexOf('/')
  const addr = slash === -1 ? t : t.slice(0, slash)
  const suffix = slash === -1 ? '' : t.slice(slash + 1)
  // Digits only: `Number('')` is 0, and a trailing slash turning into a default
  // route would be the worst possible way to be lenient.
  if (slash !== -1 && !/^\d+$/.test(suffix)) return t
  if (isIPv4(addr)) {
    const bits = slash === -1 ? 32 : Number(suffix)
    return bits > 32 ? t : `${maskIpv4(addr, bits)}/${bits}`
  }
  // A zone id is scope, not an address: two differently scoped routes are not
  // the same route, and dropping it to canonicalise would merge them.
  if (isIPv6(addr) && !addr.includes('%')) {
    const bits = slash === -1 ? 128 : Number(suffix)
    if (bits > 128) return t
    const net = maskIpv6(addr, bits)
    if (net !== null) return `${net}/${bits}`
  }
  return t
}

export function isDefaultRoute(destination: string): boolean {
  const n = normalizeCidr(destination)
  return n === '0.0.0.0/0' || n === '::/0'
}

/** A dotted mask as a prefix length, or null when it is not a contiguous
 *  mask. `route print` reports IPv4 routes this way and nothing else does. */
export function maskToPrefix(mask: string): number | null {
  const parts = mask.trim().split('.')
  if (parts.length !== 4) return null
  let bits = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    bits = bits * 256 + n
  }
  // A valid mask is a run of ones followed by a run of zeroes; inverting it
  // and adding one must land on a power of two.
  const inverted = (~bits >>> 0) + 1
  if (inverted !== 0 && (inverted & (inverted - 1)) !== 0) return null
  let len = 0
  for (let i = 31; i >= 0; i--) {
    if ((bits & (1 << i)) === 0) break
    len++
  }
  return len
}

/** Replace a literal default route with the two halves that cover the same
 *  space at a longer prefix.
 *
 *  This is the trick `wg-quick` and OpenVPN's `def1` both use, and the reason
 *  is reversibility rather than elegance: `0.0.0.0/1` plus `128.0.0.0/1` win
 *  on longest-prefix match without the existing default ever being removed,
 *  so undoing them is two deletes and the original default is still sitting
 *  there untouched — including after a `kill -9`, when nobody is around to
 *  put it back (E14). */
export function expandDefaultRoutes(routes: RouteSpec[]): RouteSpec[] {
  const out: RouteSpec[] = []
  for (const r of routes) {
    const n = normalizeCidr(r.destination)
    if (n === '0.0.0.0/0') {
      out.push({ ...r, destination: '0.0.0.0/1' }, { ...r, destination: '128.0.0.0/1' })
    } else if (n === '::/0') {
      out.push({ ...r, destination: '::/1' }, { ...r, destination: '8000::/1' })
    } else {
      out.push({ ...r, destination: n })
    }
  }
  return out
}

/** True when this route set takes over all traffic of a family — either as a
 *  literal default or as the two halves above. */
export function claimsDefault(routes: RouteSpec[], family: 'inet' | 'inet6'): boolean {
  const wanted =
    family === 'inet' ? ['0.0.0.0/1', '128.0.0.0/1'] : ['::/1', '8000::/1']
  const have = new Set(expandDefaultRoutes(routes).map((r) => normalizeCidr(r.destination)))
  return wanted.every((w) => have.has(w))
}

/** E16. A v4-only route set on a host with a live IPv6 default means IPv6
 *  traffic keeps taking the old path — which looks identical to working, and
 *  is the leak users never notice. Reported rather than fixed: the remedy
 *  ("block IPv6 while connected") destroys connectivity the user may want, so
 *  it is the caller's call, not ours. */
export function detectIpv6Leak(routes: RouteSpec[], defaults: RouteEntry[]): RouteConflict | null {
  if (claimsDefault(routes, 'inet6')) return null
  const v6 = defaults.find((d) => d.family === 'inet6' && normalizeCidr(d.destination, 'inet6') === '::/0')
  if (!v6) return null
  const where = v6.gateway
    ? `via ${v6.gateway}${v6.interfaceName ? ` on ${v6.interfaceName}` : ''}`
    : v6.interfaceName
      ? `on ${v6.interfaceName}`
      : 'on this server'
  return {
    kind: 'ipv6-leak',
    destination: '::/0',
    existing: v6,
    message: `This profile does not carry IPv6, but a default IPv6 route is live ${where}. IPv6 traffic will bypass the tunnel.`
  }
}

/** A prefix already routed by an interface that is not ours. Shared by all
 *  three platforms so the wording of the refusal is identical everywhere. */
export function detectPrefixConflicts(
  routes: RouteSpec[],
  table: RouteEntry[],
  match: (spec: RouteSpec, entry: RouteEntry) => boolean
): RouteConflict[] {
  const out: RouteConflict[] = []
  const seen = new Set<string>()
  for (const spec of expandDefaultRoutes(routes)) {
    for (const entry of table) {
      if (!match(spec, entry)) continue
      const key = `${spec.destination}|${entry.interfaceName ?? entry.interfaceIndex ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const owner =
        entry.interfaceName ??
        (entry.interfaceIndex !== undefined ? `interface ${entry.interfaceIndex}` : 'another interface')
      out.push({
        kind: 'prefix-claimed',
        destination: spec.destination,
        existing: entry,
        message: `${spec.destination} is already routed ${entry.gateway ? `via ${entry.gateway} ` : ''}on ${owner}.`
      })
    }
  }
  return out
}

/** Same prefix, different interface. `undefined` on either side means the
 *  table did not say, and an unattributed route is not evidence of a clash. */
export function sameDestinationOtherInterface(spec: RouteSpec, entry: RouteEntry): boolean {
  if (normalizeCidr(spec.destination) !== normalizeCidr(entry.destination, entry.family)) return false
  if (entry.interfaceName === undefined) return false
  return entry.interfaceName !== spec.interfaceName
}
