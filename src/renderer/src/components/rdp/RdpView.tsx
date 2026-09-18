import { useEffect, useRef, useState } from 'react'
import { KeyRound, Monitor, RotateCw } from 'lucide-react'
import type { Server } from '../../types'
import { clsx } from '../../lib/format'
import { bridgeHas } from '../../lib/bridge'

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
/**
 * What `connect` hands back. `run` is the session, not a formality.
 *
 * `connect()` performs the handshake and then RETURNS a `run` function rather
 * than calling it: inside the component it is `async () => { await
 * session.run() }`, and until something awaits it the protocol is never pumped.
 * This was typed as `Promise<unknown>` and the result discarded, so every
 * desktop connected — TLS, CredSSP and all — and then showed a black screen
 * while the server streamed updates nobody read. The canvas was the right size,
 * the socket was busy, and no error was ever raised, because nothing had gone
 * wrong; nothing had been started.
 */
interface RdpSession {
  sessionId: number
  initialDesktopSize: { width: number; height: number }
  /** Resolves when the session ends, rejects if it ends badly. Long-lived. */
  run(): Promise<unknown>
}

interface UserInteraction {
  configBuilder(): ConfigBuilder
  connect(config: unknown): Promise<RdpSession>
  shutdown(): void
  ctrlAltDel(): void
  resize(width: number, height: number, scale?: number): void
}

/**
 * The size to ask the server for, from the space the pane actually has.
 *
 * Without this the component's own canvas default — 800x600 — is what gets
 * negotiated, and `scale="fit"` then stretches that over whatever the pane is.
 * The desktop is legible but soft, and every dialog is laid out for a screen
 * nobody is looking at.
 *
 * Widths are rounded down to a multiple of 4: several RDP codecs encode in
 * 4-pixel tiles, and a width that is not a multiple of one is a well-worn
 * source of a green or torn right-hand column.
 */
function desktopSizeOf(el: HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect()
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, Math.floor(v)))
  // The floor is what a pane that has not been laid out yet collapses to; the
  // ceiling keeps a maximised window on a very large display from asking for a
  // desktop the server will refuse.
  return {
    width: clamp(rect.width, 640, 4096) & ~3,
    height: clamp(rect.height, 480, 2160) & ~3
  }
}

interface ConfigBuilder {
  withUsername(v: string): ConfigBuilder
  withPassword(v: string): ConfigBuilder
  withDestination(v: string): ConfigBuilder
  withProxyAddress(v: string): ConfigBuilder
  withServerDomain(v: string): ConfigBuilder
  withAuthToken(v: string): ConfigBuilder
  withExtension(ext: unknown): ConfigBuilder
  withDesktopSize(size: { width: number; height: number }): ConfigBuilder
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
    const raw =
      'backtrace' in err && typeof err.backtrace === 'function'
        ? (err as { backtrace: () => string }).backtrace()
        : ''
    // The client is Rust compiled in CI, so its backtrace carries the build
    // machine's absolute paths — "[CredSSP @ /home/runner/work/IronRDP/...]".
    // That tells the reader nothing and crowds out the part that does.
    const backtrace = raw.replace(/\s*@\s*\/\S+/g, '')

    // 0xc000006d is the one worth translating, because the sentence above is
    // true of several causes and this narrows it to one the user can act on.
    // A local account often has to be named `.\name` and a domain one
    // `DOMAIN\name`; a bare username is the usual reason a password that is
    // demonstrably correct is still refused.
    const hint = backtrace.includes('STATUS_LOGON_FAILURE')
      ? ' The username or password was refused. For a local account try .\\name, and for a domain account DOMAIN\\name.'
      : ''
    return backtrace ? `${base}${hint} (${backtrace})` : `${base}${hint}`
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
    let cleanupResize: (() => void) | null = null
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

        /**
         * LOADING THE BACKEND IS NOT STARTING IT.
         *
         * `init()` is what instantiates the WebAssembly module; everything else
         * the backend exports reaches through `wasm.__wbindgen_malloc`, which
         * does not exist until it resolves. Importing the module and handing it
         * straight to the element therefore failed with "Cannot read properties
         * of undefined (reading '__wbindgen_malloc')" on the first desktop
         * anyone opened — a sentence that names an internal of a dependency and
         * tells the user nothing at all. <iron-remote-desktop> does not call
         * this for us: it stores `module` and logs "Web bridge initialized".
         */
        await backend.init('WARN')
        if (disposed) return

