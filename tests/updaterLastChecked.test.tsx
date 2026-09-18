// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { stubBridge } from './setup/renderer'
import { useUpdater } from '../src/renderer/src/store/updater'
import { DEFAULT_UPDATE_PREFS } from '../src/shared/updater'
import type { UpdaterStatus } from '../src/shared/updater'

// "You're on the latest version. Last checked 1 hour ago."
//
// The age came from prefs the renderer read ONCE at init. `lastCheckedAt` is
// written by main, in a `finally` around the check itself, so pressing Check
// for updates re-checked and the line still said "1 hour ago" — a button that
// appears to do nothing, in the one panel whose whole job is to tell you
// whether the app is current. The automatic six-hourly check had the same
// problem and no button to blame it on.
//
// Hung off the status arriving rather than off the press, because every path
// that checks ends by emitting one.
//
// One test, not three: the store's `init` is module-scoped and the renderer
// harness resets stores between tests, so a second `it` would assert against a
// store that was never mounted — which is how this file first "passed" a case
// it had not exercised.
//
// Asserted on the VALUE reaching the store rather than on a call count, since
// init legitimately loads prefs and then handles an initial status, and pinning
// the number of loads would pin that incidental order.
describe('the last-checked line', () => {
  it('moves whenever a check reports back, including the early-return path', async () => {
    const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString()
    const AFTER_CHECK = new Date(Date.now() - 1000).toISOString()
    const AFTER_OFFER = new Date().toISOString()

    // Whatever main would hand back right now.
    let stored = HOUR_AGO
    let captured: ((s: UpdaterStatus) => void) | null = null

    stubBridge({
      updater: {
        status: vi.fn().mockResolvedValue({ state: 'idle' } as UpdaterStatus),
        getPrefs: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve({ ...DEFAULT_UPDATE_PREFS, lastCheckedAt: stored })
          ),
        capabilities: vi.fn().mockResolvedValue({
          currentVersion: '0.50.1',
          canAutoInstall: true,
          platform: 'darwin',
          runningChannel: 'stable'
        }),
        onStatus: (cb: (s: UpdaterStatus) => void) => {
          captured = cb
          return () => {}
        },
        check: vi.fn().mockResolvedValue(undefined)
      }
    })

    useUpdater.getState().init()
    await vi.waitFor(() => expect(captured).not.toBeNull())
    await vi.waitFor(() => expect(useUpdater.getState().prefs.lastCheckedAt).toBe(HOUR_AGO))

    // A finished check that found nothing, as the renderer sees it. This is the
    // exact case that stayed at HOUR_AGO however many times you pressed.
    stored = AFTER_CHECK
    captured!({ state: 'not-available' })
    await vi.waitFor(() => expect(useUpdater.getState().prefs.lastCheckedAt).toBe(AFTER_CHECK))

    // And the offered-update status, which returns early in applyStatus. The
    // refresh has to sit ahead of that return, or the one case where the user
    // is most likely to be reading the line is the one that keeps a stale age.
    stored = AFTER_OFFER
    captured!({ state: 'available', version: '0.50.2', channel: 'stable' })
    await vi.waitFor(() => expect(useUpdater.getState().prefs.lastCheckedAt).toBe(AFTER_OFFER))
    expect(useUpdater.getState().status.state).toBe('available')
  })
})
