// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { AddDatabaseModal } from '../src/renderer/src/components/databases/AddDatabaseModal'
import { dbConnectConfig } from '../src/renderer/src/lib/dbConfig'
import type { DbConnectConfig } from '../src/shared/db'

/**
 * Proving a database connection before saving it.
 *
 * Reported by a tester: the database dialog had no Test connection button. The
 * whole path already existed — `db:test`, `dbTest`, the preload bridge, the
 * result type — and the Databases view had been using it for a saved
 * connection all along. Only the button was missing, so the only way to find
 * out whether a connection worked was to save it and open it.
 *
 * Two things had to be true for the button to be worth pressing, and one of
 * them was not: the test has to exercise what is ON SCREEN, not what is
 * stored. Main resolves a database's secret by record id, so an unsaved form
 * has nothing to look up and must send its own; and `dbConnectConfig` dropped
 * `vpnProfileId` entirely, which is why a VPN picked in the dialog was ignored.
 */

const test = vi.fn<(cfg: DbConnectConfig) => Promise<{ ok: boolean; error?: string; version?: string }>>()

const SERVER = {
  id: 'srv-1',
  name: 'bastion',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  auth: 'password',
  // Required on a Server, and load-bearing here: the jump host's own chain is
  // what `sshHopFor` now carries, and a database whose bastion sits behind a
  // second bastion fails without it.
  route: []
}

beforeEach(() => {
  test.mockReset()
  test.mockResolvedValue({ ok: true, version: 'PostgreSQL 16.2' })
  stubBridge({ db: { test } })
  const ws = useApp.getState().activeId()
  useApp.setState({ servers: [{ ...SERVER, workspaceId: ws }] as never })
})

const footer = (): HTMLElement => document.querySelector('.modal-footer') as HTMLElement
const testButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /Test connection|Testing/ }) as HTMLButtonElement
const nameBox = (): HTMLElement => screen.getByPlaceholderText(/Production|Name|name/i)

/** The control under a given field label. The password box has no placeholder
 *  on a new connection — deliberately, because in a type=password field a
 *  placeholder is indistinguishable from a stored secret. */
const fieldInput = (label: string): HTMLInputElement => {
  const heading = [...document.querySelectorAll('.field-label')].find(
    (el) => el.textContent?.trim() === label
  )
  const input = heading?.closest('.field')?.querySelector('input')
  if (!input) throw new Error(`no input under a field labelled ${label}`)
  return input as HTMLInputElement
}

/** Fill in the least that makes the dialog valid: a name and a host. */
const fillMinimum = async (): Promise<void> => {
  await userEvent.type(nameBox(), 'Orders')
}

describe('the button', () => {
  it('is there, before Cancel and the commit', () => {
    render(<AddDatabaseModal />)
    const labels = [...footer().querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual(['Test connection', 'Cancel', 'Add database'])
  })

  // The same gate the commit uses. A test of a form that cannot be saved would
  // dial whatever the empty fields happen to mean.
  it('is off until the form is valid', async () => {
    render(<AddDatabaseModal />)
    expect(testButton().disabled).toBe(true)
    await fillMinimum()
    expect(testButton().disabled).toBe(false)
  })

  it('says what happened, in the footer', async () => {
    render(<AddDatabaseModal />)
    await fillMinimum()
    await userEvent.click(testButton())
    expect(await screen.findByText(/PostgreSQL 16\.2/)).toBeTruthy()
  })

  it('reports a failure in the user’s terms, not the driver’s', async () => {
    test.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED 10.21.15.7:5432' })
    render(<AddDatabaseModal />)
    await fillMinimum()
    await userEvent.click(testButton())
    // Through the same classifier the terminal's failure card uses: the raw
    // text names a host the user did not type and explains nothing.
    const note = await screen.findByText(/refused|listening/i)
    expect(note.className).toMatch(/danger/)
  })

  // Said, rather than a button that quietly does nothing — the rule the rest of
  // the app applies to a preload that is older than the renderer.
  it('says so when the bridge has no test channel', async () => {
    stubBridge({})
    render(<AddDatabaseModal />)
    await fillMinimum()
    await userEvent.click(testButton())
    expect(await screen.findByText(/This build cannot test a connection/)).toBeTruthy()
  })
})

describe('what it sends', () => {
  it('tests the password on screen, not one that is stored', async () => {
    render(<AddDatabaseModal />)
    await fillMinimum()
    await userEvent.type(fieldInput('Password'), 'hunter2')
    await userEvent.click(testButton())

    expect(test).toHaveBeenCalledTimes(1)
    expect(test.mock.calls[0][0]).toMatchObject({ password: 'hunter2' })
  })

  /**
   * No id for a connection that has not been saved.
   *
   * `resolveDbSecrets` keys the keychain lookup on `cfg.id`, so sending a
   * plausible-looking one would either resolve nothing or resolve somebody
   * else's credential. '' says there is nothing to look up, which is what makes
   * the inline password above the thing that gets tested.
   */
  it('sends no record id for a connection that does not exist yet', async () => {
    render(<AddDatabaseModal />)
    await fillMinimum()
    await userEvent.click(testButton())
    expect(test.mock.calls[0][0].id).toBe('')
  })

  it('goes through the jump host the form has chosen', async () => {
    render(<AddDatabaseModal />)
    await fillMinimum()
    await userEvent.selectOptions(screen.getByDisplayValue('Connect directly'), 'srv-1')
    await userEvent.click(testButton())

    expect(test.mock.calls[0][0].ssh).toMatchObject({ host: '10.0.0.1', username: 'root' })
  })
})

/**
 * The gap that made the VPN half of this silently useless.
 *
 * Main resolves a database's VPN profile from the SAVED record, which is right
 * — a caller must not be able to route a saved connection through a tunnel the
 * record never named. An unsaved one has no record, so the form's own choice is
 * the only thing there is; and this function dropped the field before it could
 * ever be sent.
 */
describe('the config builder', () => {
  const fields = {
    id: '',
    kind: 'postgres' as const,
    host: 'db.internal',
    port: 5432,
    username: 'app',
    database: 'orders',
    ssl: false,
    sshServerId: null,
    vpnProfileId: 'vpn-1' as never
  }

  it('carries a VPN profile chosen in the dialog', () => {
    expect(dbConnectConfig(fields, []).vpnProfileId).toBe('vpn-1')
  })

  it('carries none when none was chosen', () => {
    expect(dbConnectConfig({ ...fields, vpnProfileId: null }, []).vpnProfileId).toBeUndefined()
  })

  // Still a shape with no credential in it. The secret is spread in at the call
  // site precisely so this file keeps that property.
  it('holds no credential', () => {
    const cfg = dbConnectConfig(fields, []) as unknown as Record<string, unknown>
    expect(cfg.password).toBeUndefined()
    expect(cfg.uri).toBeUndefined()
  })
})
