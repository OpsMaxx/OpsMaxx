import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The WS and GraphQL URL bars sit inside ProtocolLayout's row and measure
// themselves for §2.1's degradation. A bar that does not grow shrinks to its
// content, measures small, degrades, and shrinks again: at 1440 both rows came
// out fully degraded (QA). Geometry is CDP's; this pins the rule that breaks it.

const rule = (file: string, selector: string): string => {
  const css = readFileSync(join(__dirname, '../src/renderer/src/components/http', file), 'utf8')
  const at = css.search(new RegExp(`(^|\\n)\\${selector} \\{`))
  expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('the protocol URL bars fill their row', () => {
  it.each([
    ['ws/ws.css', '.hc-ws-bar'],
    ['gql/gql.css', '.hc-gql-bar']
  ])('%s %s grows and may shrink below its content', (file, selector) => {
    const body = rule(file, selector)
    expect(body).toMatch(/flex:\s*1(\s|;)/)
    expect(body).toMatch(/min-width:\s*0/)
  })
})
