// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import {
  CloudTargetFields,
  emptyCloudDraft
} from '../src/renderer/src/components/connections/CloudTargetFields'
import type { CloudDraft } from '../src/renderer/src/components/connections/CloudTargetFields'

// Choosing a project out of a thousand.
//
// This field used to be a `<select>` whenever discovery returned anything, and
// a text box only when it returned nothing — so the users with the most
// projects were exactly the ones who could not search. A real account reported
// it with a screenshot of an unsearchable menu.
//
// What is asserted here is that both halves survive together: the list is
// filterable, and a value that is not in the list can still be typed. The
// second half is not hypothetical — enumerating every project in an
// organisation is a broader permission than reaching one instance in it, so
// people who cannot list are people who can still connect.

/** Enough projects that scrolling is not an answer. */
const PROJECTS = Array.from({ length: 1000 }, (_, i) => ({
  id: `proj-${String(i).padStart(4, '0')}`,
  name: i === 7 ? 'Billing Prod' : `Project ${i}`
}))

function stubCloud(accounts: typeof PROJECTS): void {
  stubBridge({
    cloud: {
      detect: vi.fn().mockResolvedValue({
        ok: true,
        value: { installed: true, path: '/usr/bin/gcloud', version: '1.0.0' }
      }),
      authStatus: vi.fn().mockResolvedValue({
        ok: true,
        value: { authenticated: true, account: 'someone@example.com' }
      }),
      accounts: vi.fn().mockResolvedValue({ ok: true, value: accounts }),
      locations: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      instances: vi.fn().mockResolvedValue({ ok: true, value: [] })
    }
  })
}

/** Renders the form and keeps the draft in a closure, the way the dialog does. */
function renderFields(): { draft: () => CloudDraft } {
  let draft: CloudDraft = { ...emptyCloudDraft }
  const view = render(<CloudTargetFields provider="gcp" draft={draft} onChange={() => {}} />)
  const rerender = (next: CloudDraft): void => {
    draft = next
    view.rerender(<CloudTargetFields provider="gcp" draft={draft} onChange={rerender} />)
  }
  view.rerender(<CloudTargetFields provider="gcp" draft={draft} onChange={rerender} />)
  return { draft: () => draft }
}

describe('picking a cloud project', () => {
  it('is a text box, not a menu, even once a thousand projects have loaded', async () => {
    stubCloud(PROJECTS)
    renderFields()

    // The field is an <input>. A <select> has no placeholder and cannot be
    // typed into, which is the whole defect.
    const field = await screen.findByLabelText('Project')
    expect(field.tagName).toBe('INPUT')
  })

  it('filters on what is typed, matching the name as well as the id', async () => {
    stubCloud(PROJECTS)
    const user = userEvent.setup()
    const { draft } = renderFields()

    const field = await screen.findByLabelText('Project')
    await user.type(field, 'Billing')

    // Typing the display name finds the row whose id looks nothing like it.
    await waitFor(() => expect(screen.getByText('Billing Prod')).toBeTruthy())
    await user.click(screen.getByText('Billing Prod'))

    // What lands in the draft is the id, because that is what the CLI is given.
    await waitFor(() => expect(draft().account).toBe('proj-0007'))
  })

  it('still accepts a project that discovery never returned', async () => {
    // The case that makes this a text box at all: no permission to list.
    stubCloud([])
    const user = userEvent.setup()
    const { draft } = renderFields()

    const field = await screen.findByLabelText('Project')
    await user.type(field, 'locked-down-1234')

    await waitFor(() => expect(draft().account).toBe('locked-down-1234'))
  })
})

// THE PREVIEW IS UNDER A COPY BUTTON, SO IT IS SHELL INPUT.
//
// The argv was joined with plain spaces. The placeholders contain spaces and
// angle brackets, so pasting "--key-file=<temporary public key>" made zsh
// redirect stdin from a file named `temporary` — "zsh: no such file or
// directory: temporary", which is what a user hit. The Azure line was worse:
// "<temporary directory>/config" contains a `>`, so pasting it redirected
// stdout and CREATED a file instead of failing.
//
// Identifiers here are invented. This repo is public and fixtures do not carry
// real project or instance names.
describe('the command preview', () => {
  async function previewText(): Promise<string> {
    stubCloud([{ id: 'proj-1', name: 'Project One' }])
    const user = userEvent.setup()
    let draft: CloudDraft = {
      ...emptyCloudDraft,
      account: 'proj-1',
      location: 'europe-west1-b',
      instance: 'vm-1'
    }
    const view = render(<CloudTargetFields provider="gcp" draft={draft} onChange={() => {}} />)
    const rerender = (next: CloudDraft): void => {
      draft = next
      view.rerender(<CloudTargetFields provider="gcp" draft={draft} onChange={rerender} />)
    }
    view.rerender(<CloudTargetFields provider="gcp" draft={draft} onChange={rerender} />)

    await user.click(await screen.findByText('What OpsMaxx will run'))
    const pre = document.querySelector('pre')
    return pre?.textContent ?? ''
  }

  it('quotes the placeholder instead of handing the shell a redirect', async () => {
    const text = await previewText()
    expect(text).toContain('temporary public key')
    // The failure was an unquoted `<`. Quoted, the whole argument is one token.
    expect(text).toContain("'--key-file=<temporary public key>'")
  })

  it('leaves no bare redirect anywhere a reader could paste', async () => {
    const text = await previewText()
    for (const line of text.split('\n')) {
      // Strip quoted runs, then look for what the shell would still act on.
      const unquoted = line.replace(/'[^']*'/g, '')
      expect(unquoted, `redirect left in: ${line}`).not.toMatch(/[<>]/)
    }
  })

  it('does not quote ordinary arguments, which would only make it noisy', async () => {
    const text = await previewText()
    expect(text).toContain('--zone europe-west1-b')
    expect(text).not.toContain("'--zone'")
  })
})
