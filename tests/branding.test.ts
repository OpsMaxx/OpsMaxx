import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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
    // No allowlist. CLAUDE.md states the rule without spelling the word, so
    // there is nothing left that legitimately needs to contain it -- and an
    // exemption list is how a gate like this quietly rots.
    expect(hits.trim(), `retired product name found:\n${hits}`).toBe('')
  })

  /**
   * The hole the check above had, and how it was found: on screen.
   *
   * The title bar rendered the old name as a two-tone wordmark: its first
   * half in plain text, its second wrapped in a `<b>`, with the tag sitting
   * between them. `git grep` looks for the contiguous string, so the most
   * prominent piece of branding in the whole app — visible on every screen of
   * a shipped release — was invisible to the gate that exists to catch exactly
   * this.
   *
   * The example is described rather than written out, for the reason the
   * needle above is assembled rather than typed: this file must not be a hit
   * against its own check, and an allowlist whose one entry is the test doing
   * the checking is how a gate quietly stops working.
   *
   * So markup is removed before looking. This cannot catch every possible
   * split — nothing can, short of running the app — but a tag between the
   * halves is how a DESIGNER writes a two-tone wordmark, which makes it the
   * one split that keeps happening.
   */
  it('has no trace of it once markup between the halves is removed', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter((f) => /\.(tsx?|html|md|css|json|ya?ml)$/.test(f))

    const hits: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue // unreadable or binary; the git grep above covers those
      }
      // Tags out, then whitespace collapsed: a wordmark split across lines by
      // a formatter is the same bug wearing different trousers.
      const flattened = text.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
      if (flattened.toLowerCase().includes(NEEDLE)) hits.push(file)
    }
    expect(hits, `retired product name, split by markup, in:\n${hits.join('\n')}`).toEqual([])
  })

  it('has no trace of the retired product name in any tracked path', () => {
    const paths = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((p) => p.toLowerCase().includes(NEEDLE))
    expect(paths, `retired product name in path(s):\n${paths.join('\n')}`).toEqual([])
  })
})
