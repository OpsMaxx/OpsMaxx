// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubBridge } from './setup/renderer'
import { AddySetup } from '../src/renderer/src/components/addy/AddySetup'
import { PairingPanel } from '../src/renderer/src/components/addy/PairingPanel'
import { AddyPanel } from '../src/renderer/src/components/addy/AddyPanel'
import { ConflictChooser } from '../src/renderer/src/components/addy/ConflictChooser'
import { addyJourney, type AddyStatus } from '../src/renderer/src/components/addy/addyStatus'
import { syncErrorText } from '../src/renderer/src/components/addy/collectionNames'
import { pickCheckWords, startAddyLinkWatch, useAddyUi } from '../src/renderer/src/store/addy'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'

/**
 * Sync & devices, as somebody using it meets it.
 *
 * Each block is one thing that used to go wrong on screen: an Electron
 * preamble in front of every error, a Join button that sat live through three
 * silent minutes, a pairing link that did nothing on the machine that needed
 * it, a recovery phrase lost to a sidebar click, a join whose own outcome was
 * unmounted, and conflicts the chooser never heard about.
 */

const ROOT = join(__dirname, '..')
const PHRASE = 'one two three four five six seven eight nine ten eleven twelve'
const IPC = (method: string, msg: string): Error =>
  new Error(`Error invoking remote method 'addy:${method}': AddyError: ${msg}`)

const notEnrolled = {
  enrolled: false,
  sync: { running: false, connected: false, lastSyncAt: null, conflicts: 0 }
}

beforeEach(() => {
  useApp.getState().setSettings({ addyRelayURL: '' })
})

describe('errors read as sentences', () => {
  it('drops the IPC preamble and the error class from what pairing says', async () => {
    stubBridge({
      addy: {
        joinPairing: vi.fn().mockRejectedValue(IPC('joinPairing', 'the other device did not answer in time')),
        cancelPairing: vi.fn()
      }
    })
    render(<PairingPanel baseURL="https://relay.example" canShow={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Type a code/ }))
    fireEvent.change(screen.getByPlaceholderText('Paste it here'), { target: { value: 'abcd1234.wxyz9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the other device did not answer in time')
    expect(alert.textContent).not.toMatch(/invoking remote method|AddyError/)
  })
})

describe('joining with a code', () => {
  function joining(joinPairing: ReturnType<typeof vi.fn>, cancelPairing = vi.fn()): void {
    stubBridge({ addy: { joinPairing, cancelPairing } })
    render(<PairingPanel baseURL="https://relay.example" canShow={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Type a code/ }))
    fireEvent.change(screen.getByPlaceholderText('Paste it here'), { target: { value: 'abcd1234.wxyz9876' } })
  }

  it('shows that it is waiting, for how long, and offers a way out instead of a live Join', async () => {
    joining(vi.fn(() => new Promise(() => {})))
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByText(/Waiting for the other device… \(3:00 left\)/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect((screen.getByPlaceholderText('Paste it here') as HTMLInputElement).disabled).toBe(true)
  })

  it("does not report the cancelled attempt's rejection as the next attempt's failure", async () => {
    // Main cancels the previous session before it starts the next one, and
    // the previous promise then rejects with "the pairing was cancelled".
    let rejectFirst: (e: Error) => void = () => {}
    const joinPairing = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, rej) => (rejectFirst = rej)))
      .mockImplementationOnce(() => new Promise(() => {}))
    const cancelPairing = vi.fn()
    joining(joinPairing, cancelPairing)

    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(cancelPairing).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await act(async () => rejectFirst(IPC('joinPairing', 'the pairing was cancelled')))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/Waiting for the other device/)).toBeTruthy()
  })
})

