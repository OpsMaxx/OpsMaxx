import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OSC52_MAX_BASE64, parseOsc52 } from '../src/shared/osc52'

// Copying out of Claude Code running on a server. Its copy arrives as OSC 52,
// which xterm.js drops unless something handles it — reported as "copy works
// in a normal shell but not in Claude".

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

describe('an OSC 52 write', () => {
  it('copies the text, whichever selection it names', () => {
    expect(parseOsc52(`c;${b64('kubectl get pods -A')}`)).toBe('kubectl get pods -A')
    expect(parseOsc52(`;${b64('no selection named')}`)).toBe('no selection named')
    expect(parseOsc52(`p;${b64('primary')}`)).toBe('primary')
  })

  it('keeps UTF-8 and newlines intact', () => {
    const text = 'naïve — ✓\nکاپی\n'
    expect(parseOsc52(`c;${b64(text)}`)).toBe(text)
  })

  it('tolerates base64 wrapped across lines', () => {
    const wrapped = b64('a long enough line to wrap').replace(/(.{8})/g, '$1\n')
    expect(parseOsc52(`c;${wrapped}`)).toBe('a long enough line to wrap')
  })
})

describe('what it refuses', () => {
  it('never answers a request to READ the clipboard', () => {
    // Answering would hand the user's last local copy to any program on any
    // server they connect to.
    expect(parseOsc52('c;?')).toBeNull()
  })

  it('does not let a remote program clear the clipboard', () => {
    expect(parseOsc52('c;')).toBeNull()
  })

  it('ignores malformed payloads', () => {
    expect(parseOsc52('no-semicolon')).toBeNull()
    expect(parseOsc52('c;not base64!!')).toBeNull()
    expect(parseOsc52(`c;${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')}`)).toBeNull()
  })

  it('caps the size', () => {
    expect(parseOsc52(`c;${'A'.repeat(OSC52_MAX_BASE64 + 4)}`)).toBeNull()
  })
})

describe('the terminal', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src/renderer/src/hooks/useTerminalSession.ts'), 'utf8')
  const start = SRC.indexOf('export function createTerm(')
  const create = SRC.slice(start, SRC.indexOf('return { term, fit, search }', start))

  it('handles OSC 52 in createTerm, which every terminal is built by', () => {
    expect(create).toMatch(/registerOscHandler\(52,[\s\S]*parseOsc52\(data\)[\s\S]*clipboard\.write\(text\)/)
  })

  it('lets Option-drag select on macOS inside a mouse-capturing program', () => {
    expect(create).toMatch(/macOptionClickForcesSelection: true/)
  })
})
