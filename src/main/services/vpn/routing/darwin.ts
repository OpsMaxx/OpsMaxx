import { classifyEngineLine, firstOutputLine, VpnError } from '../errors'
import { readCommand } from '../netstate'
import type { NetApplyContext } from '../netstate'
import {
  commandOutput,
  detectIpv6Leak,
  expandDefaultRoutes,
  familyOf,
  isDefaultRoute,
  normalizeCidr
} from './index'
import type { RouteConflict, RouteEntry, RouteManager, RouteSnapshot, RouteSpec } from './index'

// macOS routing through route(8). `netstat -rn` is not used: it prints
// classful abbreviations ("127" for 127.0.0.0/8) that cannot be turned back
// into a prefix without guessing, whereas `route -n get` answers the only
// question worth asking — which route would actually be taken for this
// destination, and over what.

const ROUTE = 'route'

/** `route -n get` prints `key: value` per line. Everything we need is one of
 *  destination, gateway or interface; the rest (flags, expire, recvpipe) is
 *  noise for this purpose. */
export function parseRouteGet(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (key && value && !(key in out)) out[key] = value
  }
  return out
}

function toEntry(fields: Record<string, string>, family: 'inet' | 'inet6'): RouteEntry | null {
  const destination = fields.destination
  if (!destination) return null
  return {
    destination,
    gateway: fields.gateway,
    interfaceName: fields.interface,
    family
  }
}

async function routeGet(destination: string, family: 'inet' | 'inet6'): Promise<RouteEntry | null> {
  const args = family === 'inet6' ? ['-n', 'get', '-inet6', destination] : ['-n', 'get', destination]
  const res = await readCommand(ROUTE, args)
  // "route: writing to routing socket: not in table" is the normal answer for
  // a host with no default of that family, not a failure.
  if (res.code !== 0 || /not in table|no route to host/i.test(res.stdout + res.stderr)) return null
  return toEntry(parseRouteGet(res.stdout), family)
}

function addArgs(r: RouteSpec): string[] {
  const args = ['-n', 'add']
  if (familyOf(r.destination) === 'inet6') args.push('-inet6')
  args.push('-net', r.destination)
  // A gateway and an interface are alternatives on macOS, and the interface
  // form is what a point-to-point tunnel device needs — there is no next hop
  // on a utun.
  if (r.gateway) args.push(r.gateway)
  else args.push('-interface', r.interfaceName)
  return args
}

function deleteArgs(r: RouteSpec): string[] {
  const args = ['-n', 'delete']
  if (familyOf(r.destination) === 'inet6') args.push('-inet6')
  args.push('-net', r.destination)
  if (r.gateway) args.push(r.gateway)
  else args.push('-interface', r.interfaceName)
  return args
}

export class DarwinRouteManager implements RouteManager {
  private lastCtx: NetApplyContext | null = null

  async snapshot(): Promise<RouteSnapshot> {
    const [v4, v6] = await Promise.all([routeGet('default', 'inet'), routeGet('default', 'inet6')])
    return {
      platform: 'darwin',
      capturedAt: Date.now(),
      defaults: [v4, v6].filter((e): e is RouteEntry => e !== null),
      planned: []
    }
  }

  async apply(routes: RouteSpec[], ctx: NetApplyContext): Promise<void> {
    this.lastCtx = ctx
    for (const r of expandDefaultRoutes(routes)) {
      const res = await ctx.runPrivileged(ROUTE, addArgs(r))
      if (res.code === 0) continue
      const output = commandOutput(res)
      const detail = firstOutputLine(res, `route exited ${res.code}`)
      // Re-applying an identical route is how a retry looks, and it is not a
      // failure worth tearing the tunnel down for. Tested against both streams,
      // not against the one line shown to the user — see `commandOutput`.
      if (/file exists/i.test(output)) continue
      // …and then from the table, because that text is not guaranteed to arrive.
      // `route` runs under `osascript … with administrator privileges`, and what
      // comes back is AppleScript's report of the failure; whether its message is
      // the command's own stderr under the admin variant is unverified (see
      // `parseOsascriptFailure`). The match above is the cheap path, this is the
      // one that holds when there is nothing to match.
      if (await this.alreadyOurs(r)) continue
      throw new VpnError(
        classifyEngineLine(output) ?? 'internal',
        `Could not add route ${r.destination} on ${r.interfaceName}: ${detail}`
      )
    }
  }

