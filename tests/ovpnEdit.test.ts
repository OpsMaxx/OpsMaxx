import { describe, it, expect } from 'vitest'

import {
  assertEditable,
  ovpnEditChange,
  OVPN_EDIT_REFUSAL_HELP,
  placeholderFor,
  redactInlineBlocks,
  restoreInlineBlocks
} from '../src/main/services/vpn/ovpnEdit'
import { parseOvpn } from '../src/main/services/vpn/parsers/ovpn'

// Editing an imported .ovpn without re-importing it.
//
// Every test here is about one thing: the obvious version of this feature ships
// a private key to the renderer. A stored `configBody` is a vault secret
// precisely because it carries `<key>`, and "let them edit the text" means
// handing that to a window, and from there to the clipboard.

const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIB\n-----END CERTIFICATE-----'

const profile = (): string =>
  [
    'client',
    'dev tun',
    'proto udp',
    'remote vpn.example.com 1194',
    'cipher AES-256-GCM',
    '<ca>',
    CERT,
    '</ca>',
    '<cert>',
    CERT,
    '</cert>',
    '<key>',
    KEY,
    '</key>',
    ''
  ].join('\n')

describe('what leaves this process', () => {
  it('carries no key material at all', () => {
    const r = redactInlineBlocks(profile())
    expect(r.text).not.toContain('BEGIN PRIVATE KEY')
    expect(r.text).not.toContain('MIIEvQIBADANBgkq')
    expect(r.text).not.toContain('BEGIN CERTIFICATE')
  })

  it('keeps every directive an operator would want to edit', () => {
    const r = redactInlineBlocks(profile())
    expect(r.text).toContain('remote vpn.example.com 1194')
    expect(r.text).toContain('cipher AES-256-GCM')
  })

  it('leaves one unmistakable line where a hundred were', () => {
    const r = redactInlineBlocks(profile())
    expect(r.text).toContain(placeholderFor('key'))
    // Not config. openvpn would reject it, so a placeholder left in a file by a
    // bug fails loudly rather than being read as a directive.
    expect(placeholderFor('key').startsWith('###')).toBe(true)
  })

  it('holds the blocks in order, in this process only', () => {
    expect(redactInlineBlocks(profile()).blocks.map((b) => b.tag)).toEqual(['ca', 'cert', 'key'])
  })

  // A profile whose closing tag never arrives is broken either way. The version
  // that LEAKS is the one that stops redacting at the missing tag.
  it('redacts to the end of the file when a block is never closed', () => {
    const broken = `client\n<key>\n${KEY}\n`
    const r = redactInlineBlocks(broken)
    expect(r.text).not.toContain('BEGIN PRIVATE KEY')
    expect(r.blocks.map((b) => b.tag)).toEqual(['key'])
  })

  it('leaves a tag it does not know alone rather than swallowing it', () => {
    // `<something>` is not an inline block, and eating it would silently change
    // the profile.
    const r = redactInlineBlocks('client\n<something>\nx\n</something>\n')
    expect(r.text).toContain('<something>')
    expect(r.blocks).toEqual([])
  })
})

