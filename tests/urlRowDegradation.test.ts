import { describe, expect, it } from 'vitest'
import { urlRowLayout } from '../src/renderer/src/components/http/ProtocolLayout'

// The URL row's degradation (§2.1), as a pure function. §1's measured main
// areas: 1064 (1440, sidebar 280), 648 (1024, sidebar 280), 448 (1024 with the
// sidebar at 480, or 125% zoom), and the 440 floor.

describe('the URL row degrades in §2.1’s order', () => {
  it('keeps everything at 1064, with or without a TLS chip', () => {
    expect(urlRowLayout(1064, { tls: false }).step).toBe(0)
    expect(urlRowLayout(1064, { tls: true }).step).toBe(0)
  })

  it('at 648 the route chip goes icon-only first', () => {
    expect(urlRowLayout(648, { tls: false })).toMatchObject({
      step: 1,
      routeIcon: true,
      sendIcon: false,
      tlsIcon: false,
      methodAbbrev: false
    })
  })

  it('at 448 with TLS off, steps 1–4 apply and the ⚠ stays in the row', () => {
    const row = urlRowLayout(448, { tls: true })
    expect(row).toMatchObject({ step: 4, routeIcon: true, sendIcon: true, tlsIcon: true, methodAbbrev: true })
    expect(row.urlWidth).toBeGreaterThanOrEqual(120)
  })

  it('at the 440 floor the URL still has more than its 120px minimum', () => {
    expect(urlRowLayout(440, { tls: true }).urlWidth).toBeGreaterThan(120)
  })

  it('applies steps one at a time and never skips one', () => {
    let last = 0
    for (let w = 1200; w >= 440; w -= 4) {
      const { step, routeIcon, sendIcon, tlsIcon, methodAbbrev } = urlRowLayout(w, { tls: true })
      expect(step - last).toBeLessThanOrEqual(1)
      expect([routeIcon, sendIcon, tlsIcon, methodAbbrev]).toEqual([step >= 1, step >= 2, step >= 3, step >= 4])
      last = step
    }
    expect(last).toBe(4)
  })

  it('shrinks the URL last, and never below 120px', () => {
    expect(urlRowLayout(300, { tls: true }).urlWidth).toBe(120)
  })
})
