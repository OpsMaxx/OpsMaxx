import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

// The product and the repo were both renamed to OpsMaxx, and the old name is
// retired everywhere — user-facing text, code, config, and URLs alike. The
// rename has happened twice now, and both times a stray literal survived it,
// so this is the ratchet that keeps it gone.
//
// The needle is assembled at runtime rather than written out, so that this
// file is not itself a hit and does not need to exempt itself. An allowlist
// with one entry that is the test doing the checking is how a gate like this
// quietly stops working.
const NEEDLE = ['shell', 'pilot'].join('')

// The single exemption, and it earns it: CLAUDE.md has to name the old repo in
// order to say "never recreate it", and that warning is load-bearing — the 301
// standing behind every already-published download URL dies the moment a repo
// exists at the old slug. A rule cannot be stated without naming its subject.
//
// Nothing else goes in here. If a second entry ever looks necessary, the fix is
// to rename the thing, not to widen the list.
const ALLOWED = new Set(['CLAUDE.md'])

describe('branding', () => {
  it('has no trace of the retired product name in any tracked file', () => {
    // `git grep`, not a filesystem walk, for two reasons. It searches exactly
    // the tracked set — no node_modules, no build output, no local scratch —
    // and `-a` makes it read binary files as text. A committed binary carrying
    // the old module path in its strings is precisely how this last slipped
    // through, and a plain `grep -rl` would have reported "Binary file
    // matches" and been skipped by any sed pipeline downstream.
    //
    // `-a` also covers four tracked source files that contain non-UTF-8 bytes
    // and that GNU/BSD grep therefore misclassifies as binary; git treats them
    // as text either way, but the flag makes the behaviour explicit.
    let hits = ''
    try {
      hits = execFileSync('git', ['grep', '-a', '-i', '-n', NEEDLE], {
        encoding: 'utf8'
      })
    } catch (err) {
      // git grep exits 1 with no output when there are no matches, which is
      // the passing case. Any other failure is a broken test, not a pass.
      const e = err as { status?: number; stdout?: string; stderr?: string }
      if (e.status !== 1) throw err
      hits = e.stdout ?? ''
    }
    const offending = hits
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !ALLOWED.has(line.slice(0, line.indexOf(':'))))
    expect(offending, `retired product name found:\n${offending.join('\n')}`).toEqual([])
  })

  it('has no trace of the retired product name in any tracked path', () => {
    const paths = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((p) => p.toLowerCase().includes(NEEDLE))
    expect(paths, `retired product name in path(s):\n${paths.join('\n')}`).toEqual([])
  })
})
