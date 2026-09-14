import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
// From the mock by PATH rather than through the `electron` specifier. Vitest
// aliases that specifier to this same file, so it is the same module instance
// the tap patches — but `tsc` resolves the specifier to Electron's real types,
// which have no `handlers` map to read a registration back out of.
import { ipcMain } from './mocks/electron'
import {
  debugRecord,
  deleteDebugLog,
  installIpcDebugTap,
  readDebugTrace,
  resetDebugLogForTests,
  syncDebugLog,
  DEBUG_LOG_PATH
} from '../src/main/services/debugLog'

// One wrapper stands in for a log statement at 302 call sites, which is the only
// reason instrumenting this app was a small change rather than a rewrite. The
// things that make it safe rather than merely convenient are all testable, and
// all of them are the kind that rot quietly, so they are pinned here.

const on = (): void => syncDebugLog({ settings: { debugLogEnabled: true } })

/** The channels the tap has recorded, newest last. */
const channels = (): string[] =>
  readDebugTrace()
    .map((l) => JSON.parse(l) as { event: string; ch?: string })
    .filter((e) => e.event === 'ipc')
    .map((e) => e.ch ?? '')

beforeEach(() => {
  resetDebugLogForTests()
  deleteDebugLog()
  ipcMain.handlers.clear()
  installIpcDebugTap()
})

describe('what the tap records', () => {
  it('records the channel, not the arguments', async () => {
    on()
    ipcMain.handle('ssh:connect', () => 'connected')

    await ipcMain.handlers.get('ssh:connect')?.({}, { host: 'db.internal', password: 'hunter2' })

    // THE assertion in this file. Arguments carry passwords, passphrases, key
    // material and vault contents; leaving them out is what keeps the trace
    // tolerable by shape rather than by trusting a filter over text nobody
    // bounded. A secret that never reaches the file cannot leak out of it.
    const raw = readFileSync(DEBUG_LOG_PATH, 'utf8')
    expect(raw).toContain('ssh:connect')
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('db.internal')
  })

  it('records that a handler threw, and rethrows it unchanged', () => {
    on()
    ipcMain.handle('ssh:connect', () => {
      throw new Error('ECONNREFUSED')
    })

    // Synchronously, the way the handler threw it. A wrapper that turned a sync
    // throw into a rejection would change the IPC surface it only observes.
    expect(() => ipcMain.handlers.get('ssh:connect')?.({})).toThrow('ECONNREFUSED')

    // Which operation failed and why is the whole of what a maintainer is
    // reading the trace for.
    expect(readFileSync(DEBUG_LOG_PATH, 'utf8')).toContain('ECONNREFUSED')
  })

  it('records a rejected promise the same way', async () => {
    on()
    ipcMain.handle('vault:unlock', () => Promise.reject(new Error('bad passphrase')))

    await expect(ipcMain.handlers.get('vault:unlock')?.({})).rejects.toThrow('bad passphrase')

    expect(channels()).toContain('vault:unlock')
  })
})

describe('what the tap must not change', () => {
  it('returns what the handler returned', async () => {
    on()
    ipcMain.handle('app:platform', () => 'darwin')
    expect(await ipcMain.handlers.get('app:platform')?.({})).toBe('darwin')
  })

  it('leaves a synchronous handler synchronous', () => {
    on()
    ipcMain.handle('window:isMaximized', () => false)
    // Not awaited on purpose: a wrapper that made every handler async would
    // change the IPC surface it was only supposed to observe.
    expect(ipcMain.handlers.get('window:isMaximized')?.({})).toBe(false)
  })

  it('does nothing at all while debug mode is off', async () => {
    ipcMain.handle('data:load', () => ({}))
    await ipcMain.handlers.get('data:load')?.({})
    expect(readDebugTrace()).toEqual([])
  })

  it('skips its own channels', async () => {
    on()
    ipcMain.handle('debug:status', () => ({ enabled: true }))

    await ipcMain.handlers.get('debug:status')?.({})

    // Or the call that reports the trace's size appends to the trace it is
    // reporting on, and reading the status grows the thing being read.
    expect(channels()).not.toContain('debug:status')
  })

  it('does not recurse when the append itself fails', () => {
    on()
    // `appendLogLine` throws on a refused path, `debugRecord` catches it, and
    // the catch must not reach a console this module has teed back into itself.
    expect(() => debugRecord('ipc', { ch: 'x' })).not.toThrow()
  })
})

describe('the claim that it is installed before every registration', () => {
  it('holds, because only one file registers handlers', () => {
    // The tap is installed as the first statement of src/main/index.ts, which
    // covers every registration only for as long as that file is the only one
    // that registers any. Moving a handler into a feature module would silently
    // stop it being recorded, and this is the signal that it happened.
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name)
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
      })

    const registrars = walk('src/main').filter((p) => {
      const src = readFileSync(p, 'utf8')
      return src.includes('ipcMain.handle(') || src.includes('ipcMain.on(')
    })

    // One file, and services/debugLog.ts is deliberately not in this list: it
    // REASSIGNS `ipcMain.handle` rather than calling it, which is the whole
    // mechanism.
    expect(registrars).toEqual([join('src', 'main', 'index.ts')])
  })
})
