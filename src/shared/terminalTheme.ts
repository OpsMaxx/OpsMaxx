// Terminal colour schemes: the built-in set, and importers for the two formats
// people actually have files of.
//
// Pure and dependency-free on purpose. The parsers take a string and return a
// scheme or an error, so they are testable without a DOM, a file picker or a
// terminal — and so a malformed file someone downloaded cannot do anything
// worse than fail to parse.

/**
 * The sixteen ANSI slots, in the order every terminal format lists them.
 *
 * All sixteen are required. xterm silently fills any slot a theme omits from
 * its OWN defaults, so a partial scheme does not "inherit the rest of ours" —
 * it renders a blend of two palettes and merely looks slightly wrong.
 */
export const ANSI_KEYS = [
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
] as const

export type AnsiKey = (typeof ANSI_KEYS)[number]

export interface TerminalScheme {
  /** Stable across renames; `''` means "follow the app theme", the default. */
  id: string
  name: string
  /**
   * Surface colours. Optional as a set: a scheme that omits them keeps the
   * app's own background and foreground, which is what makes the ANSI-only
   * presets sit correctly in both light and dark without shipping two of each.
   */
  background?: string
  foreground?: string
  cursor?: string
  selectionBackground?: string
  /** All sixteen, keyed as xterm names them. */
  ansi: Record<AnsiKey, string>
}

const hex = (v: string): string => (v.startsWith('#') ? v : `#${v}`).toLowerCase()

/** Builds a scheme from the sixteen in canonical order. Internal to the presets. */
function scheme(
  id: string,
  name: string,
  order: string[],
  surface?: Pick<TerminalScheme, 'background' | 'foreground' | 'cursor' | 'selectionBackground'>
): TerminalScheme {
  const ansi = {} as Record<AnsiKey, string>
  ANSI_KEYS.forEach((k, i) => (ansi[k] = hex(order[i])))
  return { id, name, ansi, ...surface }
}

/**
 * The built-ins.
 *
 * `''` is deliberately first and deliberately empty: it is the app's own
 * palette, which is what every existing install already renders, so choosing a
 * scheme is opt-in and the default is "leave it alone". Its colours live in
 * the renderer's themeFromCss rather than here, because four of them come from
 * CSS variables that follow the app theme.
 */
