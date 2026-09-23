// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ARM_MS, useArming } from '../src/renderer/src/hooks/useArming'

// A timer may fire a fraction of a millisecond before performance.now() says
// the arming delay is up. The hook used to re-render once, read "not armed",
// and never schedule again — the yes stayed inert for good. It was seen on
// CI, where the approval dialog's yes never armed within five seconds.
describe('useArming when its timer fires early', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('arms anyway, by scheduling the remainder', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const { result } = renderHook(() => useArming('a'))
    expect(result.current.armed).toBe(false)

    // The timer fires, but the clock reads half a millisecond short.
    now = 1000 + ARM_MS - 0.5
    act(() => {
      vi.advanceTimersByTime(ARM_MS + 2)
    })
    expect(result.current.armed).toBe(false)

    // The remainder was rescheduled; once the clock catches up, it arms.
    now = 1000 + ARM_MS + 5
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(result.current.armed).toBe(true)
  })
})
