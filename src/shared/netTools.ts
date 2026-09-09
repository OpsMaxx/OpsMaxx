// ping and traceroute: the command for a host, and the parser for its output.
//
// Pure and platform-parameterised so both are testable without a network. The
// caller says which platform the TARGET is, because these run wherever the
// exec function points — this machine, or a server over SSH — and the flags
// differ in ways that matter (`-c` vs `-n`, `-W` in seconds vs milliseconds).
//
// ── The rule that shapes this whole file ───────────────────────────────────
//
// The host is user input and it is going into a shell command. Nothing here
// interpolates it without checking it first: `buildPingCommand` refuses
// anything that is not a hostname or an IP literal, and refuses it by returning
// null rather than by escaping, because an allowlist of what a hostname may
// contain is knowable and an escaping scheme for every shell is not.

/** A host or IPv4/IPv6 literal. Deliberately strict — see the header. */
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/
const IPV6 = /^[0-9A-Fa-f:]{2,45}$/

export function isProbeableHost(host: string): boolean {
  const h = host.trim()
  if (!h || h.length > 253) return false
  // An IPv6 literal is all hex and colons; anything else must look like a name
  // or a dotted address, both of which HOSTNAME covers.
  return HOSTNAME.test(h) || (h.includes(':') && IPV6.test(h))
}

export type NetToolPlatform = 'linux' | 'darwin' | 'win32'

export interface PingOptions {
  /** How many echo requests. Clamped: this runs on someone's server. */
  count?: number
  /** Per-probe timeout, in seconds. */
  timeoutSec?: number
}

/**
 * `ping`, with the count flag the platform actually uses.
 *
 * Windows counts with `-n` and takes its timeout in MILLISECONDS; the Unixes
 * count with `-c`. macOS has no `-W` for the whole run in the way Linux does,
 * so the deadline is applied per probe there and the overall bound comes from
 * the caller's exec timeout instead.
 *
 * Returns null for a host that is not a plausible host, which is the refusal
 * that keeps user input out of a command line.
 */
export function buildPingCommand(
  host: string,
  platform: NetToolPlatform,
  opts: PingOptions = {}
): string | null {
  if (!isProbeableHost(host)) return null
  const count = Math.min(Math.max(Math.trunc(opts.count ?? 4), 1), 20)
  const timeout = Math.min(Math.max(Math.trunc(opts.timeoutSec ?? 2), 1), 30)
  const h = host.trim()

  if (platform === 'win32') return `ping -n ${count} -w ${timeout * 1000} ${h}`
  if (platform === 'darwin') return `ping -c ${count} -W ${timeout * 1000} ${h}`
  // Linux: -W is seconds, and -w bounds the whole run so a black-holed host
  // cannot hold the connection open for count × timeout.
  return `ping -c ${count} -W ${timeout} -w ${count * timeout} ${h}`
}

/**
 * `traceroute`, or `tracert` on Windows.
 *
 * `-n` everywhere: reverse DNS for every hop is most of the wall-clock time and
 * none of the answer. `-q 1` on Unix sends one probe per hop rather than three,
 * for the same reason — this is a UI control someone is waiting on.
 */
export function buildTracerouteCommand(
  host: string,
  platform: NetToolPlatform,
  maxHops = 20
): string | null {
  if (!isProbeableHost(host)) return null
  const hops = Math.min(Math.max(Math.trunc(maxHops), 1), 40)
  const h = host.trim()
  if (platform === 'win32') return `tracert -d -h ${hops} ${h}`
  // `-w 2` bounds each hop's wait; without it an unresponsive hop stalls the
  // whole trace for five seconds per probe.
  return `traceroute -n -q 1 -w 2 -m ${hops} ${h} 2>&1`
}

export interface PingResult {
  /** Whether anything came back at all. */
  reachable: boolean
  transmitted: number
  received: number
  /** Percent, 0-100. */
  loss: number
  minMs?: number
  avgMs?: number
  maxMs?: number
  /** The address the name resolved to, when the tool said. */
  resolvedIp?: string
  /** What went wrong, when nothing came back. */
  error?: string
}

const NUM = String.raw`\d+(?:\.\d+)?`

/**
 * Parse ping output from any of the three platforms.
 *
 * They agree on almost nothing: the summary line is "4 packets transmitted, 4
 * received, 0% packet loss" on Linux, "…4 packets received…" on macOS, and a
 * "Packets: Sent = 4, Received = 4, Lost = 0" table on Windows. The timing line
 * is `rtt min/avg/max/mdev` on Linux, `round-trip min/avg/max/stddev` on macOS,
 * and "Minimum = 1ms, Maximum = 3ms, Average = 2ms" on Windows.
 */
