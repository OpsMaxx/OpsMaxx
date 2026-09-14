// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ActivityBar } from '../src/renderer/src/components/layout/ActivityBar'
import { CommandPalette } from '../src/renderer/src/components/palette/CommandPalette'
import { ReportBugModal } from '../src/renderer/src/components/common/ReportBugModal'
import { ISSUES_BASE, ISSUE_TEMPLATE, issueUrl } from '../src/renderer/src/lib/reportBug'
import { useApp } from '../src/renderer/src/store/app'
import { useToasts } from '../src/renderer/src/store/toast'

// Reporting a bug was seven steps across two applications, and step one was
// knowing to look in Settings > Advanced. Then it became one silent click that
// wrote a file into the downloads folder nobody had agreed to and claimed the
// file had been saved whenever nothing had thrown -- including every time the
// user cancelled the save dialog.
//
// So what is asserted here is the CONSENT and the HONESTY, not just the effect:
// nothing is written and no browser opens until the user has had the text on
// screen and pressed the button under it, and what the app then says about the
// file is what actually happened to it.

const BUNDLE = {
  text: 'OpsMaxx bug report\nversion: 0.36.12\n\n[trace]\n  {"event":"ipc"}\n',
  version: '0.36.12',
  os: 'macOS' as const,
  events: 1,
  truncated: false
}

type SaveResult =
  | { ok: true; path: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }

/** The debug slice the modal uses, with every half recorded.
 *
 *  `build: null` stands for the two ways the report can be unavailable: an old
 *  preload with no `build` method, and a collector in main that threw. */
function stub(
  save: SaveResult = { ok: true, path: '/Users/x/Downloads/opsmaxx-bug-report-2026-01-01.txt' },
  build: typeof BUNDLE | null = BUNDLE
): {
  saveFn: ReturnType<typeof vi.fn>
  buildFn: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
} {
  const buildFn = vi.fn().mockResolvedValue(build)
  const saveFn = vi.fn().mockResolvedValue(save)
  stubBridge({
    ...(build === null ? {} : { debug: { build: buildFn, save: saveFn, event: vi.fn() } })
  })
  const open = vi.fn().mockReturnValue(null)
  vi.spyOn(window, 'open').mockImplementation(open as unknown as typeof window.open)
  return { saveFn, buildFn, open }
}

const messages = (): string[] => useToasts.getState().toasts.map((t) => t.message)

beforeEach(() => {
  vi.restoreAllMocks()
  useToasts.getState().clear()
  useApp.getState().setModal(null)
  useApp.getState().setSettings({ debugLogEnabled: false })
})

