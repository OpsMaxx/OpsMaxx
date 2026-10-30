import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  LOCALES,
  PSEUDO_LOCALE,
  loadMessages,
  parseLanguagePref,
  pseudoLocalize,
  resolveLocale,
  translate,
  type Locale,
  type MessageKey,
  type Messages
} from '../src/shared/i18n'

const pack = (l: string): Messages => JSON.parse(readFileSync(`src/shared/locales/${l}.json`, 'utf8'))
const en = pack('en')
const PLURAL = /_(zero|one|two|few|many|other)$/
const base = (k: string): string => k.replace(PLURAL, '')
const vars = (s: string): string[] => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort()

describe('language packs', () => {
  // A pack that is BEHIND English is fine: the missing strings show in English
  // and a translator catches up. A pack that is WRONG is not, and these are the
  // ways a pack can be wrong without anyone reading it.
  it.each(LOCALES.filter((l) => l !== 'en'))('%s has no key English lacks', (l) => {
    const known = new Set(Object.keys(en).map(base))
    expect(Object.keys(pack(l)).filter((k) => !known.has(base(k)))).toEqual([])
  })

  it.each(LOCALES.filter((l) => l !== 'en'))('%s keeps every placeholder English has', (l) => {
    // A translated `{{count}}` comes out as the literal text "{{Anzahl}}".
    const wrong = Object.entries(pack(l)).filter(([k, v]) => {
      const source = en[k] ?? en[`${base(k)}_other`] ?? en[base(k)]
      return source !== undefined && vars(v).join() !== vars(source).join()
    })
    expect(wrong.map(([k]) => k)).toEqual([])
  })

  it.each(LOCALES)('%s has no empty strings', (l) => {
    expect(Object.entries(pack(l)).filter(([, v]) => typeof v !== 'string' || !v.trim())).toEqual([])
  })

  it('gives every English plural an _other form, which every language falls back to', () => {
    const plurals = new Set(Object.keys(en).filter((k) => PLURAL.test(k)).map(base))
    expect([...plurals].filter((b) => !(`${b}_other` in en))).toEqual([])
  })

  it.each<Locale>([...LOCALES, PSEUDO_LOCALE])('%s loads through the same path the app uses', async (l) => {
    expect(Object.keys(await loadMessages(l)).length).toBeGreaterThan(0)
  })
})

describe('translate', () => {
  const key = 'menu.edit' as MessageKey

  it('falls back to English for a key the pack lacks', () => {
    expect(translate('de', {}, key)).toBe('Edit')
  })

  it('picks the plural form the language asks for, then _other', () => {
    const m = { 'x_one': '{{count}} Datei', 'x_other': '{{count}} Dateien' }
    const k = 'x' as MessageKey
    expect(translate('de', m, k, { count: 1 })).toBe('1 Datei')
    expect(translate('de', m, k, { count: 3 })).toBe('3 Dateien')
    // Chinese has one form, `other`, and never asks for `one`.
    expect(translate('zh-CN', { 'x_other': '{{count}} 个文件' }, k, { count: 1 })).toBe('1 个文件')
  })

  it('leaves a placeholder it has no value for, rather than printing "undefined"', () => {
    expect(translate('en', { k: 'Hi {{name}} {{other}}' }, 'k' as MessageKey, { name: 'Ana' })).toBe('Hi Ana {{other}}')
  })
})

describe('resolveLocale', () => {
  it('follows the first OS language it has a pack for', () => {
    expect(resolveLocale('system', ['nl-NL', 'de-AT', 'fr'])).toBe('de')
    expect(resolveLocale('system', ['es-419'])).toBe('es')
  })

  it('takes Simplified Chinese tags, and does not hand Simplified to Traditional', () => {
    expect(resolveLocale('system', ['zh-Hans-CN'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-CN'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-Hant-TW', 'fr-CA'])).toBe('fr')
    expect(resolveLocale('system', ['zh-HK'])).toBe('en')
  })

  it('lets an explicit choice win over the OS', () => {
    expect(resolveLocale('fr', ['de-DE'])).toBe('fr')
  })

  it('treats anything unrecognised on disk as "system"', () => {
    expect(parseLanguagePref('klingon')).toBe('system')
    expect(parseLanguagePref(undefined)).toBe('system')
    expect(parseLanguagePref('zh-CN')).toBe('zh-CN')
  })
})

describe('pseudo-locale', () => {
  it('changes every letter, keeps placeholders intact, and grows the string', () => {
    const out = pseudoLocalize('Delete {{count}} files')
    expect(out).toMatch(/^\[Ðéĺéţé \{\{count\}\} ƒîĺéš~+\]$/)
    expect(out.length).toBeGreaterThan('Delete {{count}} files'.length * 1.3)
  })
})
