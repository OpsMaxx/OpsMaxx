// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { FleetHealth } from '../src/renderer/src/components/monitor/FleetHealth'
import { useNav } from '../src/renderer/src/store/nav'
import { useFleet } from '../src/renderer/src/store/fleet'
import type { Server } from '../src/renderer/src/types'

// Item 43's deep link. LogTailPanel has taken a `jump` prop since it shipped,
// and its own comment names the caller it was written for: "the failed-unit
// list is the one that matters". NOTHING EVER PASSED IT -- the same shape as
// item 33's job engine, built and never wired. So the shortest path from
// "nginx failed" to "why" was to read the unit name off the overview, change
// tab, pick the server again and type the name back in.

const SERVER: Server = {
  id: 'srv-1',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'edge-01',
  host: 'edge-01.internal',
  port: 22,
  username: 'ops',
  auth: 'key',
  status: 'online',
  tags: [],
  favorite: false,
  os: 'linux',
  route: [],
  vpnProfileId: null
}

beforeEach(() => {
  stubBridge({})
  useNav.setState({ logTailJump: null, monitorTab: 'overview' })
  useFleet.setState({
    hosts: {
      'srv-1': {
        hostname: 'edge-01',
        services: [
          { name: 'nginx.service', active: 'failed', sub: 'failed', description: 'The web server' },
          { name: 'cron.service', active: 'active', sub: 'running', description: 'cron' }
        ],
        listeners: [],
        listenerSource: null,
        cores: 2,
        memTotal: 1,
        memUsed: 0,
        diskTotal: 100,
        diskUsed: 10,
        load: [0, 0, 0],
        uptime: 1,
        kernel: 'x'
      } as never
    },
    samples: {},
    errors: {},
    facts: {}
  })
})

describe('getting from a failed unit to its log', () => {
  it('offers the log beside the unit that failed', async () => {
    render(<FleetHealth servers={[SERVER]} />)
    expect(screen.getByTitle('Tail nginx.service on edge-01')).toBeTruthy()
  })

  it('asks for that unit on that server, and moves to the tail', async () => {
    render(<FleetHealth servers={[SERVER]} />)
    await userEvent.click(screen.getByTitle('Tail nginx.service on edge-01'))
    const jump = useNav.getState().logTailJump
    expect(jump).toMatchObject({ kind: 'unit', target: 'nginx.service', serverId: 'srv-1' })
    expect(useNav.getState().monitorTab).toBe('logTail')
  })

  it('carries a fresh nonce each time, so the same unit twice running still lands', async () => {
    // LogTailJump's own reasoning: a prop that only changes when the target
    // changes cannot express "show me that again".
    render(<FleetHealth servers={[SERVER]} />)
    const btn = screen.getByTitle('Tail nginx.service on edge-01')
    await userEvent.click(btn)
    const first = useNav.getState().logTailJump!.nonce
    vi.setSystemTime(new Date(Date.now() + 5))
    await userEvent.click(btn)
    expect(useNav.getState().logTailJump!.nonce).not.toBe(first)
  })

  it('does not offer a log for a unit that is running fine', () => {
    render(<FleetHealth servers={[SERVER]} />)
    expect(screen.queryByTitle(/Tail cron.service/)).toBeNull()
  })
})

describe('the half that was missing', () => {
  // The defect this item fixes was NOT a missing prop -- it was a prop that
  // existed, was documented, and had no caller. Asserting the store is set is
  // therefore only half a test: the panel still has to be handed it, and that
  // wiring lives in FleetMonitor where no renderer test reaches.
  //
  // Read off the source for the reason moduleBoundaries.test.ts reads its
  // tab guards off the source: mounting FleetMonitor pulls in the whole app
  // store, and a test that did it would be testing zustand.
  it('hands the panel the jump, or this whole item is still not wired', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(
      resolve(__dirname, '..', 'src/renderer/src/components/monitor/FleetMonitor.tsx'),
      'utf8'
    )
    expect(src).toMatch(/<LogTailPanel[^>]*jump=/)
    expect(src).toContain('logTailJump')
  })
})
