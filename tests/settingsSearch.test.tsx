// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { Settings, searchSettings } from '../src/renderer/src/components/settings/Settings'
import { useNav } from '../src/renderer/src/store/nav'

// Reported from the running app: "there is no background checking settings and
// no way to search it in the monitoring settings panel".
//
// Both halves are worth keeping honest, and they are different failures. There
// was no search at all — fourteen sections, each of them long, and the only way
// in was to already know which one owned the row you wanted. And the setting
// the user was looking for DOES exist: it is called "Check servers in the
// background", so a search box on its own would still have returned nothing for
// the words they typed. The vocabulary the app uses in its own prose —
// "background checking" — is not in the row's label.
//
// So these tests are about the words, not about the widget. The queries below
// are the ones a person types; every one of them has to reach the same toggle.

beforeEach(() => {
  stubBridge({
    autoStart: { get: () => Promise.resolve({ supported: false, reason: 'not here' }) },
    updates: { state: () => Promise.resolve(null), onState: () => () => undefined }
  })
})

const TOGGLE = 'Check servers in the background'

describe('the words people actually type reach the setting', () => {
  // The reported phrase, its plural, and the one that quotes the label back.
  it.each(['background checking', 'background checks', 'background check', 'check servers'])(
    '“%s” finds the background-checking toggle',
    (query) => {
      const titles = searchSettings(query).map((e) => e.title)
      expect(titles).toContain(TOGGLE)
    }
  )

  it('sends it to the section that owns it', () => {
    const hit = searchSettings('background checking').find((e) => e.title === TOGGLE)
    expect(hit?.section).toBe('monitoring')
  })

  // Anti-vacuity: a matcher that returned everything would pass every test
  // above and be useless in the product.
  it('does not return the whole list for any of them', () => {
    const all = searchSettings('e').length
    expect(searchSettings('background checking').length).toBeLessThan(all)
    expect(searchSettings('zzzz')).toEqual([])
  })

  // Every word has to appear somewhere: two terms narrow rather than widen.
  it('narrows as words are added rather than accumulating matches', () => {
    expect(searchSettings('webhook recovers').map((e) => e.title)).toEqual([
      'Also send when it recovers'
    ])
  })

  // The index doubles as the jump target: a result finds its row again by
  // matching this string against the rendered `.s-title`. A title invented here
  // navigates to the right page and then silently highlights nothing.
  it('indexes the label the row actually renders', () => {
    const src = readSettingsSource()
    for (const entry of searchSettings('background checking')) {
      expect(src, entry.title).toContain(entry.title)
    }
  })
})

function readSettingsSource(): string {
  return readFileSync(join(__dirname, '../src/renderer/src/components/settings/Settings.tsx'), 'utf8')
}

describe('the settings screen can be searched', () => {
  it('offers a search box', () => {
    render(<Settings />)
    expect(screen.getByLabelText('Search settings')).not.toBeNull()
  })

  it('lists the background-checking toggle, with the page it is on', async () => {
    render(<Settings />)
    await userEvent.type(screen.getByLabelText('Search settings'), 'background checking')

    const hit = screen.getByRole('option', { name: /Check servers in the background/ })
    // Which page it will take you to, before you press it.
    expect(hit.textContent).toContain('Monitoring')
  })

  it('takes you to the section and marks the row it sent you to', async () => {
    render(<Settings />)
    await userEvent.type(screen.getByLabelText('Search settings'), 'background checks')
    await userEvent.click(screen.getByRole('option', { name: /Check servers in the background/ }))

    expect(useNav.getState().settingsSection).toBe('monitoring')
    // The row, not just the page: Monitoring is long enough that arriving at
    // the top of it is arriving somewhere else.
    const marked = document.querySelector('.setting-row.setting-hit')
    expect(marked?.textContent).toContain(TOGGLE)
    // The result list gives the section list back rather than standing over
    // the page it just jumped to.
    expect(document.querySelector('.settings-results')).toBeNull()
  })

  it('says so when nothing matches instead of showing an empty box', async () => {
    render(<Settings />)
    await userEvent.type(screen.getByLabelText('Search settings'), 'qqqqzz')
    expect(document.querySelector('.settings-results')?.textContent).toContain('No setting matches')
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)
  })
})
