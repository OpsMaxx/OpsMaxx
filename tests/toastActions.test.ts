import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast, useToasts } from '../src/renderer/src/store/toast'

// The toast store is the whole reason an error can offer a way out.
//
// It used to take a string and delete itself after 3.2 seconds, so a message
// could only ever describe a problem. "Unlock the vault and try again" left the
// reader to work out what a vault is, find it, unlock it, come back, and
// remember what they had been doing. These tests pin the properties that stop
// that happening again: an action survives to the view, a failed message does
// not disappear while it is being read, an actionable one stays long enough to
// be reached, and one problem reads as one problem.
//
// The correction since: having a button no longer makes a message permanent.
// It used to, and a session's worth of "An AI agent changed the server X."
// acknowledgements — each with a Show it link nobody wanted to click — stacked
// up until every one was dismissed by hand. A button buys a longer window, not
// immortality; only an error, or an explicit opt-in, stays.
//
// A plain zustand store, so it runs in the node environment the rest of the
// suite uses — no DOM required.

beforeEach(() => {
  useToasts.getState().clear()
  vi.useRealTimers()
})

describe('actions', () => {
  it('carries the action through to the view', () => {
    const run = vi.fn()
    toast('The vault is locked.', 'error', { label: 'Unlock vault', run })

    const [t] = useToasts.getState().toasts
    expect(t.action?.label).toBe('Unlock vault')
    t.action?.run()
    expect(run).toHaveBeenCalledOnce()
  })

  it('does not make an informational message permanent just for having a button', () => {
    toast('Imported. Confirm what each proxy exposes.', 'info', {
      label: 'Open profile',
      run: () => undefined
    })
    expect(useToasts.getState().toasts[0].sticky).toBe(false)
  })
})

describe('lifetime', () => {
  it('keeps errors until they are dismissed', () => {
    vi.useFakeTimers()
    toast('No response from the server.', 'error')
    vi.advanceTimersByTime(60_000)
    expect(useToasts.getState().toasts).toHaveLength(1)
  })

  it('still lets a plain confirmation go away by itself', () => {
    vi.useFakeTimers()
    toast('office saved', 'ok')
    expect(useToasts.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })

  it('gives a message with a button long enough to reach the button', () => {
    // The window a plain confirmation gets is enough to read a sentence and not
    // enough to decide to click something at the end of it. So an actionable
    // message outlives that window -- and still goes away on its own.
    vi.useFakeTimers()
    toast('An AI agent changed the server web-01.', 'ok', {
      label: 'Show it',
      run: () => undefined
    })
    vi.advanceTimersByTime(5_000)
    expect(useToasts.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })

  it('keeps a message that explicitly asks to stay', () => {
    // The kill switch summary is the one non-error that earns this: every agent
    // in the workspace was just cut off, and the counts have to survive an
    // operator who pressed the button and looked away.
    vi.useFakeTimers()
    toast('Stopped every agent: 2 session(s) revoked.', 'ok', undefined, { sticky: true })
    vi.advanceTimersByTime(60_000)
    expect(useToasts.getState().toasts).toHaveLength(1)
  })

  it('dismisses on request', () => {
    toast('No response from the server.', 'error')
    const { id } = useToasts.getState().toasts[0]
    useToasts.getState().dismiss(id)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })
})

describe('duplicates', () => {
  it('collapses an identical message rather than stacking it', () => {
    // A reconnect loop emits the same sentence repeatedly. Three copies of one
    // problem reads as three problems.
    toast('Lost the connection to the server.', 'error')
    toast('Lost the connection to the server.', 'error')
    toast('Lost the connection to the server.', 'error')
    expect(useToasts.getState().toasts).toHaveLength(1)
  })

  it('keeps the newest action when a message repeats', () => {
    const stale = vi.fn()
    const fresh = vi.fn()
    toast('The vault is locked.', 'error', { label: 'Unlock', run: stale })
    toast('The vault is locked.', 'error', { label: 'Unlock', run: fresh })

    const [t] = useToasts.getState().toasts
    t.action?.run()
    expect(fresh).toHaveBeenCalledOnce()
    expect(stale).not.toHaveBeenCalled()
  })

  it('does not collapse two genuinely different problems', () => {
    toast('No response from the server.', 'error')
    toast('The local port is already in use.', 'error')
    expect(useToasts.getState().toasts).toHaveLength(2)
  })
})
