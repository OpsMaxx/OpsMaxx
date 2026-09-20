import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8')

/**
 * Every state this device can be in has a way out of it, reachable from the
 * screen.
 *
 * THE DEFECT CLASS, AGAIN: `startSync` had exactly one caller — the end of
 * `loginAndRecord`, which only runs at launch — so every way of failing to
 * attach left a device whose single remedy was quitting OpsMaxx, and nothing
 * said so. And the only control the product offered was Leave, which destroys
 * this device's keys, so somebody who wanted to stop for an hour had to take
 * the irreversible option.
 */
describe('the addy session has a way out of every state', () => {
  const session = read('src', 'main', 'services', 'addy', 'session.ts')
  const main = read('src', 'main', 'index.ts')
  const preload = read('src', 'preload', 'index.ts')
  const panel = read('src', 'renderer', 'src', 'components', 'addy', 'AddyPanel.tsx')

  it('detaching forgets the roster, so a left account stops listing devices', () => {
    const fn = session.slice(session.indexOf('async detach()'))
    expect(fn.length, 'the parser is wrong, not the code').toBeGreaterThan(200)
    const body = fn.slice(0, fn.indexOf('\n  }'))
    expect(
      body,
      'lastRoster survives detach, so a device that left still renders the device table ' +
        'of the account it left, with "including this one" beside a count that is not true'
    ).toContain('this.lastRoster = null')
  })

  for (const [name, channel] of [
    ['reconnect', 'addy:reconnect'],
    ['pauseSync', 'addy:pauseSync'],
    ['resumeSync', 'addy:resumeSync']
  ] as const) {
    it(`${name} is reachable from the renderer`, () => {
      expect(session, `${name} does not exist on the session`).toContain(`${name}(`)
      expect(main, `no IPC channel for ${name}`).toContain(`ipcMain.handle('${channel}'`)
      expect(preload, `${name} is not bridged, so the renderer cannot call it`).toContain(
        `ipcRenderer.invoke('${channel}')`
      )
    })
  }

  it('the panel offers the retry, and only when there is something to retry', () => {
    expect(panel, 'nothing calls reconnect').toContain('reconnect()')
    // Rendered from `status.problem`, which is the field that used to be a
    // console log. A retry button with no stated reason is a shrug.
    const problems = panel.slice(panel.indexOf('function AddyProblems('))
    const body = problems.slice(0, problems.indexOf('\nfunction '))
    expect(body, 'the banner does not read the problem').toContain('status?.problem')
    expect(body, 'the banner has no way to act on the problem').toContain('ReconnectButton')
  })

  it('pausing is offered above leaving, so the quiet answer is read first', () => {
    expect(panel).toContain('PauseRow')
    const pauseAt = panel.indexOf('<PauseRow')
    const leaveAt = panel.indexOf('<LeaveRow')
    expect(pauseAt, 'PauseRow is not mounted').toBeGreaterThan(-1)
    expect(leaveAt, 'LeaveRow is not mounted').toBeGreaterThan(-1)
    expect(
      pauseAt,
      'Leave is offered before Pause, so the irreversible option is the one found first'
    ).toBeLessThan(leaveAt)
  })

  it('resuming sync refuses without a token, rather than starting a timer that fails', () => {
    const fn = session.slice(session.indexOf('resumeSync('))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    expect(body.length, 'the parser is wrong, not the code').toBeGreaterThan(100)
    expect(
      body,
      'a timer without a token runs a pass that fails every collection and records ' +
        'that failure as the account’s state'
    ).toMatch(/token === ''|this\.account === null/)
  })
})
