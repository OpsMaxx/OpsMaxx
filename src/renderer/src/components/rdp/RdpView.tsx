import { useEffect, useRef, useState } from 'react'
import { KeyRound, Monitor, RotateCw } from 'lucide-react'
import type { Server } from '../../types'
import { clsx } from '../../lib/format'

// A remote desktop, drawn by the IronRDP WebAssembly client into a canvas
// owned by the <iron-remote-desktop> web component.
//
// Why the web component rather than driving the WASM SessionBuilder directly:
// the builder takes raw scancodes, and turning a browser KeyboardEvent into
// PS/2 Set 1 is a lookup table with a long tail of layout and lock-key
// behaviour that is wrong in ways nobody notices until someone types a
// backslash on a German keyboard. The component owns that table, plus pointer
// capture, clipboard and scaling, and it is the surface Devolutions maintains.
// What is left here is what is actually ours: when to load it, how a session is
// authorised, and what a failure says.
//
// Why both modules are imported lazily: the RDP backend is 5.8 MB, because the
// WASM binary is inlined into it as a data: URI. Importing it at module scope
// would put that in the renderer's initial chunk for every user, including the
// overwhelming majority who never open a desktop.

/** The `detail` of the component's `ready` event. */
interface ReadyDetail {
  irgUserInteraction: UserInteraction
}

// Structurally what this file uses, rather than the package's full type: the
// modules are loaded at runtime by dynamic import, and a static type import
// from a lazily-loaded package would defeat the code splitting it exists for.
interface UserInteraction {
  configBuilder(): ConfigBuilder
  connect(config: unknown): Promise<unknown>
  shutdown(): void
  ctrlAltDel(): void
  resize(width: number, height: number, scale?: number): void
}

interface ConfigBuilder {
  withUsername(v: string): ConfigBuilder
  withPassword(v: string): ConfigBuilder
  withDestination(v: string): ConfigBuilder
  withProxyAddress(v: string): ConfigBuilder
  withServerDomain(v: string): ConfigBuilder
  withAuthToken(v: string): ConfigBuilder
  withExtension(ext: unknown): ConfigBuilder
  build(): unknown
}

/**
 * `IronErrorKind` from the client, whose numbering is part of its API.
 *
 * Restated rather than imported for the same reason as the interfaces above,
 * and mapped to sentences here because the raw kinds are the difference between
 * "it didn't work" and knowing whether to fix the password or the account.
 */
const ERROR_KIND: Record<number, string> = {
  0: 'The connection failed.',
  1: 'The password was rejected.',
  2: 'That account could not log on to this machine.',
  3: 'That account is not allowed to connect over RDP. It usually needs to be in Remote Desktop Users.',
  4: 'The connection to the local RDP relay failed.',
  5: 'The local RDP relay could not reach the server.',
  6: 'The server refused the security settings offered. If it requires Network Level Authentication, turn NLA on for this server.'
}

function describeError(err: unknown): string {
  // The client throws an IronError, not an Error: it has no `message`, and its
  // useful content sits behind methods.
  if (err && typeof err === 'object' && 'kind' in err && typeof err.kind === 'function') {
    const kind = (err as { kind: () => number }).kind()
    const base = ERROR_KIND[kind] ?? ERROR_KIND[0]
    const backtrace =
      'backtrace' in err && typeof err.backtrace === 'function'
        ? (err as { backtrace: () => string }).backtrace()
        : ''
    return backtrace ? `${base} (${backtrace})` : base
  }
  if (err instanceof Error) return err.message
  return String(err)
}

type Phase = 'idle' | 'loading' | 'connecting' | 'connected' | 'failed'

