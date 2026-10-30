import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { load } from 'js-yaml'
import { LOCALES } from '../src/shared/i18n'

// The text the operating system shows on the app's behalf: macOS permission
// prompts and the Linux menu entry. It lives in packaging, not in the language
// packs, so nothing else notices when a language or a prompt is added.

type Builder = {
  mac: { extendInfo: Record<string, string>; extraResources?: { from: string; filter: string[] }[] }
  linux: { desktop: { entry: Record<string, string> } }
}
const builder = load(readFileSync('electron-builder.yml', 'utf8')) as Builder

// The folder names macOS and Electron use, which are not quite BCP 47.
const LPROJ: Record<string, string> = { 'zh-CN': 'zh_CN', fr: 'fr', es: 'es', de: 'de' }
const translated = LOCALES.filter((l) => l !== 'en')

const prompts = Object.entries(builder.mac.extendInfo).filter(([k]) => k.endsWith('UsageDescription'))

function strings(lproj: string): Record<string, string> {
  const text = readFileSync(`build/locales/${lproj}.lproj/InfoPlist.strings`, 'utf8')
  return Object.fromEntries([...text.matchAll(/"(\w+)" = "((?:[^"\\]|\\.)*)";/g)].map((m) => [m[1], m[2]]))
}

describe('macOS permission prompts', () => {
  it('has a folder for every language the app speaks, and none it does not', () => {
    expect(readdirSync('build/locales').sort()).toEqual(translated.map((l) => `${LPROJ[l]}.lproj`).sort())
  })

  it.each(translated)('says every prompt in %s, and only those', (l) => {
    const s = strings(LPROJ[l])
    expect(Object.keys(s).sort()).toEqual(prompts.map(([k]) => k).sort())
    for (const [k, english] of prompts) expect(s[k], k).not.toBe(english)
  })

  it('ships them into the app bundle', () => {
    expect(builder.mac.extraResources?.some((r) => r.from === 'build/locales')).toBe(true)
  })
})

describe('the Linux menu entry', () => {
  it.each(translated)('has a %s comment', (l) => {
    expect(builder.linux.desktop.entry[`Comment[${LPROJ[l]}]`]).toBeTruthy()
  })
})
