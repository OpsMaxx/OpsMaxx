import { useEffect, useState } from 'react'
import { Activity, Radio } from 'lucide-react'
import { useApp, useWorkspaceServers } from '../../store/app'
import { LOCAL_TARGET } from '../../../../shared/execTarget'
import { sshTargetFor } from '../../lib/ssh'
import {
  buildPingCommand,
  buildTracerouteCommand,
  isProbeableHost,
  parsePing,
  parseTraceroute,
  type NetToolPlatform,
  type PingResult,
  type TraceHop
} from '../../../../shared/netTools'

/**
 * ping and traceroute, run FROM a target rather than from here.
 *
 * That is the whole point of putting them in this app rather than opening a
 * terminal: "can this server reach that service" is a different question from
 * "can my laptop reach it", and it is the one an operator actually has. So the
 * source is a picker — this machine, or any server in the workspace — and the
 * command goes down the same exec path every other read uses.
 *
 * The host is user input going into a command line. It is validated in
 * shared/netTools.ts and the command is never built at all for a host that does
 * not pass; the button below is disabled on the same predicate, so the refusal
 * is visible before it is enforced.
 */

type Tool = 'ping' | 'traceroute'

export function NetToolsPanel(): React.JSX.Element {
  const servers = useWorkspaceServers()
  const localAllowed = useApp((s) => s.settings.localTerminalEnabled !== false)

  const [source, setSource] = useState<string>(localAllowed ? 'local' : (servers[0]?.id ?? ''))
  const [host, setHost] = useState('')
  const [tool, setTool] = useState<Tool>('ping')
  const [busy, setBusy] = useState(false)
  const [ping, setPing] = useState<PingResult | null>(null)
  const [hops, setHops] = useState<TraceHop[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * This machine's platform, asked for once.
   *
   * The bridge answers asynchronously, and the command's flags depend on it —
   * `-c` versus `-n`. Linux until the answer arrives, which is the right guess
   * for a server and harmless here because the local option cannot be run
   * before the component has mounted.
   */
  const [localPlatform, setLocalPlatform] = useState<NetToolPlatform>('linux')
  useEffect(() => {
    let live = true
    void window.opsmaxx?.platform?.().then((p) => {
      if (live) setLocalPlatform(p === 'win32' ? 'win32' : p === 'darwin' ? 'darwin' : 'linux')
    })
    return () => {
      live = false
    }
  }, [])

  const server = servers.find((s) => s.id === source)
  const valid = isProbeableHost(host)

  /**
   * Which platform's flags to build for.
   *
   * The TARGET's platform, not this machine's: `-c` versus `-n` is decided by
   * where the command runs. A server's stored `os` is what the app knows, and
   * an unknown one falls back to the Linux form, which is what the overwhelming
   * majority of servers are.
   */
  const platform: NetToolPlatform =
    source === 'local'
      ? localPlatform
      : server?.os === 'windows'
        ? 'win32'
        : server?.os === 'macos'
          ? 'darwin'
          : 'linux'

  const run = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    setPing(null)
    setHops(null)
    setFailure(null)
    try {
      const command =
        tool === 'ping'
          ? buildPingCommand(host, platform, { count: 4 })
          : buildTracerouteCommand(host, platform)
      // Null means the host did not pass validation. The button is disabled on
      // the same predicate, so reaching here would be a bug rather than input.
      if (!command) {
        setFailure('That is not a host this can probe.')
        return
      }

      const target = source === 'local' ? LOCAL_TARGET : server ? sshTargetFor(server) : null
      if (!target) {
        setFailure('Choose where to run this from.')
        return
      }

      // Traceroute is slow by nature — twenty hops with a two-second wait each.
      const timeoutMs = tool === 'ping' ? 30_000 : 90_000
      const r = await window.opsmaxx?.netTools?.run(target as never, command, timeoutMs)
      if (!r) {
        setFailure('This build of the bridge cannot run network tools.')
        return
      }
      const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
      // `ok: false` means the command could not be RUN — unreachable target, no
      // shell. A ping that reports 100% loss ran perfectly well and is a result,
      // not a failure, which is why this checks the transport and not the exit
      // code.
      if (!r.ok && !text.trim()) {
        setFailure(r.error ?? 'The command could not be run.')
        return
      }
      if (tool === 'ping') setPing(parsePing(text))
      else setHops(parseTraceroute(text))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="content">
      <div className="content-header">
        <div>
          <h1>Network tools</h1>
          <div className="sub">Run ping and traceroute from this machine or from a server</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 180 }}>
            <span className="field-label">Run from</span>
            <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              {localAllowed && <option value="local">This machine</option>}
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field" style={{ minWidth: 120 }}>
            <span className="field-label">Tool</span>
            <select
              className="input"
              value={tool}
              onChange={(e) => setTool(e.target.value as Tool)}
            >
              <option value="ping">ping</option>
              <option value="traceroute">traceroute</option>
            </select>
          </label>

          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span className="field-label">Host</span>
            <input
              className="input"
              placeholder="example.com or 10.0.0.1"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
              }}
            />
          </label>

          <button className="btn primary" disabled={!valid || busy} onClick={() => void run()}>
            <Radio size={14} /> {busy ? 'Running…' : 'Run'}
          </button>
        </div>
        {host.trim() !== '' && !valid && (
          // Said as soon as it is true, rather than on submit: the button is
          // already disabled, and a disabled button with no reason is a puzzle.
          <span className="field-hint">
            Enter a hostname or an IP address. Anything else is refused before a
            command is built.
          </span>
        )}
      </div>

      {failure && (
        <div className="card" style={{ marginBottom: 16 }}>
          <span className="faint">{failure}</span>
        </div>
      )}

      {ping && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'baseline' }}>
            <Activity size={14} className="faint" />
            <span className="sidebar-title">{host}</span>
            {ping.resolvedIp && ping.resolvedIp !== host && (
              <span className="mono faint" style={{ fontSize: 11 }}>
                {ping.resolvedIp}
              </span>
            )}
          </div>
          <div className="info-grid">
            <div>
              <div className="ft-label">Reachable</div>
              <div className="ft-value">{ping.reachable ? 'Yes' : 'No'}</div>
            </div>
            <div>
              <div className="ft-label">Packet loss</div>
              <div className="ft-value">{ping.loss}%</div>
            </div>
            {ping.avgMs !== undefined && (
              <div>
                <div className="ft-label">Average</div>
                <div className="ft-value">{ping.avgMs.toFixed(1)} ms</div>
              </div>
            )}
            {ping.minMs !== undefined && ping.maxMs !== undefined && (
              <div>
                <div className="ft-label">Range</div>
                <div className="ft-value">
                  {ping.minMs.toFixed(1)}–{ping.maxMs.toFixed(1)} ms
                </div>
              </div>
            )}
          </div>
          {/* The reason, when there is one. "0 received" alone sends people to
              look at the network when the answer is usually right here. */}
          {ping.error && (
            <span className="faint" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
              {ping.error}
            </span>
          )}
        </div>
      )}

      {hops && (
        <div className="card">
          <div className="sidebar-title" style={{ marginBottom: 10 }}>
            Route to {host}
          </div>
          <div className="col" style={{ gap: 3 }}>
            {hops.length === 0 && <span className="faint">No hops were reported.</span>}
            {hops.map((h) => (
              <div key={h.hop} className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                <span className="mono faint" style={{ minWidth: 26, textAlign: 'right' }}>
                  {h.hop}
                </span>
                <span className="mono selectable" style={{ minWidth: 170 }}>
                  {/* An asterisk, as every traceroute prints it: this hop did
                      not answer, which is common and is not an error. */}
                  {h.host ?? '*'}
                </span>
                <span className="faint" style={{ fontSize: 11 }}>
                  {h.timedOut ? 'no reply' : h.timesMs.map((t) => `${t} ms`).join('  ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