export function parsePing(output: string): PingResult {
  const text = output.replace(/\r/g, '')

  // Windows first: its shape is unambiguous and does not collide with the others.
  const win = /Sent = (\d+), Received = (\d+)/i.exec(text)
  if (win) {
    const transmitted = Number(win[1])
    const received = Number(win[2])
    const t = /Minimum = (\d+)ms, Maximum = (\d+)ms, Average = (\d+)ms/i.exec(text)
    return {
      reachable: received > 0,
      transmitted,
      received,
      loss: transmitted ? Math.round(((transmitted - received) / transmitted) * 100) : 100,
      minMs: t ? Number(t[1]) : undefined,
      maxMs: t ? Number(t[2]) : undefined,
      avgMs: t ? Number(t[3]) : undefined,
      resolvedIp: /Pinging \S+ \[([^\]]+)\]/i.exec(text)?.[1],
      error: received === 0 ? firstProblem(text) : undefined
    }
  }

  const summary = new RegExp(String.raw`(\d+) packets transmitted,\s*(\d+)( packets)? received`).exec(
    text
  )
  const transmitted = summary ? Number(summary[1]) : 0
  const received = summary ? Number(summary[2]) : 0

  const timing = new RegExp(
    String.raw`(?:rtt|round-trip)[^=]*=\s*(${NUM})/(${NUM})/(${NUM})`
  ).exec(text)

  // `PING host (1.2.3.4)` on both Unixes.
  const resolved = /^PING\s+\S+\s+\(([^)]+)\)/m.exec(text)?.[1]

  return {
    reachable: received > 0,
    transmitted,
    received,
    loss: transmitted ? Math.round(((transmitted - received) / transmitted) * 100) : 100,
    minMs: timing ? Number(timing[1]) : undefined,
    avgMs: timing ? Number(timing[2]) : undefined,
    maxMs: timing ? Number(timing[3]) : undefined,
    resolvedIp: resolved,
    error: received === 0 ? firstProblem(text) : undefined
  }
}

/**
 * The first line that reads like a reason, for a ping that got nothing back.
 *
 * "0 received" alone sends someone to look at the network when the answer is
 * frequently sitting in the output — an unknown host, no route, a permissions
 * refusal on a container without CAP_NET_RAW.
 */
function firstProblem(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) =>
      /unknown host|cannot resolve|Name or service not known|Network is unreachable|No route to host|Operation not permitted|could not find host|Request timed out|Destination .* unreachable/i.test(
        l
      )
    )
  return line || undefined
}

export interface TraceHop {
  /** Hop number, as the tool numbered it. */
  hop: number
  /** Absent for a hop that did not answer. */
  host?: string
  /** Round-trip times reported for this hop, in ms. */
  timesMs: number[]
  /** True when every probe for this hop timed out. */
  timedOut: boolean
}

/**
 * Parse traceroute / tracert output.
 *
 * The two formats differ enough to be worth saying: Unix is
 * `1  10.0.0.1  1.234 ms`, Windows is `1     1 ms     1 ms     1 ms  10.0.0.1`
 * with the address LAST. Both use `*` for a probe that did not answer.
 */
export function parseTraceroute(output: string): TraceHop[] {
  const hops: TraceHop[] = []
  for (const raw of output.replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    // A hop line starts with its number. Headers ("traceroute to …", "Tracing
    // route to …") do not.
    const m = /^(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const hop = Number(m[1])
    const rest = m[2]

    const timesMs = [...rest.matchAll(new RegExp(String.raw`(${NUM})\s*ms`, 'g'))].map((x) =>
      Number(x[1])
    )

    /**
     * The address, from either layout.
     *
     * Unix puts it immediately after the hop number; Windows puts it at the end
     * of the line. Taking "the first token that is not a time and not a `*`"
     * finds it on Unix, and the trailing-token check catches Windows — where
     * every leading token IS a time.
     */
    let host: string | undefined
    const tokens = rest.split(/\s+/).filter(Boolean)
    for (const tok of tokens) {
      if (tok === '*' || tok === 'ms' || /^[<>]?\d+(\.\d+)?$/.test(tok)) continue
      if (/^[A-Za-z0-9._:-]+$/.test(tok) && !/^ms$/i.test(tok)) {
        host = tok
        break
      }
    }
    // Windows: the address is last, and the loop above would have found nothing
    // because every earlier token is a number or `ms`.
    if (!host) {
      const last = tokens[tokens.length - 1]
      if (last && last !== '*' && /^[A-Za-z0-9._:-]+$/.test(last)) host = last
    }

    hops.push({ hop, host, timesMs, timedOut: timesMs.length === 0 })
  }
  return hops
}
