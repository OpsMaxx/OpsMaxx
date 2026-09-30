import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { demoProfileDir } from '../src/main/demoGuard'

/**
 * The screenshot demo fills a profile with invented servers, a vault and a
 * signed audit chain, and answers every SSH connection itself. Three things
 * have to be true, and each is pinned here:
 *
 *   1. A packaged app can never enter it, whatever the environment says.
 *   2. It can never be pointed at the real profile. A dev run's userData IS
 *      the installed app's (productName is OpsMaxx either way), so this is not
 *      hypothetical: a bundler chunk split once made the services resolve the
 *      real paths, and only the seed's "is the profile empty" check stopped it.
 *   3. A production build does not contain it at all.
 */

const REAL = '/Users/someone/Library/Application Support/OpsMaxx'

describe('when the demo profile is used', () => {
  it('is used in a development run that asks for it', () => {
    expect(demoProfileDir({ OPSMAXX_DEMO_PROFILE: '/tmp/opsmaxx-demo' }, false, REAL)).toBe('/tmp/opsmaxx-demo')
  })

  it('is never used by a packaged app, even when asked', () => {
    expect(demoProfileDir({ OPSMAXX_DEMO_PROFILE: '/tmp/opsmaxx-demo' }, true, REAL)).toBeNull()
  })

  it('is not used when nobody asked', () => {
    expect(demoProfileDir({}, false, REAL)).toBeNull()
    expect(demoProfileDir({ OPSMAXX_DEMO_PROFILE: '   ' }, false, REAL)).toBeNull()
  })

  it('refuses the real profile, however it is spelled', () => {
    expect(() => demoProfileDir({ OPSMAXX_DEMO_PROFILE: REAL }, false, REAL)).toThrow(/real profile/)
    expect(() => demoProfileDir({ OPSMAXX_DEMO_PROFILE: `${REAL}/` }, false, REAL)).toThrow(/real profile/)
    expect(() => demoProfileDir({ OPSMAXX_DEMO_PROFILE: `${REAL}/../OpsMaxx` }, false, REAL)).toThrow(/real profile/)
  })
})

describe('how the demo is wired', () => {
  const index = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')

  it('is started only behind the build-time and the runtime guard together', () => {
    expect(index).toMatch(/if \(import\.meta\.env\.DEV && isDemo\) installDemo\(\)/)
    expect(index.match(/installDemo\(/g)).toHaveLength(1)
  })

  it('is imported statically, straight after portable.ts', () => {
    // A dynamic import() made Rollup split the modules the demo shares with
    // index.ts into a chunk evaluated BEFORE portable.ts's redirect -- which is
    // how the store came to resolve the real profile's path.
    const imports = index.split('\n').filter((l) => l.startsWith('import '))
    expect(imports[0]).toContain("from './portable'")
    expect(imports[1]).toBe("import { installDemo } from './demo'")
    expect(index).not.toMatch(/import\(['"]\.\/demo['"]\)/)
  })

  it('proves its paths are inside the demo profile before it touches anything', () => {
    const demo = readFileSync(join(__dirname, '../src/main/demo/index.ts'), 'utf8')
    const check = demo.indexOf('DATA_FILE_PATH, AUDIT_LOG_PATH')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(demo.indexOf('setDemoConnector('))
  })

  it('is reached from nowhere else in the app', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (!p.endsWith(join('src', 'main', 'demo'))) walk(p)
        } else if (/\.tsx?$/.test(e.name) && !p.endsWith(join('src', 'main', 'index.ts'))) {
          if (/from ['"][./]*\/?demo(\/|['"])/.test(readFileSync(p, 'utf8'))) offenders.push(p)
        }
      }
    }
    walk(join(__dirname, '../src'))
    expect(offenders).toEqual([])
  })
})

// A dev run -- including `npm run demo` -- also writes out/main, with the demo
// in it, so this can only be trusted where the build is known to be a
// production one: CI, which runs `npm run build` before the tests.
const bundle = join(__dirname, '../out/main/index.js')
describe('the production bundle', () => {
  it.skipIf(!process.env.CI || !existsSync(bundle))('contains none of the demo', () => {
    const files = [bundle, ...readdirSync(join(__dirname, '../out/main/chunks')).map((f) => join(__dirname, '../out/main/chunks', f))]
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const marker of ['installDemo', 'setDemoConnector', 'seedDemoProfile', 'srv-demo-', 'fakeClient']) {
        expect(text.includes(marker), `${marker} in ${f}`).toBe(false)
      }
    }
  })
})
