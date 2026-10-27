// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { AddySetup, copyPhrase } from '../src/renderer/src/components/addy/AddySetup'
import { PairingPanel, joinerFailure } from '../src/renderer/src/components/addy/PairingPanel'
import { ConflictChooser } from '../src/renderer/src/components/addy/ConflictChooser'
import { AddyPanel } from '../src/renderer/src/components/addy/AddyPanel'
import { deferConflict, holdPhrase, useAddyUi } from '../src/renderer/src/store/addy'
import { useApp } from '../src/renderer/src/store/app'
import { openMonitor } from '../src/renderer/src/store/nav'
import { useToasts } from '../src/renderer/src/store/toast'

/**
 * Sync & devices, second pass: what a render probe found after the first.
 *
 * A relay field that crashed the app on its first keystroke, a code that said
 * leaving the screen ended it when it did not, a joiner left waiting with no
 * clock and no way out, a link acted on before the app knew whether this
 * machine had an account, a conflict dialog that failed silently and did not
 * hold focus, and a recovery review with no exit.
 */

const notEnrolled = {
  enrolled: false,
  sync: { running: false, connected: false, lastSyncAt: null, conflicts: 0 }
}
const enrolled = { ...notEnrolled, enrolled: true, relayURL: 'https://relay.example' }

beforeEach(() => {
  useApp.getState().setSettings({ addyRelayURL: '' })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a half-typed relay address', () => {
  it('does not take the app down', async () => {
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(notEnrolled) } })
    render(<AddySetup />)
    fireEvent.click(await screen.findByRole('button', { name: /already use OpsMaxx/ }))
    fireEvent.change(screen.getByPlaceholderText('https://relay.example'), { target: { value: 'h' } })
    expect(screen.getByRole('button', { name: /Type a code/ })).toBeTruthy()
  })

  it('shows the code without a link rather than throwing', async () => {
    stubBridge({
      addy: {
        beginPairing: vi.fn().mockResolvedValue({ code: 'abcd1234', pairingId: 'wxyz9876' }),
        awaitPairing: vi.fn(() => new Promise(() => {})),
        cancelPairing: vi.fn()
      }
    })
    render(<PairingPanel baseURL="h" />)
    fireEvent.click(screen.getByRole('button', { name: /Show a code/ }))
    expect(await screen.findByText('abcd1234.wxyz9876')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy the pairing link' })).toBeNull()
  })
})

describe('the showing side', () => {
  function showing(): ReturnType<typeof vi.fn> {
    const cancelPairing = vi.fn()
    stubBridge({
      addy: {
        beginPairing: vi.fn().mockResolvedValue({ code: 'abcd1234', pairingId: 'wxyz9876' }),
        awaitPairing: vi.fn(() => new Promise(() => {})),
        cancelPairing
      }
    })
    return cancelPairing
  }

  it('ends the code when the user leaves Sync & devices, as it says', async () => {
    const cancelPairing = showing()
    openMonitor('addy')
    render(<PairingPanel baseURL="https://relay.example" />)
    fireEvent.click(screen.getByRole('button', { name: /Show a code/ }))
    expect(await screen.findByText(/as soon as you leave Sync & devices/)).toBeTruthy()

    act(() => useApp.getState().setActivity('connections'))
    expect(cancelPairing).toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toMatch(/you left Sync & devices/)
  })

  it('does not read the countdown aloud every second, and stops at 0:00 itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const cancelPairing = showing()
    render(<PairingPanel baseURL="https://relay.example" />)
    fireEvent.click(screen.getByRole('button', { name: /Show a code/ }))
    const clock = await screen.findByText(/stops working in 3:00/)
    expect(clock.closest('[role="status"],[aria-live]')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(181_000)
    })
    expect(cancelPairing).toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toMatch(/code ran out/)
  })

  it('says the other device joined, not this one', async () => {
    stubBridge({
      addy: {
        beginPairing: vi.fn().mockResolvedValue({ code: 'abcd1234', pairingId: 'wxyz9876' }),
        awaitPairing: vi.fn().mockResolvedValue({ sas: ['🐶'], sasWords: 'dog', peer: { pubSign: 'aa' } }),
        completePairing: vi.fn().mockResolvedValue(undefined),
        cancelPairing: vi.fn()
      }
    })
    render(<PairingPanel baseURL="https://relay.example" />)
    fireEvent.click(screen.getByRole('button', { name: /Show a code/ }))
    fireEvent.click(await screen.findByRole('button', { name: /They match/ }))
    expect(await screen.findByText('The other device is now on the account.')).toBeTruthy()
  })
})