export function RdpView({
  server,
  visible
}: {
  server: Server
  /**
   * Tabs stay mounted so sessions survive, so the *first* time a tab is shown
   * is what starts the session. A background tab must not silently open a
   * desktop the user never asked to look at, and an already-running one must
   * not be torn down when they switch away.
   */
  visible: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const uiRef = useRef<UserInteraction | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  // Bumped by Reconnect. Re-running the effect is the whole teardown-and-retry:
  // the cleanup shuts the old session down before the new one is built.
  const [attempt, setAttempt] = useState(0)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    if (visible) setStarted(true)
  }, [visible])

  useEffect(() => {
    if (!started) return
    const host = hostRef.current
    if (!host) return

    // Set before the first await so a teardown during module loading is seen.
    let disposed = false
    setPhase('loading')
    setError(null)

    const run = async (): Promise<void> => {
      let element: HTMLElement
      try {
        // Order matters: the component registers itself as a custom element on
        // import, and it needs the backend module before it initialises.
        const [, backend] = await Promise.all([
          import('@devolutions/iron-remote-desktop'),
          import('@devolutions/iron-remote-desktop-rdp')
        ])
        if (disposed) return

        element = document.createElement('iron-remote-desktop')
        // A property, not an attribute: it is a module object.
        ;(element as unknown as { module: unknown }).module = backend
        element.setAttribute('scale', 'fit')
        element.setAttribute('flexcenter', 'true')
        element.style.cssText = 'flex:1; min-height:0; display:block'

        const ready = new Promise<UserInteraction>((resolve) => {
          element.addEventListener(
            'ready',
            (e) => resolve((e as CustomEvent<ReadyDetail>).detail.irgUserInteraction),
            { once: true }
          )
        })
        host.appendChild(element)
        const ui = await ready
        if (disposed) {
          ui.shutdown()
          return
        }
        uiRef.current = ui

        setPhase('connecting')
        // Main resolves the host, the account and the credential from the saved
        // record; this passes a server id and gets back what to connect with.
        const result = await window.opsmaxx?.rdp.ticket(server.id)
        if (disposed) return
        if (!result?.ok || !result.ticket) {
          setError(result?.error ?? 'The remote desktop bridge is unavailable.')
          setPhase('failed')
          return
        }
        const ticket = result.ticket

        const config = ui
          .configBuilder()
          .withUsername(ticket.username)
          .withPassword(ticket.password)
          .withDestination(ticket.destination)
          .withProxyAddress(ticket.proxyUrl)
          .withAuthToken(ticket.token)
          .withServerDomain(ticket.domain ?? '')
          .withExtension(backend.enableCredssp(ticket.nla))

        // Only when the target actually needs Kerberos: the renderer has no
        // ticket cache, so without a KKDCP proxy a Kerberos-only host is
        // unreachable — but adding an empty one to every session is a way to
        // break NTLM logins that work.
        if (ticket.kdcProxyUrl) config.withExtension(backend.kdcProxyUrl(ticket.kdcProxyUrl))

        await ui.connect(config.build())
        if (disposed) return
        setPhase('connected')
      } catch (err) {
        if (disposed) return
        setError(describeError(err))
        setPhase('failed')
      }
    }

    void run()

    return () => {
      disposed = true
      try {
        uiRef.current?.shutdown()
      } catch {
        // A session that failed before connecting has nothing to shut down,
        // and an unmount must not throw on the way out.
      }
      uiRef.current = null
      // The component is created here rather than rendered by React, so it is
      // removed here too. Leaving it would leak a canvas and its WASM instance
      // for every closed tab.
      host.replaceChildren()
    }
  }, [started, attempt, server.id])

  const retry = (): void => {
    setAttempt((n) => n + 1)
  }

  return (
    <div className="rdp-view">
      {/* This tab has no viewbar — there is only one view — so the two controls
          a desktop cannot do without live here. Ctrl+Alt+Del in particular:
          the browser keeps that combination for itself, so a session with no
          button for it cannot reach the Windows security screen at all. */}
      <div className="viewbar">
        <span className="server-meta mono">
          {server.username}@{server.host}:{server.rdp?.port ?? 3389}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn"
          title="Send Ctrl+Alt+Del"
          disabled={phase !== 'connected'}
          onClick={() => uiRef.current?.ctrlAltDel()}
        >
          <KeyRound size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Reconnect"
          disabled={phase === 'loading' || phase === 'connecting'}
          onClick={retry}
        >
          <RotateCw size={15} />
        </button>
      </div>
      <div ref={hostRef} className={clsx('rdp-surface', phase !== 'connected' && 'rdp-busy')} />
      {phase !== 'connected' && (
        <div className="rdp-overlay">
          <Monitor size={26} />
          {phase === 'failed' ? (
            <>
              <div className="rdp-overlay-title">Could not open the desktop</div>
              <div className="rdp-overlay-msg">{error}</div>
              <button type="button" className="btn" onClick={retry}>
                <RotateCw size={14} /> Reconnect
              </button>
            </>
          ) : (
            <div className="rdp-overlay-msg">
              {phase === 'idle'
                ? 'Ready.'
                : phase === 'loading'
                  ? 'Loading the remote desktop client…'
                  : `Connecting to ${server.name}…`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
