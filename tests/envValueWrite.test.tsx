// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { stubBridge } from './setup/renderer'
import { EnvValueWrite } from '../src/renderer/src/components/docker/EnvValueWrite'
import { toVaultDescriptor, type VaultEntryDescriptor } from '../src/shared/vaultIndex'

// Rendered rather than read. The promise this control makes is about what it
// SENDS -- an id and a slot, never a value -- and a source regex cannot tell
// whether a component that holds the right props renders the wrong call.

// A DESCRIPTOR, which is all this component can ever see. There is no password
// on it to leak, which is the property under test rather than an omission in
// the fixture.
const entry = (over: Partial<VaultEntryDescriptor> = {}): VaultEntryDescriptor => ({
  id: 'v1',
  name: 'Redis prod',
  kind: 'login',
  has: { password: true, privateKey: false, username: true },
  fieldKeys: ['REDIS_URL'],
  ...over
})

function mount(
  writeEnvValue: (...a: unknown[]) => Promise<unknown>,
  opts: { unlocked?: boolean } = {}
): { onWritten: ReturnType<typeof vi.fn> } {
  stubBridge({
    compose: { writeEnvValue },
    vaultIndex: {
      list: async () =>
        opts.unlocked === false
          ? { ok: false, error: 'The vault is locked.' }
          : { ok: true, entries: [entry()] }
    }
  })
  const onWritten = vi.fn()
  render(
    <EnvValueWrite
      cfg={{ host: 'h' }}
      serverId="srv-1"
      path="/srv/app/.env"
      name="REDIS_PASSWORD"
      onWritten={onWritten}
    />
  )
  return { onWritten }
}

const open = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: /set redis_password from the vault/i }))
}

