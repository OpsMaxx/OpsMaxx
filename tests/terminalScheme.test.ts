import { describe, it, expect } from 'vitest'
import {
  ANSI_KEYS,
  TERMINAL_SCHEMES,
  parseITermColors,
  parseTerminalScheme,
  parseWindowsTerminalScheme,
  schemeById
} from '../src/shared/terminalTheme'

/**
 * Terminal colour schemes and the two importers.
 *
 * The presets get the same assertion the app palette gets: all sixteen slots
 * named, because xterm fills anything omitted from its own defaults and a
 * partial scheme renders a blend of two palettes rather than failing.
 *
 * The importers are parsers for files people downloaded, so they are tested for
 * what they do with a bad one as much as a good one.
 */

describe('built-in schemes', () => {
  it('names all sixteen ANSI colours in every preset', () => {
    for (const scheme of TERMINAL_SCHEMES) {
      const missing = ANSI_KEYS.filter((k) => !scheme.ansi[k])
      expect(missing, `${scheme.id} is missing colours`).toEqual([])
    }
  })

  it('uses well-formed hex throughout', () => {
    for (const scheme of TERMINAL_SCHEMES) {
      for (const key of ANSI_KEYS) {
        expect(scheme.ansi[key], `${scheme.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('has unique ids, since the id is what gets persisted', () => {
    const ids = TERMINAL_SCHEMES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resolves nothing for the empty id, which means the app palette', () => {
    // '' is a real selectable value, not a missing one — the app's own palette
    // lives in the renderer because four of its colours come from CSS.
    expect(schemeById('')).toBeNull()
    expect(schemeById(undefined)).toBeNull()
    expect(schemeById('no-such-scheme')).toBeNull()
    expect(schemeById('dracula')?.name).toBe('Dracula')
  })
})

describe('Windows Terminal import', () => {
  const SCHEME = {
    name: 'Campbell',
    background: '#0C0C0C',
    foreground: '#CCCCCC',
    cursorColor: '#FFFFFF',
    selectionBackground: '#FFFFFF',
    black: '#0C0C0C',
    red: '#C50F1F',
    green: '#13A10E',
    yellow: '#C19C00',
    blue: '#0037DA',
    purple: '#881798',
    cyan: '#3A96DD',
    white: '#CCCCCC',
    brightBlack: '#767676',
    brightRed: '#E74856',
    brightGreen: '#16C60C',
    brightYellow: '#F9F1A5',
    brightBlue: '#3B78FF',
    brightPurple: '#B4009E',
    brightCyan: '#61D6D6',
    brightWhite: '#F2F2F2'
  }

  it('reads a bare scheme object', () => {
    const r = parseWindowsTerminalScheme(JSON.stringify(SCHEME))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scheme.name).toBe('Campbell')
    expect(r.scheme.background).toBe('#0c0c0c')
  })

  // `purple`, not `magenta`. The one naming trap in the format.
  it('maps purple onto magenta', () => {
    const r = parseWindowsTerminalScheme(JSON.stringify(SCHEME))
    if (!r.ok) throw new Error(r.error)
    expect(r.scheme.ansi.magenta).toBe('#881798')
    expect(r.scheme.ansi.brightMagenta).toBe('#b4009e')
  })

  // A whole settings.json is what people actually have on disk.
  it('finds a scheme inside a settings file', () => {
    const settings = JSON.stringify({ profiles: {}, schemes: [SCHEME] })
    const r = parseWindowsTerminalScheme(settings)
    expect(r.ok).toBe(true)
  })

  it('can pick one scheme by name out of several', () => {
    const other = { ...SCHEME, name: 'Vintage', red: '#800000' }
    const settings = JSON.stringify({ schemes: [SCHEME, other] })
    const r = parseWindowsTerminalScheme(settings, 'Vintage')
    if (!r.ok) throw new Error(r.error)
    expect(r.scheme.ansi.red).toBe('#800000')
  })

  it('refuses a scheme missing a colour rather than filling it in', () => {
    const { brightCyan: _dropped, ...partial } = SCHEME
    const r = parseWindowsTerminalScheme(JSON.stringify(partial))
    expect(r.ok).toBe(false)
  })

  it('reports invalid JSON as invalid JSON', () => {
    const r = parseWindowsTerminalScheme('{ not json')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/JSON/)
  })
})

describe('iTerm2 import', () => {
  /** Components are floats, so 0.5 must become 128 and not 127 or 0.5. */
  const plist = (): string => {
    const colour = (i: number, r: number, g: number, b: number): string => `
      <key>Ansi ${i} Color</key>
      <dict>
        <key>Red Component</key><real>${r}</real>
        <key>Green Component</key><real>${g}</real>
        <key>Blue Component</key><real>${b}</real>
      </dict>`
    let body = ''
    for (let i = 0; i < 16; i++) body += colour(i, i / 15, 0.5, 1)
    return `<?xml version="1.0"?><plist version="1.0"><dict>${body}
      <key>Background Color</key>
      <dict>
        <key>Red Component</key><real>0</real>
        <key>Green Component</key><real>0</real>
        <key>Blue Component</key><real>0</real>
      </dict>
    </dict></plist>`
  }

  it('converts float components to hex', () => {
    const r = parseITermColors(plist())
    if (!r.ok) throw new Error(r.error)
    // 0.5 * 255 = 127.5, rounded to 128 = 0x80. Getting this wrong produces a
    // palette that is subtly not the one the author published.
    expect(r.scheme.ansi.black).toBe('#0080ff')
    expect(r.scheme.ansi.brightWhite).toBe('#ff80ff')
    expect(r.scheme.background).toBe('#000000')
  })

  it('names all sixteen', () => {
    const r = parseITermColors(plist())
    if (!r.ok) throw new Error(r.error)
    expect(ANSI_KEYS.filter((k) => !r.scheme.ansi[k])).toEqual([])
  })

  it('refuses a preset that is missing a slot', () => {
    const truncated = plist().replace(/<key>Ansi 15 Color<\/key>[\s\S]*?<\/dict>/, '')
    const r = parseITermColors(truncated)
    expect(r.ok).toBe(false)
  })

  it('refuses a file that is not a plist', () => {
    expect(parseITermColors('hello').ok).toBe(false)
  })
})

describe('format detection', () => {
  // People rename these files, so the content decides, not the extension.
  it('chooses the parser by content', () => {
    expect(parseTerminalScheme('<?xml version="1.0"?><plist><dict></dict></plist>').ok).toBe(false)
    const r = parseTerminalScheme('{"nope":true}')
    expect(r.ok).toBe(false)
  })

  it('says what it accepts when it recognises nothing', () => {
    const r = parseTerminalScheme('just some text')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/itermcolors|Windows Terminal/i)
  })
})

/**
 * The two other hex spellings people's files actually contain.
 *
 * Rejecting `#rgb` failed a whole scheme over a shorthand, and silently
 * dropping an 8-digit surface colour imported a scheme with no background —
 * which reads as the importer half-working rather than as a rejected file.
 */
describe('hex forms', () => {
  const base = {
    name: 'Short',
    black: '#000', red: '#f00', green: '#0f0', yellow: '#ff0',
    blue: '#00f', purple: '#f0f', cyan: '#0ff', white: '#fff',
    brightBlack: '#111', brightRed: '#f11', brightGreen: '#1f1', brightYellow: '#ff1',
    brightBlue: '#11f', brightMagenta: '#f1f', brightPurple: '#f1f', brightCyan: '#1ff',
    brightWhite: '#eee',
    background: '#123456ff'
  }

  it('expands the three-digit form', () => {
    const r = parseWindowsTerminalScheme(JSON.stringify(base))
    if (!r.ok) throw new Error(r.error)
    expect(r.scheme.ansi.black).toBe('#000000')
    expect(r.scheme.ansi.red).toBe('#ff0000')
  })

  it('drops the alpha from an eight-digit form rather than the colour', () => {
    const r = parseWindowsTerminalScheme(JSON.stringify(base))
    if (!r.ok) throw new Error(r.error)
    expect(r.scheme.background).toBe('#123456')
  })

  // A hand-edited settings.json readily produces this, and it used to throw a
  // TypeError out of a parser whose whole contract is to return a result.
  it('survives a schemes array containing junk', () => {
    const r = parseWindowsTerminalScheme(JSON.stringify({ schemes: [null, 'x', 42, base] }))
    expect(r.ok).toBe(true)
  })

  it('still refuses a genuinely malformed colour', () => {
    const r = parseWindowsTerminalScheme(JSON.stringify({ ...base, red: 'crimson' }))
    expect(r.ok).toBe(false)
  })
})
