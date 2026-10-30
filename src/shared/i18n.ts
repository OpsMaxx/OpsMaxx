import en from './locales/en.json'

// Translation for main and the renderer alike, in the file format i18next
// reads: one flat JSON object per language, `{{name}}` placeholders, and
// plural forms as `key_one` / `key_other` (whatever `Intl.PluralRules` names
// for that language). Written here rather than installed because it is this
// much code, it needs nothing a test has to mock, and the same function serves
// a process with no React in it. Moving to i18next later changes this file and
// none of the packs.
//
// English is the source of every key and the fallback for every missing one, so
// a pack that is behind shows English for the strings it lacks rather than a
// key or a blank.

export const LOCALES = ['en', 'zh-CN', 'fr', 'es', 'de'] as const
/** Generated from English: accented, padded, bracketed. Shows a string that
 *  skipped `t()` (it stays plain) and one that will not fit in German (it
 *  overflows). Offered in development builds only. */
export const PSEUDO_LOCALE = 'en-XA'
export type Locale = (typeof LOCALES)[number] | typeof PSEUDO_LOCALE
export type LanguagePref = 'system' | Locale

/** Each language named in itself, so someone who cannot read the current one
 *  can still find theirs. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  [PSEUDO_LOCALE]: 'Pseudo (en-XA)'
}

export type Messages = Record<string, string>
type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
type BaseKey<K> = K extends `${infer B}_${PluralSuffix}` ? B : K
/** Every key English has, with plural forms folded to their base key. */
export type MessageKey = BaseKey<keyof typeof en>
export type Vars = Record<string, string | number>
export type Translate = (key: MessageKey, vars?: Vars) => string

// Narrowed rather than trusted: it arrives from a data file on disk.
export function parseLanguagePref(v: unknown): LanguagePref {
  return v === PSEUDO_LOCALE || (LOCALES as readonly unknown[]).includes(v) ? (v as Locale) : 'system'
}

/** The pack to use for a preference, given the OS's languages in order. */
export function resolveLocale(pref: LanguagePref, system: readonly string[]): Locale {
  if (pref !== 'system') return pref
  for (const tag of system) {
    const [lang, ...rest] = tag.toLowerCase().split(/[-_]/)
    if (lang === 'zh') {
      // Traditional Chinese has no pack, and Simplified is the wrong script
      // for it rather than a near miss, so zh-TW / zh-HK / zh-Hant keep
      // looking down the list instead.
      if (rest.some((p) => p === 'hant' || p === 'tw' || p === 'hk' || p === 'mo')) continue
      return 'zh-CN'
    }
    const hit = LOCALES.find((l) => l === lang)
    if (hit) return hit
  }
  return 'en'
}

const ACCENT_FROM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const ACCENT_TO = [...'áƀçðéƒĝĥîĵķĺɱñöþǫŕšţûṽŵẋýžÅßÇÐÉƑĜĤÎĴĶĹṀÑÖÞǪŔŠŢÛṼŴẊÝŽ']

export function pseudoLocalize(s: string): string {
  const body = s
    .split(/(\{\{\s*\w+\s*\}\})/)
    .map((part, i) =>
      // Odd parts are placeholders and must survive untouched.
      i % 2 ? part : [...part].map((ch) => ACCENT_TO[ACCENT_FROM.indexOf(ch)] ?? ch).join('')
    )
    .join('')
  // About a third longer: roughly what German costs over English.
  return `[${body}${'~'.repeat(Math.ceil(s.length * 0.35))}]`
}

function lookup(locale: string, messages: Messages, key: string, vars?: Vars): string | undefined {
  if (typeof vars?.count === 'number') {
    const form = new Intl.PluralRules(locale).select(vars.count)
    return messages[`${key}_${form}`] ?? messages[`${key}_other`] ?? messages[key]
  }
  return messages[key]
}

export function translate(locale: Locale, messages: Messages, key: MessageKey, vars?: Vars): string {
  const msg = lookup(locale, messages, key, vars) ?? lookup('en', en, key, vars) ?? key
  if (!vars) return msg
  return msg.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

// One chunk per language, fetched only when that language is chosen. English
// is left out: it is imported above, and is the one pack every build carries.
const PACKS = import.meta.glob<Messages>(['./locales/*.json', '!./locales/en.json'], {
  import: 'default'
})

export async function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === 'en') return en
  if (locale === PSEUDO_LOCALE) {
    return Object.fromEntries(Object.entries(en).map(([k, v]) => [k, pseudoLocalize(v)]))
  }
  const load = PACKS[`./locales/${locale}.json`]
  if (!load) throw new Error(`No language pack for ${locale}`)
  return load()
}

export async function loadTranslator(locale: Locale): Promise<Translate> {
  const messages = await loadMessages(locale)
  return (key, vars) => translate(locale, messages, key, vars)
}

export const englishT: Translate = (key, vars) => translate('en', en, key, vars)
