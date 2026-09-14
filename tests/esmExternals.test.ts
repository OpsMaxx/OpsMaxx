import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

// A named import of a CommonJS dependency can type-check, pass every test, and
// still kill the packaged app on launch.
//
// `package.json` has `"type": "module"` and `electron.vite.config.ts` uses
// `externalizeDepsPlugin()`, so the main bundle is ESM and every entry in
// `dependencies` survives into `out/main/index.js` as a bare specifier. Node
// then has to work out that module's named exports itself, which it does by
// running cjs-module-lexer over the CommonJS source. The lexer only recognises
// certain shapes. ssh2 ends with
//
//     module.exports = {
//       Client: require('./client.js'),   // recognised
//       utils: { parseKey, ... },         // NOT recognised - object literal
//     };
//
// so `import { Client } from 'ssh2'` works and `import { utils } from 'ssh2'`
// throws "SyntaxError: Named export 'utils' not found" before a single line of
// the app runs. That shipped as 0.42.0 and the app would not start at all.
//
// Nothing else catches this. `tsc` uses `moduleResolution: "Bundler"` with
// `esModuleInterop`, so it never models Node's lexing. Vitest resolves the same
// import through Vite's interop and is perfectly happy - tests/cloudCertKey
// imported `utils` by name and passed. That is exactly why the check below
// spawns a real `node`: running it inside this process would reproduce the
// resolver that hid the bug rather than the one that has to live with it.
//
// The fix, when this fails, is a default import:
//
//     import pkg from 'thing'
//     const { thing } = pkg

const require_ = createRequire(import.meta.url)

const ROOT = resolve(__dirname, '..')
const SCANNED = ['src/main', 'src/preload']

// electron-vite rewrites `electron` itself, and it does not load under a plain
// `node` anyway. Every other dependency is on its own.
const SKIP = new Set(['electron'])

/**
 * Where the dependencies actually live.
 *
 * A fresh git worktree has no `node_modules` of its own, so this asks the
 * resolver instead of assuming a path, then walks back out of the resolved file
 * to the directory that contains `node_modules`. That directory is the `cwd`
 * the subprocesses run in, so they resolve bare specifiers exactly the way the
 * packaged app does.
 */
function modulesRoot(): string {
  let dir = dirname(require_.resolve('ssh2'))
  while (basename(dir) !== 'node_modules') {
    const up = dirname(dir)
    if (up === dir) throw new Error(`no node_modules above ${require_.resolve('ssh2')}`)
    dir = up
  }
  return dirname(dir)
}

/** `@scope/name/deep/path.js` -> `@scope/name`; `ws/thing` -> `ws`. */
function packageOf(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// A static named import at the start of a line: `import { a, b } from 'x'` or
// `import d, { a } from 'x'`. Anchoring to the line start keeps it away from
// import-like text inside strings, and the negated class spans newlines, so
// multi-line specifier lists are covered too.
//
// `import type { ... } from 'x'` does not match (no `{` and no `,` after the
// identifier), which is correct: type-only imports are erased before the
// bundle exists and can name anything they like.
const NAMED_IMPORT = /^import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm

/** `a`, `a as b`, `type C` -> the runtime binding, or null if it is a type. */
function binding(specifier: string): string | null {
  const text = specifier.trim()
  if (!text || /^type\s/.test(text)) return null
  return text.split(/\s+as\s+/)[0].trim()
}

describe('ESM imports of external dependencies', () => {
  const deps = new Set(
    Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies ?? {})
  )

  // specifier as written -> the runtime names imported from it, and where.
  const wanted = new Map<string, { names: Set<string>; sites: Set<string> }>()

  for (const dir of SCANNED) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8')
      NAMED_IMPORT.lastIndex = 0
      for (const m of text.matchAll(NAMED_IMPORT)) {
        const spec = m[2]
        const pkg = packageOf(spec)
        if (!deps.has(pkg) || SKIP.has(pkg)) continue
        const names = m[1].split(',').map(binding).filter((n): n is string => n !== null)
        if (names.length === 0) continue
        const entry = wanted.get(spec) ?? { names: new Set(), sites: new Set() }
        names.forEach((n) => entry.names.add(n))
        entry.sites.add(relative(ROOT, file))
        wanted.set(spec, entry)
      }
    }
  }

  it('finds the external imports to check', () => {
    // Guards the scan itself: a regex that quietly stops matching would make
    // every assertion below pass by checking nothing.
    expect(wanted.has('ssh2')).toBe(true)
    expect([...(wanted.get('ssh2')?.names ?? [])]).toContain('Client')
  })

  it.each([...wanted.keys()])('node can resolve the names imported from %s', (spec) => {
    const { names, sites } = wanted.get(spec)!
    const list = [...names].sort().join(', ')
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import { ${list} } from ${JSON.stringify(spec)}`],
      { cwd: modulesRoot(), encoding: 'utf8', timeout: 30_000 }
    )

    expect(
      result.status,
      `Node cannot import { ${list} } from '${spec}'.\n\n` +
        `The main process is ESM and '${packageOf(spec)}' is external, so this is what runs ` +
        `on a user's machine at launch - the app will not start. Import the module's default ` +
        `export and destructure instead:\n\n` +
        `    import pkg from '${spec}'\n` +
        `    const { ${list} } = pkg\n\n` +
        `Imported at: ${[...sites].join(', ')}\n\n` +
        `${result.stderr ?? ''}`
    ).toBe(0)
  })
})
