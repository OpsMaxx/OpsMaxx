import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ADDYD_BINARY } from '../src/main/services/addy/sidecar'

// Three files have to agree on one string and nothing made them:
//
//   scripts/build-addyd.sh   writes  resources/bin/<platform>/opsmaxx-addyd
//   resources/bin/manifest.json      records it under that same name
//   sidecar.ts               asks    resolveBundledBinary(<name>)
//
// 0.50.0 shipped with sidecar.ts asking for a bare `addyd`. Every build was
// green, every artifact was correct, and the binary was sitting right there in
// the app bundle under its real name. The only symptom was an error at the
// moment a user tried to create an account — the last place you find out.
//
// tests/bundledBinary.test.ts cannot catch this: it builds its own manifest
// from whatever name the test passes in, so the name always agrees with itself.
// This one reads the real files instead.

const root = resolve(__dirname, '..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

describe('the addyd binary name', () => {
  it('is the name the build script writes', () => {
    const script = read('scripts/build-addyd.sh')
    const built = script.match(/-o "\$dest\/([A-Za-z0-9._-]+)\$exe"/)

    // Parser sanity: if the build script is rewritten in a way this regex no
    // longer matches, that is a broken test, not a passing one.
    expect(built, 'no `-o "$dest/...$exe"` in scripts/build-addyd.sh').not.toBeNull()
    expect(built![1]).toBe(ADDYD_BINARY)
  })

  it('is the name sidecar.ts actually passes to the resolver', () => {
    const src = read('src/main/services/addy/sidecar.ts')
    const call = src.match(/resolveBundledBinary\(\s*([^,]+),/)

    expect(call, 'no resolveBundledBinary(...) call in sidecar.ts').not.toBeNull()

    // A string literal here is exactly the bug: it can drift from the build
    // script with nothing to notice. The call must go through the constant.
    expect(call![1].trim()).toBe('ADDYD_BINARY')
  })

  it('has a manifest row on every platform the script builds for', () => {
    const manifest = JSON.parse(read('resources/bin/manifest.json')) as {
      binaries: Record<string, unknown>
    }
    const rows = Object.keys(manifest.binaries).filter((k) => k.includes(ADDYD_BINARY))

    expect(rows.length).toBeGreaterThanOrEqual(6)
    for (const row of rows) {
      const base = row.slice(row.indexOf('/') + 1)
      expect(base === ADDYD_BINARY || base === `${ADDYD_BINARY}.exe`).toBe(true)
    }
  })
})