export const TERMINAL_SCHEMES: TerminalScheme[] = [
  scheme(
    'solarized-dark',
    'Solarized Dark',
    [
      '#073642', '#dc322f', '#859900', '#b58900',
      '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83',
      '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'
    ],
    { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642' }
  ),
  scheme(
    'solarized-light',
    'Solarized Light',
    [
      '#073642', '#dc322f', '#859900', '#b58900',
      '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83',
      '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'
    ],
    { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: '#eee8d5' }
  ),
  scheme(
    'dracula',
    'Dracula',
    [
      '#21222c', '#ff5555', '#50fa7b', '#f1fa8c',
      '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5',
      '#d6acff', '#ff92df', '#a4ffff', '#ffffff'
    ],
    { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a' }
  ),
  scheme(
    'nord',
    'Nord',
    [
      '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b',
      '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b',
      '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'
    ],
    { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e' }
  ),
  scheme(
    'gruvbox-dark',
    'Gruvbox Dark',
    [
      '#282828', '#cc241d', '#98971a', '#d79921',
      '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f',
      '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'
    ],
    { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selectionBackground: '#3c3836' }
  ),
  scheme(
    'one-dark',
    'One Dark',
    [
      '#000000', '#e06c75', '#98c379', '#d19a66',
      '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b',
      '#61afef', '#c678dd', '#56b6c2', '#ffffff'
    ],
    { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451' }
  )
]

export function schemeById(id: string | undefined): TerminalScheme | null {
  if (!id) return null
  return TERMINAL_SCHEMES.find((s) => s.id === id) ?? null
}

/**
 * A scheme by id, looking in the user's imported ones first.
 *
 * Imported wins on a collision so that re-importing a preset's own file
 * overrides it rather than being silently ignored — which is what someone doing
 * that is asking for.
 */
export function resolveScheme(
  id: string | undefined,
  custom?: TerminalScheme[]
): TerminalScheme | null {
  if (!id) return null
  return custom?.find((s) => s.id === id) ?? schemeById(id)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type SchemeImport = { ok: true; scheme: TerminalScheme } | { ok: false; error: string }

/**
 * `#rrggbb`, and the two other spellings people's files actually contain.
 *
 * `#rgb` is expanded and `#rrggbbaa` has its alpha dropped, because xterm's
 * theme takes six digits: rejecting these meant refusing a whole scheme over a
 * shorthand, and silently dropping an 8-digit surface colour meant importing a
 * scheme with no background.
 */
const HEX_ANY = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function toHex6(raw: string): string | null {
  if (!HEX_ANY.test(raw)) return null
  const body = raw.replace(/^#/, '').toLowerCase()
  if (body.length === 3) return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
  return `#${body.slice(0, 6)}`
}

/** Windows Terminal's own key names, in ANSI order. */
const WT_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite'
]

/**
 * A Windows Terminal scheme object.
 *
 * Accepts either a bare scheme or a whole `settings.json` — people export both,
 * and a file that contains a `schemes` array is far more common than a lone
 * object, because that is what the settings file looks like. `magenta` is
 * called `purple` here, which is the one naming trap.
 */
export function parseWindowsTerminalScheme(text: string, want?: string): SchemeImport {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' }
  }

  const candidates: Record<string, unknown>[] = []
  const root = json as { schemes?: unknown }
  if (Array.isArray(root?.schemes)) {
    // Filtered, not cast. A `schemes` array containing `null` — which a
    // hand-edited settings.json readily produces — made `c[k]` throw a
    // TypeError out of a parser whose whole contract is to return a result, and
    // the import then failed silently at the call site.
    for (const c of root.schemes) {
      if (c && typeof c === 'object' && !Array.isArray(c)) candidates.push(c as Record<string, unknown>)
    }
  } else if (json && typeof json === 'object' && !Array.isArray(json)) {
    candidates.push(json as Record<string, unknown>)
  }

  const pick = want
    ? candidates.find((c) => String(c.name ?? '') === want)
    : candidates.find((c) => WT_KEYS.every((k) => typeof c[k] === 'string'))

  if (!pick) {
    return {
      ok: false,
      error: candidates.length
        ? 'No scheme in that file has all sixteen colours.'
        : 'That file contains no colour scheme.'
    }
  }

  const ansi = {} as Record<AnsiKey, string>
  for (let i = 0; i < ANSI_KEYS.length; i++) {
    const raw = pick[WT_KEYS[i]]
    const six = typeof raw === 'string' ? toHex6(raw) : null
    if (!six) {
      return { ok: false, error: `"${WT_KEYS[i]}" is missing or is not a #rrggbb colour.` }
    }
    ansi[ANSI_KEYS[i]] = six
  }

  const surface = (key: string): string | undefined => {
    const v = pick[key]
    return typeof v === 'string' ? (toHex6(v) ?? undefined) : undefined
  }

  const name = typeof pick.name === 'string' && pick.name.trim() ? pick.name.trim() : 'Imported scheme'
  return {
    ok: true,
    scheme: {
      id: `imported-${slug(name)}`,
      name,
      ansi,
      background: surface('background'),
      foreground: surface('foreground'),
      cursor: surface('cursorColor'),
      selectionBackground: surface('selectionBackground')
    }
  }
}

/**
 * An iTerm2 `.itermcolors` file.
 *
 * It is an XML plist whose colours are float components, not hex — so a value
 * of `0.5` is 128, and rounding it any other way produces a palette that is
 * subtly not the one the author published. Parsed with a scanner rather than an
 * XML library because adding a parser dependency for one import path is a poor
 * trade, and the format's shape is rigid: a `<key>` followed by a `<dict>` of
 * three or four `<real>`s.
 */
export function parseITermColors(text: string): SchemeImport {
  if (!/<plist|<dict/i.test(text)) {
    return { ok: false, error: 'That file is not an iTerm2 colour preset.' }
  }

  // Each entry: <key>NAME</key> ... <dict> ... </dict>
  const entries = new Map<string, Record<string, number>>()
  const entryRx = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/gi
  let m: RegExpExecArray | null
  while ((m = entryRx.exec(text))) {
    const components: Record<string, number> = {}
    const compRx = /<key>([^<]+)<\/key>\s*<real>([^<]+)<\/real>/gi
    let c: RegExpExecArray | null
    while ((c = compRx.exec(m[2]))) {
      components[c[1].trim()] = Number(c[2])
    }
    entries.set(m[1].trim(), components)
  }

  const toHex = (name: string): string | undefined => {
    const c = entries.get(name)
    if (!c) return undefined
    const part = (k: string): number | null => {
      const v = c[k]
      if (typeof v !== 'number' || Number.isNaN(v)) return null
      // Components are 0..1. Clamp rather than reject: a hand-edited file with
      // 1.0000001 is not a file worth refusing.
      return Math.round(Math.min(1, Math.max(0, v)) * 255)
    }
    const r = part('Red Component')
    const g = part('Green Component')
    const b = part('Blue Component')
    if (r === null || g === null || b === null) return undefined
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }

  const ansi = {} as Record<AnsiKey, string>
  for (let i = 0; i < ANSI_KEYS.length; i++) {
    const value = toHex(`Ansi ${i} Color`)
    if (!value) return { ok: false, error: `"Ansi ${i} Color" is missing or unreadable.` }
    ansi[ANSI_KEYS[i]] = value
  }

  return {
    ok: true,
    scheme: {
      id: 'imported-iterm',
      name: 'Imported scheme',
      ansi,
      background: toHex('Background Color'),
      foreground: toHex('Foreground Color'),
      cursor: toHex('Cursor Color'),
      selectionBackground: toHex('Selection Color')
    }
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scheme'
}

/**
 * Import a scheme from a file, choosing the parser by content rather than by
 * extension: people rename these files, and both formats are unmistakable in
 * their first bytes.
 */
export function parseTerminalScheme(text: string, name?: string): SchemeImport {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<')) return parseITermColors(text)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseWindowsTerminalScheme(text, name)
  }
  return {
    ok: false,
    error: 'Unrecognised file. Import an iTerm2 .itermcolors or a Windows Terminal scheme.'
  }
}
