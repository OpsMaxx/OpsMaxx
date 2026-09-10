import { useEffect, useRef, useState } from 'react'
import { Pencil, RotateCw, Terminal as TerminalIcon, X } from 'lucide-react'
import { credentialNote, type CredentialShape } from '../../../../shared/credentialShape'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import { TerminalSearch } from './TerminalSearch'
import { PasteConfirm } from './PasteConfirm'
import { EmptyState } from '../common/EmptyState'
import { useApp } from '../../store/app'
import {
  createTerm,
  observeSize,
  setupTerminalUX,
  useTerminalSession
} from '../../hooks/useTerminalSession'
import { adviseOnError, classifyConnectionError } from '../../lib/connectionError'
import { clsx } from '../../lib/format'
import type { TerminalTransport } from '../../lib/transport'
import type { Server } from '../../types'

// ---- Simulated demo shell --------------------------------------------------
const MOCK: Record<string, string> = {
  ls: 'app  config  docker-compose.yml  logs  node_modules  package.json  src',
  uname: 'Linux',
  date: 'Live shell — connect a backend to run real commands',
  help: 'Simulated shell. Try: ls, pwd, whoami, uptime, echo <text>, clear'
}

function useDemoSession(server: Server, hostRef: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (!hostRef.current) return
    const { term, fit } = createTerm(
      hostRef.current,
      useApp.getState().settings.terminalFontSize,
      useApp.getState().settings.terminalScheme,
      useApp.getState().settings.terminalCustomSchemes
    )
    const disposeUX = setupTerminalUX(term, hostRef.current)
    const user = server.username
    const short = server.name.toLowerCase().split(' ')[0]
    const home = `/home/${user}`
    const prompt = (): void => term.write(`\r\n\x1b[32m${user}@${short}\x1b[0m:\x1b[34m~\x1b[0m$ `)

    term.writeln('\x1b[38;5;80mOpsMaxx\x1b[0m — simulated session')
    term.writeln(`Connected to \x1b[1m${server.name}\x1b[0m (${server.host}) · ${server.os}`)
    if (server.route.length) {
      term.writeln(`\x1b[90mvia ${server.route.map((h) => h.label).join(' -> ')}\x1b[0m`)
    }
    term.writeln('\x1b[90mType "help" for available commands.\x1b[0m')
    prompt()

    let line = ''
    const run = (cmd: string): void => {
      const [c, ...rest] = cmd.split(' ')
      if (c === '') return
      if (c === 'clear') return term.clear()
      if (c === 'echo') return void term.write(`\r\n${rest.join(' ')}`)
      if (c === 'whoami') return void term.write(`\r\n${user}`)
      if (c === 'pwd') return void term.write(`\r\n${home}`)
      if (c === 'uptime')
        return void term.write('\r\n 14:22:01 up 18 days,  4:21,  1 user,  load average: 0.24, 0.19, 0.14')
      if (c in MOCK) return void term.write(`\r\n${MOCK[c]}`)
      term.write(`\r\n\x1b[31m${c}: command not found\x1b[0m`)
    }

    const onInput = term.onData((data) => {
      for (const ch of data) {
        const code = ch.charCodeAt(0)
        if (ch === '\r') {
          run(line.trim())
          line = ''
          prompt()
        } else if (code === 127) {
          if (line.length) {
            line = line.slice(0, -1)
            term.write('\b \b')
          }
        } else if (code === 3) {
          term.write('^C')
          line = ''
          prompt()
        } else if (code >= 32) {
          line += ch
          term.write(ch)
        }
      }
    })

    const host = hostRef.current
    const disposeSize = observeSize(fit, host)

    return () => {
      onInput.dispose()
      disposeSize()
      disposeUX()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id])
}

function DemoTerminal({ server }: { server: Server }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useDemoSession(server, hostRef)
  return (
    <div className="terminal-wrap">
      <div className="xterm-host" ref={hostRef} />
    </div>
  )
}

