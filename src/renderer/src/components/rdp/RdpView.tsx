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
  /**
   * Show the surface. The component never does this for us.
   *
   * It renders into a canvas that starts `visibility: hidden` and translated
   * off-screen, and the only call it makes to this itself is `false`, in the
   * `finally` when a session ends. `setVisibility` is on the object it hands
   * the embedder precisely because turning it ON is the embedder's job.
   *
   * Without it a session connects, runs and paints a complete desktop into a
   * surface nobody can see. Measured on a live session: the canvas held a
   * Windows desktop, 800,038 of its 800,128 pixels non-black, at (-688, -677).
   */
  setVisibility(visible: boolean): void
  /** `fit`, `full` or `real`. Re-asserting `fit` is how a resize that the
   *  server ignores stops leaving the desktop stretched — see the resize. */
  setScale(scale: string): void
}

/**
 * The size to ask the server for, from the space the pane actually has.
 *
 * Without this the component's own canvas default — 800x600 — is what gets
 * negotiated, and `scale="fit"` then stretches that over whatever the pane is.
 * The desktop is legible but soft, and every dialog is laid out for a screen
 * nobody is looking at.
 *
 * Width is rounded down to an EVEN number, and height is not rounded at all.
 *
 * It used to round both down to a multiple of four, on the usual story about
 * codecs encoding in 4-pixel tiles and a ragged edge producing a green or torn
 * right-hand column. That story is inherited folklore: it comes from
 * uncompressed bitmap rows being DWORD-aligned and from old FreeRDP and xrdp
 * breakage, which is encoder-side padding rather than a constraint on the
 * desktop size, and RemoteFX works in 64x64 tiles with a clipping region that
 * handles ragged edges by design.
 *
 * What the rounding did cost is real. `fit` scales by
 * min(availWidth / canvas.width, availHeight / canvas.height), so a canvas up
 * to three pixels narrower than its pane is resampled by about 1.002 — the
 * whole desktop bilinearly filtered, every session, for nothing. Even width
 * cuts that to at most one pixel, and to exactly zero whenever the pane's width
 * is a whole number, which on a maximised window it usually is.
 *
 * Even width is kept because MS-RDPEDISP states it for MONITOR_LAYOUT.Width,
 * and MS-RDPEDISP is the channel `ui.resize` actually drives — so that is the
 * one place a violation would be on the wire. Marked as reasoned rather than
 * verified: it could not be confirmed against IronRDP, whose wasm is inlined as
 * a base64 data URI and has no greppable strings. Height has no such rule.
 *
 * MEASURED IN CSS PIXELS, WHICH MEANS HALF RESOLUTION ON A RETINA DISPLAY, and
 * that is a known, deliberate omission rather than an oversight. On a dpr-2
 * screen a 1500x900 pane negotiates a 1500x900 desktop, which the compositor
 * then rasterises across 3000x1800 device pixels: every glyph upsampled 2x.
 * Multiplying by devicePixelRatio here is what fixes it, and `scale="fit"`
 * does scale the larger canvas back down to the pane, so it genuinely sharpens
 * rather than letterboxes.
 *
 * It is not done because the multiply alone is not the whole change and the
 * rest is not verifiable from here:
 *
 *  - Windows would render a 2x desktop at 100% DPI, so every control comes out
 *    half its physical size. The companion is a DesktopScaleFactor passed as
 *    the third argument to resize(), which the component forwards untouched to
 *    the session. Nothing in the package's types or source states its units or
 *    its accepted values, and MS-RDPEDISP ignores an invalid scale pair
 *    wholesale, so this needs proving against a real host before it is trusted.
 *  - A server with no Microsoft::Windows::RDS::DisplayControl -- xrdp, or
 *    anything pre-2012R2 -- ignores the resize AND the scale factor. There the
 *    change is not a trade-off but a regression with no way back: a sharp
 *    desktop permanently at half size.
 *  - Twice the linear resolution is four times the pixels to encode, send and
 *    decode. Free on a LAN, not free on a WAN.
 *  - A 2x multiply meets the 4096 ceiling below on any large display.
 *
 * So it wants a live test against a host known to support display control, and
 * a fallback for hosts that do not, which is a change of its own rather than a
 * line in this function.
 */
