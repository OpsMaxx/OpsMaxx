import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS } from '../src/renderer/src/store/app'

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const VIEW = read('../src/renderer/src/components/databases/DatabaseView.tsx')
const HOOK = read('../src/renderer/src/hooks/useDragSize.ts')
const CSS = read('../src/renderer/src/styles/global.css')

/**
 * The database view as a workbench rather than a form.
 *
 * Two of its three boundaries were fixed -- a 220px schema column and a 110px
 * textarea -- so on a maximised window a query too long to read sat in a small
 * box under a screenful of nothing, and a schema column too narrow for its own
 * table names could not be widened.
 */

describe('the dividers', () => {
  it('are clamped, so neither pane can be dragged away', () => {
    // A pane dragged to zero is a pane the user cannot get back without knowing
    // to grab an invisible edge.
    expect(HOOK).toMatch(/Math\.min\(max, Math\.max\(min, from \+ delta\)\)/)
    expect(VIEW).toMatch(/min: 150,[\s\S]{0,40}max: 520/)
    expect(VIEW).toMatch(/min: 80,[\s\S]{0,40}max: 600/)
  })

  it('survive a restart', () => {
    // In settings because settings is what persist.ts saves. A layout somebody
    // arranged and has to redo every launch is a layout they stop arranging.
    expect(DEFAULT_SETTINGS.dbSchemaWidth).toBeGreaterThan(0)
    expect(DEFAULT_SETTINGS.dbEditorHeight).toBeGreaterThan(0)
    expect(VIEW).toMatch(/onCommit: \(dbSchemaWidth\) => setSettings\(\{ dbSchemaWidth \}\)/)
    expect(VIEW).toMatch(/onCommit: \(dbEditorHeight\) => setSettings\(\{ dbEditorHeight \}\)/)
  })

  it('do not select text while being dragged', () => {
    // The one detail that makes a hand-rolled divider feel broken.
    expect(HOOK).toMatch(/e\.preventDefault\(\)/)
  })

  it('read the live size rather than the size at mousedown', () => {
    // A second drag that starts from the first drag's starting point jumps.
    expect(HOOK).toMatch(/const from = latest\.current/)
  })
})

describe('what fills the space', () => {
  it('gives the results whatever the editor does not take', () => {
    expect(CSS).toMatch(/\.db-results \{[\s\S]*?flex: 1;/)
    expect(CSS).toMatch(/\.db-editor \{[\s\S]*?flex: none;/)
  })

  it('centres an empty result instead of pinning it to a corner', () => {
    // Top-left in a very wide pane reads as a rendering fault, not an answer.
    expect(CSS).toMatch(/\.db-results > \.empty \{\s*margin: auto;/)
  })
})

describe('the schema column', () => {
  it('can be searched once the list is past a glance', () => {
    expect(VIEW).toMatch(/objects\.length > 12 &&/)
    expect(VIEW).toMatch(/shownObjects/)
  })

  it('says so when a filter matches nothing, rather than looking empty', () => {
    expect(VIEW).toMatch(/title="Nothing matches"/)
  })

  it('clips a long name to one line and keeps the whole of it in the title', () => {
    expect(CSS).toMatch(/\.db-schema \.tree-row \.label \{[\s\S]*?text-overflow: ellipsis;/)
    expect(VIEW).toMatch(/<span className="label" title=\{t\}>/)
  })
})
