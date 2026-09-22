import { useEffect, useState, type ComponentType } from 'react'

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
      (e: unknown) => void (failed = e)
    ))
  function View(props: P): React.JSX.Element | null {
    const [, arrived] = useState(false)
    useEffect(() => {
      if (!Loaded && !failed) void preload().then(() => arrived(true))
    }, [])
    // Into the ErrorBoundary, where a throw from the view itself would have
    // landed, rather than a main area that silently stays empty.
    if (failed) throw failed
    return Loaded ? <Loaded {...props} /> : null
  }
  return { View, preload }
}