describe('the joiner after "They match"', () => {
  it('has a clock and a way out while the other device decides', async () => {
    const cancelPairing = vi.fn()
    stubBridge({
      addy: {
        joinPairing: vi.fn().mockResolvedValue({
          sas: ['🐶'],
          sasWords: 'dog',
          peer: { pubSign: 'aa' },
          self: { pubSign: 'bb', pubEnc: 'cc' }
        }),
        finishJoin: vi.fn(() => new Promise(() => {})),
        cancelPairing
      }
    })
    render(<PairingPanel baseURL="https://relay.example" canShow={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Type a code/ }))
    fireEvent.change(screen.getByPlaceholderText('Paste it here'), { target: { value: 'abcd1234.wxyz9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    fireEvent.click(await screen.findByRole('button', { name: /They match/ }))

    expect(
      await screen.findByText(
        (_, el) => el?.tagName === 'P' && /press They match \(3:00 left\)/.test(el.textContent ?? '')
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelPairing).toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Joining stopped/)
  })
})

describe('a link that arrives before the status does', () => {
  it('waits, and then refuses a pair link on a machine already on an account', async () => {
    let answer: (s: unknown) => void = () => {}
    stubBridge({ addy: { status: vi.fn(() => new Promise((r) => (answer = r))) } })
    useAddyUi.setState({
      link: { action: 'pair', relay: 'https://relay.example', code: 'abcd1234', pairingId: 'wxyz9876' }
    })
    render(<AddySetup />)
    // Not acted on yet: nobody knows what this machine is.
    expect(useAddyUi.getState().link).not.toBeNull()
    expect(screen.queryByPlaceholderText('Paste it here')).toBeNull()

    await act(async () => answer(enrolled))
    await waitFor(() => expect(useAddyUi.getState().link).toBeNull())
    expect(screen.queryByPlaceholderText('Paste it here')).toBeNull()
    expect(useToasts.getState().toasts.at(-1)?.message).toMatch(/already on one/)
  })
})

describe('the conflict dialog', () => {
  const conflict = {
    id: 1,
    collection: 'servers',
    device: '',
    createdAt: new Date().toISOString(),
    winning: [1],
    losing: [2]
  }

  it('says when a choice did not go through', async () => {
    stubBridge({
      addy: {
        conflicts: vi.fn().mockResolvedValue([conflict]),
        discardConflict: vi
          .fn()
          .mockRejectedValue(new Error("Error invoking remote method 'addy:discardConflict': AddyError: the relay stopped answering"))
      }
    })
    render(<ConflictChooser />)
    fireEvent.click(await screen.findByRole('button', { name: /Keep the version in use/ }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not finish: the relay stopped answering/)
  })

  it('takes focus on the harmless button, keeps it inside, and gives it back', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    stubBridge({ addy: { conflicts: vi.fn().mockResolvedValue([conflict]) } })
    render(<ConflictChooser />)
    const later = await screen.findByRole('button', { name: 'Decide later' })
    await waitFor(() => expect(document.activeElement).toBe(later))

    // Tab from the last button wraps to the first, not out to the page.
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)

    fireEvent.click(later)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('stops counting a deferred conflict that was resolved elsewhere', async () => {
    deferConflict(1)
    deferConflict(2)
    stubBridge({ addy: { conflicts: vi.fn().mockResolvedValue([{ ...conflict, id: 2 }]) } })
    render(<ConflictChooser />)
    await waitFor(() => expect(useAddyUi.getState().deferredConflicts).toEqual([2]))
  })
})

describe('recovery and the phrase', () => {
  it('has a way out of the recovery review', async () => {
    let push: (s: unknown) => void = () => {}
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue(notEnrolled),
        onStatus: (cb: (s: unknown) => void) => {
          push = cb
          return () => {}
        },
        recover: vi.fn().mockResolvedValue({ devices: 2 })
      }
    })
    render(<AddySetup />)
    fireEvent.click(await screen.findByRole('button', { name: /other devices are gone/ }))
    fireEvent.change(screen.getByPlaceholderText('https://relay.example'), {
      target: { value: 'https://relay.example' }
    })
    fireEvent.change(screen.getByPlaceholderText(/twelve words/), {
      target: { value: 'one two three four five six seven eight nine ten eleven twelve' }
    })
    fireEvent.change(screen.getAllByRole('textbox').at(-1)!, { target: { value: 'laptop' } })
    fireEvent.click(screen.getByRole('button', { name: /Recover this account/ }))
    await screen.findByText('You are back in')
    // Enrolled now, and the review stays until the person is done with it.
    await act(async () => push(enrolled))
    expect(screen.getByText('You are back in')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('heading', { name: 'Add another device' })).toBeTruthy()
  })

  it('focuses the first word, and says which one is wrong and why Done waits', async () => {
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(enrolled) } })
    holdPhrase('one two three four five six seven eight nine ten eleven twelve')
    render(<AddySetup />)
    fireEvent.click(await screen.findByRole('button', { name: /I have written them down/ }))
    const [i] = useAddyUi.getState().checkWords
    const first = screen.getByLabelText(`Word ${i + 1}`)
    expect(document.activeElement).toBe(first)
    expect(screen.getByText(/once all three words match/)).toBeTruthy()

    fireEvent.change(first, { target: { value: 'nope' } })
    expect(first.getAttribute('aria-invalid')).toBe('false')
    fireEvent.blur(first)
    expect(first.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(`That is not word ${i + 1}. Check what you wrote down.`)).toBeTruthy()
  })

  it('takes the copied phrase off the clipboard a minute later, if it is still there', async () => {
    vi.useFakeTimers()
    let held = ''
    const write = vi.fn((t: string) => (held = t))
    stubBridge({ clipboard: { write, read: vi.fn(async () => held) } })
    copyPhrase('one two')
    expect(held).toBe('one two')
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(held).toBe('')

    // Something else copied since: left alone.
    copyPhrase('one two')
    held = 'something else'
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(held).toBe('something else')
  })
})

