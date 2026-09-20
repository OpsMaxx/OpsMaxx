import { describe, it, expect } from 'vitest'
import { splitTicket } from '../src/renderer/src/components/addy/PairingPanel'
import { addyPairLink, parseAddyLink } from '../src/shared/addyLink'

/**
 * One thing to carry, not two.
 *
 * The id addresses the mailbox and the code proves who may open it, so both
 * cross — but that is the protocol's business. Two labelled fields meant two
 * chances to transpose a character and a decision about which box each went
 * in, while the other machine waited and the code expired with the window.
 */
describe('a pairing ticket', () => {
  it('splits what the other device shows', () => {
    expect(splitTicket('abcd1234.wxyz9876')).toEqual({ code: 'abcd1234', pairingId: 'wxyz9876' })
  })

  it('accepts the shapes a chat window and a human produce', () => {
    const want = { code: 'abcd1234', pairingId: 'wxyz9876' }
    // Trimmed, wrapped onto two lines, and the previous version's copy format.
    expect(splitTicket('  abcd1234.wxyz9876  ')).toEqual(want)
    expect(splitTicket('abcd1234\nwxyz9876')).toEqual(want)
    expect(splitTicket('abcd1234 wxyz9876')).toEqual(want)
  })

  it('refuses what is not one, rather than joining with half of it', () => {
    for (const bad of ['', '   ', 'abcd1234', '.wxyz9876', 'abcd1234.', 'ab.cd', 'abcd1234.wxyz!!!!']) {
      expect(splitTicket(bad), `accepted ${JSON.stringify(bad)}`).toBeNull()
    }
  })

  it('round-trips through the link the showing device offers', () => {
    const link = addyPairLink('https://addy.opsmaxx.dev', 'abcd1234', 'wxyz9876')
    const parsed = parseAddyLink(link)
    expect('link' in parsed, link).toBe(true)
    if (!('link' in parsed)) return
    expect(parsed.link.action).toBe('pair')
    expect(parsed.link.relay).toBe('https://addy.opsmaxx.dev')
    expect(parsed.link.code).toBe('abcd1234')
    expect(parsed.link.pairingId).toBe('wxyz9876')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('the pairing panel is not a dead end and the link is consumed', () => {
  const panel = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'addy', 'PairingPanel.tsx'),
    'utf8'
  )

  it('offers another pairing after one succeeds', () => {
    const done = panel.slice(panel.indexOf("stage === 'done'"))
    expect(done.length, 'the parser is wrong, not the code').toBeGreaterThan(100)
    // A terminal state with no way back meant no third device: the only route
    // to another pairing was restarting the app, on the screen whose whole job
    // is adding machines.
    expect(done.slice(0, 700), 'the done state has no way back to pairing').toMatch(
      /Pair another device/
    )
  })

  it('listens for a link from the OS', () => {
    // The handler was wired from the scheme to the renderer and no further, so
    // a clicked link brought the app to the front and did nothing.
    expect(panel, 'nothing subscribes to addy:link').toContain('onLink')
    expect(panel, 'a refused link is not surfaced').toContain('onLinkRefused')
    // It fills the field. It must not join.
    const effect = panel.slice(panel.indexOf('onLink?.('))
    expect(effect.slice(0, 500), 'the link handler joins by itself').not.toMatch(/joinPairing\(/)
  })
})

describe('a paired device gets a name that is actually its own', () => {
  const session = readFileSync(
    join(__dirname, '..', 'src', 'main', 'services', 'addy', 'session.ts'),
    'utf8'
  )
  const panel = readFileSync(
    join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'addy', 'PairingPanel.tsx'),
    'utf8'
  )

  it('never seals a constant as the label', () => {
    // `confirmation.self` is returned by the sidecar ONLY to the joining
    // device, and the initiator writes the roster entry — so
    // `confirmation.self?.label` was always undefined and the `??` behind it
    // sealed the string "a paired device" into an immutable entry. Every
    // device this product ever paired had that name, including siblings on one
    // account: two identical rows, one with a button that wipes a laptop.
    const at = session.indexOf('label: label?.trim()')
    expect(at, 'the label is no longer built where the fix was made').toBeGreaterThan(-1)
    const line = session.slice(at, at + 200)
    expect(line, 'the fallback is a constant again').not.toMatch(/'a paired device'/)
    expect(line, 'the fallback is not derived from that device’s own key').toMatch(/pubSign/i)
  })

  it('asks the person doing the pairing, because nothing else can', () => {
    expect(panel, 'no field for the name').toContain('newLabel')
    expect(panel, 'the name is not sent with the confirmation').toMatch(
      /completePairing\(confirmation, newLabel\)/
    )
    // Only the machine writing the entry is asked; the joiner does not write
    // one and has nothing to name.
    const field = panel.slice(panel.indexOf('{!confirmation.self && ('))
    expect(field.slice(0, 400), 'the joiner is asked for a name it cannot use').toContain(
      'What is the other machine called?'
    )
  })
})