function desktopSizeOf(el: HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect()
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, Math.floor(v)))
  // The floor is what a pane that has not been laid out yet collapses to; the
  // ceiling keeps a maximised window on a very large display from asking for a
  // desktop the server will refuse.
  return {
    width: clamp(rect.width, 640, 4096) & ~1,
    height: clamp(rect.height, 480, 2160)
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
  /** Something true about a session that WORKED — shown while it runs, not
   *  after it fails. Currently only the no-forward-secrecy fallback. */
  const [notice, setNotice] = useState<string | null>(null)
  /** The session ran and finished, rather than never starting. Only the title
   *  differs, but "could not open" about a desktop that opened is a lie. */
  const [ended, setEnded] = useState(false)
  // Bumped by Reconnect. Re-running the effect is the whole teardown-and-retry:
  // the cleanup shuts the old session down before the new one is built.
  const [attempt, setAttempt] = useState(0)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    if (visible) setStarted(true)
  }, [visible])

  /**
   * Take keyboard focus, once there is something focusable to take it.
   *
   * The component forwards keys only while it is `document.activeElement`, and
   * the only thing that ever sets that is its own `mouseenter` handler — a
   * click cannot, because it preventDefault()s every mousedown and so kills the
   * browser's focus-on-click. `mouseenter` is an edge, so a pointer already
   * resting over the pane when the desktop appears never crosses it and the
   * session is keyboard-dead for good.
   *
   * WHY THIS IS AN EFFECT AND NOT A LINE AFTER setVisibility(true), which is
   * where it was first written and did nothing at all. At that instant two
   * `visibility: hidden` layers are still applied: the component's own
   * `.screen-wrapper.hidden`, which it drops on a Svelte microtask, and
   * `.rdp-busy`, which React removes only once this phase change commits.
   * Chromium refuses to focus a hidden element and reports nothing — the same
   * shape as every other bug in this component, where the step you skipped
   * looks exactly like a step you took.
   *
   * requestAnimationFrame rather than the effect body alone, because React's
   * commit and the component's microtask are two independent clocks and this
   * has to be after both. It also covers returning to a tab that was
   * `display: none`, where the same no-op applies.
   */
  /**
   * Let go of held keys when this tab stops being the visible one.
   *
   * The component releases held input on exactly three events: window blur,
   * visibilitychange, and mouseleave on the canvas. Switching OpsMaxx tabs is
   * none of them — WorkspacePanel sets `display: none`, which blurs the host
   * without any window-level event at all, while the OS window keeps focus.
   *
   * So: hold Ctrl, press a digit to switch workspace, and the Ctrl keydown was
   * forwarded but the keyup is dropped by the capture gate, because by then the
   * component is no longer activeElement. The remote holds Ctrl down for ever
   * and every later keystroke arrives as a chord. Nothing recovers it; even
   * mouseleave will not fire if the pointer never moves.
   *
   * `releaseAllInputs` is not on the object the component hands the embedder —
   * the twenty entries of getExposedFunctions are the whole surface — so the
   * only way to reach it is the component's own window-blur listener. That
   * handler does one thing, `a.focusLost()`, and capture is recomputed from
   * document.activeElement on every keystroke rather than latched, so a
   * synthetic blur cannot leave it stuck off: the focus effect above restores
   * it on the way back.
   *
   * The one thing this cannot prove is that no third-party library in the
   * renderer listens for window blur. Nothing in src/renderer/src does, and the
   * editors here bind to their own elements, but a dependency could.
   */
  useEffect(() => {
    if (visible || phase !== 'connected') return
    window.dispatchEvent(new Event('blur'))
  }, [visible, phase])

  useEffect(() => {
    if (!visible || phase !== 'connected') return
    const id = requestAnimationFrame(() => {
      const el = hostRef.current?.firstElementChild as HTMLElement | null
      el?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(id)
  }, [visible, phase])

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
        if (disposed) {
          // SHUT IT DOWN HERE, because the cleanup below could not.
          //
          // The effect's teardown calls `uiRef.current?.shutdown()`, and the
          // component's shutdown is `this.session?.shutdown()` with `session`
          // assigned only once connect() resolves. So a tab closed WHILE
          // connecting ran a teardown that did nothing, and then this line
          // returned from a session that was by then fully established: a live
          // WebSocket to the relay, a TLS connection to the host, and the SSH
          // chain to any bastion behind it, all with nothing holding a
          // reference to close them. Sixteen of those and every later desktop
          // is refused for "too many remote desktops are already open" with
          // none on screen.
          //
          // It also means CredSSP completed — the password went to the machine
          // — for a desktop the user had already closed.
          try {
            ui.shutdown()
          } catch {
            /* Best effort: a half-built session has nothing to close, and
               throwing here would lose the return that stops this effect. */
          }
          return
        }

        // Before the phase flips, so the surface is showing by the time the
        // overlay stops covering it. See setVisibility on the interface: the
        // component starts hidden and only ever hides itself again.
        ui.setVisibility(true)
        setPhase('connected')

        // Focus is taken in an effect below, once React has committed and the
        // component has dropped its own hidden class. Doing it here looked
        // right and did nothing: see the effect for why.

        // A session that CONNECTED can still have something worth saying: the
        // commonest is that this host's certificate forced a key exchange with
        // no forward secrecy. That advisory was only ever read in the catch
        // below, so on the path where it actually applies -- a successful
        // connection -- it was never shown, and instead surfaced later glued to
        // the next unrelated failure on that server. The justification for the
        // fallback is that the downgrade is visible; this is what makes it so.
        void window.opsmaxx?.rdp
          .advisory(server.id)
          .then((note) => {
            if (!disposed) setNotice(note ?? null)
          })
          .catch(() => {
            /* A missing advisory is the normal case, not a failure. */
          })

        // Releasing a session that has ENDED, which nothing used to do: the
        // client kept whatever it still held -- including its WebSocket to the
        // relay -- until the tab was closed or Reconnect was pressed. Wrapped,
        // because shutdown() is a call into WASM and the unmount path will run
        // it a second time on a session that is already consumed.
        const closeSession = (): void => {
          try {
            uiRef.current?.shutdown()
          } catch {
            /* already gone */
          }
        }

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
              closeSession()
              setEnded(true)
              setError('The remote desktop session ended.')
              setPhase('failed')
            }
          })
          .catch((err: unknown) => {
            if (!disposed) {
              closeSession()
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
            // A HIDDEN TAB IS NOT A RESIZE.
            //
            // Inactive tabs are `display: none`, so the observer fires with a
            // 0x0 rect the moment the user switches away. desktopSizeOf then
            // clamps that up to its 640x480 floor and this sent a real
            // MS-RDPEDISP renegotiation: every window on the remote desktop
            // crushed into 640x480 and the icons rearranged. Switching back
            // renegotiates the size up again, and Windows does not put the
            // layout back — so half a second on another tab permanently
            // rearranged the user's desktop.
            //
            // The floor in desktopSizeOf was papering over exactly this, which
            // is why it describes "a pane that has not been laid out yet".
            const rect = host.getBoundingClientRect()
            if (!rect.width || !rect.height) return

            const next = desktopSizeOf(host)
            try {
              ui.resize(next.width, next.height)
              // IMMEDIATELY, IN THE SAME TASK, and that is the whole point.
              //
              // resize() publishes its new size to the component's own signals
              // BEFORE it asks the session for anything, which pins the viewer
              // to the requested box while the canvas still holds the old
              // desktop. A server that accepts the resize corrects it when the
              // new frame arrives; a server with no display control -- xrdp, or
              // anything pre-2012R2 -- accepts nothing and never corrects it,
              // so the desktop stayed stretched to the wrong aspect until the
              // next resize.
              //
              // Re-asserting the fit here writes to the same signals before
              // Svelte flushes, so the stretched value never reaches the DOM
              // and never paints. On the accepting path it is idempotent: the
              // fit is recomputed to the same numbers, and the server's own
              // canvasResized recomputes it again anyway.
              ui.setScale('fit')
            } catch {
              // A session that died between the observation and the call has
              // already surfaced its own failure; resizing it is not a second
              // thing to report.
            }
          }, 250)
        })
        observer.observe(host)

        // Clicking BACK into the desktop has to restore the keyboard too.
        //
        // Focus is lost to anything else in the app — a sidebar entry, another
        // tab, the address row above — and clicking the desktop again does not
        // bring it back: `mouseenter` does not fire, because the pointer is
        // already inside, and mousedown is preventDefault()ed by the component
        // before the browser can act on it. So the desktop keeps taking mouse
        // input and silently ignores every keystroke.
        //
        // `pointerdown` runs ahead of mousedown and the component does not
        // touch it, which makes it the one place this can be repaired without
        // fighting the component for the event.
        const refocus = (): void => element.focus({ preventScroll: true })
        host.addEventListener('pointerdown', refocus)

        cleanupResize = () => {
          clearTimeout(debounce)
          observer.disconnect()
          host.removeEventListener('pointerdown', refocus)
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
    // Cleared here, or a reconnect that never opens still claims the session
    // "ended" — which is the opposite of what happened.
    setEnded(false)
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
          // NOT disabled while connecting, which is the one state a user most
          // needs it in. A host that stalls inside CredSSP never resolves and
          // neither `await ready` nor connect() has a client-side deadline, so
          // "Connecting..." sat there for ever with every control greyed out
          // and closing the tab the only way out. Retry already tears the old
          // attempt down through the effect cleanup; it was simply unreachable.
          disabled={phase === 'loading'}
          onClick={retry}
        >
          <RotateCw size={15} />
        </button>
      </div>
      {/* A live session's caveat, above the desktop rather than inside the
          failure overlay. It describes the connection you are using right now,
          so it has to be visible while that connection is up. */}
      {phase === 'connected' && notice && (
        <div className="rdp-notice" role="status">
          {notice}
        </div>
      )}
      {/* The surface and its overlay share a positioning context of their own.
          The overlay is `inset: 0`, and while it was positioned against
          `.rdp-view` it painted over the viewbar: in a failed session the
          Reconnect button was enabled, visible through nothing, and unclickable,
          and the user@host line was hidden behind an opaque panel. */}
      <div className="rdp-stage">
        <div ref={hostRef} className={clsx('rdp-surface', phase !== 'connected' && 'rdp-busy')} />
        {phase !== 'connected' && (
          <div className="rdp-overlay">
            <Monitor size={26} />
            {phase === 'failed' ? (
              <>
                {/* A session that RAN and then ended is not a failure to open
                    one. Signing out of Windows reported "Could not open the
                    desktop" about a desktop that had demonstrably opened, which
                    reads as a bug in the app rather than as what the user just
                    did. */}
                <div className="rdp-overlay-title">
                  {ended ? 'The remote desktop session ended' : 'Could not open the desktop'}
                </div>
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
    </div>
  )
}
