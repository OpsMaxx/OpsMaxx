// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { themeFromCss } from '../src/renderer/src/hooks/useTerminalSession'

/**
 * xterm fills any palette slot the theme omits from its OWN defaults, silently.
 *
 * That is why this is worth a test: the failure is invisible. `themeFromCss`
 * named nine of the sixteen ANSI colours, and the seven it left out did not
 * inherit anything of ours — they came from xterm's built-in palette. Every
 * bright except brightBlack was missing, which is most of what `ls`, `git
 * status` and a coloured prompt actually emit, so the terminal was rendering a
 * blend of two palettes and looked merely "slightly off" rather than broken.
 *
 * Asserting the full set is what makes the next omission fail loudly.
 */
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

// The four that track the app's own tokens rather than being fixed.
const SURFACE = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground']

describe('themeFromCss', () => {
  it('names all sixteen ANSI colours, so none falls back to xterm defaults', () => {
    const theme = themeFromCss()
    const missing = ANSI.filter((k) => !theme[k])
    expect(missing).toEqual([])
  })

  it('gives every ANSI colour a real hex value', () => {
    const theme = themeFromCss()
    const malformed = ANSI.filter((k) => !/^#[0-9a-f]{6}$/i.test(theme[k]))
    expect(malformed).toEqual([])
  })

  it('exposes the surface colours the app theme drives', () => {
    const theme = themeFromCss()
    for (const key of SURFACE) {
      expect(theme).toHaveProperty(key)
    }
  })

  /**
   * The brights must be distinguishable from their normals. Duplicating a
   * normal into its bright slot would satisfy every assertion above while
   * making bold text render identically to plain — which is the bug this
   * palette had, in the form of an absent value rather than a duplicated one.
   */
  it('keeps each bright distinct from its normal', () => {
    const theme = themeFromCss()
    const same = ANSI.slice(0, 8)
      .map((normal) => {
        const bright = `bright${normal[0].toUpperCase()}${normal.slice(1)}`
        return theme[normal] === theme[bright] ? normal : null
      })
      .filter(Boolean)
    expect(same).toEqual([])
  })
})
