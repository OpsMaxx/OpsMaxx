// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ActivityBar } from '../src/renderer/src/components/layout/ActivityBar'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import { ISSUES_URL } from '../src/renderer/src/lib/reportBug'
import { useToasts } from '../src/renderer/src/store/toast'

// Reporting a bug was seven steps across two applications, and step one was
// knowing to look in Settings > Advanced. Nothing anywhere in the app said
// "report a bug" or pointed at the issue tracker at all.
//
// So what is asserted here is the whole click, not its parts: the diagnostics
// land in a FILE and on the clipboard AND the issue form opens AND the user is
// told which of those just happened. A test that only checked the copy would
// have passed on the day this feature did not exist.

const DIAGNOSTICS = 'OpsMaxx diagnostics\nversion: 0.36.12\n'

/** What the download half did, recorded off a fake anchor.
 *
 *  `document.createElement` is stubbed rather than letting a real anchor be
 *  clicked: jsdom treats a click on an `<a href>` as a navigation it has not
 *  implemented, so a real one would pass while writing a warning instead of a
 *  file, and the name and the body are exactly what has to be asserted. */
interface Download {
  name: string | null
  body: string | null
  type: string | null
}

/** The bridge slice this path uses, with every half recorded.
 *
 *  `objectUrl: 'throw'` stands for every environment where the download cannot
 *  happen -- no `createObjectURL`, downloads switched off -- which must cost
 *  the user the file and nothing else. */
function stub(
  text: string | null = DIAGNOSTICS,
  objectUrl: 'ok' | 'throw' = 'ok'
): {
  write: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  download: Download
} {
  const write = vi.fn()
  stubBridge({
    clipboard: { write },
    // `null` stands for the two ways the text can be unavailable: an old
    // preload with no `text` method, and a collector that threw.
    ...(text === null ? {} : { diagnostics: { text: vi.fn().mockResolvedValue(text) } })
  })
  const open = vi.fn().mockReturnValue(null)
  vi.spyOn(window, 'open').mockImplementation(open as unknown as typeof window.open)

  const download: Download = { name: null, body: null, type: null }
  const revoke = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      if (objectUrl === 'throw') throw new Error('createObjectURL is not available')
      download.type = blob.type
      void blob.text().then((t) => {
        download.body = t
      })
      return 'blob:diagnostics'
    }
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke })

  const real = document.createElement.bind(document)
  // Cast because Electron widens `createElement`'s overloads with `webview`,
  // and a general implementation cannot satisfy that one signature.
  vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    opts?: ElementCreationOptions
  ): HTMLElement => {
    const el = real(tag, opts) as HTMLElement
    if (tag === 'a') {
      // Swallow the click so jsdom never tries to follow the blob: URL, and
      // record the filename the user would have got.
      el.click = (): void => {
        download.name = (el as HTMLAnchorElement).download
      }
    }
    return el
  }) as typeof document.createElement)

  return { write, open, download }
}

