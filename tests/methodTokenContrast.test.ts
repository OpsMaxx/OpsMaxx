import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The HTTP method colours (§2.19, UX-m4). Method text sits on the sidebar
// (tree rows, history) and on the panel (tab strip, URL row), so each colour
// has to read at AA on both, in both themes. Read from the shipped stylesheet,
// comments stripped, the same way tests/contrast.test.ts reads it.

const CSS = readFileSync(join(__dirname, '../src/renderer/src/styles/tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const chan = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function token(theme: 'dark' | 'light', name: string): string {
  const at = CSS.indexOf(":root[data-theme='light']")
  const block = theme === 'dark' ? CSS.slice(0, at) : CSS.slice(at)
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)
  expect(m, `--${name} must be a hex in the ${theme} theme`).not.toBeNull()
  return m![1]
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'other']

describe.each(['dark', 'light'] as const)('method tokens, %s theme', (theme) => {
  it.each(METHODS)('--method-%s is at least 4.5:1 on --bg-sidebar and --bg-panel', (m) => {
    for (const bg of ['bg-sidebar', 'bg-panel']) {
      const ratio = contrast(token(theme, `method-${m}`), token(theme, bg))
      expect(ratio, `--method-${m} on --${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
