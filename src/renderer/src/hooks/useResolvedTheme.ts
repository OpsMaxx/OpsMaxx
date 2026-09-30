import { useEffect, useState } from 'react'

/**
 * The theme actually being painted: the root's `data-theme`, never 'system'.
 *
 * It returns the painted theme itself rather than 'dark' or 'light'. It did
 * the latter, and OpsMaxx and Classic dark are both dark -- so switching
 * between them changed nothing this reported, and every open terminal kept the
 * previous theme's background until it was closed.
 *
 * The store holds the user's *setting*, which can be 'system' — and a
 * component that needs to hand a concrete mode to something else (the API
 * client themes itself with a class, not a CSS variable) cannot use 'system'.
 * App.tsx already resolves it onto the root element, so this reads the answer
 * from there rather than duplicating the media query and risking the two
 * disagreeing for a frame.
 */
export function useResolvedTheme(): string {
  const [theme, setTheme] = useState<string>(read)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // On 'system', the root attribute is rewritten by App.tsx only when the
    // setting changes — not when the OS flips underneath it. Watching the query
    // too is what makes the client follow a scheduled dark mode.
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onQuery = (): void => setTheme(read())
    query.addEventListener('change', onQuery)

    return () => {
      observer.disconnect()
      query.removeEventListener('change', onQuery)
    }
  }, [])

  return theme
}

function read(): string {
  return document.documentElement.getAttribute('data-theme') ?? 'dark'
}
