import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// A wide table scrolled, and nothing said so.
//
// A column cut by the panel edge looked like the end of the row, and in the
// light theme a security count was cut MID-NUMBER — "38626" truncated and shown
// as though it were the whole figure. That is a correctness bug wearing a
// layout bug's clothes: the reader is not told the value is incomplete, so they
// read it as complete. A hairline scrollbar under the last row is not an answer.

const ROOT = join(__dirname, '..')
const CSS = readFileSync(join(ROOT, 'src/renderer/src/styles/global.css'), 'utf8')
const PANELS = join(ROOT, 'src/renderer/src/components/monitor')

const sources = readdirSync(PANELS)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ file: f, text: readFileSync(join(PANELS, f), 'utf8') }))

describe('every wide table is inside the wrapper that shows it is scrollable', () => {
  // The affordance lives on `.inv-scroll`. A table that renders outside one
  // gets the clipping and none of the signal, which is the state every one of
  // them was in before.
  it('never uses inv-table without inv-scroll in the same file', () => {
    for (const { file, text } of sources) {
      const tables = text.split('inv-table').length - 1
      if (tables === 0) continue
      const wrappers = text.split('inv-scroll').length - 1
      expect(wrappers, `${file} has ${tables} inv-table and ${wrappers} inv-scroll`).toBe(tables)
    }
  })

  // Anti-vacuity: if the class were renamed and this test stopped matching, the
  // loop above would pass by finding nothing to check.
  it('finds tables to check', () => {
    expect(sources.some((s) => s.text.includes('inv-table'))).toBe(true)
  })
})

describe('the wrapper says which side has more', () => {
  // The standard self-detecting overflow shadow: layers attached to the CONTENT
  // slide away as it scrolls, layers attached to the container stay. Where the
  // content covers the container, the local layer hides the shadow — so the
  // fade appears only on a side that genuinely has more, with no measurement
  // and nothing to keep in step.
  it('pairs local and scroll backgrounds on the scroll container', () => {
    const block = CSS.slice(CSS.indexOf('.inv-scroll {'), CSS.indexOf('.inv-table {'))
    expect(block).toContain('overflow-x: auto')
    expect(block.match(/no-repeat local/g) ?? []).toHaveLength(2)
    expect(block.match(/no-repeat scroll/g) ?? []).toHaveLength(2)
  })

  // The host identifies the row. Without this, a wide table shows eight columns
  // of numbers belonging to a server whose name is off-screen to the left.
  it('pins the first column so a scrolled row is still identifiable', () => {
    const i = CSS.indexOf('.inv-table th:first-child')
    expect(i).toBeGreaterThan(-1)
    // Bounded by the rule's own closing brace, not by a character count. A
    // fixed window spilled into the `tr:hover td:first-child` rule below,
    // which also sets a background — so removing the background from the rule
    // under test still passed.
    const block = CSS.slice(i, CSS.indexOf('}', i))
    expect(block).toContain('position: sticky')
    expect(block).toContain('left: 0')
    // Transparent would let the scrolling columns show through underneath it.
    expect(block).toMatch(/background:\s*var\(--bg-/)
  })
})
