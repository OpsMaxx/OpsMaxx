// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { EmptyState } from '../src/renderer/src/components/common/EmptyState'
import { VpnManager } from '../src/renderer/src/components/vpn/VpnManager'
import { FrpManager } from '../src/renderer/src/components/vpn/FrpManager'
import { ProcessesPanel } from '../src/renderer/src/components/processes/ProcessesPanel'
import { BackupDestinations } from '../src/renderer/src/components/settings/BackupDestinations'

// One grammar for "there is nothing here yet".
//
// There were four: the shared component, a single left-aligned line of body
// text with an inline icon, a plain sentence followed by a row of three
// "+ type" buttons, and raw uncontained text. Empty states are where a new
// user spends their first ten minutes, so four grammars is the product telling
// them, in its first ten minutes, that it was assembled rather than designed.
//
// The two assertions worth writing are the ones a screenshot review keeps
// missing: whether the state offers the SAME ways in that the header does
// (the VPN one offered WireGuard only, on a screen that offers OpenVPN
// equally), and whether it offers so many that none of them reads as the way
// in (the frp one had four).

beforeEach(() => {
  stubBridge({
    platform: () => Promise.resolve('darwin'),
    clipboard: { write: () => undefined },
    vpn: { list: () => Promise.resolve([]), probe: () => Promise.resolve(null), onStatus: () => () => undefined }
  })
})

/** Buttons drawn with the accent fill, which is the app's word for "this is
 *  the thing to do here". More than one on a screen means none of them is. */
function primaries(): string[] {
  return [...document.querySelectorAll('button.btn.primary')].map((b) =>
    (b.textContent ?? '').trim()
  )
}

describe('the compact variant is the same component, not a fifth grammar', () => {
  it('drops the glyph tile and keeps the title, sentence and action', () => {
    render(
      <EmptyState
        compact
        // Passed on purpose. `compact` has to REFUSE a tile, not merely go
        // without one when the caller happens not to supply it — a caller
        // reaching for the shared component will pass the icon it already had.
        icon={<svg data-testid="glyph" />}
        title="No results"
        message="Run a query to see results."
        action={<button className="btn secondary size-28">Run</button>}
      />
    )
    const el = document.querySelector('.empty')!
    expect(el.className).toContain('compact')
    // The tile is what makes the full variant wrong in a slot inside a screen:
    // 56px of chrome centred in a pane that is not the emptiness.
    expect(el.querySelector('.empty-icon')).toBeNull()
    expect(screen.getByRole('heading', { name: 'No results' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy()
  })

  it('still draws the tile when it is a whole screen', () => {
    render(<EmptyState icon={<svg />} title="No tunnels" message="Create one." />)
    expect(document.querySelector('.empty-icon')).not.toBeNull()
  })
})

describe('an empty state offers the ways in that the screen actually has', () => {
  it('VPN offers OpenVPN as well as WireGuard', () => {
    render(<VpnManager />)
    // The header offers both, and the sentence in the empty state names both.
    // A lone "Import WireGuard" was the only thing on an OpenVPN user's first
    // screen that looked like the way in, and it was the wrong one.
    const empty = document.querySelector('.empty')!
    const labels = [...empty.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim())
    expect(labels).toContain('Import WireGuard')
    expect(labels).toContain('Import OpenVPN')
  })

  it('local processes stopped being a line of body text with an icon in it', () => {
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
    return screen.findByRole('heading', { name: 'No processes yet' }).then((h) => {
      expect(h.closest('.empty')?.className).toContain('compact')
    })
  })

  it('backup destinations stopped being a bare sentence in front of a row of buttons', async () => {
    stubBridge({
      backup: {
        destinations: () =>
          Promise.resolve({ version: 1, destinations: [], lastRunAt: {}, lastReport: {} }),
        dumpableDatabases: () => Promise.resolve([])
      }
    })
    render(<BackupDestinations />)
    const heading = await screen.findByRole('heading', { name: 'No destinations yet' })
    expect(heading.closest('.empty')?.className).toContain('compact')
    // The three "+ Local directory / + SFTP server / + S3" buttons are still
    // there — they are a choice of kind, and that was never a title.
    expect(screen.getByRole('button', { name: /Local directory/ })).toBeTruthy()
  })
})

describe('one primary per screen', () => {
  it('the reverse-proxy screen keeps the jargon-free entry point and demotes the rest', () => {
    render(<FrpManager />)
    // "Get a public URL" is the only one of the four that is task-shaped
    // rather than named in frp's own vocabulary. "Import frpc config", "New
    // frp client" and the empty state's second "New frp client" all described
    // machinery to someone who has not yet decided to care about it.
    expect(primaries()).toEqual(['Get a public URL'])
    // Demoted, not deleted. Someone who does know what an frpc.toml is can
    // still import one.
    expect(screen.getByRole('button', { name: 'Import frpc config' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /New frp client/ }).length).toBeGreaterThan(0)
  })
})