describe('the showing side', () => {
  it('says when the code really expires instead of "while this window is open"', async () => {
    stubBridge({
      addy: {
        beginPairing: vi.fn().mockResolvedValue({ code: 'abcd1234', pairingId: 'wxyz9876' }),
        awaitPairing: vi.fn(() => new Promise(() => {})),
        cancelPairing: vi.fn()
      }
    })
    render(<PairingPanel baseURL="https://relay.example" />)
    fireEvent.click(screen.getByRole('button', { name: /Show a code/ }))
    expect(await screen.findByText(/stops working in 3:00/)).toBeTruthy()
    expect(screen.queryByText(/while this window is open/)).toBeNull()
  })
})

describe('a pairing link on a fresh machine', () => {
  it('opens the join path with the relay and the code filled in, and does not join', async () => {
    const joinPairing = vi.fn()
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue(notEnrolled),
        takeLink: vi.fn().mockResolvedValue({
          action: 'pair',
          relay: 'https://relay.example',
          code: 'abcd1234',
          pairingId: 'wxyz9876'
        }),
        joinPairing
      }
    })
    useApp.getState().setSettings({ modules: { ...useApp.getState().settings.modules, addy: true } })
    const stop = startAddyLinkWatch()
    // The watch brings the user to the screen that can use it — once the
    // saved settings are in, so it does not decide from the defaults.
    await waitFor(() => expect(useAddyUi.getState().link).not.toBeNull())
    expect(useNav.getState().monitorTab).not.toBe('addy')
    useApp.setState({ hydrated: true })
    expect(useNav.getState().monitorTab).toBe('addy')
    render(<AddySetup />)

    expect(((await screen.findByPlaceholderText('Paste it here')) as HTMLInputElement).value).toBe(
      'abcd1234.wxyz9876'
    )
    expect((screen.getByPlaceholderText('https://relay.example') as HTMLInputElement).value).toBe(
      'https://relay.example'
    )
    expect(joinPairing).not.toHaveBeenCalled()
    expect(useAddyUi.getState().link).toBeNull()
    stop()
  })

  it('is held by main until the renderer takes it, including one from a cold start', () => {
    const main = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    const take = main.slice(main.indexOf("ipcMain.handle('addy:takeLink'"))
    expect(take.slice(0, 200), 'nothing reads the held link').toContain('pendingLink.link')
    expect(main, 'a link in the launch argv is never looked at').toMatch(
      /linkInArgv\(process\.argv\)/
    )
  })
})

describe('the recovery phrase', () => {
  function created(): ReturnType<typeof vi.fn> {
    const createAccount = vi.fn().mockResolvedValue({ mnemonic: PHRASE })
    stubBridge({
      hostname: vi.fn().mockResolvedValue('studio-mac.local'),
      addy: { status: vi.fn().mockResolvedValue(notEnrolled), createAccount }
    })
    return createAccount
  }

  async function createOne(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: /first device/i }))
    fireEvent.change(screen.getByPlaceholderText('https://relay.example'), {
      target: { value: 'https://relay.example' }
    })
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'invite-token' } })
    fireEvent.click(screen.getByRole('button', { name: /Create an account/ }))
    await screen.findByText('Write this down before you go on')
  }

  it('names the first device after the machine, not "this device"', async () => {
    const createAccount = created()
    render(<AddySetup />)
    await createOne()
    expect(createAccount.mock.calls[0][2]).toBe('studio-mac')
  })

  it('survives the screen being unmounted by a click elsewhere', async () => {
    created()
    const first = render(<AddySetup />)
    await createOne()
    first.unmount()
    render(<AddySetup />)
    expect(await screen.findByText('Write this down before you go on')).toBeTruthy()
    expect(screen.getByText('twelve')).toBeTruthy()
  })

  it('is confirmed by typing words back, not by ticking a box', async () => {
    created()
    render(<AddySetup />)
    await createOne()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /I have written them down/ }))

    const words = PHRASE.split(' ')
    const asked = useAddyUi.getState().checkWords
    expect(asked).toHaveLength(3)
    const done = screen.getByRole('button', { name: /Done — I have them/ }) as HTMLButtonElement
    // The list is hidden while they type.
    expect(screen.queryByText('twelve')).toBeNull()
    for (const i of asked) {
      fireEvent.change(screen.getByLabelText(`Word ${i + 1}`), { target: { value: 'wrong' } })
    }
    expect(done.disabled).toBe(true)
    for (const i of asked) {
      fireEvent.change(screen.getByLabelText(`Word ${i + 1}`), {
        target: { value: ` ${words[i].toUpperCase()} ` }
      })
    }
    expect(done.disabled).toBe(false)
    fireEvent.click(done)
    expect(useAddyUi.getState().phrase).toBeNull()
  })

  it('asks for three different words', () => {
    const picked = pickCheckWords(12, () => 0)
    expect(new Set(picked).size).toBe(3)
    expect(picked.every((i) => i >= 0 && i < 12)).toBe(true)
  })
})