describe('leaving without being removed', () => {
  it('is not reported in the success colour', async () => {
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue({
          ...enrolled,
          sync: { running: true, connected: true, lastSyncAt: Date.now(), conflicts: 0 }
        }),
        leave: vi.fn().mockResolvedValue({ left: true, accountId: 'a', removedFromRoster: false })
      }
    })
    render(<AddyPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }))
    fireEvent.click(screen.getByRole('button', { name: /Leave the account/ }))
    await waitFor(() => expect(useToasts.getState().toasts.at(-1)?.kind).toBe('error'))
  })
})


describe('pairing says what is at stake', () => {
  const asJoiner = {
    sas: ['🐶'],
    sasWords: 'dog',
    peer: { pubSign: 'aa' },
    self: { pubSign: 'bb', pubEnc: 'cc' }
  }

  function typeCode(): void {
    fireEvent.click(screen.getByRole('button', { name: /Type a code/ }))
    fireEvent.change(screen.getByPlaceholderText('Paste it here'), { target: { value: 'abcd1234.wxyz9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
  }

  it('tells the person holding the code never to give it to anyone, beside the code and the link', async () => {
    stubBridge({
      addy: {
        beginPairing: vi.fn().mockResolvedValue({ code: 'abcd1234', pairingId: 'wxyz9876' }),
        awaitPairing: vi.fn(() => new Promise(() => {})),
        cancelPairing: vi.fn()
      }
    })
    render(<PairingPanel baseURL="https://relay.example" />)
    fireEvent.click(screen.getByRole('button', { name: /Show a code/ }))
    const warning = await screen.findByText(
      (_, el) => el?.tagName === 'P' && /^Never give this code to anyone\./.test(el.textContent ?? '')
    )
    expect(warning.textContent).toMatch(/including whoever runs your relay, will ever ask for it/)
    expect(screen.getByText(/send this link to your other machine, and only to it/)).toBeTruthy()
  })

  it('says what They match grants on the machine showing the code, and what a used code looks like', async () => {
    stubBridge({
      addy: {
        beginPairing: vi.fn().mockResolvedValue({ code: 'abcd1234', pairingId: 'wxyz9876' }),
        awaitPairing: vi.fn().mockResolvedValue({ sas: ['🐶'], sasWords: 'dog', peer: { pubSign: 'aa' } }),
        cancelPairing: vi.fn()
      }
    })
    render(<PairingPanel baseURL="https://relay.example" />)
    fireEvent.click(screen.getByRole('button', { name: /Show a code/ }))
    await screen.findByRole('button', { name: /They match/ })
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/gives that machine everything this account syncs: your servers, settings and vault/)
    expect(text).toMatch(/only if the other screen shows these same emoji/)
    expect(text).toMatch(/still waiting, or shows different emoji, someone else used the code/)
    // It is not "nothing is added until both sides agree": this one press adds.
    expect(text).not.toMatch(/both sides agree/)
  })

  it('shows the joiner which relay it is joining, and not the initiator\'s warning', async () => {
    stubBridge({ addy: { joinPairing: vi.fn().mockResolvedValue(asJoiner), cancelPairing: vi.fn() } })
    render(<PairingPanel baseURL="https://relay.example:8443/" canShow={false} />)
    typeCode()
    await screen.findByRole('button', { name: /They match/ })
    expect(screen.getByText('relay.example:8443', { selector: 'strong' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/gives that machine everything/)
  })

  it('tells a joiner that timed out where to look, from main or from its own clock', async () => {
    stubBridge({
      addy: {
        joinPairing: vi
          .fn()
          .mockRejectedValue(
            new Error("Error invoking remote method 'addy:joinPairing': AddyError: the other device did not answer in time")
          ),
        cancelPairing: vi.fn()
      }
    })
    const { unmount } = render(<PairingPanel baseURL="https://relay.example" canShow={false} />)
    typeCode()
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /did not answer in time\. If the other machine already showed emoji and someone pressed They match, another device may have used your code/
    )
    unmount()

    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubBridge({ addy: { joinPairing: vi.fn(() => new Promise(() => {})), cancelPairing: vi.fn() } })
    render(<PairingPanel baseURL="https://relay.example" canShow={false} />)
    typeCode()
    await act(async () => {
      vi.advanceTimersByTime(181_000)
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(/another device may have used your code/)
  })

  it('leaves every other failure as it was', () => {
    expect(joinerFailure('the relay refused the rendezvous (403)')).toBe('the relay refused the rendezvous (403)')
    expect(joinerFailure('this pairing is no longer open on the relay — it finished.')).toMatch(
      /it finished\. If the other machine/
    )
  })
})