describe('the bug button opens the report dialog', () => {
  const button = (): HTMLElement => screen.getByRole('button', { name: /^Report a bug/ })

  it('is on the rail without anything being opened first', () => {
    stub()
    render(<ActivityBar />)
    // The whole point: found by someone who has not opened Settings, does not
    // know the palette exists, and has never seen the crash card.
    expect(button().getAttribute('title')).toContain('read before you send')
  })

  it('says it is recording while debug mode is on, on the control that stops it', () => {
    stub()
    useApp.getState().setSettings({ debugLogEnabled: true })
    render(<ActivityBar />)
    // A capture running silently is the failure mode this indicator exists for,
    // and the sentence is on the button because a bare dot reads equally as
    // "recording" and as "something is broken".
    expect(button().getAttribute('title')).toContain('recording')
  })

  it('opens the dialog and writes nothing on the press itself', async () => {
    const { saveFn, open } = stub()
    render(<ActivityBar />)

    await userEvent.click(button())

    await waitFor(() => expect(useApp.getState().modal).toBe('report-bug'))
    // The press used to save a file, overwrite the clipboard and open a browser
    // tab before the user had seen anything. None of that may happen here.
    expect(saveFn).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('the palette reaches the same dialog', async () => {
    stub()
    const { container } = render(<CommandPalette />)
    const hit = [...container.querySelectorAll('.palette-item')].find(
      (el) => el.querySelector('.p-title')?.textContent === 'Report a bug'
    )
    expect(hit, 'the palette has no "Report a bug" entry').toBeTruthy()

    await userEvent.click(hit as HTMLElement)

    // Both entry points call the one function, so neither can drift.
    await waitFor(() => expect(useApp.getState().modal).toBe('report-bug'))
  })
})

describe('the report is read before it is written', () => {
  const saveButton = (): HTMLElement => screen.getByRole('button', { name: /Save report/ })

  it('shows the whole report, including the trace', async () => {
    stub()
    render(<ReportBugModal />)

    // The preview is a GATE here rather than the courtesy it is for the
    // diagnostics block: the trace carries error text, and an error names the
    // host it failed to reach.
    await waitFor(() => expect(screen.getByText(/\[trace\]/)).toBeTruthy())
  })

  it('warns that a hostname cannot be filtered out', async () => {
    stub()
    render(<ReportBugModal />)

    // The diagnostics block may promise "counts and on/off states only". This
    // may not, and the difference has to be on screen rather than in a comment.
    const said = document.body.textContent ?? ''
    expect(said).toMatch(/hostnames/i)
    expect(said).toMatch(/a hostname cannot be/i)
  })

  it('saves nothing and opens nothing until the button under the preview is pressed', async () => {
    const { saveFn, open } = stub()
    render(<ReportBugModal />)

    await waitFor(() => expect(saveButton()).toBeTruthy())
    expect(saveFn).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the issue form only after the file is really written', async () => {
    const { saveFn, open } = stub()
    render(<ReportBugModal />)
    await waitFor(() => expect(saveButton()).toBeTruthy())

    await userEvent.click(saveButton())

    await waitFor(() => expect(saveFn).toHaveBeenCalledWith(BUNDLE.text))
    expect(open).toHaveBeenCalledWith(
      issueUrl(BUNDLE.version, BUNDLE.os),
      '_blank',
      'noopener,noreferrer'
    )
    // And it names the path it actually wrote, which is the half the old toast
    // could not do because it never had one.
    await waitFor(() =>
      expect(document.body.textContent).toContain('opsmaxx-bug-report-2026-01-01.txt')
    )
  })

  it('says CANCELLED when the user cancels the dialog, and opens no browser', async () => {
    const { open } = stub({ ok: false, cancelled: true })
    render(<ReportBugModal />)
    await waitFor(() => expect(saveButton()).toBeTruthy())

    await userEvent.click(saveButton())

    // This is the bug the old path had: `saveDiagnosticsFile` returned true
    // whenever nothing threw, so a cancelled save was reported as a file in the
    // downloads folder that did not exist.
    await waitFor(() => expect(messages()[0]).toMatch(/cancelled/i))
    expect(messages()[0]).toMatch(/not saved/i)
    // And no path is named, because there is no file to name. The old toast
    // named the downloads folder either way.
    expect(document.body.textContent).not.toMatch(/Saved to/)
    expect(open).not.toHaveBeenCalled()
  })

  it('says why when the write fails', async () => {
    const { open } = stub({ ok: false, error: 'EACCES: permission denied' })
    render(<ReportBugModal />)
    await waitFor(() => expect(saveButton()).toBeTruthy())

    await userEvent.click(saveButton())

    await waitFor(() => expect(messages()[0]).toMatch(/EACCES/))
    expect(open).not.toHaveBeenCalled()
  })

  it('stops the capture when the dialog opens, so the reporter need not remember to', async () => {
    stub()
    useApp.getState().setSettings({ debugLogEnabled: true })
    render(<ReportBugModal />)

    // Pressing Report IS the moment they finished reproducing. It goes through
    // the ordinary setting so main hears about it on the same data:save, and the
    // Settings toggle cannot disagree with the dialog.
    await waitFor(() => expect(useApp.getState().settings.debugLogEnabled).toBe(false))
  })

  it('starts the recording from here, without sending anyone to Settings', async () => {
    stub()
    render(<ReportBugModal />)

    // THE regression this guards. Reporting a bug used to begin with knowing to
    // look in Settings > Advanced, which is a path only somebody who already
    // knows the app can walk. A dialog that asks for a recording and then points
    // at another screen to start one has reinstated exactly that, one step
    // later -- so the control has to be in the step that asks for it.
    const start = screen.getByRole('button', { name: /Start recording/ })
    expect(document.body.textContent).not.toMatch(/Settings . Advanced . Debug mode/)

    await userEvent.click(start)

    await waitFor(() => expect(useApp.getState().settings.debugLogEnabled).toBe(true))
    // And it gets out of the way, because what it just asked for happens in the
    // app rather than in this dialog.
    expect(useApp.getState().modal).toBeNull()
    expect(messages()[0]).toMatch(/reproduce/i)
  })

  it('offers the quick path, and says what it costs, when nothing was recorded', async () => {
    stub()
    render(<ReportBugModal />)

    await waitFor(() => expect(screen.getByText(/Record what the app does/)).toBeTruthy())
    // A report with no trace is still a report; it is the one the old button
    // sent every time. The dialog says what it is missing rather than refusing.
    expect(screen.getByRole('button', { name: /Save report/ })).toBeTruthy()
  })

  it('cannot save when the report could not be collected', async () => {
    stub({ ok: true, path: '/x' }, null)
    render(<ReportBugModal />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save report/ }).hasAttribute('disabled')).toBe(true)
    )
    // There is deliberately no fallback text to save: a file that claims to be
    // a bug report and is not one is worse than no file, because it is the one
    // that gets attached.
    expect(document.body.textContent).toMatch(/could not be collected/i)
  })
})

