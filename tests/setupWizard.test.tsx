// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SetupCard } from '../src/renderer/src/components/onboarding/SetupCard'
import { SETUP_QUESTIONS } from '../src/renderer/src/components/onboarding/setupQuestions'
import { useApp } from '../src/renderer/src/store/app'
import { useOnboarding } from '../src/renderer/src/store/onboarding'
import { useUpdater } from '../src/renderer/src/store/updater'
import { MODULES, moduleEnabled } from '../src/shared/modules'

/**
 * The first run, as a wizard.
 *
 * `tests/setupQuestions.test.ts` pins the DATA: that the default answers name
 * only modules that read. These pin the SCREENS, which is where that guarantee
 * can now be lost without the data changing — the card used to commit on one
 * keystroke and now commits on the sixth, and every assertion below exists
 * because some plausible change to the stepping would break it silently.
 */

const SCREENS = SETUP_QUESTIONS.length + 2

beforeEach(() => {
  useOnboarding.setState({ setupOpen: true, open: false })
})

function pressEnter(times: number): void {
  for (let i = 0; i < times; i++) fireEvent.keyDown(window, { key: 'Enter' })
}

/** What a no-read commit is allowed to have turned on. */
function expectReadOnlyDefaults(): void {
  const modules = useApp.getState().settings.modules
  expect(moduleEnabled(modules, 'docker')).toBe(true)
  expect(moduleEnabled(modules, 'kubernetes')).toBe(true)
  for (const m of MODULES) {
    if (m.surface === 'operate') expect(moduleEnabled(modules, m.id)).toBe(false)
  }
  expect(moduleEnabled(modules, 'inventory')).toBe(false)
  expect(moduleEnabled(modules, 'posture')).toBe(false)
}

describe('committing without reading', () => {
  it('still turns on nothing that writes to a server', () => {
    // The whole point of the conversion. Six Enters have to land where one used
    // to; anyone who "helpfully" makes Enter mean Yes fails here.
    render(<SetupCard />)
    pressEnter(SCREENS)
    expect(useOnboarding.getState().setupOpen).toBe(false)
    expectReadOnlyDefaults()
  })

  it('lets Escape commit from the very first screen', () => {
    // Escape now accepts the defaults for four questions the user never saw. It
    // is safe for exactly one reason: those defaults only ever read.
    render(<SetupCard />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useOnboarding.getState().setupOpen).toBe(false)
    expectReadOnlyDefaults()
  })

  it('does not let a held Enter run the whole card', () => {
    render(<SetupCard />)
    for (let i = 0; i < SCREENS; i++) fireEvent.keyDown(window, { key: 'Enter', repeat: true })
    expect(useOnboarding.getState().setupOpen).toBe(true)
  })

  it('commits nothing before the last screen', () => {
    const before = useApp.getState().settings.modules
    render(<SetupCard />)
    pressEnter(SCREENS - 1)
    expect(useOnboarding.getState().setupOpen).toBe(true)
    expect(useApp.getState().settings.modules).toBe(before)
  })
})