const messages = (): string[] => useToasts.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('one click reports a bug from the activity bar', () => {
  const button = (): HTMLElement => screen.getByRole('button', { name: /^Report a bug/ })

  it('is on the rail without anything being opened first', () => {
    stub()
    render(<ActivityBar />)
    // The whole point: found by someone who has not opened Settings, does not
    // know the palette exists, and has never seen the crash card.
    expect(button().getAttribute('title')).toContain('saves and copies your diagnostics')
    expect(button().getAttribute('title')).toContain('opens the issue form')
  })

  it('saves the diagnostics, copies them and opens the issue form on the one press', async () => {
    const { write, open, download } = stub()
    render(<ActivityBar />)

    await userEvent.click(button())

    await waitFor(() => expect(write).toHaveBeenCalledWith(DIAGNOSTICS))
    await waitFor(() => expect(download.body).toBe(DIAGNOSTICS))
    expect(open).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer')
  })

  it('writes a dated .txt the reporter can attach without opening it first', async () => {
    const { download } = stub()
    render(<ActivityBar />)

    await userEvent.click(button())

    // `.txt` and `text/plain`, because the payload is `key: value` lines and an
    // attachment named for anything else invites GitHub, an editor or the
    // reporter to render it as something it is not.
    await waitFor(() => expect(download.name).toMatch(/^opsmaxx-diagnostics-\d{4}-\d{2}-\d{2}\.txt$/))
    expect(download.type).toBe('text/plain')
  })

  it('starts the download before the browser tab takes the focus', async () => {
    const calls: string[] = []
    const { open, download } = stub()
    Object.defineProperty(download, 'name', {
      configurable: true,
      set() {
        calls.push('download')
      },
      get: () => null
    })
    ;(open as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('open')
      return null
    })
    render(<ActivityBar />)

    await userEvent.click(button())

    // The order is the feature: a form opened first steals the focus and the
    // save is the half that loses.
    await waitFor(() => expect(calls).toEqual(['download', 'open']))
  })

  it('still copies and still opens when the file cannot be written', async () => {
    const { write, open, download } = stub(DIAGNOSTICS, 'throw')
    render(<ActivityBar />)

    await userEvent.click(button())

    // No `createObjectURL`, or downloads switched off. That costs the user the
    // attachment and must cost them nothing else.
    await waitFor(() => expect(write).toHaveBeenCalledWith(DIAGNOSTICS))
    expect(download.name).toBeNull()
    expect(open).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer')
    expect(messages()[0]).toMatch(/clipboard/i)
    expect(messages()[0]).not.toMatch(/download/i)
  })

  it('names the file, the clipboard and the form it just opened', async () => {
    stub()
    render(<ActivityBar />)

    await userEvent.click(button())

    await waitFor(() => expect(messages()).toHaveLength(1))
    const [said] = messages()
    // Every half of what just happened. A toast that only said "Copied" would
    // leave the browser tab unexplained, one that only said "Opened" would
    // leave the user retyping their version numbers by hand, and one that never
    // mentioned the download leaves a file in their downloads folder they did
    // not ask for and cannot account for.
    expect(said).toMatch(/downloads/i)
    expect(said).toMatch(/attach/i)
    expect(said).toMatch(/clipboard/i)
    expect(said).toMatch(/paste/i)
    expect(said).toMatch(/issue form/i)
  })

  it('still opens the form when the diagnostics cannot be collected', async () => {
    const { write, open, download } = stub(null)
    render(<ActivityBar />)

    await userEvent.click(button())

    // A user who pressed this has a bug to report. Losing the version block is
    // a reason to say so, not a reason for the button to do nothing.
    await waitFor(() => expect(open).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer'))
    expect(write).not.toHaveBeenCalled()
    // And nothing is written either: an empty file in the downloads folder is
    // worse than no file, because it is the one the reporter would attach.
    expect(download.name).toBeNull()
    expect(messages()[0]).toMatch(/Settings > Advanced/)
  })
})

describe('the issue form is opened empty', () => {
  // This is a constraint, not a style choice, and it is easy to "improve" away.
  // A pre-filled body puts the diagnostics in the address bar, the browser's
  // history and every proxy log on the way, and GitHub truncates a long URL —
  // so the [config] section, the half that four bugs needed, is exactly the
  // part that would vanish. The clipboard has neither problem.
  it('carries no query string and no fragment', () => {
    const url = new URL(ISSUES_URL)
    expect(url.search).toBe('')
    expect(url.hash).toBe('')
    expect(url.pathname).toBe('/OpsMaxx/OpsMaxx/issues/new/choose')
  })

  it('points at the chooser, not at a template', () => {
    expect(ISSUES_URL).toBe('https://github.com/OpsMaxx/OpsMaxx/issues/new/choose')
  })
})

describe('the palette reaches it too', () => {
  const entry = (container: HTMLElement): HTMLElement => {
    const hit = [...container.querySelectorAll('.palette-item')].find(
      (el) => el.querySelector('.p-title')?.textContent === 'Report a bug'
    )
    expect(hit, 'the palette has no "Report a bug" entry').toBeTruthy()
    return hit as HTMLElement
  }

  it('lists it under Actions', () => {
    stub()
    const { container } = render(<CommandPalette />)
    const groups = [...container.querySelectorAll('.palette-group')].map((el) => el.textContent)
    expect(groups).toContain('Actions')
    expect(entry(container)).toBeTruthy()
  })

  it('does the same one thing the rail button does', async () => {
    const { write, open, download } = stub()
    const { container } = render(<CommandPalette />)

    await userEvent.click(entry(container))

    await waitFor(() => expect(write).toHaveBeenCalledWith(DIAGNOSTICS))
    await waitFor(() => expect(download.body).toBe(DIAGNOSTICS))
    expect(open).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer')
  })
})
