import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { OLD_HTTP, RENDERER, code, newHttpFiles, read, rel, walk } from './httpSurface'

/**
 * The redesign was built beside the old client and swapped in by one commit
 * (§0.1 decision 7). After it, the old client stays gone:
 *
 *  - its files do not exist, and nothing imports them;
 *  - its CSS was pruned by selector (scripts/http-css-prune.mjs), and no
 *    component writes, and no stylesheet defines, one of its class families;
 *  - no HTML is ever injected: server and spec text render as text (§0.2 rule 5).
 */

const files = newHttpFiles()
const sources = files.filter((p) => /\.tsx?$/.test(p))

describe('the old HTTP client is gone', () => {
  const deleted = [...OLD_HTTP, 'httpTransport', 'apiWorkspaceSnapshot', 'apiCollectionImport']
  it.each(deleted)('%s is deleted and imported by nothing', (name) => {
    const all = walk(join(RENDERER, '..', '..'))
    expect(all.some((p) => new RegExp(`/${name}\\.tsx?$`).test(p))).toBe(false)
    const importer = new RegExp(`from\\s+['"][^'"]*/${name}['"]|import\\(\\s*['"][^'"]*/${name}['"]`)
    expect(all.filter((p) => /\.tsx?$/.test(p) && importer.test(read(p))).map(rel)).toEqual([])
  })
})

/** The old client's class families, as the prune found them. */
const OLD_CLASS =
  /^(http-|gql-|ws-(log|frame|send|incoming|outgoing)|env-(bar|head|toggle|select|vars|add|secret)|endpoints-|method-tag|req-(pane|bar|method|path|send|url|blocked|tabs|editor|body|note|response)|kv-(editor|empty|row|add))/

const classTokens = (css: string): Set<string> =>
  new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1]))

/** Every class name a component writes: className literals and clsx() arguments. */
function classesUsed(src: string): string[] {
  const out: string[] = []
  const strings = (s: string): void => {
    for (const m of s.matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) out.push(...m[2].split(/\s+/).filter(Boolean))
  }
  for (const m of src.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
    if (m[1] ?? m[2]) out.push(...(m[1] ?? m[2]).split(/\s+/))
    else strings(m[3])
  }
  for (const m of src.matchAll(/\bclsx\(([^)]*)\)/g)) strings(m[1])
  return [...new Set(out.filter((t) => /^-?[a-zA-Z_][\w-]*$/.test(t)))]
}

describe('the old HTTP styles stay gone', () => {
  const global = classTokens(read(join(RENDERER, 'styles/global.css')))

  it('global.css defines none of the old client’s classes', () => {
    expect([...global].filter((t) => OLD_CLASS.test(t))).toEqual([])
  })

  it('no component writes one', () => {
    const hits = sources.flatMap((p) =>
      classesUsed(code(read(p)))
        .filter((t) => OLD_CLASS.test(t))
        .map((t) => `${rel(p)}: ${t}`)
    )
    expect(hits).toEqual([])
  })

  it('new stylesheets use only hc- classes of their own', () => {
    // Besides hc- blocks: is-* state modifiers on them, CodeMirror's own cm-*
    // classes, and the app's shared vocabulary from global.css.
    const own = (t: string): boolean => /^(hc-|is-|cm-)/.test(t) || global.has(t)
    const hits = files
      .filter((p) => p.endsWith('.css'))
      .flatMap((p) => [...classTokens(read(p))].filter((t) => !own(t)).map((t) => `${rel(p)}: ${t}`))
    expect(hits).toEqual([])
  })

  it('reads class names the way components write them', () => {
    expect(classesUsed(`<div className="a b" /><i className={clsx('c', x && "d")} />`)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('the HTTP client renders server and spec text as text', () => {
  const http = sources.filter((p) => p.includes('/components/http/'))
  it.each([
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['innerHTML', /\.innerHTML\b|\bouterHTML\b|insertAdjacentHTML/],
    ['marked', /from\s+['"]marked['"]/],
    ['markdown-it', /from\s+['"]markdown-it['"]/]
  ])('has no %s', (_what, pattern) => {
    expect(http.filter((p) => pattern.test(code(read(p)))).map(rel)).toEqual([])
  })
})