describe('one question per screen', () => {
  it('opens on the role question, not the modules', () => {
    render(<SetupCard />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What do you do?')
    for (const q of SETUP_QUESTIONS) expect(screen.queryByText(q.question)).toBeNull()
  })

  it('shows exactly one question at a time', () => {
    render(<SetupCard />)
    pressEnter(1)
    const showing = SETUP_QUESTIONS.filter((q) => screen.queryByText(q.question) !== null)
    expect(showing).toHaveLength(1)
    expect(showing[0].id).toBe(SETUP_QUESTIONS[0].id)
  })

  it('states the cost of every answer on its own screen', () => {
    // The security disclosure. Fails if anyone later tucks `cost` into a
    // `title=` attribute or behind a <details>, which is the shape of change
    // that makes a wizard feel tidier and the product less honest.
    render(<SetupCard />)
    for (const q of SETUP_QUESTIONS) {
      pressEnter(1)
      expect(screen.getByText(q.cost)).toBeTruthy()
    }
  })

  it('says where you are', () => {
    render(<SetupCard />)
    expect(screen.getByText(`Step 1 of ${SCREENS}`)).toBeTruthy()
    pressEnter(1)
    expect(screen.getByText(`Step 2 of ${SCREENS}`)).toBeTruthy()
  })

  it('moves focus to each new question', () => {
    render(<SetupCard />)
    pressEnter(1)
    expect(document.activeElement?.textContent).toBe(SETUP_QUESTIONS[0].question)
  })
})

describe('answering', () => {
  it('records the answer when Enter activates the button rather than the heading', () => {
    // A focused button fires its own click on Enter, so the window-level handler
    // has to stand down and let the native activation through. Without that
    // guard the keystroke advances the screen first, the question remounts, and
    // the click then lands on a detached node -- the user pressed Enter on "No"
    // and moved on, and their No was never recorded.
    //
    // Fired as the two raw events a browser fires. `userEvent.keyboard` cannot
    // reproduce it: it re-reads focus between the keydown and the click, and by
    // then the component has moved focus to the next heading.
    render(<SetupCard />)
    pressEnter(1)
    const no = screen.getByRole('radio', { name: 'No' })
    fireEvent.keyDown(no, { key: 'Enter' })
    fireEvent.click(no)
    // One screen on, and the answer went with it.
    expect(screen.queryByText(SETUP_QUESTIONS[1].question)).toBeTruthy()
    pressEnter(SCREENS - 2)
    expect(moduleEnabled(useApp.getState().settings.modules, 'docker')).toBe(false)
  })

  it('comes back with the answer intact', async () => {
    const user = userEvent.setup()
    render(<SetupCard />)
    pressEnter(1)
    await user.click(screen.getByRole('radio', { name: 'No' }))
    await user.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByRole('radio', { name: 'No' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Yes' }).getAttribute('aria-checked')).toBe('false')
  })

  it('records an answer changed on the way through', async () => {
    const user = userEvent.setup()
    render(<SetupCard />)
    pressEnter(1)
    // Question one is `containers`, preselected true. Answer no.
    await user.click(screen.getByRole('radio', { name: 'No' }))
    pressEnter(SCREENS - 2)
    expect(moduleEnabled(useApp.getState().settings.modules, 'docker')).toBe(false)
  })
})

describe('the review screen', () => {
  it('lists every answer and goes back to the one you click', async () => {
    const user = userEvent.setup()
    render(<SetupCard />)
    pressEnter(SCREENS - 1)
    for (const q of SETUP_QUESTIONS) expect(screen.getByText(q.question)).toBeTruthy()
    await user.click(screen.getByText(SETUP_QUESTIONS[2].question))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      SETUP_QUESTIONS[2].question
    )
  })
})

describe('preferences nobody opened', () => {
  it('writes none of them', () => {
    // The trap at the top of setupQuestions.ts: `AppSettings` is persisted
    // wholesale, so a value written here outranks a later change to the default
    // for the life of the install. `setupPatch` is unit-tested; this proves the
    // WIZARD never hands it a materialised default on its way past.
    const before = useApp.getState().settings
    const updatesBefore = useUpdater.getState().prefs
    render(<SetupCard />)
    pressEnter(SCREENS)
    const after = useApp.getState().settings
    for (const k of [
      'compactDensity',
      'fleetSamplingEnabled',
      'fleetSamplingIntervalMs',
      'resourceAlertsEnabled',
      'resourceAlertThreshold'
    ] as const) {
      expect(after[k]).toBe(before[k])
    }
    expect(useUpdater.getState().prefs).toBe(updatesBefore)
  })

  it('writes none of them when the role screen is skipped', async () => {
    const user = userEvent.setup()
    const before = useApp.getState().settings.fleetSamplingEnabled
    render(<SetupCard />)
    expect(screen.getByRole('button', { name: /Skip/ })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Skip/ }))
    pressEnter(SCREENS - 1)
    expect(useApp.getState().settings.fleetSamplingEnabled).toBe(before)
  })
})

describe('personas', () => {
  it('fill the questions ahead and their one preference', async () => {
    const user = userEvent.setup()
    render(<SetupCard />)
    await user.click(screen.getByRole('button', { name: /SRE \/ on-call/ }))
    // Still on the role screen: picking one fills in four questions the user has
    // not seen, and skipping off the screen would hide the only thing it did.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What do you do?')
    pressEnter(1)
    expect(screen.getByRole('radio', { name: 'Yes' }).getAttribute('aria-checked')).toBe('true')
    pressEnter(SCREENS - 1)
    const modules = useApp.getState().settings.modules
    expect(moduleEnabled(modules, 'inventory')).toBe(true)
    expect(useApp.getState().settings.fleetSamplingEnabled).toBe(true)
  })
})