  /** Does this destination already leave over our own interface?
   *
   *  The question a failed `route add` actually needs answered. `route -n get`
   *  is a lookup rather than a table dump — it reports the route that would be
   *  taken — which is what makes this work for the `/1` halves of a full tunnel,
   *  where the table prints `destination: default` for both and the prefix
   *  cannot be matched literally.
   *
   *  A broader route of ours covering the prefix counts as a yes, and is meant
   *  to: the point of the route that would not add is that this destination goes
   *  through the tunnel, and it does. An unprivileged read, so it raises no
   *  second password prompt, and `readCommand` never throws. */
  private async alreadyOurs(r: RouteSpec): Promise<boolean> {
    const entry = await routeGet(r.destination, familyOf(r.destination))
    return entry?.interfaceName === r.interfaceName
  }

  async revert(snapshot: RouteSnapshot, ctx?: NetApplyContext): Promise<void> {
    const use = ctx ?? this.lastCtx
    if (!use) return
    // Reverse order so a more specific route goes before whatever it was
    // layered on top of.
    for (const r of expandDefaultRoutes(snapshot.planned).reverse()) {
      // Every delete is best effort: after a kill -9 the interface is already
      // gone and the kernel took its routes with it.
      await use.runPrivileged(ROUTE, deleteArgs(r)).catch(() => {})
    }
    await this.restoreDefaults(snapshot, use)
  }

  /** The /1 split means the original default was never removed, so this is
   *  insurance rather than the mechanism — but a default that went missing
   *  while we were up is exactly the state a user cannot recover from alone. */
  private async restoreDefaults(snapshot: RouteSnapshot, ctx: NetApplyContext): Promise<void> {
    for (const d of snapshot.defaults) {
      if (!d.gateway || normalizeCidr(d.destination, d.family) !== (d.family === 'inet6' ? '::/0' : '0.0.0.0/0')) continue
      if (await routeGet('default', d.family)) continue
      const args = ['-n', 'add']
      if (d.family === 'inet6') args.push('-inet6')
      args.push('default', d.gateway)
      await ctx.runPrivileged(ROUTE, args).catch(() => {})
    }
  }

  async conflicts(routes: RouteSpec[]): Promise<RouteConflict[]> {
    const out: RouteConflict[] = []
    const seen = new Set<string>()
    for (const spec of expandDefaultRoutes(routes)) {
      const family = familyOf(spec.destination)
      const entry = await routeGet(spec.destination, family)
      if (!entry || !entry.interfaceName) continue
      if (entry.interfaceName === spec.interfaceName) continue
      // A `default` answer means nothing more specific claims this prefix,
      // which is the ordinary case for every route we are about to add.
      const answersDefault = entry.destination.trim().toLowerCase() === 'default'
      if (answersDefault && !isDefaultRoute(spec.destination)) continue
      if (seen.has(spec.destination)) continue
      seen.add(spec.destination)
      out.push({
        kind: 'prefix-claimed',
        destination: spec.destination,
        existing: { ...entry, destination: spec.destination },
        message: `${spec.destination} is already routed ${entry.gateway ? `via ${entry.gateway} ` : ''}on ${entry.interfaceName}.`
      })
    }

    const snap = await this.snapshot()
    const leak = detectIpv6Leak(routes, snap.defaults)
    if (leak) out.push(leak)
    return out
  }
}
