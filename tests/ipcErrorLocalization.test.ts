import { beforeEach, describe, expect, it } from 'vitest'
import { ipcMain } from './mocks/electron'
import { installIpcErrorLocalization, syncLanguage } from '../src/main/services/locale'
import { LocalizedError, englishT, type MessageKey } from '../src/shared/i18n'

const key = 'menu.edit' as MessageKey
const call = (channel: string): unknown => ipcMain.handlers.get(channel)?.({})

// Main's language is module state; each test sets the one it needs and waits
// for the pack, the way syncLanguage's own onChange tells main to redraw.
const speak = (language: string): Promise<void> =>
  new Promise((done) => {
    if (!syncLanguage({ settings: { language } }, [], done)) done()
  })

beforeEach(async () => {
  ipcMain.handlers.clear()
  await speak('en')
})

describe('a LocalizedError on its way to the renderer', () => {
  installIpcErrorLocalization()

  it('keeps English as the error main itself sees', () => {
    expect(new LocalizedError(key).message).toBe(englishT(key))
  })

  it('reaches the renderer in the language main is speaking', async () => {
    await speak('de')
    ipcMain.handle('x:sync', () => {
      throw new LocalizedError(key)
    })
    ipcMain.handle('x:async', async () => {
      throw new LocalizedError(key)
    })
    expect(() => call('x:sync')).toThrow('Bearbeiten')
    await expect(call('x:async')).rejects.toThrow('Bearbeiten')
  })

  it('leaves every other error, and every result, exactly as it was', async () => {
    await speak('de')
    const plain = new Error('ECONNREFUSED')
    ipcMain.handle('x:plain', async () => {
      throw plain
    })
    ipcMain.handle('x:ok', () => 42)
    await expect(call('x:plain')).rejects.toBe(plain)
    expect(call('x:ok')).toBe(42)
  })
})
