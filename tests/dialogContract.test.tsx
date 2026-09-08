// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { AddDatabaseModal } from '../src/renderer/src/components/databases/AddDatabaseModal'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { TunnelManager } from '../src/renderer/src/components/tunnels/TunnelManager'
import { FrpPublishDialog } from '../src/renderer/src/components/vpn/FrpPublishDialog'
import { FrpTunnelSetup } from '../src/renderer/src/components/vpn/FrpTunnelSetup'
import { BackupDestinations } from '../src/renderer/src/components/settings/BackupDestinations'
import { ProcessesPanel } from '../src/renderer/src/components/processes/ProcessesPanel'
import { useApp } from '../src/renderer/src/store/app'
import type { FrpPublishTarget } from '../src/shared/frpTunnel'
import type { VpnProfile } from '../src/renderer/src/types'

// The add-flows, rendered, asserting POSITION rather than appearance.
//
// The finding these come from is not a taste complaint. Seven flows put the
// confirm button in three different places, and the cost is paid on every use
// by a hand that already knew where it was going. Position is the thing to
// pin, and it is the thing a source grep cannot see: `<button className="btn
// primary">` is identical whether it sits in a sticky footer or two thirds of
// the way up a nested card.
//
// So these tests walk the DOM. "Last control in the footer", "footer is a
// sibling of the body, not inside it", "no second bordered container in the
// body", "the error is in the same field as the control it is about". Each one
// is a sentence about where something is, checked where it actually ends up.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modal(): HTMLElement {
  const el = document.querySelector('.modal')
  if (!el) throw new Error('no dialog rendered')
  return el as HTMLElement
}

function footer(): HTMLElement {
  const el = modal().querySelector('.modal-footer')
  if (!el) throw new Error('dialog has no footer')
  return el as HTMLElement
}

/** The confirm, defined structurally: the last button in the footer. If a
 *  dialog ever puts Cancel after it, this reads Cancel and the assertion on
 *  its label fails — which is the point. */
function confirmButton(): HTMLButtonElement {
  const buttons = footer().querySelectorAll('button')
  return buttons[buttons.length - 1] as HTMLButtonElement
}

/** The `.field` a control belongs to, so an error message can be asserted to
 *  be in the SAME one rather than merely somewhere on the page. */
function fieldOf(control: Element): HTMLElement {
  const el = control.closest('.field')
  if (!el) throw new Error('control is not inside a .field')
  return el as HTMLElement
}

const SERVER = {
  id: 'srv-1',
  workspaceId: 'ws-default',
  name: 'bastion',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  auth: 'password'
}

function withOneServer(): void {
  const ws = useApp.getState().activeId()
  useApp.setState({ servers: [{ ...SERVER, workspaceId: ws }] as never })
}

const FRP_TARGET = (): FrpPublishTarget => {
  const profile: VpnProfile = {
    id: 'vpn-host',
    workspaceId: useApp.getState().activeId(),
    name: 'Tunnel server',
    autoStart: false,
    spec: {
      kind: 'frp',
      serverAddr: 'frp.example.com',
      serverPort: 7000,
      auth: { method: 'token' },
      transport: { protocol: 'tcp', tlsEnable: true },
      proxies: [],
      visitors: [],
      publicHost: {
        baseDomain: 'tunnel.example.com',
        scheme: 'https',
        confirmedAt: 1_700_000_000_000
      }
    }
  }
  return {
    profile,
    spec: profile.spec as FrpPublishTarget['spec'],
    host: { baseDomain: 'tunnel.example.com', scheme: 'https', confirmedAt: 1_700_000_000_000 }
  } as FrpPublishTarget
}

beforeEach(() => {
  stubBridge({
    clipboard: { write: () => undefined },
    secrets: { set: () => Promise.resolve(true) },
    tunnel: { list: () => Promise.resolve([]), stop: () => Promise.resolve(), onStatus: () => () => undefined },
    vpn: { list: () => Promise.resolve([]), onStatus: () => () => undefined }
  })
})