describe('putting the blocks back', () => {
  it('produces the original body when nothing was changed', () => {
    const r = redactInlineBlocks(profile())
    const back = restoreInlineBlocks(r.text, r.blocks)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.body).toContain(KEY)
    expect(back.body).toContain('<key>')
    expect(back.removed).toEqual([])
  })

  it('carries an edited directive through', () => {
    const r = redactInlineBlocks(profile())
    const edited = r.text.replace('remote vpn.example.com 1194', 'remote vpn2.example.com 443')
    const back = restoreInlineBlocks(edited, r.blocks)
    expect(back.ok && back.body).toContain('remote vpn2.example.com 443')
  })

  // Honoured AND reported. Removing `<cert>` silently is the difference between
  // a profile that connects and one that does not.
  it('treats a deleted placeholder as a removed block, and says which', () => {
    const r = redactInlineBlocks(profile())
    const edited = r.text.split('\n').filter((l) => l !== placeholderFor('cert')).join('\n')
    const back = restoreInlineBlocks(edited, r.blocks)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.removed).toEqual(['cert'])
    expect(back.body).not.toContain('<cert>')
    expect(back.body).toContain('<key>')
  })

  it('refuses a placeholder for a block the profile does not have', () => {
    const r = redactInlineBlocks('client\nremote a 1\n')
    const back = restoreInlineBlocks(`client\n${placeholderFor('key')}\n`, r.blocks)
    expect(back.ok).toBe(false)
    expect(back.ok ? '' : back.reason).toBe('unknown-placeholder')
  })

  it('refuses the same placeholder twice', () => {
    const r = redactInlineBlocks(profile())
    const back = restoreInlineBlocks(`${r.text}\n${placeholderFor('key')}`, r.blocks)
    expect(back.ok ? '' : back.reason).toBe('duplicate-placeholder')
  })

  // The case where somebody genuinely wants a new key. That is an IMPORT, and
  // accepting it here would make the whole redaction theatre.
  it('refuses a key pasted back into the edit', () => {
    const r = redactInlineBlocks(profile())
    const back = restoreInlineBlocks(`${r.text}\n<key>\n${KEY}\n</key>\n`, r.blocks)
    expect(back.ok).toBe(false)
    if (back.ok) return
    expect(back.reason).toBe('pasted-key')
    expect(back.detail).toContain('is an import, not an edit')
  })

  it('names every refusal in words rather than a code', () => {
    for (const v of Object.values(OVPN_EDIT_REFUSAL_HELP)) expect(v.length).toBeGreaterThan(40)
  })
})

describe('the sanitiser still runs afterwards', () => {
  // There is exactly one sanitiser, and this file deliberately does not have a
  // second opinion: a rule kept in two places is a rule that drifts.
  it('hands the restored body to the real parser, which accepts a good one', () => {
    const r = redactInlineBlocks(profile())
    const back = restoreInlineBlocks(r.text, r.blocks)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    const parsed = parseOvpn(back.body)
    expect(parsed.ok).toBe(true)
    expect(parsed.spec?.kind).toBe('openvpn')
  })

  it('lets the parser refuse a directive the edit introduced', () => {
    // `up` runs a script. The edit path adds no rules of its own; it is the
    // sanitiser that says no, which is the point.
    const r = redactInlineBlocks(profile())
    const back = restoreInlineBlocks(`${r.text}\nup /tmp/evil.sh`, r.blocks)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    let threw = false
    try {
      const parsed = parseOvpn(back.body)
      // Either a throw or a refusal; both are the sanitiser doing its job.
      threw = parsed.ok === false
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('what changed, for the confirmation', () => {
  it('names the lines added and removed', () => {
    const before = 'client\nremote a 1194\ncipher AES-256-GCM\n'
    const after = 'client\nremote b 443\ncipher AES-256-GCM\nverb 3\n'
    const c = ovpnEditChange(before, after)
    expect(c.added.sort()).toEqual(['remote b 443', 'verb 3'])
    expect(c.removed).toEqual(['remote a 1194'])
  })

  it('ignores comments and blank lines, which are not changes worth confirming', () => {
    const c = ovpnEditChange('client\n', '\n# a note\n;another\nclient\n')
    expect(c.added).toEqual([])
    expect(c.removed).toEqual([])
  })

  it('carries the removed blocks through to the same summary', () => {
    expect(ovpnEditChange('client\n', 'client\n', ['cert']).blocksRemoved).toEqual(['cert'])
  })

  it('reports nothing for an edit that changed nothing', () => {
    const c = ovpnEditChange(profile(), profile())
    expect(c.added).toEqual([])
    expect(c.removed).toEqual([])
  })
})

describe('a profile with nothing in it', () => {
  it('is refused rather than edited into existence', () => {
    expect(() => assertEditable('   \n')).toThrow(/no configuration stored/)
    expect(() => assertEditable('client\n')).not.toThrow()
  })
})