describe('finishing a join', () => {
  it('keeps the pairing on screen when enrolment lands mid-call, and shows how it ended', async () => {
    let push: (s: unknown) => void = () => {}
    let failJoin: (e: Error) => void = () => {}
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue(notEnrolled),
        onStatus: (cb: (s: unknown) => void) => {
          push = cb
          return () => {}
        },
        joinPairing: vi.fn().mockResolvedValue({
          sas: ['🐶'],
          sasWords: 'dog',
          peer: { pubSign: 'aa' },
          self: { pubSign: 'bb', pubEnc: 'cc' }
        }),
        finishJoin: vi.fn(() => new Promise((_, rej) => (failJoin = rej))),
        cancelPairing: vi.fn()
      }
    })
    render(<AddySetup />)
    fireEvent.click(await screen.findByRole('button', { name: /already use OpsMaxx/ }))
    fireEvent.change(screen.getByPlaceholderText('https://relay.example'), {
      target: { value: 'https://relay.example' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Type a code/ }))
    fireEvent.change(screen.getByPlaceholderText('Paste it here'), { target: { value: 'abcd1234.wxyz9876' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    fireEvent.click(await screen.findByRole('button', { name: /They match/ }))

    // The engine announces enrolment before `finishJoin` has returned.
    await act(async () => push({ ...notEnrolled, enrolled: true, relayURL: 'https://relay.example' }))
    expect(screen.queryByRole('heading', { name: 'Add another device' })).toBeNull()

    await act(async () => failJoin(IPC('finishJoin', 'the device list did not verify')))
    expect((await screen.findByRole('alert')).textContent).toContain('the device list did not verify')
  })
})

