// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler } from 'react'
import { act, render } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { CicdPanel } from '../src/renderer/src/components/cicd/CicdPanel'
import type { CicdBridge, CicdConnection } from '../src/shared/cicd'

/**
 * The CI/CD panel's "read 34s ago" clock stops while the panel is not on screen.
 *
 * FleetMonitor keeps every visited module mounted and hides it with
 * display:none, so a clock that ignored that re-rendered the whole panel once a
 * second for the rest of the session, behind a terminal nobody had moved off.
 */
const CONN: CicdConnection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Platform',
  provider: 'github',
  baseUrl: 'https://github.example.com',
  vaultEntryId: 'v1',
  route: { kind: 'direct' },
  enabled: true
}

const bridge = {
  configure: async () => undefined,
  snapshot: async () => [],
  agentRuns: async () => [],
  onState: () => () => undefined
} as unknown as CicdBridge

beforeEach(() => {
  stubBridge({})
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function commitsOverAMinute(active: boolean): Promise<number> {
  let commits = 0
  render(
    <Profiler id="cicd" onRender={() => commits++}>
      <CicdPanel connections={[CONN]} bridge={bridge} active={active} />
    </Profiler>
  )
  // Let the mount settle — snapshot, subscriptions — before counting.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  commits = 0
  // A second at a time: one act() around the whole minute would batch every
  // tick into a single commit and hide exactly what is being counted.
  for (let s = 0; s < 60; s++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
  }
  return commits
}

describe('CicdPanel clock', () => {
  it('ticks once a second while on screen', async () => {
    expect(await commitsOverAMinute(true)).toBeGreaterThanOrEqual(59)
  })

  it('does not re-render at all while hidden', async () => {
    expect(await commitsOverAMinute(false)).toBe(0)
  })
})
