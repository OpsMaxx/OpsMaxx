import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../src/main/services/ssh', () => ({ acquire: vi.fn(), release: vi.fn() }))
const { guardNavigation } = await import('../src/main/services/httpClient')

type Listener = (e: { url: string; preventDefault(): void }) => void

function fakeContents(current: string) {
  let listener: Listener | null = null
  return {
    getURL: () => current,
    on: (_event: 'will-navigate', fn: Listener) => {
      listener = fn
    },
    navigate(url: string): boolean {
      let prevented = false
      listener?.({ url, preventDefault: () => (prevented = true) })
      return prevented
    }
  }
}

describe('the will-navigate guard (SEC-M9)', () => {
  it('prevents the main window leaving the app', () => {
    const contents = fakeContents('file:///Applications/OpsMaxx.app/renderer/index.html')
    guardNavigation(contents)
    expect(contents.navigate('https://example.com')).toBe(true)
    expect(contents.navigate('file:///etc/passwd')).toBe(true)
  })

  it('allows the app reloading itself, hash or not', () => {
    const contents = fakeContents('http://localhost:5173/')
    guardNavigation(contents)
    expect(contents.navigate('http://localhost:5173/')).toBe(false)
    expect(contents.navigate('http://localhost:5173/#settings')).toBe(false)
    expect(contents.navigate('http://localhost:5174/')).toBe(true)
  })

  it('is installed on the main window', () => {
    expect(readFileSync('src/main/index.ts', 'utf8')).toContain('guardNavigation(mainWindow.webContents)')
  })
})
