// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { serverIdentity } from '../src/shared/localMounts'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { sshTransport } from '../src/renderer/src/lib/transport'
import { useApp } from '../src/renderer/src/store/app'
import { stubBridge } from './setup/renderer'

it('saves forwarding independently of password auth and clears consent when the destination changes', async () => {
  const connect = vi.fn().mockResolvedValue(undefined)
  stubBridge({ ssh: { connect, defaultKeys: async () => [] } })
  const store = useApp.getState()
  const id = store.addServer({ name: 'Bastion', host: 'host.example', auth: 'password' })
  store.openServerEditor(id)
  const { unmount } = render(<AddServerModal />)
  const toggle = () => screen.getByRole<HTMLInputElement>('checkbox', { name: 'Forward SSH agent' })
  const server = () => useApp.getState().servers.find((entry) => entry.id === id)!
  const user = userEvent.setup()

  expect(toggle().checked).toBe(false)
  await sshTransport(server(), vi.fn()).connect('plain', 80, 24)
  expect(connect.mock.lastCall?.[0]).not.toHaveProperty('forwardAgent')
  await user.click(toggle())
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(useApp.getState().settings.sshAgentForwarding?.[id]).toBe(serverIdentity(server()))
  await sshTransport(server(), vi.fn()).connect('forwarded', 80, 24)
  expect(connect.mock.lastCall?.[0]).toMatchObject({ auth: 'password', forwardAgent: true })

  unmount()
  store.openServerEditor(id)
  render(<AddServerModal />)
  expect(toggle().checked).toBe(true)
  const host = screen.getByPlaceholderText('10.20.0.10')
  await user.clear(host)
  await user.type(host, 'other.example')
  expect(toggle().checked).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  expect(useApp.getState().settings.sshAgentForwarding?.[id]).toBeUndefined()
  await sshTransport(server(), vi.fn()).connect('other', 80, 24)
  expect(connect.mock.lastCall?.[0]).not.toHaveProperty('forwardAgent')
})
