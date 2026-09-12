import { classifyEngineLine, firstOutputLine, VpnError } from '../errors'
import { readCommand } from '../netstate'
import type { NetApplyContext } from '../netstate'
import {
  commandOutput,
  detectIpv6Leak,
  detectPrefixConflicts,
  expandDefaultRoutes,
  familyOf,
  maskToPrefix,
  normalizeCidr
} from './index'
import type { RouteConflict, RouteEntry, RouteManager, RouteSnapshot, RouteSpec } from './index'

// Windows addresses interfaces by index, never by name. The connection name is
// user-editable and localised ("Ethernet" is "Ethernet" in English and
// something else elsewhere), and two adapters can carry the same description,
// so the name is resolved to an index once and the index is what goes into
// every command.
//
// Every route is added with `store=active`, which means it lives in the
// running stack and not in the registry. A persistent route that outlived a
// reboot would be a route nothing on the machine knows how to remove.

const ROUTE = 'route'
const NETSH = 'netsh'

/** `netsh interface ipv4 show interfaces`:
 *    Idx     Met         MTU          State                Name
 *    ---  ----------  ----------  ------------  ---------------------------
 *     12          25        1500  connected     Ethernet
 *  The header words are localised; the four leading numeric/state columns are
 *  not, so the row is split positionally and everything after the fourth
 *  column is the name. */
export function parseShowInterfaces(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const name = m[5].trim()
    if (!name) continue
    out[name] = Number(m[1])
  }
  return out
}

/** `route print`, both families. IPv4 rows are destination/netmask/gateway/
 *  interface-address/metric; IPv6 rows are index/metric/prefix/gateway. Only
 *  the rows are parsed — the section headers are localised. */
export function parseRoutePrint(text: string): RouteEntry[] {
  const out: RouteEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^-+$/.test(line) || /^=+$/.test(line)) continue
    const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\S+)\s+(\S+)\s+(\d+)$/.exec(line)
    if (v4) {
      const prefix = maskToPrefix(v4[2])
      if (prefix === null) continue
      out.push({
        destination: `${v4[1]}/${prefix}`,
        gateway: /^on-link$/i.test(v4[3]) ? undefined : v4[3],
        metric: Number(v4[5]),
        family: 'inet'
      })
      continue
    }
    const v6 = /^(\d+)\s+(\d+)\s+(\S*:\S*(?:\/\d+)?)\s+(\S.*?)\s*$/.exec(line)
    if (v6) {
      out.push({
        destination: normalizeCidr(v6[3], 'inet6'),
        gateway: /^on-link$/i.test(v6[4]) ? undefined : v6[4],
        interfaceIndex: Number(v6[1]),
        metric: Number(v6[2]),
        family: 'inet6'
      })
    }
  }
  return out
}

/** `netsh interface ipv4 show route`:
 *    Publish  Type      Met  Prefix                    Idx  Gateway/Interface Name
 *    No       Manual    256  0.0.0.0/0                  12  192.168.1.1
 *  Used for conflict detection rather than `route print` because it names the
 *  interface by index, which is the only identifier that can be compared with
 *  the one commands are issued against. */
export function parseNetshShowRoute(text: string, family: 'inet' | 'inet6'): RouteEntry[] {
  const out: RouteEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^-+$/.test(line)) continue
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(\S+\/\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    out.push({
      destination: normalizeCidr(m[4], family),
      gateway: m[6].trim(),
      interfaceIndex: Number(m[5]),
      metric: Number(m[3]),
      family
    })
  }
  return out
}

async function interfaceIndexes(): Promise<Record<string, number>> {
  const [v4, v6] = await Promise.all([
    readCommand(NETSH, ['interface', 'ipv4', 'show', 'interfaces']),
    readCommand(NETSH, ['interface', 'ipv6', 'show', 'interfaces'])
  ])
  // v6 second so a dual-stack adapter keeps one index; they are the same
  // number, and a v4-only adapter still gets an entry from the first call.
  return { ...parseShowInterfaces(v4.stdout), ...parseShowInterfaces(v6.stdout) }
}

function contextFor(destination: string): 'ipv4' | 'ipv6' {
  return familyOf(destination) === 'inet6' ? 'ipv6' : 'ipv4'
}

function addArgs(r: RouteSpec, index: number): string[] {
  const args = [
    'interface',
    contextFor(r.destination),
    'add',
    'route',
    `prefix=${r.destination}`,
    `interface=${index}`
  ]
  if (r.gateway) args.push(`nexthop=${r.gateway}`)
  if (r.metric !== undefined) args.push(`metric=${r.metric}`)
  args.push('store=active')
  return args
}

function deleteArgs(r: RouteSpec, index: number): string[] {
  const args = [
    'interface',
    contextFor(r.destination),
    'delete',
    'route',
    `prefix=${r.destination}`,
    `interface=${index}`
  ]
  if (r.gateway) args.push(`nexthop=${r.gateway}`)
  args.push('store=active')
  return args
}

