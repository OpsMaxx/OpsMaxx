import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
    // A singular form may say the number in words ("Jede Stunde") and drop
    // `{{count}}`, as English "_one" forms already do; nothing else may go.
    const wrong = Object.entries(pack(l)).filter(([k, v]) => {
      const source = en[k] ?? en[`${base(k)}_other`] ?? en[base(k)]
      if (source === undefined) return false
      const singular = PLURAL.test(k) && !k.endsWith('_other')
      const strip = (names: string[]): string[] => (singular ? names.filter((n) => n !== 'count') : names)
      return strip(vars(v)).join() !== strip(vars(source)).join()
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

describe('the shared translator', () => {
  it('speaks English until something points it elsewhere, which only the renderer does', async () => {
    const { st, setSharedTranslator, englishT, loadTranslator } = await import('../src/shared/i18n')
    const key = 'menu.edit' as MessageKey
    expect(st(key)).toBe('Edit')
    try {
      setSharedTranslator(await loadTranslator('de'))
      expect(st(key)).toBe('Bearbeiten')
      expect(englishT(key)).toBe('Edit')
    } finally {
      setSharedTranslator(englishT)
    }
  })

  it('leaves names that are stored with a grant in English, whatever the screen speaks', async () => {
    const { setSharedTranslator, englishT, loadTranslator } = await import('../src/shared/i18n')
    const { resolveDefaultSessionGroup, sessionModeLabel } = await import('../src/shared/mcp')
    try {
      setSharedTranslator(await loadTranslator('de'))
      expect(resolveDefaultSessionGroup(null, []).name).toBe('No AI Access')
      expect(sessionModeLabel('auto', undefined, englishT)).toBe('Auto')
    } finally {
      setSharedTranslator(englishT)
    }
  })

  it('is never pointed anywhere by main', () => {
    let hits = ''
    try {
      hits = execFileSync('git', ['grep', '-l', 'setSharedTranslator', '--', 'src/main', 'src/cli', 'src/preload'], {
        encoding: 'utf8'
      })
    } catch (e) {
      // Exit 1 is git grep finding nothing, which is the point.
      if ((e as { status?: number }).status !== 1) throw e
    }
    expect(hits).toBe('')
  })
})
