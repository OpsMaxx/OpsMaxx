import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A settings control that writes nowhere is worse than an absent one.
 *
 * The panel had two switch components that looked identical on screen.
 * `SettingSwitch` wrote to the store. `Toggle` held its value in local
 * `useState` and reached nothing — placeholder UI from the original mock that
 * five settings were still wired to years later. Beside them sat a font-family
 * `<select>` with no `value` and no `onChange` at all.
 *
 * So the only way to find out a setting did nothing was to set it, close the
 * pane, and watch it snap back. That is issue #35: "terminal Fonts Family and
 * Color Schema resets everytime", filed against a dropdown that had never once
 * been connected to anything since 0.1.0.
 *
 * This guards the shape of the mistake rather than every control in the app. A
 * general "is this wired" check would have to model handlers passed down
 * through props and would be wrong often enough that people stopped reading
 * it. A control rendered inline with no binding is specific and repeatable,
 * and so is the placeholder component that made it easy.
 */

const SETTINGS = join(process.cwd(), 'src/renderer/src/components/settings/Settings.tsx')

/** The opening tag of each `<select …>`, with JSX braces balanced so an
 *  arrow function inside an attribute does not end the tag early. */
function openingTags(src: string, tag: string): string[] {
  const out: string[] = []
  for (let i = src.indexOf(`<${tag}`); i !== -1; i = src.indexOf(`<${tag}`, i + 1)) {
    let depth = 0
    for (let j = i; j < src.length; j++) {
      const c = src[j]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) {
        out.push(src.slice(i, j + 1))
        break
      }
    }
  }
  return out
}

describe('every settings control writes somewhere', () => {
  const src = readFileSync(SETTINGS, 'utf8')

  it('has no placeholder switch component', () => {
    // The specific footgun: a second switch that looks like the real one.
    expect(src).not.toMatch(/function Toggle\b/)
    expect(src).not.toMatch(/<Toggle\b/)
  })

  it('gives every select a value and a change handler', () => {
    const unbound = openingTags(src, 'select').filter(
      (t) => !t.includes('value=') || !t.includes('onChange=')
    )
    expect(unbound).toEqual([])
  })

  it('leaves no search-index entry pointing at a control that is gone', () => {
    // The index is what the settings search matches against, so an entry for a
    // deleted control sends someone to a section that does not contain it.
    for (const title of [
      'Copy on select',
      'Scroll to bottom on output',
      'Show status bar',
      'Animated transitions'
    ]) {
      expect(src).not.toContain(`title: '${title}'`)
    }
  })

  it('still indexes the controls that do exist', () => {
    // The other half of the previous assertion: deleting the index wholesale
    // would also pass it.
    expect(src).toContain("title: 'Font family'")
    expect(src).toContain("title: 'Cursor blink'")
    expect(src).toContain("title: 'Colour scheme'")
  })
})