describe('what it sends', () => {
  it('sends an entry id and a slot, and no value', async () => {
    const spy = vi.fn(async () => ({ ok: true, name: 'REDIS_PASSWORD', line: 3, action: 'replace', backup: '/srv/app/.env.opsmaxx-bak' }))
    mount(spy)
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.click(screen.getByRole('button', { name: /^write$/i }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    const [, req, ref] = spy.mock.calls[0] as unknown[]
    expect(req).toEqual({ path: '/srv/app/.env', name: 'REDIS_PASSWORD', serverId: 'srv-1' })
    expect(ref).toEqual({ vaultEntryId: 'v1', slot: 'password' })
    // Nothing anywhere in the call carries the entry's secret.
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('hunter2')
  })

  it('sends a field key only when a named field was chosen', async () => {
    const spy = vi.fn(async () => ({ ok: true, name: 'X', line: null, action: 'append', backup: 'b' }))
    mount(spy)
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.selectOptions(screen.getByLabelText('Which field'), 'field')
    await userEvent.selectOptions(screen.getByLabelText('Field name'), 'REDIS_URL')
    await userEvent.click(screen.getByRole('button', { name: /^write$/i }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect((spy.mock.calls[0] as unknown[])[2]).toEqual({
      vaultEntryId: 'v1',
      slot: 'field',
      fieldKey: 'REDIS_URL'
    })
  })

  // The field list offers KEYS. A key is a label the operator typed; the value
  // beside it must never reach this process.
  it('lists the field keys and not their values', async () => {
    mount(async () => ({ ok: true, name: 'X', line: 1, action: 'replace', backup: 'b' }))
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.selectOptions(screen.getByLabelText('Which field'), 'field')
    expect(screen.getByRole('option', { name: 'REDIS_URL' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('redis://x')
  })

  it('will not write before an entry is chosen', async () => {
    const spy = vi.fn(async () => ({ ok: true, name: 'X', line: 1, action: 'replace', backup: 'b' }))
    mount(spy)
    await open()
    expect(screen.getByRole('button', { name: /^write$/i }).hasAttribute('disabled')).toBe(true)
  })

  it('will not write a named field with no field chosen', async () => {
    mount(async () => ({ ok: true, name: 'X', line: 1, action: 'replace', backup: 'b' }))
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.selectOptions(screen.getByLabelText('Which field'), 'field')
    expect(screen.getByRole('button', { name: /^write$/i }).hasAttribute('disabled')).toBe(true)
  })
})

describe('what it says', () => {
  it('states that it cannot tell you the value is already the same', async () => {
    mount(async () => ({ ok: true, name: 'X', line: 1, action: 'replace', backup: 'b' }))
    await open()
    expect(screen.getByText(/cannot tell you whether the value is already the same/i)).toBeTruthy()
  })

  it('names the line it changed and the backup, and never a value', async () => {
    mount(async () => ({
      ok: true,
      name: 'REDIS_PASSWORD',
      line: 3,
      action: 'replace',
      backup: '/srv/app/.env.opsmaxx-bak'
    }))
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.click(screen.getByRole('button', { name: /^write$/i }))
    await screen.findByText(/replaced on line 3/i)
    expect(document.body.textContent).toContain('.env.opsmaxx-bak')
    expect(document.body.textContent).not.toContain('hunter2')
  })

  // A written file is not a running stack, and an operator who thinks it is
  // will not understand why nothing changed.
  it('says the stack has to come up again before the value is in use', async () => {
    mount(async () => ({ ok: true, name: 'X', line: null, action: 'append', backup: 'b' }))
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.click(screen.getByRole('button', { name: /^write$/i }))
    await screen.findByText(/brought up again/i)
  })

  it('shows a refusal in the words main sent', async () => {
    mount(async () => ({ ok: false, reason: 'that file sets the name twice' }))
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.click(screen.getByRole('button', { name: /^write$/i }))
    await screen.findByText(/sets the name twice/i)
  })

  it('reports a call that threw instead of leaving the button spinning', async () => {
    mount(async () => {
      throw new Error('gone')
    })
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.click(screen.getByRole('button', { name: /^write$/i }))
    await screen.findByText(/could not be run/i)
    expect(screen.getByRole('button', { name: /^write$/i })).toBeTruthy()
  })

  it('re-reads the names only after a write that succeeded', async () => {
    const { onWritten } = mount(async () => ({ ok: false, reason: 'no' }))
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Vault entry'), 'v1')
    await userEvent.click(screen.getByRole('button', { name: /^write$/i }))
    await screen.findByText(/^no$/i)
    expect(onWritten).not.toHaveBeenCalled()
  })
})

// `vault.list()` returns every entry WITH its password. Importing the store put
// the whole plaintext vault inside the docker module's renderer half, and
// `moduleBoundaries` caught it -- this pins the fix rather than the symptom.
describe('how it reads the vault', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  /** Comments stripped. This file EXPLAINS which vault paths are forbidden and
   *  why, so a bare search matches the prose saying they are not used -- the
   *  same trap the `mcpServer` and `envWrite` scans hit. */
  const code = (rel: string): string =>
    read(rel)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
  const src = code('../src/renderer/src/components/docker/EnvValueWrite.tsx')

  it('never reaches the vault store or the vault namespace', () => {
    expect(src).not.toContain('store/vault')
    expect(src).not.toMatch(/opsmaxx\??\.vault\b/)
    expect(src).toContain('opsmaxx?.vaultIndex')
  })

  // The projection is where a secret would be added, and an INLINE object
  // literal there type-checked with `password: e.password` on it. Annotating
  // the function's return type is what makes that a compile error.
  it('projects an entry to names and flags, dropping every value', () => {
    const d = toVaultDescriptor({
      id: 'v1',
      name: 'Redis prod',
      kind: 'login',
      username: 'redis',
      password: 'hunter2',
      privateKey: '',
      fields: [{ key: 'REDIS_URL' }]
    })
    expect(d).toEqual({
      id: 'v1',
      name: 'Redis prod',
      kind: 'login',
      has: { password: true, privateKey: false, username: true },
      fieldKeys: ['REDIS_URL']
    })
    expect(JSON.stringify(d)).not.toContain('hunter2')
  })

  // An empty slot is not a slot with something in it, and a picker that offered
  // both the same way would send a reference main can only refuse.
  it('reports an empty slot as absent rather than present', () => {
    const d = toVaultDescriptor({ id: 'a', name: 'n', kind: 'login', password: '' })
    expect(d.has).toEqual({ password: false, privateKey: false, username: false })
  })

  it('uses a descriptor type with no field that could hold a value', () => {
    const idx = code('../src/shared/vaultIndex.ts')
    const iface = idx.slice(
      idx.indexOf('export interface VaultEntryDescriptor'),
      idx.indexOf('export type VaultIndexResult')
    )
    for (const forbidden of ['password:', 'privateKey:', 'value:', 'secret:']) {
      // `has: { password: boolean }` is a FLAG, not a value, and reads as
      // `password:` -- so the check is on the value-bearing shape.
      expect(iface).not.toMatch(new RegExp(`${forbidden}\\s*string`))
    }
    expect(iface).toContain('fieldKeys: string[]')
  })
})

describe('when it will not offer the form', () => {
  // The value comes from the vault. Collecting a choice and then refusing it
  // wastes somebody's time twice.
  it('asks for an unlock rather than showing the picker', async () => {
    mount(async () => ({ ok: true, name: 'X', line: 1, action: 'replace', backup: 'b' }), {
      unlocked: false
    })
    await open()
    expect(screen.getByText(/unlock the vault/i)).toBeTruthy()
    expect(screen.queryByLabelText('Vault entry')).toBeNull()
  })

  // A button that cannot do anything is worse than no button.
  it('renders nothing when the preload has no such method', () => {
    stubBridge({ compose: {}, vaultIndex: { list: async () => ({ ok: true, entries: [] }) } })
    const { container } = render(
      <EnvValueWrite cfg={{}} serverId="s" path="/a/.env" name="N" onWritten={() => {}} />
    )
    expect(container.textContent).toBe('')
  })
})