// ---------------------------------------------------------------------------
// One footer contract, in every dialog
// ---------------------------------------------------------------------------

describe('every add-flow dialog puts its commit in the same place', () => {
  it('Add Database: the confirm is the last control in the footer', async () => {
    render(<AddDatabaseModal />)
    expect(confirmButton().textContent).toBe('Add database')
    // Cancel sits immediately before it, never after.
    const buttons = [...footer().querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons).toEqual(['Cancel', 'Add database'])
  })

  it('Create tunnel: the confirm is in the footer, not in a card inside the body', async () => {
    withOneServer()
    render(<TunnelManager />)
    await userEvent.click(screen.getAllByRole('button', { name: /Create tunnel/ })[0])

    expect(confirmButton().textContent).toBe('Create tunnel')
    // The nested bordered card this form used to draw around its own fields
    // and its own action row is gone. A second container inside a container is
    // what made this dialog's confirm land somewhere else than its neighbour's.
    expect(modal().querySelector('.modal-body .card')).toBeNull()
  })

  it('Publish a local port: the confirm is the last control in the footer', () => {
    render(<FrpPublishDialog target={FRP_TARGET()} localPort={3000} onClose={() => undefined} />)
    expect(confirmButton().textContent).toBe('Publish')
  })

  it('Set up a tunnel server: the confirm is the last control in the footer', () => {
    render(
      <FrpTunnelSetup
        workspaceId={useApp.getState().activeId()}
        onClose={() => undefined}
        onDone={() => undefined}
      />
    )
    expect(confirmButton().textContent).toBe('Finish setup')
  })

  // -------------------------------------------------------------------------
  // The dialog that still drew its own footer
  // -------------------------------------------------------------------------
  //
  // Reported from the running app: the Edit Server dialog's footer read
  // [Cancel] [Test connection] [Save Changes] [Cancel]. AddServerModal predates
  // the refactor above and hand-composed the whole row, including a Cancel of
  // its own, while Modal renders one unless a dialog says it has no way back.
  //
  // Counted rather than shape-matched, because "two Cancels" is what the user
  // saw and a source grep cannot see it: each button was correct on its own.
  it('Edit Server: there is exactly one Cancel, and Save Changes is last', () => {
    withOneServer()
    useApp.setState({ editServerId: 'srv-1', modal: 'add-server' } as never)
    render(<AddServerModal />)

    const labels = [...footer().querySelectorAll('button')].map((b) => b.textContent)
    expect(labels.filter((l) => l === 'Cancel')).toHaveLength(1)
    expect(labels).toEqual(['Test connection', 'Cancel', 'Save Changes'])
  })

  it('Add Server: the same footer, with the label the un-saved case needs', () => {
    // Private key is the default method, and the form offers what is already
    // in ~/.ssh rather than opening a file picker over a hidden directory.
    stubBridge({ ssh: { defaultKeys: () => Promise.resolve([]) } })
    render(<AddServerModal />)
    const labels = [...footer().querySelectorAll('button')].map((b) => b.textContent)
    expect(labels.filter((l) => l === 'Cancel')).toHaveLength(1)
    expect(confirmButton().textContent).toBe('Add Server')
    // Off until the form is complete, with the reason stated rather than left
    // to be guessed at from a grey button.
    expect(confirmButton().hasAttribute('disabled')).toBe(true)
    expect(footer().querySelector('.footer-note')?.textContent).toBe('Give this connection a name.')
  })

  it.each([
    ['Add Database', <AddDatabaseModal key="db" />],
    [
      'Publish a local port',
      <FrpPublishDialog key="frp" target={FRP_TARGET()} localPort={3000} onClose={() => undefined} />
    ]
  ])('%s: the footer is a sibling of the body, so it cannot scroll away', (_name, element) => {
    render(element)
    const body = modal().querySelector('.modal-body')
    expect(body).not.toBeNull()
    // The failure this rules out: an action row rendered inside `children`,
    // which scrolls with the content. On a long form both the button and the
    // sentence saying why it is disabled start out below the fold.
    expect(body!.contains(footer())).toBe(false)
    expect(footer().parentElement).toBe(modal())
  })
})