        element = document.createElement('iron-remote-desktop')
        /**
         * `Backend`, not the module namespace.
         *
         * A property rather than an attribute, because it is an object — but it
         * is a specific one. The element does `new this.module.SessionBuilder()`
         * and reads DesktopSize, InputTransaction, ClipboardData and DeviceEvent
         * off the same object, and those five are exactly what the package's
         * `Backend` export holds. The namespace does not carry them at the top
         * level, so handing it over got as far as connecting and then failed
         * with "this.module.SessionBuilder is not a constructor".
         *
         * Everything else this file calls — init, enableCredssp — stays on the
         * namespace, which is where the package exports those.
         */
        ;(element as unknown as { module: unknown }).module = backend.Backend
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
        // Guarded rather than optional-chained: under `electron-vite dev` the
        // renderer hot-reloads while the process keeps the preload bundle it
        // booted with, so a newly added namespace is undefined for the rest of
        // that session. Reaching through it throws "cannot read properties of
        // undefined", which describes the symptom and not the fix.
        if (!bridgeHas(window.opsmaxx?.rdp as Record<string, unknown> | undefined, 'ticket')) {
          setError(
            'The remote desktop bridge is not available in this session. Restart the app to rebuild the preload script.'
          )
          setPhase('failed')
          return
        }
        // Main resolves the host, the account and the credential from the saved
        // record; this passes a server id and gets back what to connect with.
        const result = await window.opsmaxx.rdp.ticket(server.id)
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
          .withDesktopSize(desktopSizeOf(host))
          .withExtension(backend.enableCredssp(ticket.nla))

        // Only when the target actually needs Kerberos: the renderer has no
        // ticket cache, so without a KKDCP proxy a Kerberos-only host is
        // unreachable — but adding an empty one to every session is a way to
        // break NTLM logins that work.
        if (ticket.kdcProxyUrl) config.withExtension(backend.kdcProxyUrl(ticket.kdcProxyUrl))

        const session = await ui.connect(config.build())
        if (disposed) return
        setPhase('connected')

        // THE SESSION HAS TO BE RUN. Connecting only gets as far as a server
        // that is willing to talk; `run()` is the loop that reads its updates
        // and paints them. Not awaited here, because it resolves when the
        // session ENDS — awaiting it would stall this effect for the life of
        // the desktop and never reach the resize observer below.
        void session
          .run()
          .then(() => {
            // A session that ends on its own: the user signed out, or the
            // server hung up. Not an error, and not something to leave looking
            // live either.
            if (!disposed) {
              setError('The remote desktop session ended.')
              setPhase('failed')
            }
          })
          .catch((err: unknown) => {
            if (!disposed) {
              setError(describeError(err))
              setPhase('failed')
            }
          })

        // Follow the pane from here on. Debounced because a window drag emits a
        // resize per frame and each one is a round trip to the server, which
        // reallocates its framebuffer; a desktop that renegotiated sixty times
        // a second would spend the drag redrawing rather than resizing.
        let debounce: ReturnType<typeof setTimeout> | undefined
        const observer = new ResizeObserver(() => {
          clearTimeout(debounce)
          debounce = setTimeout(() => {
            if (disposed) return
            const next = desktopSizeOf(host)
            try {
              ui.resize(next.width, next.height)
            } catch {
              // A session that died between the observation and the call has
              // already surfaced its own failure; resizing it is not a second
              // thing to report.
            }
          }, 250)
        })
        observer.observe(host)
        cleanupResize = () => {
          clearTimeout(debounce)
          observer.disconnect()
        }
      } catch (err) {
        if (disposed) return
        // The WASM client's own message first, then the relay's reason if it
        // has one. The client can only report the RDCleanPath error PDU, which
        // is an integer and an HTTP status, so on its own it says "general
        // error (code 1); HTTP 502 bad gateway" whether the certificate was
        // refused, the server was deleted, or the machine simply has no remote
        // desktop service running. The second sentence is the one that tells
        // you where to go next.
        // THE SESSION'S OWN ANSWER FIRST.
        //
        // This used to lead with the relay's reason and put the client's in
        // brackets behind it, which read fine while the relay's reason was the
        // specific one. Then a host connected over a fallback key exchange and
        // every later failure on it opened with a sentence about TLS — so a
        // refused password arrived as a parenthetical inside a note about
        // certificates. Whatever the client says is what happened just now.
        //
        // The relay's reason follows, for the failures the client can only
        // describe as a 502. The advisory is last: it is not why this failed.
        const [reason, advisory] = await Promise.all([
          window.opsmaxx?.rdp.lastError(server.id).catch(() => null) ?? null,
          window.opsmaxx?.rdp.advisory(server.id).catch(() => null) ?? null
        ])
        if (disposed) return
        setError([describeError(err), reason, advisory].filter(Boolean).join(' '))
        setPhase('failed')
      }
    }

    void run()

    return () => {
      disposed = true
      cleanupResize?.()
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
