import { useCallback, useEffect, useRef, useState } from 'react'
import { Pencil, RotateCw, Terminal as TerminalIcon, X } from 'lucide-react'
import { RECOVERY_BUDGET_MS, type RecoveryState } from '../../hooks/useSessionRecovery'
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
/**
 * What the app is doing while it carries a session across a reboot.
 *
 * Deliberately NOT phrased as "waiting for the server to come back". Nothing
 * here knows that it is coming back — the app cannot see the command that was
 * typed (see the note in useSessionRecovery) and a rebooting host and a dead
 * one are the same silence. So it says what it is doing and what it will do
 * next, which is true either way, and the reason the session ended stays on the
 * card underneath it.
 */
function Recovering({
  transport,
  recovery,
  onCancel
}: {
  transport: TerminalTransport
  recovery: RecoveryState
  onCancel: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="td-title">Reconnecting to {transport.title}</div>
      <div className="td-hint">
        {recovery.nextInSec > 0
          ? `Attempt ${recovery.attempt} in ${recovery.nextInSec}s`
          : `Attempt ${recovery.attempt} — connecting…`}
      </div>
      <div className="td-actions">
        <button className="btn" onClick={onCancel}>
          <X size={14} /> Stop trying
        </button>
      </div>
    </>
  )
}

/**
 * Did this key event come from the terminal, rather than from a control drawn
 * over it?
 *
 * The dead-session card, the find bar and the paste confirmation all live
 * inside `.terminal-wrap`, so a keydown handler on the wrapper sees their keys
 * too — and anything focusable in there owns its own Enter.
 *
 * A POSITIVE test, not a list of things to exclude. Naming the overlays means
 * the next one added inherits the bug silently, and it is the kind of list
 * that is wrong the moment a class is renamed. The terminal is `.xterm-host`
 * and the wrapper itself, which is where focus sits after a click or a drag on
 * the dead scrollback; everything else in here is a control.
 */
function fromTerminalItself(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('.xterm-host') !== null || target.classList.contains('terminal-wrap')
}