// ---------------------------------------------------------------------------
// Validation lives with the field it is about
// ---------------------------------------------------------------------------

describe('a field says what is wrong with it, beside itself', () => {
  it('marks required fields before anything has been submitted', () => {
    render(<AddDatabaseModal />)
    const name = screen.getByPlaceholderText('Production DB')
    expect(fieldOf(name).querySelector('.field-req')).not.toBeNull()
    // …and it is stated at rest, with nothing typed and nothing pressed.
    expect(fieldOf(name).textContent).toContain('Required')
  })

  it('puts the message in the same field as the control, and the error border on it', async () => {
    render(<AddDatabaseModal />)
    const name = screen.getByPlaceholderText('Production DB')
    await userEvent.click(name)
    await userEvent.tab()

    const field = fieldOf(name)
    expect(field.querySelector('.field-error')?.textContent).toBe('Give this connection a name.')
    // The control is marked too. A sentence under an input that looks fine is
    // half a message.
    expect(name.closest('.field-control')?.className).toContain('invalid')
    // And nowhere else: not a banner at the top of the body.
    expect(document.querySelectorAll('.field-error')).toHaveLength(1)
  })

  it('Create tunnel says which of its four fields is the reason', async () => {
    withOneServer()
    render(<TunnelManager />)
    await userEvent.click(screen.getAllByRole('button', { name: /Create tunnel/ })[0])

    const name = screen.getByPlaceholderText('web-db')
    await userEvent.click(name)
    await userEvent.tab()

    expect(fieldOf(name).querySelector('.field-error')?.textContent).toBe('Give the tunnel a name.')
    expect(confirmButton().hasAttribute('disabled')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The two inline panels get the same contract
// ---------------------------------------------------------------------------

describe('an inline commit panel puts its primary after the fields it commits', () => {
  it('the backup destination editor: Save comes after every input, not above them', async () => {
    stubBridge({
      backup: {
        destinations: () =>
          Promise.resolve({ version: 1, destinations: [], lastRunAt: {}, lastReport: {} }),
        saveDestinations: () => Promise.resolve(null),
        dumpableDatabases: () => Promise.resolve([])
      }
    })
    render(<BackupDestinations />)
    await userEvent.click(await screen.findByRole('button', { name: /S3/ }))

    const save = screen.getByRole('button', { name: 'Save destination' })
    const inputs = [...document.querySelectorAll('input, select')]
    expect(inputs.length).toBeGreaterThan(4)

    // Document order, which is the order a person scrolls through. Every field
    // precedes the button that commits it. This is the actual bug: Cancel and
    // Save were flex siblings of the field column in a `align-items:
    // flex-start` banner, so they rendered at the TOP-right and, on the two
    // tallest states of this form, ended up off-screen behind the user.
    for (const input of inputs) {
      expect(save.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    }
    expect(save.closest('.inline-panel-footer')).not.toBeNull()
  })

  it('the local process form: the refusal is beside the footer, not above the fields', async () => {
    stubBridge({
      processes: {
        list: () => Promise.resolve([]),
        status: () => Promise.resolve([]),
        logs: () => Promise.resolve([]),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        restart: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        create: () => Promise.resolve()
      }
    })
    render(<ProcessesPanel />)
    await userEvent.click(screen.getByRole('button', { name: /Add a process/ }))
    await userEvent.type(screen.getByPlaceholderText('API server'), 'Worker')
    await userEvent.click(screen.getByRole('button', { name: 'Add process' }))

    const alert = await screen.findByRole('alert')
    // In the footer, after the fields — where the button that was pressed is.
    // It used to render above the whole panel, which on this form means the
    // user scrolls back up past everything they just typed to read it.
    expect(alert.closest('.inline-panel-footer')).not.toBeNull()
    const name = screen.getByPlaceholderText('API server')
    expect(alert.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })
})
