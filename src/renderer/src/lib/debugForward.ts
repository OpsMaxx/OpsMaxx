import { bridgeHas } from './bridge'

/**
 * One line into main's debug trace, or nothing.
 *
 * Exported because `ErrorBoundary` needs it too: the listeners below catch what
 * React does not, and the boundary catches what only React sees. Neither should
 * carry its own copy of the guard.
 *
 * `bridgeHas` for the reason every other caller uses it: under
 * `electron-vite dev` the running process keeps the preload bundle it booted
 * with, so a method added since then is undefined for the rest of the session.
 */
export function forwardDebugError(kind: string, message: string, stack?: string): void {
  const api = window.opsmaxx?.debug
  if (!bridgeHas(api as Record<string, unknown> | undefined, 'event')) return
  try {
    api?.event(kind, message, stack)
  } catch {
    // A dead bridge during teardown. Losing a trace line must never be the
    // thing that raises a second error out of the error handler.
  }
}

/**
 * Renderer errors, into main's debug trace.
 *
 * The trace is written in main, and until now main could not see a renderer
 * error at all: `ErrorBoundary` catches what React throws beneath it, and
 * everything else — an error in an event handler, a rejected promise nobody
 * awaited, a failure outside the tree React owns — reached `console.error` in a
 * devtools console nobody has open. For a bug in the UI that is the whole of
 * the evidence, so it is the half of the trace most worth having.
 *
 * Sent, never invoked: an error report has no reply worth waiting for, and a
 * failing renderer should not be made to await the process it is reporting to.
 * Main drops these when debug mode is off, so this is safe to install
 * unconditionally — and it is installed unconditionally on purpose, because the
 * renderer's copy of the flag arrives asynchronously and an error raised before
 * it does is exactly the kind worth keeping.
 */
export function installDebugForwarding(): void {
  window.addEventListener('error', (e) => {
    forwardDebugError(
      'error',
      e.message,
      e.error instanceof Error ? (e.error.stack ?? undefined) : undefined
    )
  })

  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason
    forwardDebugError(
      'unhandledrejection',
      String(r),
      r instanceof Error ? (r.stack ?? undefined) : undefined
    )
  })
}