/** Is this exact prefix already routed on this interface index?
 *
 *  What a failed `add route` has to be judged on here, because the two cheaper
 *  answers are both unavailable on Windows. The command said nothing we can hear
 *  (ShellExecute gives the elevated process no pipes), and its exit status does
 *  not separate "already there" from anything else — netsh returns 1 for every
 *  failure in this context, so reading a collision out of the code would be a
 *  guess dressed as a check.
 *
 *  `netsh … show route` is unprivileged, so this raises no second UAC prompt,
 *  and `parseNetshShowRoute` reads the rows positionally — which is also why
 *  this keeps working on a Windows that does not print "The object already
 *  exists." in English. Exact prefixes, unlike macOS: netsh prints `0.0.0.0/1`
 *  as `0.0.0.0/1`. */
async function routeExistsOn(r: RouteSpec, index: number): Promise<boolean> {
  const res = await readCommand(NETSH, ['interface', contextFor(r.destination), 'show', 'route'])
  if (res.code !== 0) return false
  const family = familyOf(r.destination)
  const want = normalizeCidr(r.destination, family)
  return parseNetshShowRoute(res.stdout, family).some(
    (e) => e.destination === want && e.interfaceIndex === index
  )
}

export class Win32RouteManager implements RouteManager {
  private lastCtx: NetApplyContext | null = null

  async snapshot(): Promise<RouteSnapshot> {
    const [print, indexes] = await Promise.all([
      readCommand(ROUTE, ['print']),
      interfaceIndexes()
    ])
    const table = print.code === 0 ? parseRoutePrint(print.stdout) : []
    return {
      platform: 'win32',
      capturedAt: Date.now(),
      defaults: table.filter(
        (e) => normalizeCidr(e.destination, e.family) === (e.family === 'inet6' ? '::/0' : '0.0.0.0/0')
      ),
      planned: [],
      interfaceIndex: indexes
    }
  }

  /** The index the snapshot recorded is preferred over a fresh lookup: at
   *  revert time the adapter may already be gone, and deleting against the
   *  index it had is still the right call. */
  private async resolveIndex(
    name: string,
    known?: Record<string, number>
  ): Promise<number | null> {
    if (known && known[name] !== undefined) return known[name]
    const fresh = await interfaceIndexes()
    return fresh[name] ?? null
  }

  async apply(routes: RouteSpec[], ctx: NetApplyContext): Promise<void> {
    this.lastCtx = ctx
    const indexes = await interfaceIndexes()
    for (const r of expandDefaultRoutes(routes)) {
      const index = indexes[r.interfaceName]
      if (index === undefined) {
        throw new VpnError(
          'interface-conflict',
          `No network interface named ${r.interfaceName} was found, so ${r.destination} could not be routed.`
        )
      }
      const res = await ctx.runPrivileged(NETSH, addArgs(r, index))
      if (res.code === 0) continue
      const output = commandOutput(res)
      const detail = firstOutputLine(res, `netsh exited ${res.code}`)
      // netsh reports an identical existing route as an object clash; a retry
      // landing on its own earlier route is not a failure. Tested against both
      // streams rather than the displayed line — see `commandOutput`.
      //
      // KNOWN LIMIT: in production this match never fires, and cannot. The
      // elevated netsh is started by `Start-Process -Verb RunAs`, i.e. through
      // ShellExecute, which has no handles to redirect — so `res.stderr` is
      // undefined on every real Windows run and there is nothing to test. It is
      // kept because the check below is a second command and this is free when
      // output does exist: a caller that supplies it (the tests, and any future
      // elevation route that can hear the command — a helper service, a netd
      // sidecar) gets the answer without a round trip. The line that decides this
      // on a real machine is the next one.
      if (/already exists|object already exists/i.test(output)) continue
      if (await routeExistsOn(r, index)) continue
      throw new VpnError(
        classifyEngineLine(output) ?? 'internal',
        `Could not add route ${r.destination} on ${r.interfaceName}: ${detail}`
      )
    }
  }

  async revert(snapshot: RouteSnapshot, ctx?: NetApplyContext): Promise<void> {
    const use = ctx ?? this.lastCtx
    if (!use) return
    for (const r of expandDefaultRoutes(snapshot.planned).reverse()) {
      const index = await this.resolveIndex(r.interfaceName, snapshot.interfaceIndex)
      // Nothing to delete against: the adapter is gone and so are its routes.
      if (index === null) continue
      await use.runPrivileged(NETSH, deleteArgs(r, index)).catch(() => {})
    }
  }

  async conflicts(routes: RouteSpec[]): Promise<RouteConflict[]> {
    const [v4, v6, indexes] = await Promise.all([
      readCommand(NETSH, ['interface', 'ipv4', 'show', 'route']),
      readCommand(NETSH, ['interface', 'ipv6', 'show', 'route']),
      interfaceIndexes()
    ])
    const table = [
      ...parseNetshShowRoute(v4.stdout, 'inet'),
      ...parseNetshShowRoute(v6.stdout, 'inet6')
    ]
    const out = detectPrefixConflicts(routes, table, (spec, entry) => {
      if (normalizeCidr(spec.destination) !== normalizeCidr(entry.destination, entry.family)) return false
      const ours = indexes[spec.interfaceName]
      if (ours === undefined || entry.interfaceIndex === undefined) return false
      return entry.interfaceIndex !== ours
    })
    const defaults = table.filter(
      (e) => normalizeCidr(e.destination, e.family) === (e.family === 'inet6' ? '::/0' : '0.0.0.0/0')
    )
    const leak = detectIpv6Leak(routes, defaults)
    if (leak) out.push(leak)
    return out
  }
}
