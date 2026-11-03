// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DockerDbPicker } from '../src/renderer/src/components/databases/DockerDbPicker'
import type { DbContainer } from '../src/shared/dockerDb'

const PG: DbContainer = {
  name: 'postgres-main',
  image: 'postgres:16-alpine',
  kind: 'postgres',
  port: 5432,
  published: false,
  networks: [{ name: 'app', ip: '172.20.0.2' }]
}

function bridge(r: unknown): void {
  ;(window as unknown as { opsmaxx: unknown }).opsmaxx = { docker: { dbContainers: async () => r } }
}

describe('the Docker database picker', () => {
  it('offers what it found and hands back the choice', async () => {
    bridge({ ok: true, containers: [PG] })
    const onPick = vi.fn()
    render(<DockerDbPicker target={{}} where="prod-1" selected={null} onPick={onPick} />)
    fireEvent.click(await screen.findByText('postgres-main'))
    expect(onPick).toHaveBeenCalledWith(PG)
    expect(screen.getByText('Not exposed')).toBeTruthy()
  })

  it('shows nothing at all on a host with no database containers', async () => {
    bridge({ ok: true, containers: [] })
    const { container } = render(<DockerDbPicker target={{}} where="prod-1" selected={null} onPick={() => {}} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })

  it('shows nothing when Docker is missing, but says so when it is only forbidden', async () => {
    bridge({ ok: false, reason: 'not-installed', detail: 'docker: not found' })
    const first = render(<DockerDbPicker target={{}} where="prod-1" selected={null} onPick={() => {}} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(first.container.textContent).toBe('')
    first.unmount()

    bridge({ ok: false, reason: 'permission-denied', detail: 'permission denied' })
    render(<DockerDbPicker target={{}} where="prod-1" selected={null} onPick={() => {}} />)
    await waitFor(() => expect(screen.getByText(/isn't allowed to use Docker/)).toBeTruthy())
  })
})
