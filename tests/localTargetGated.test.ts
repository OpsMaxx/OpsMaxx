import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

/**
 * Every local-target dispatch in main must consult the local kill switch.
 *
 * `isLocalTerminalEnabled()` was written for the local terminal and was
 * consulted by the three `local:*` handlers and by nothing else. Meanwhile the
 * Docker, Kubernetes, Compose, cron, host-facts, Files and metrics panels all
 * grew a "This machine" option, and each of those reached its local half
 * through a dispatch in this file that never asked. The switch turned off a
 * shell while leaving `kubectl`, `docker rm` and arbitrary file writes running
 * on the same machine with the same privileges.
 *
 * localGate.ts states the threat model as a compromised renderer calling the
 * IPC surface directly. Such a renderer would not call `local:connect` — it
 * would call a panel channel, which is exactly the path that did not check.
 *
 * This is a static test rather than a runtime one because the thing worth
 * protecting is a property of the dispatch, not of any single handler: the
 * failure mode is someone adding a SEVENTH local target next year and wiring it
 * the way the other six were wired. A grep is what catches that; a test that
 * drives six handlers is not.
 *
 * If this fails, the new dispatch needs the switch, not an exemption here.
 */

const INDEX = resolve(__dirname, '../src/main/index.ts')

/**
 * The local halves. Each runs with the user's own privileges and no credential,
 * so each is a thing the switch is supposed to be able to stop.
 *
 * `localExec` is expected to appear exactly once, inside `localExecGated` — the
 * helper that applies the check — rather than at each of its call sites.
 */
const LOCAL_ENTRY_POINTS = ['localExec', 'localFilesConnect', 'localMetricsSample']

const GATE = 'isLocalTerminalEnabled'

/** The nearest enclosing function, which is the scope the check has to be in. */
function enclosingFunction(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current
    }
    current = current.parent
  }
  return null
}

describe('local target dispatch', () => {
  const source = readFileSync(INDEX, 'utf8')
  const sourceFile = ts.createSourceFile(INDEX, source, ts.ScriptTarget.Latest, true)

  const calls: { name: string; line: number; guarded: boolean }[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (LOCAL_ENTRY_POINTS.includes(name)) {
        const fn = enclosingFunction(node)
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
        calls.push({ name, line, guarded: fn !== null && fn.getText().includes(GATE) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  it('finds every local entry point, so the test cannot pass by matching nothing', () => {
    for (const name of LOCAL_ENTRY_POINTS) {
      expect(calls.filter((c) => c.name === name).length).toBeGreaterThan(0)
    }
  })

  it('guards every local dispatch with the kill switch', () => {
    const ungated = calls.filter((c) => !c.guarded).map((c) => `${c.name} at index.ts:${c.line}`)
    expect(ungated).toEqual([])
  })

  /**
   * localExec is the sharpest of the three — it runs an arbitrary command
   * string — so it gets the stronger assertion: one call site, not N guarded
   * ones. Each additional site is another place the guard can be forgotten.
   */
  it('routes every local command through a single gated helper', () => {
    expect(calls.filter((c) => c.name === 'localExec')).toHaveLength(1)
  })

  /**
   * A local Files session is keyed at connect, and every later call carries only
   * that key. Refusing new connects would therefore leave an already-open
   * session reading and writing for as long as the tab lived, which is not what
   * "off" means — so flipping the switch has to end the sessions it allowed.
   */
  it('ends open local file sessions when the switch is turned off', () => {
    const save = source.slice(source.indexOf("ipcMain.handle('data:save'"))
    const body = save.slice(0, save.indexOf('\n})'))
    expect(body).toContain('syncLocalTerminalEnabled')
    expect(body).toContain('localFilesDisposeAll')
  })
})
