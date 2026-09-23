import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The access, posture, change-log and drift gates used to be read from the data
// file at module scope in main — before `ready`, when a sealed file cannot be
// unsealed — so every launch with an existing profile brought all four up OFF
// and logged the primary and the backup as unreadable.
//
// Asserted against the source because the alternative is booting an Electron
// main process, and the regression is precisely a call moving back above
// whenReady.
const main = readFileSync(resolve(__dirname, '..', 'src/main/index.ts'), 'utf8')
const ready = main.indexOf('app.whenReady().then(')

describe('module gates at boot', () => {
  it('are read inside whenReady, from the one boot read', () => {
    expect(ready).toBeGreaterThan(-1)
    const boot = main.indexOf('const boot = loadData()', ready)
    expect(boot).toBeGreaterThan(ready)
    expect(main.indexOf('syncAccessModule(boot)', boot)).toBeGreaterThan(boot)
  })

  it('are never read before whenReady', () => {
    const early = main.slice(0, ready)
    // The only loadData() above whenReady may be the data:load handler, which
    // no renderer can call before there is a window.
    const calls = early.match(/loadData\(\)/g) ?? []
    expect(early).not.toMatch(/syncAccessModule\(loadData\(\)\)/)
    expect(calls.length).toBe((early.match(/ipcMain\.handle\('data:load', \(\) => loadData\(\)\)/g) ?? []).length)
  })
})
