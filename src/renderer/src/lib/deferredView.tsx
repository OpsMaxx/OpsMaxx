import { useEffect, useRef, useState, type ComponentType } from 'react'
import { forwardDebugError } from './debugForward'

/**
 * A view whose code is kept out of the startup bundle.
 *
 * Every one of these is behind an activity-bar click, and together they were
 * about half of the script the window had to evaluate before it could paint
 * anything. They are fetched once the app is idle (see App), so by the
 * time somebody clicks one it is already here and renders synchronously —
 * exactly as it did when it was a static import.
 *
 * Deliberately not React.lazy. A lazy component suspends on its first render
 * even when its module has already arrived, and React holds a revealed
 * Suspense fallback for at least 300 ms — a blank main area on the first visit
 * to every view, which a static import never had. Rendering nothing only while
 * the chunk really is still in flight costs a frame, not that.
 *
 * A chunk that will not load is the one failure a static import could never
 * have, so it is answered here, in the view's own place, with a retry. Thrown
 * instead, it would reach the root ErrorBoundary and take WorkspacePanel — and
 * every live terminal in it — down with a view the user was only visiting.
 */
export function deferredView<P extends object>(
  load: () => Promise<ComponentType<P>>
): { View: (props: P) => React.JSX.Element | null; preload: () => Promise<void> } {
  let Loaded: ComponentType<P> | null = null
  let failed: unknown = null
  let pending: Promise<void> | null = null
  const preload = (): Promise<void> =>
    (pending ??= load().then(
      (c) => void (Loaded = c),
      (e: unknown) => {
        failed = e
        // The idle preload has no screen to fail on, so without this a broken
        // chunk would go unnoticed until somebody clicked the view.
        console.error('[deferredView] a view failed to load:', e)
        forwardDebugError(
          'deferred-view',
          e instanceof Error ? e.message : String(e),
          e instanceof Error ? e.stack : undefined
        )
      }
    ))
  const retry = (): Promise<void> => {
    failed = null
    pending = null
    return preload()
  }
  function View(props: P): React.JSX.Element | null {
    const [, rerender] = useState(0)
    // Whether THIS view mounted empty, decided at render rather than read in
    // the effect. The chunk can land between a render that returned nothing
    // and the effect that runs after it; reading the module state there would
    // see it loaded, skip the re-render, and leave the view blank.
    const mountedEmpty = useRef(!Loaded && !failed)
    useEffect(() => {
      if (mountedEmpty.current) void preload().then(() => rerender((n) => n + 1))
    }, [])
    if (failed) {
      return (
        <div className="panel-note is-alarm">
          <span className="grow">
            This view failed to load: {failed instanceof Error ? failed.message : String(failed)}
          </span>
          <button className="btn" onClick={() => void retry().then(() => rerender((n) => n + 1))}>
            Retry
          </button>
        </div>
      )
    }
    return Loaded ? <Loaded {...props} /> : null
  }
  return { View, preload }
}
