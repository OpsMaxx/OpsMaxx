import { useEffect, useState } from 'react'
import { Activity, Radio } from 'lucide-react'
import { useApp, useWorkspaceServers } from '../../store/app'
import { LOCAL_TARGET } from '../../../../shared/execTarget'
import { sshTargetFor } from '../../lib/ssh'
import { useT } from '../../lib/i18n'
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
  const t = useT()
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
        setFailure(t('monitor.netTools.notProbeable'))
        return
      }

      const target = source === 'local' ? LOCAL_TARGET : server ? sshTargetFor(server) : null
      if (!target) {
        setFailure(t('monitor.netTools.chooseSource'))
        return
      }

      // Traceroute is slow by nature — twenty hops with a two-second wait each.
      const timeoutMs = tool === 'ping' ? 30_000 : 90_000
      const r = await window.opsmaxx?.netTools?.run(target as never, command, timeoutMs)
      if (!r) {
        setFailure(t('monitor.netTools.noBridge'))
        return
      }
      const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
      // `ok: false` means the command could not be RUN — unreachable target, no
      // shell. A ping that reports 100% loss ran perfectly well and is a result,
      // not a failure, which is why this checks the transport and not the exit
      // code.
      if (!r.ok && !text.trim()) {
        setFailure(r.error ?? t('monitor.netTools.couldNotRun'))
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
          <h1>{t('modules.netTools.label')}</h1>
          <div className="sub">{t('monitor.netTools.sub')}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 180 }}>
            <span className="field-label">{t('monitor.netTools.runFrom')}</span>
            <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              {localAllowed && <option value="local">{t('monitor.common.thisMachine')}</option>}
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field" style={{ minWidth: 120 }}>
            <span className="field-label">{t('monitor.netTools.tool')}</span>
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
            <span className="field-label">{t('monitor.netTools.host')}</span>
            <input
              className="input"
              placeholder={t('monitor.netTools.hostPlaceholder')}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
              }}
            />
          </label>

          <button className="btn primary" disabled={!valid || busy} onClick={() => void run()}>
            <Radio size={14} /> {busy ? t('monitor.netTools.running') : t('monitor.netTools.run')}
          </button>
        </div>
        {host.trim() !== '' && !valid && (
          // Said as soon as it is true, rather than on submit: the button is
          // already disabled, and a disabled button with no reason is a puzzle.
          <span className="field-hint">
            {t('monitor.netTools.hostHint')}
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
              <div className="ft-label">{t('monitor.netTools.reachable')}</div>
              <div className="ft-value">{ping.reachable ? t('common.yes') : t('common.no')}</div>
            </div>
            <div>
              <div className="ft-label">{t('monitor.netTools.packetLoss')}</div>
              <div className="ft-value">{ping.loss}%</div>
            </div>
            {ping.avgMs !== undefined && (
              <div>
                <div className="ft-label">{t('monitor.netTools.average')}</div>
                <div className="ft-value">{ping.avgMs.toFixed(1)} ms</div>
              </div>
            )}
            {ping.minMs !== undefined && ping.maxMs !== undefined && (
              <div>
                <div className="ft-label">{t('monitor.netTools.range')}</div>
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
            {t('monitor.netTools.routeTo', { host })}
          </div>
          <div className="col" style={{ gap: 3 }}>
            {hops.length === 0 && <span className="faint">{t('monitor.netTools.noHops')}</span>}
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
                  {h.timedOut
                    ? t('monitor.netTools.noReply')
                    : h.timesMs.map((ms) => `${ms} ms`).join('  ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