function DeadSession({
  dead,
  transport,
  recovery,
  onCancelRecovery,
  onReconnect,
  onClose,
  closeLabel
}: {
  dead: string
  transport: TerminalTransport
  recovery: RecoveryState
  onCancelRecovery: () => void
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

  // While a recovery run is going, the card is about the run: the cause
  // sentence is still true but it is not the news, and the buttons underneath
  // would be three ways to interrupt something already in progress. The reason
  // the session ended stays visible below.
  if (recovery.active) {
    return (
      <div className="term-dead">
        <div className="td-box">
          <Recovering transport={transport} recovery={recovery} onCancel={onCancelRecovery} />
          <div className="td-sub">{transport.subtitle}</div>
          <div className="td-raw mono">{dead}</div>
        </div>
      </div>
    )
  }

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
        {/* Said plainly, and without pretending the host is gone for good: all
            we know is that we stopped. The Reconnect button below still works,
            which is the point of saying so rather than silently going quiet. */}
        {recovery.exhausted && (
          <div className="td-hint">
            {`Tried to reconnect for ${Math.round(RECOVERY_BUDGET_MS / 60_000)} minutes and stopped. `}
            Reconnect is still here whenever you want it.
          </div>
        )}
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

        {/* This used to promise the opposite: "Reconnecting reuses the pooled
            connection when one is still open." That was the app describing an
            optimisation as a feature, and after a reboot it described the bug —
            the pooled socket is the one the server took down, and reusing it is
            how a host that is already back reports itself as still gone.
            Reconnect now drops it first, on every path. */}
        {advice.retry && (
          <div className="td-hint">
            The scrollback above is kept. Reconnecting drops the shared connection first, so it
            never dials on a socket the server may have taken with it.
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
  /**
   * Restored from the last run and not yet dialled.
   *
   * Read from the tab that owns this pane rather than passed down, because a
   * split pane's id is not its tab's id -- `tabId` here is the PANE id, which
   * is what `findRequest` matches on above.
   */
  const dormant = useApp((s) => {
    if (!tabId) return false
    const owner = Object.entries(s.panes).find(([, tp]) =>
      tp.panes.some((p) => p.id === tabId)
    )?.[0]
    return !!s.tabs.find((t) => t.id === (owner ?? tabId))?.dormant
  })
  const wakeTab = useApp((s) => s.wakeTab)

  const { termRef, searchRef, dead, reconnect, recovery, cancelRecovery } = useTerminalSession(
    transport,
    hostRef,
    () => setFinding(true),
    (text, lines) => setPending({ text, lines }),
    tabId,
    dormant
  )

  /**
   * Take the keyboard when this pane becomes the active one.
   *
   * Every tab and pane shortcut in the app was half a shortcut without this.
   * Ctrl+T, Ctrl+Tab, Ctrl+1..9, Ctrl+\ and reopen-closed-tab all moved the
   * selection and left the keyboard nowhere: `.focus()` was called after a
   * paste and after closing the find bar, and in no other place in the
   * renderer. So every one of them ended with the user reaching for the mouse
   * to click into the terminal they had just navigated to, which is the one
   * thing a terminal's keyboard shortcuts exist to avoid.
   *
   * It lives here rather than in PaneGrid or in each runner because this is the
   * component that owns the xterm instance, and because "the active pane holds
   * the keyboard" is one rule -- a focus call in every caller would be the same
   * rule written eight times, and the ninth caller would forget.
   *
   * Only when the pane is genuinely on screen: a pane in a background tab that
   * grabbed focus would steal typing from the tab the user is actually in.
   */
  const isActivePane = useApp((s) => {
    if (!tabId) return false
    const holder = Object.entries(s.panes).find(([, tp]) =>
      tp.panes.some((p) => p.id === tabId)
    )
    if (!holder) return false
    const [holdingTabId, tp] = holder
    return holdingTabId === s.activeTabId && tp.activePaneId === tabId
  })
  useEffect(() => {
    if (!isActivePane || dead) return
    const host = hostRef.current
    if (!host) return

    /**
     * Focus when the pane is ACTUALLY VISIBLE, not when it was told to be.
     *
     * The first version of this asked on the next animation frame and did not
     * work, which is worth writing down: a background tab is hidden by
     * `display: none` on an ancestor, `focus()` on an element inside a hidden
     * subtree is silently a no-op, and a requestAnimationFrame callback runs
     * BEFORE the style and layout pass for that frame -- so at the moment it
     * fired, the pane React had just marked visible frequently still was not.
     * The call succeeded, changed nothing, and reported nothing, which is why
     * switching tabs still left the cursor dead until you clicked.
     *
     * An IntersectionObserver fires after layout, when the element is visible
     * as a fact rather than as an intention. The frame attempt stays because it
     * wins outright in the common case where the pane was already on screen.
     */
    const take = (): void => {
      if (!useApp.getState().tabs.length) return
      termRef.current?.focus()
    }
    const id = requestAnimationFrame(take)
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) take()
    })
    io.observe(host)
    return () => {
      cancelAnimationFrame(id)
      io.disconnect()
    }
  }, [isActivePane, dead, termRef, hostRef])

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

  /**
   * Dial again after the session ended.
   *
   * One function for the card's button and for Enter, rather than the button's
   * inline handler plus a second copy: the scrollback tells the user those are
   * the same action, and two implementations of one promise is how the promise
   * came to be half-true in the first place.
   */
  const reconnectFromDead = useCallback((): void => {
    // Clear the flag first: the tab is awake from here on, so a later drop
    // shows an ordinary reconnect rather than claiming again that it was
    // restored.
    if (dormant && tabId) {
      const owner = Object.entries(useApp.getState().panes).find(([, tp]) =>
        tp.panes.some((p) => p.id === tabId)
      )?.[0]
      wakeTab(owner ?? tabId)
    }
    reconnect()
  }, [dormant, tabId, wakeTab, reconnect])

  return (
    <div
      className="terminal-wrap"
      // Ctrl+wheel zooms, matching every other terminal emulator.
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        zoom(e.deltaY < 0 ? 1 : -1)
      }}
      /* Somebody at the keyboard outranks the countdown. Reaching for the
         terminal while it is waiting to dial means they have their own plan —
         reading the scrollback, closing the tab, fixing the server — and a
         reconnect firing underneath that is the app arguing with its user.
         Tab and the bare modifiers are excluded: moving focus between the
         card's own buttons is not a decision about the session. */
      onKeyDown={(e) => {
        /* THE SCROLLBACK PROMISES THIS, so it has to be true wherever focus is.
           "Press Enter to reconnect in this tab." was written into the dead
           session's own output, and nothing implemented it: Enter worked only
           because the card's Reconnect button is autoFocus'd, so a focused
           button activated on Enter. Click the error text to read it — the
           dead terminal is deliberately still selectable — and focus moved
           into xterm, where Enter was written to a closed session and vanished.
           Nothing ever put focus back; the focus effect refuses to while dead.
           That is the whole of "it works sometimes".

           Handled here rather than by re-focusing the button, because this
           catches the xterm case too: React's synthetic keydown sees the event
           bubbling out of the terminal's own textarea.

           AND THAT REACH IS WHY IT NEEDS A TARGET CHECK. The wrapper contains
           the whole dead card and the find bar, so an unguarded version stole
           Enter from every control inside it. The worst case is a rejected
           credential: `auth` advice is `{retry: false, edit: true}`, so there
           is no Reconnect button at all, "Edit connection" is the autofocused
           one, and Enter on it would `preventDefault()` the button's own
           activation and silently reconnect instead — offering the action the
           advice table exists to say is known not to work. Same theft for the
           Close button, the vault-unlock button, and Enter in the find bar,
           which is reachable while dead precisely because the card advertises
           that the scrollback is kept. */
        if (dead && e.key === 'Enter' && !recovery.active && fromTerminalItself(e.target)) {
          e.preventDefault()
          reconnectFromDead()
          return
        }
        if (!recovery.active) return
        if (['Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
        cancelRecovery()
      }}
    >
      <div className="xterm-host" ref={hostRef} />
      {dead && (
        <DeadSession
          dead={dead}
          transport={transport}
          recovery={recovery}
          onCancelRecovery={cancelRecovery}
          onReconnect={reconnectFromDead}
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
