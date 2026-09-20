import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8')

/**
 * Leaving an account, reachable from the screen to the keychain.
 *
 * THE DEFECT THIS GUARDS IS NOT A BUG IN LEAVING. It is the one this codebase
 * has produced twelve times: a control implemented, exported, tested directly,
 * and reached from nowhere. `forgetAddySecret` was exactly that for months —
 * it existed in `keys.ts`, was imported by `session.ts`, and no IPC channel
 * called anything that called it, so there was no way to leave an account from
 * the product at all.
 *
 * So each link is asserted, not just the ends. A test that only checked
 * `leaveAccount` exists would have passed throughout the period when nothing
 * could invoke it.
 */
describe('leaving an account is wired end to end', () => {
  const session = read('src', 'main', 'services', 'addy', 'session.ts')
  const main = read('src', 'main', 'index.ts')
  const preload = read('src', 'preload', 'index.ts')
  const panel = read('src', 'renderer', 'src', 'components', 'addy', 'AddyPanel.tsx')

  it('the session forgets every kind of secret it holds for the account', () => {
    const body = session.slice(session.indexOf('async leaveAccount('))
    expect(body.length, 'the parser is wrong, not the code').toBeGreaterThan(400)
    const fn = body.slice(0, body.indexOf('\n  }'))
    // Each kind the machine-only contract names. Leaving one behind leaves a
    // key on the disk of a machine the user believes they have detached.
    for (const scope of [':device', ':device-enc', ':account', ':root']) {
      expect(fn, `a secret scoped ${scope} survives leaving`).toContain(scope)
    }
    expect(fn, 'the enrolment record survives, so the panel still thinks it is joined').toContain(
      'forgetEnrolment()'
    )
    expect(fn, 'sync state survives, so a later join would resume somebody else’s agreements').toContain(
      'forgetSyncState()'
    )
    // Sync must stop BEFORE the state is forgotten, or an in-flight pass
    // writes it back afterwards.
    expect(fn.indexOf('detach()'), 'detach must come before the forgetting').toBeLessThan(
      fn.indexOf('forgetSyncState()')
    )
  })

  it('an IPC channel calls it', () => {
    expect(main).toContain("ipcMain.handle('addy:leave'")
    expect(main, 'the handler does not call leaveAccount').toMatch(
      /addy:leave'[^\n]*leaveAccount\(\)/
    )
  })

  it('the preload bridges that channel', () => {
    expect(preload).toContain("ipcRenderer.invoke('addy:leave')")
    expect(preload, 'the bridge is not named leave, so the renderer cannot find it').toMatch(
      /leave: \(\)/
    )
  })

  it('the panel calls the bridge, and only behind a confirmation', () => {
    expect(panel, 'nothing in the panel reaches the bridge').toContain('leave()')
    // Two presses. A single-press leave is a data-loss button next to a
    // re-key button.
    const row = panel.slice(panel.indexOf('function LeaveRow('))
    expect(row.length, 'the parser is wrong, not the code').toBeGreaterThan(400)
    const body = row.slice(0, row.indexOf('\nfunction '))
    expect(body, 'no open/confirm state, so Leave acts on the first press').toContain('setOpen')
    expect(body, 'the confirmation does not say leaving is not removal').toMatch(
      /does not remove the device/i
    )
    expect(body, 'the last-device case is not called out, and it is the unrecoverable one').toMatch(
      /only device/i
    )
  })

  it('the panel mounts it only when this device is on an account', () => {
    expect(panel).toMatch(/status\?\.enrolled && <LeaveRow/)
  })
})