describe('the issue URL carries the two short fields and nothing else', () => {
  // This was "carries no query string at all", and the reasoning behind that is
  // unchanged and still binding: a pre-filled `?body=` puts the report in the
  // address bar, the browser's history and every proxy log on the way, and
  // GitHub truncates a long URL -- so the [config] section, the half four bugs
  // needed, is exactly the part that would vanish. The file has neither problem.
  //
  // What changed is narrower than it looks. `version` and `os` are two short
  // strings the app already prints on its own Settings screen, bounded by
  // construction -- a semver and one of three literals. The reason a BLOCK
  // cannot go in a URL is its length and its contents, and a version number has
  // neither property. So the rule is not "no query string", it is "these three
  // keys, and never the payload" -- which is what this pins.
  const url = (): URL => new URL(issueUrl('0.40.1', 'macOS'))

  it('permits only template, version and os', () => {
    expect([...url().searchParams.keys()].sort()).toEqual(['os', 'template', 'version'])
  })

  it('never carries a body, a title or a fragment', () => {
    const u = url()
    expect(u.searchParams.get('body')).toBeNull()
    expect(u.searchParams.get('title')).toBeNull()
    expect(u.hash).toBe('')
  })

  it('stays short enough that GitHub cannot truncate anything that matters', () => {
    expect(issueUrl('0.40.1', 'macOS').length).toBeLessThan(300)
  })

  it('points at the bug template, not at the chooser', () => {
    // The chooser asked every reporter to first classify their own bug, which
    // is the question the button they pressed has already answered -- and it
    // takes no parameters, so prefilling anything requires this path.
    expect(url().pathname).toBe('/OpsMaxx/OpsMaxx/issues/new')
    expect(url().searchParams.get('template')).toBe(ISSUE_TEMPLATE)
    expect(ISSUES_BASE).toBe('https://github.com/OpsMaxx/OpsMaxx/issues/new')
  })

  it('prefills field ids the template actually has', () => {
    // GitHub matches a query parameter to an issue-form field by its `id` and
    // silently ignores one that matches nothing. Renaming a field in the
    // template would otherwise break the prefill with no signal anywhere.
    const yml = readFileSync('.github/ISSUE_TEMPLATE/bug_report.yml', 'utf8')
    for (const id of ['version', 'os']) expect(yml).toContain(`id: ${id}`)
    // And `os` is a dropdown, so the value has to be one of its option labels
    // verbatim or it selects nothing at all.
    for (const os of ['Windows', 'macOS', 'Linux']) expect(yml).toContain(os)
  })
})
