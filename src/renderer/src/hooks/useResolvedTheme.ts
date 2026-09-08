import { useEffect, useState } from 'react'

/**
 * The theme actually being painted, 'dark' or 'light'.
 *
 * The store holds the user's *setting*, which can be 'system' — and a
 * component that needs to hand a concrete mode to something else (the API
 * client themes itself with a class, not a CSS variable) cannot use 'system'.
 * App.tsx already resolves it onto the root element, so this reads the answer
 * from there rather than duplicating the media query and risking the two
 * disagreeing for a frame.
 */
export function useResolvedTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>(read)

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

function read(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}
