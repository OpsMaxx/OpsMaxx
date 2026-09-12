// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import { useApp } from '../src/renderer/src/store/app'
import { useNav, AI_SECTIONS, AI_SECTION_LABELS } from '../src/renderer/src/store/nav'
import type { AiSection } from '../src/renderer/src/store/nav'

// Ctrl+K reached AI & MCP as a single destination and then showed whichever
// page happened to be open last, so six of the seven pages could not be named
// from the palette at all — and two of them, Approvals and Active Sessions, had
// no pointer anywhere else in the app either. You got to them by knowing which
// tab to click.
//
// Asserted through the store the way a user experiences it: press the entry,
// end up on the right activity AND the right page. A test that only checked
// `openAi` was called would have passed on the day this was broken, because
// nothing was calling it.

beforeEach(() => {
  stubBridge({})
  useApp.setState({ activity: 'connections' })
})

/** The palette entry for one AI page, found the way a reader finds it: by the
 *  name on it, under the AI & MCP heading. Scoped by the sub as well as the
 *  title because Security is also the name of a Settings page. */
function aiEntry(container: HTMLElement, label: string): HTMLElement {
  const hit = [...container.querySelectorAll('.palette-item')].find(
    (el) =>
      el.querySelector('.p-title')?.textContent === label &&
      el.querySelector('.p-sub')?.textContent === 'AI & MCP'
  )
  expect(hit, `the palette has no AI & MCP entry named "${label}"`).toBeTruthy()
  return hit as HTMLElement
}

describe('every page of AI & MCP is reachable from the palette', () => {
  // `AI_SECTIONS`, not a list written here: a page added to the union arrives
  // in this loop on its own, and the Record keyed by `AiSection` in nav.ts
  // means it cannot arrive without a label. That is the compile-level half of
  // this guarantee, and it is why there is no runtime test that the labels
  // exist.
  it.each(AI_SECTIONS)('lands on %s', async (id: AiSection) => {
    // Somewhere other than the target, or landing on it would prove nothing.
    useNav.setState({ aiSection: id === 'overview' ? 'audit' : 'overview' })
    const { container } = render(<CommandPalette />)

    await userEvent.click(aiEntry(container, AI_SECTION_LABELS[id]))

    expect(useApp.getState().activity).toBe('ai')
    expect(useNav.getState().aiSection).toBe(id)
  })

  it('reaches Approvals and Active Sessions, which nothing else deep-links', async () => {
    useNav.setState({ aiSection: 'overview' })
    const { container } = render(<CommandPalette />)

    await userEvent.click(aiEntry(container, 'Approvals'))
    expect(useNav.getState().aiSection).toBe('approvals')

    const second = render(<CommandPalette />)
    await userEvent.click(aiEntry(second.container, 'Active Sessions'))
    expect(useNav.getState().aiSection).toBe('sessions')
    expect(useApp.getState().activity).toBe('ai')
  })

  it('names each page the way the panel names it', () => {
    // One record, read by both. The panel used to keep its own copy, which is
    // what let the palette have none.
    const { container } = render(<CommandPalette />)
    const named = [...container.querySelectorAll('.palette-item')]
      .filter((el) => el.querySelector('.p-sub')?.textContent === 'AI & MCP')
      .map((el) => el.querySelector('.p-title')?.textContent)
    expect(named).toEqual(AI_SECTIONS.map((id) => AI_SECTION_LABELS[id]))
  })
})
