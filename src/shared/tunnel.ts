import type { SshHop } from './ssh'

export type TunnelKind = 'local' | 'remote' | 'socks'

export interface TunnelConfig {
  id: string
  kind: TunnelKind
  // Where the listener is opened. For `local`/`socks` this is on this machine;
  // for `remote` it is on the SSH server.
  listenHost: string
  listenPort: number
  // Where traffic is delivered. Unused for `socks`, which takes the
  // destination from each SOCKS request.
  targetHost: string
  targetPort: number
}

export interface TunnelSshConfig extends SshHop {
  serverId?: string
  hops?: SshHop[]
}

export type TunnelState = 'starting' | 'active' | 'error' | 'stopped'

export interface TunnelStatus {
  id: string
  state: TunnelState
  error?: string
  // Live count of proxied connections, shown in the UI.
  connections: number
  // Actual bound port — differs from the request when 0 was passed.
  listenPort?: number
}

export interface TunnelResult {
  ok: boolean
  error?: string
  listenPort?: number
}

// "127.0.0.1:5432" -> { host, port }. Accepts a bare port and bracketed IPv6.
export function parseEndpoint(text: string, defaultHost = '127.0.0.1'): { host: string; port: number } {
  const s = text.trim()
  if (/^\d+$/.test(s)) return { host: defaultHost, port: Number(s) }
  const v6 = /^\[(.+)\]:(\d+)$/.exec(s)
  if (v6) return { host: v6[1], port: Number(v6[2]) }
  const i = s.lastIndexOf(':')
  if (i === -1) return { host: s || defaultHost, port: 0 }
  return { host: s.slice(0, i) || defaultHost, port: Number(s.slice(i + 1)) || 0 }
}

// ---------------------------------------------------------------------------
// DEFAULT LISTEN ADDRESS PER KIND
// ---------------------------------------------------------------------------
//
// The three kinds have three conventional ports, and the form used to move
// between them one way only:
//
//     onClick={() => { setKind(k); if (k === 'socks') setListen('127.0.0.1:1080') }}
//
// So local → socks swapped 8080 for 1080, and socks → local left 1080 sitting
// in the field. The saved record then read "Local forward · 127.0.0.1:1080",
// which collides with any real SOCKS proxy on that port and shows a config the
// user never chose. The type toggle changed the visible fields and not the
// values behind them.
//
// Blanking on every switch would be the other bug: somebody who typed
// `127.0.0.1:15432` because 5432 is taken loses it by clicking a type button to
// re-read the label. So the rule is narrower and matches how the rest of this
// codebase treats a user edit — it is intent on record and outranks a default.
// A field still holding SOME kind's default is untouched and gets swapped; a
// field holding anything else was typed, and is left exactly alone.
export const TUNNEL_DEFAULT_LISTEN: Record<TunnelKind, string> = {
  local: '127.0.0.1:8080',
  // A remote forward listens ON THE SERVER, and 0.0.0.0 there would publish it
  // to that server's whole network. Loopback is the safe default and the one
  // sshd allows without GatewayPorts.
  remote: '127.0.0.1:8080',
  socks: '127.0.0.1:1080'
}

const DEFAULTS = Object.values(TUNNEL_DEFAULT_LISTEN)

/** True when the field still holds a default nobody has edited. */
export function isDefaultListen(listen: string): boolean {
  return DEFAULTS.includes(listen.trim())
}

/**
 * The listen address after switching to `next`.
 *
 * Returns `current` unchanged when the user has typed their own value, which is
 * the whole point — see the note above.
 */
export function listenForKind(current: string, next: TunnelKind): string {
  return isDefaultListen(current) ? TUNNEL_DEFAULT_LISTEN[next] : current
}
