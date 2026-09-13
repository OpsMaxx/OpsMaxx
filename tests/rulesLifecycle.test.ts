import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The rule engine's lifecycle against the window, and what the module switch
 * actually gates.
 *
 * Both of these are source-level assertions, and that is deliberate rather than
 * lazy: what broke is WHERE two calls sit in `src/main/index.ts` — a file that
 * boots Electron, opens a SQLite store and registers three hundred IPC handlers,
 * and cannot be imported in a unit test. The engine's own behaviour is covered
 * properly in tests/rulesEngine.test.ts; these two pin the wiring around it.
 */

const MAIN = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
const MODULES = readFileSync(join(__dirname, '../src/shared/modules.ts'), 'utf8')
const MONITOR = readFileSync(
  join(__dirname, '../src/renderer/src/components/monitor/FleetMonitor.tsx'),
  'utf8'
)

describe('the engine survives a window closing', () => {
  // THE BUG: on macOS, ⌘W then a Dock click left every rule permanently dead.
  //
  // `ruleEngine.stop()` runs from `webContents.on('destroyed')`, and
  // `window-all-closed` does not quit on darwin — so the app stayed running with
  // its sweep timer cleared, and `app.on('activate')` rebuilt the window without
  // restarting the engine. The panel still read "Enabled" for rules that could
  // no longer fire, which is the one claim RulesPanel is built never to make.
  //
  // The incoherence: `start()` precedes `createWindow()` in `whenReady` on
  // purpose — "so a rule does not wait on a window it never needs" — so the
  // engine is deliberately window-independent at START and was accidentally
  // window-dependent at STOP.
  it('restarts the engine whenever a window is created', () => {
    const fn = MAIN.slice(MAIN.indexOf('function createWindow(): void {'))
    const body = fn.slice(0, fn.indexOf('\nfunction '))
    expect(body, 'createWindow does not re-arm the rule engine').toMatch(/ruleEngine\.start\(\)/)
  })

  it('still starts the engine before any window exists', () => {
    // The other half, which must not be traded away for the fix above: rules
    // are meant to run on a launch that never shows a window.
    const ready = MAIN.slice(MAIN.indexOf('startHistory()'))
    const start = ready.indexOf('ruleEngine.start()')
    const window = ready.indexOf('createWindow()')
    expect(start, 'whenReady no longer starts the engine').toBeGreaterThan(-1)
    expect(start, 'the engine must start before the window, not after').toBeLessThan(window)
  })
})

describe('what the module switch claims to gate', () => {
  // The registry used to say the toggle gated "the PANEL and the sweep". The
  // sweep half was never true — main has flags for access, posture, changeLog
  // and drift, and has never had one for rules — so an install that switched
  // Rules off kept running its rules on that sentence's authority.
  it('does not claim to gate the sweep', () => {
    const entry = MODULES.slice(MODULES.indexOf("id: 'rules'"), MODULES.indexOf("id: 'drift'"))
    expect(entry).not.toMatch(/gates is the PANEL and the sweep/)
  })

  it('has no main-process flag for rules, which is why the claim was wrong', () => {
    // If somebody adds one later, this test should be deleted along with the
    // narrowed comment — not left asserting an absence that stopped being true.
    expect(MAIN).not.toMatch(/rulesModuleOn/)
  })

  it('keeps the panel reachable while any rule is armed', () => {
    // A switch may hide a feature. It may not hide the only list of what is
    // armed and the only control that disarms it, while those rules keep
    // running jobs on the estate.
    expect(MONITOR).toMatch(/useArmedRules/)
    expect(MONITOR).toMatch(/m\.id === 'rules' && rulesArmed/)
    expect(MONITOR).toMatch(/moduleEnabled\(modules, 'rules'\) \|\| rulesArmed/)
  })

  it('stops advertising rules as switched-off while it is on screen', () => {
    // Otherwise the strip disagrees with itself: a tab the reader can see,
    // listed under "switched off and available" in the popover beside it.
    const off = MONITOR.slice(MONITOR.indexOf('const offTabs'), MONITOR.indexOf('const activeTab'))
    expect(off).toMatch(/!\(m\.id === 'rules' && rulesArmed\)/)
  })
})
