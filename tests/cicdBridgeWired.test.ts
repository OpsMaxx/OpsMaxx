import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Every member of `CicdBridge` is implemented AND reached.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 *
 * This module was built by several people working in parallel, each in their
 * own file. Every piece was individually correct and unit-tested, the whole
 * suite was green, the typecheck was clean — and the feature could not be used
 * once, because the pieces were not connected to each other.
 *
 * Three separate holes, all the same shape:
 *
 *   - `refresh` was declared on the contract and implemented nowhere. The
 *     panel's one primary action shipped permanently greyed out.
 *   - `getRun` was implemented in the contract, the preload bridge, the IPC
 *     layer and the wiring — and no renderer called it, so the run workbench's
 *     job list was permanently empty.
 *   - `onSave` in the connect modal was gated on an optional prop nothing
 *     supplied, so Connect could never be pressed and no connection could be
 *     created at all.
 *
 * None of those is visible to a typechecker: an interface member that nobody
 * calls typechecks perfectly, and `Promise<unknown>` plus `.catch(() =>
 * undefined)` hides the rest. None is visible to a unit test either, because
 * each unit did exactly what it promised.
 *
 * So this walks the actual text of the three layers. It is crude on purpose —
 * a regex over source is proof that a NAME appears, not that the call is
 * correct — but the failure it catches is "nothing anywhere mentions this",
 * which is precisely the failure that got through three times.
 */

const ROOT = resolve(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const CONTRACT = read('src/shared/cicd.ts')
const PRELOAD = read('src/preload/index.ts')
const MAIN = read('src/main/index.ts')

function filesUnder(dir: string): string[] {
  const full = join(ROOT, dir)
  const out: string[] = []
  for (const entry of readdirSync(full)) {
    const p = join(full, entry)
    if (statSync(p).isDirectory()) out.push(...filesUnder(join(dir, entry)))
    else if (/\.tsx?$/.test(entry)) out.push(readFileSync(p, 'utf8'))
  }
  return out
}

// The whole renderer, not just the CI panel: `agentRuns` is read by the AI
// kill switch in `components/ai`, which is exactly where it belongs. The
// question this answers is "does any renderer code reach this", and scoping it
// to one directory would have forced a false exemption for a correctly-placed
// caller.
const RENDERER = [...filesUnder('src/renderer/src/components'), ...filesUnder('src/renderer/src/store')].join('\n')

/** The member names declared on `CicdBridge`, read out of the interface body. */
function bridgeMembers(): string[] {
  const start = CONTRACT.indexOf('export interface CicdBridge {')
  expect(start, 'CicdBridge is not declared where this test looks for it').toBeGreaterThan(-1)
  // Brace matching rather than a lazy `}` — the body contains nested object
  // types, and stopping at the first close brace silently checks half of it.
  let depth = 0
  let end = start
  for (let i = CONTRACT.indexOf('{', start); i < CONTRACT.length; i++) {
    if (CONTRACT[i] === '{') depth++
    else if (CONTRACT[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = CONTRACT.slice(start, end)
  const names = new Set<string>()
  // A member is `name(` at the start of a line, ignoring comment bodies.
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue
    const m = /^([a-zA-Z][A-Za-z0-9]*)\s*\(/.exec(t)
    if (m) names.add(m[1])
  }
  return [...names]
}

/**
 * Members that legitimately have no `ipcMain.handle`.
 *
 * `onState` is a subscription: main pushes with `webContents.send` and the
 * preload half registers a listener, so there is no handler to find. Anything
 * else appearing here needs a reason written next to it.
 */
const NO_IPC_HANDLER = new Set(['onState'])

describe('the CI/CD bridge is wired end to end', () => {
  const members = bridgeMembers()

  it('found the members it is supposed to be checking', () => {
    // A parser that silently matches nothing turns this whole file into a
    // test that always passes.
    expect(members.length).toBeGreaterThan(8)
    expect(members).toContain('configure')
    expect(members).toContain('trigger')
  })

  it.each(bridgeMembers())('preload implements %s', (member) => {
    // The `cicd` namespace declares it as a property.
    expect(PRELOAD, `${member} is on CicdBridge but the preload bridge has no such member`).toMatch(
      new RegExp(`\\b${member}\\s*:`)
    )
  })

  it.each(bridgeMembers().filter((m) => !NO_IPC_HANDLER.has(m)))(
    'main handles cicd:%s',
    (member) => {
      expect(
        MAIN,
        `${member} crosses IPC but main registers no 'cicd:${member}' handler — the call would ` +
          `reject at runtime and typecheck perfectly`
      ).toContain(`'cicd:${member}'`)
    }
  )

  it.each(bridgeMembers())('some renderer code actually calls %s', (member) => {
    // THE ONE THAT CAUGHT THE REAL BUGS. A member nothing calls is a feature
    // nobody can reach, and every other layer of checking passes over it.
    expect(
      RENDERER,
      `No renderer code calls ${member}. It is declared on CicdBridge, so either ` +
        `wire it to the UI that needs it or take it off the contract — a member with no caller ` +
        `is a promise the panel does not keep.`
    ).toMatch(new RegExp(`\\.${member}\\s*[(?]|\\b${member}\\s*:`))
  })
})

describe('the panel does not gate itself off', () => {
  const PANEL = read('src/renderer/src/components/cicd/CicdPanel.tsx')
  const MODAL = read('src/renderer/src/components/cicd/CicdConnectModal.tsx')

  it('always hands the connect modal a save handler', () => {
    // This exact line shipped as `onSave={onSaveConnection ? save : undefined}`
    // with nothing in the app supplying `onSaveConnection`, so Connect was
    // disabled forever and no connection could be created. The feature was
    // unusable with a fully green suite.
    expect(PANEL).toMatch(/onSave=\{save\}/)
    expect(PANEL, 'the save handler is conditional again').not.toMatch(
      /onSave=\{[^}]*\?[^}]*:\s*undefined\}/
    )
  })

  it('keeps the token out of the record it saves', () => {
    // `opsmaxx-data.json` is documented as carrying no credentials, and the
    // record the panel upserts is the record that reaches it.
    expect(PANEL).toMatch(/createSecret/)
    expect(MODAL).toMatch(/NEVER STORES THE TOKEN/)
  })
})