// The failure card.
//
// It used to print the raw driver string as its title and offer Reconnect and
// nothing else, so an unreachable host, a wrong port, a wrong username and a
// rejected key were one sentence with one button — and the button was the one
// action that cannot fix three of the four. The hint underneath then reassured
// the reader that reconnecting "usually skips authentication", which is
// precisely the wrong thing to say when authentication is the suspect.
//
// The classifier in lib/connectionError.ts already knew the difference. This is
// the surface finally asking it.
function DeadSession({
  dead,
  transport,
  onReconnect,
  onClose,
  closeLabel
}: {
  dead: string
  transport: TerminalTransport
  onReconnect: () => void
  onClose?: () => void
  closeLabel?: string
}): React.JSX.Element {
  const openServerEditor = useApp((s) => s.openServerEditor)
  const advice = adviseOnError(dead)
  const fault = classifyConnectionError(dead)
  const serverId = transport.serverId

  /**
   * What OpsMaxx actually offered, for an authentication failure.
   *
   * "All configured authentication methods failed" is the SERVER's sentence,
   * and it reads identically whether a key was rejected or no credential was
   * ever stored. The app knows which, and not saying so is how a missing
   * credential gets reported as "the private key mechanism is not working".
   *
   * Asked for only on an auth failure, because on any other kind there is
   * nothing to add and it would be a pointless round trip.
   */
  const [credential, setCredential] = useState<CredentialShape | null>(null)
  useEffect(() => {
    if (fault !== 'auth' || !serverId) {
      setCredential(null)
      return
    }
    let live = true
    void window.opsmaxx?.ssh
      ?.credentialShape?.(serverId)
      .then((s) => {
        if (live) setCredential(s ?? null)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [fault, serverId])
  const note = credentialNote(credential)

  return (
    <div className="term-dead">
      <div className="td-box">
        {/* The cause leads. The driver's own words are kept below rather than
            dropped: they are what a person pastes into a search when our
            sentence is not enough, and for `unknown` they are the only real
            information on the card. */}
        <div className="td-title">{advice.cause}</div>
        <div className="td-sub">{transport.subtitle}</div>
        <div className="td-raw mono">{dead}</div>
        {advice.hint && <div className="td-hint">{advice.hint}</div>}
        {/* What we offered, which the server's own message cannot tell them. */}
        {note && <div className="td-hint td-credential">{note}</div>}
        {/* And where the answer is "unlock the vault", the unlock is here.
            This note used to end with "Unlock it and try again" and offer no
            way to — the exact dead end this sweep is about. Reconnect is
            offered with it, because unlocking is only useful if the thing you
            were trying to do can then happen. */}
        {credential?.kind === 'vault' && credential.vaultLocked === true && (
          <div className="td-actions">
            <UnlockVaultButton
              className="btn primary"
              reason={`${transport.subtitle} signs in with a credential from your vault.`}
              onUnlocked={onReconnect}
              label="Unlock and reconnect"
            />
          </div>
        )}

        <div className="td-actions">
          {/* Offered only when it can work. A Reconnect on a rejected
              credential re-runs the same rejected credential, forever. */}
          {advice.retry && (
            <button className="btn primary" autoFocus onClick={onReconnect}>
              <RotateCw size={14} /> Reconnect
            </button>
          )}
          {advice.edit && serverId && (
            <button
              className={clsx('btn', !advice.retry && 'primary')}
              autoFocus={!advice.retry}
              onClick={() => openServerEditor(serverId)}
            >
              <Pencil size={14} /> Edit connection
            </button>
          )}
          {/* Neither applies — a changed host key, or an OS refusal. Retrying
              is still allowed, it is just not the thing being recommended. */}
          {!advice.retry && !(advice.edit && serverId) && (
            <button className="btn" onClick={onReconnect}>
              <RotateCw size={14} /> Try again
            </button>
          )}
          {/* Giving up is an outcome too, and until now the only way to act on
              it was the tab strip — the `×` PaneGrid draws over a pane appears
              only when there is a sibling to distinguish it from, so a single
              failed pane offered Reconnect or nothing.

              Deliberately not autoFocus'd: Reconnect and Edit already compete
              for it, and Enter on a dead session is documented as reconnect.
              The label says which container goes, because "Close" over a split
              is ambiguous in the one place ambiguity costs the other pane. */}
          {onClose && (
            <button className="btn" onClick={onClose}>
              <X size={14} /> {closeLabel ?? 'Close'}
            </button>
          )}
        </div>

        {/* Only where it is true. Reconnecting reuses a pooled connection, which
            is worth knowing when the failure was transport-level and actively
            misleading when it was not. */}
        {advice.retry && (
          <div className="td-hint">
            The scrollback above is kept. Reconnecting reuses the pooled connection when one is
            still open.
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Real session ----------------------------------------------------------
function RealTerminal({
  transport,
  tabId,
  onClose,
  closeLabel
}: {
  transport: TerminalTransport
  tabId?: string
  onClose?: () => void
  closeLabel?: string
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const zoom = useApp((s) => s.zoomTerminal)
  const [finding, setFinding] = useState(false)

  /**
   * The toolbar's magnifier, which used to be a button with no onClick.
   *
   * Search worked only from the keyboard, so the one affordance pointing at
   * it did nothing — and a control that does nothing reads as a broken
   * feature rather than a missing binding. Reported as "search and filter not
   * working".
   *
   * Watched on the nonce so asking twice for the same pane is two events:
   * pressing the magnifier while the bar is already open re-focuses and
   * re-selects it, the way every editor's find does.
   */
  const findRequest = useApp((s) => s.findRequest)
  useEffect(() => {
    if (!findRequest || !tabId || findRequest.paneId !== tabId) return
    setFinding(true)
  }, [findRequest, tabId])
  const [pending, setPending] = useState<{ text: string; lines: number } | null>(null)
  const { termRef, searchRef, dead, reconnect } = useTerminalSession(
    transport,
    hostRef,
    () => setFinding(true),
    (text, lines) => setPending({ text, lines }),
    tabId
  )

  /**
   * A shell that exited cleanly closes what held it.
   *
   * `exit` is how somebody says they are finished, and answering it with a
   * card that has to be dismissed makes the ordinary end of a session into a
   * two-step one. Every terminal emulator closes on a clean exit; this one
   * left a panel saying the session had closed, which the user could already
   * see, over a terminal they had deliberately ended.
   *
   * ONLY on a clean exit. `classifyConnectionError` tells `shell exited` from
   * `shell exited with 3` and from every genuine failure, and those keep the
   * card — a pane that vanished when a connection dropped would take the
   * reason with it, which is the one moment the reason matters most.
   *
   * Off makes the card the answer for every ending, for anyone who wants the
   * scrollback to survive the shell.
   */
  const closeOnExit = useApp((s) => s.settings.closeTabOnShellExit !== false)
  useEffect(() => {
    if (!dead || !onClose || !closeOnExit) return
    if (classifyConnectionError(dead) !== 'exited') return
    onClose()
  }, [dead, onClose, closeOnExit])

  return (
    <div
      className="terminal-wrap"
      // Ctrl+wheel zooms, matching every other terminal emulator.
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        zoom(e.deltaY < 0 ? 1 : -1)
      }}
    >
      <div className="xterm-host" ref={hostRef} />
      {dead && (
        <DeadSession
          dead={dead}
          transport={transport}
          onReconnect={reconnect}
          onClose={onClose}
          closeLabel={closeLabel}
        />
      )}
      {pending && (
        <PasteConfirm
          text={pending.text}
          lines={pending.lines}
          server={transport.title}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            termRef.current?.paste(pending.text)
            setPending(null)
            termRef.current?.focus()
          }}
        />
      )}
      {finding && (
        <TerminalSearch
          search={searchRef}
          // Re-focus and re-select when asked again while already open.
          focusNonce={findRequest?.nonce}
          // What iTerm does: a selection becomes the thing you are looking
          // for, so selecting an error and hitting find needs no retyping.
          seed={termRef.current?.getSelection() || undefined}
          onClose={() => {
            setFinding(false)
            termRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

// A terminal is either driven by a transport (SSH or a local pty — this
// component does not care which) or, for a demo server, by the simulated
// shell. Callers that have a real target must pass a transport: an SSH tab
// with no transport is a bug in the caller, not a demo session.
export function TerminalView({
  transport,
  server,
  tabId,
  onClose,
  closeLabel
}: {
  transport?: TerminalTransport
  // Only for the demo path, which is still keyed on a Server.
  server?: Server
  tabId?: string
  /**
   * Dismisses whatever holds this terminal — the pane when it has a sibling,
   * the tab when it is alone. PaneGrid decides which, because it is the only
   * place that knows both ids and the pane count; see the note there.
   *
   * Optional because the demo and empty paths have nothing to dismiss.
   */
  onClose?: () => void
  closeLabel?: string
}): React.JSX.Element {
  if (transport)
    return (
      <RealTerminal
        transport={transport}
        tabId={tabId}
        onClose={onClose}
        closeLabel={closeLabel}
      />
    )
  if (server && server.demo !== false) return <DemoTerminal server={server} />
  return (
    <EmptyState
      icon={<TerminalIcon size={26} />}
      title="Session unavailable"
      message="This session has no transport."
    />
  )
}
