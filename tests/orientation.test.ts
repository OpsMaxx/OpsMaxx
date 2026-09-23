import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS } from '../src/shared/apiModel'
import { orientationFor, ratioFor, withRatio } from '../src/renderer/src/components/http/ProtocolLayout'

// The grid's orientation and split ratios (§2.1, §2.2), as pure functions.

describe('orientationFor', () => {
  it('auto is stacked below 800 and side by side from 800', () => {
    expect(orientationFor(799, 'auto')).toEqual({ orientation: 'vertical', forced: false })
    expect(orientationFor(800, 'auto')).toEqual({ orientation: 'horizontal', forced: false })
    expect(orientationFor(448, 'auto').orientation).toBe('vertical')
  })

  it('an explicit side by side that cannot fit two 280px panes renders stacked, and says so', () => {
    expect(orientationFor(564, 'horizontal')).toEqual({ orientation: 'horizontal', forced: false })
    expect(orientationFor(563, 'horizontal')).toEqual({ orientation: 'vertical', forced: true })
    expect(orientationFor(448, 'horizontal')).toEqual({ orientation: 'vertical', forced: true })
    expect(orientationFor(648, 'horizontal')).toEqual({ orientation: 'horizontal', forced: false })
  })

  it('stacked is stacked at any width', () => {
    expect(orientationFor(1344, 'vertical')).toEqual({ orientation: 'vertical', forced: false })
  })
})

describe('ratios per protocol and orientation', () => {
  it('has §2.2’s six defaults', () => {
    expect(ratioFor(DEFAULT_PREFS, 'http', 'horizontal')).toBe(0.5)
    expect(ratioFor(DEFAULT_PREFS, 'http', 'vertical')).toBe(0.4)
    expect(ratioFor(DEFAULT_PREFS, 'graphql', 'horizontal')).toBe(0.5)
    expect(ratioFor(DEFAULT_PREFS, 'graphql', 'vertical')).toBe(0.45)
    expect(ratioFor(DEFAULT_PREFS, 'ws', 'horizontal')).toBe(0.4)
    expect(ratioFor(DEFAULT_PREFS, 'ws', 'vertical')).toBe(0.3)
  })

  it('a drag changes only its own protocol and orientation', () => {
    const prefs = { ...DEFAULT_PREFS, ...withRatio(DEFAULT_PREFS, 'ws', 'vertical', 0.6) }
    expect(ratioFor(prefs, 'ws', 'vertical')).toBe(0.6)
    expect(ratioFor(prefs, 'ws', 'horizontal')).toBe(0.4)
    expect(ratioFor(prefs, 'http', 'vertical')).toBe(0.4)
    expect(DEFAULT_PREFS.ratios.ws.v).toBe(0.3)
  })
})