describe('conflicts', () => {
  const conflict = { id: 1, collection: 'servers', device: '', createdAt: new Date().toISOString(), winning: [1], losing: [2] }

  it('are read again when a sync pass reports, not only at launch', async () => {
    let push: (s: unknown) => void = () => {}
    const conflicts = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([conflict])
    stubBridge({
      addy: {
        conflicts,
        onStatus: (cb: (s: unknown) => void) => {
          push = cb
          return () => {}
        }
      }
    })
    render(<ConflictChooser />)
    await waitFor(() => expect(conflicts).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => push({ enrolled: true }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('left for later can be brought back from the panel in the same session', async () => {
    stubBridge({ addy: { conflicts: vi.fn().mockResolvedValue([conflict]) } })
    render(<ConflictChooser />)
    fireEvent.click(await screen.findByRole('button', { name: /Decide later/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const status: AddyStatus = {
      enrolled: true,
      sync: { running: true, connected: true, lastSyncAt: Date.now(), conflicts: 1 }
    }
    stubBridge({
      addy: { conflicts: vi.fn().mockResolvedValue([conflict]), status: vi.fn().mockResolvedValue(status) }
    })
    render(<AddyPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review now' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

describe('the panel', () => {
  it('puts the sign-in problem first, and the checklist does not call the account unaffected', async () => {
    const status: AddyStatus = {
      enrolled: true,
      problem: 'This device could not sign in to the relay.',
      sync: { running: false, connected: false, lastSyncAt: null, conflicts: 0 }
    }
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(status) } })
    render(<AddyPanel />)
    const problem = await screen.findByText(status.problem!)
    const firstSection = screen.getByText('Where you are')
    expect(
      problem.compareDocumentPosition(firstSection) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the reason is below the readout it explains'
    ).toBeTruthy()

    const sync = addyJourney(status, true, undefined).find((s) => s.key === 'sync')!
    expect(sync.detail).not.toMatch(/unaffected/)
    expect(sync.detail).toMatch(/could not sign in/)
  })

  it('names the collection a sync failure was about, and keeps the code out of the sentence', async () => {
    expect(syncErrorText('knownHosts: the relay refused (500)')).toBe(
      'could not carry your trusted SSH host keys — the relay refused (500)'
    )
    expect(syncErrorText('something else entirely')).toBe('something else entirely')
    const status: AddyStatus = {
      enrolled: true,
      sync: {
        running: true,
        connected: true,
        lastSyncAt: Date.now(),
        conflicts: 0,
        error: { message: 'knownHosts: the relay refused (500)', at: Date.now(), code: 'relay-unreachable' }
      }
    }
    stubBridge({ addy: { status: vi.fn().mockResolvedValue(status) } })
    render(<AddyPanel />)
    const band = await screen.findByText(/Sync last failed/)
    expect(band.textContent).toContain('your trusted SSH host keys')
    expect(band.textContent).not.toMatch(/knownHosts|relay-unreachable/)
  })

  it('is called Sync & devices, and so is everything that points at it', () => {
    const files = ['AddyPanel.tsx', 'AddySetup.tsx', 'PairingPanel.tsx'].map((f) =>
      readFileSync(join(ROOT, 'src/renderer/src/components/addy', f), 'utf8')
    )
    for (const f of files) {
      expect(f).not.toMatch(/title="Account"|Open <strong>Account<\/strong>|open Account there|pairing id/)
    }
    const settings = readFileSync(join(ROOT, 'src/renderer/src/components/settings/Settings.tsx'), 'utf8')
    expect(settings).not.toContain('<h3>addy</h3>')
    expect(settings).toContain("<h3>{t('settingsPage.sync.heading')}</h3>")
    const en = JSON.parse(readFileSync(join(ROOT, 'src/shared/locales/en.json'), 'utf8'))
    expect(en['settingsPage.sync.heading']).toBe('Sync & devices')
    // The words themselves live in the catalog now, so the same rule is held
    // there: the panel's title is the feature's name, and nothing these
    // screens say sends anybody to "Account" or asks for a pairing id.
    expect(files[0]).toContain("title={t('modules.addy.label')}")
    expect(en['modules.addy.label']).toBe('Sync & devices')
    for (const [key, text] of Object.entries(en as Record<string, string>)) {
      if (!key.startsWith('addy.')) continue
      expect(text, key).not.toMatch(/Open <strong>Account<\/strong>|open Account there|pairing id/)
    }
  })

  it('labels the re-key box', async () => {
    stubBridge({
      addy: {
        status: vi.fn().mockResolvedValue({
          enrolled: true,
          sync: { running: true, connected: true, lastSyncAt: Date.now(), conflicts: 0 }
        })
      }
    })
    render(<AddyPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change it' }))
    expect(screen.getByLabelText('Recovery phrase')).toBeTruthy()
  })

  it('uses only colour tokens the app defines', () => {
    const css = readFileSync(join(ROOT, 'src/renderer/src/components/addy/addy.css'), 'utf8')
    const dir = join(ROOT, 'src/renderer/src/styles')
    const global = require('node:fs')
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.css'))
      .map((f: string) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
    for (const v of new Set(css.match(/var\(--[a-z0-9-]+/g) ?? [])) {
      const name = v.slice(4)
      expect(global, `${name} is not defined anywhere`).toContain(`${name}:`)
    }
  })
})
