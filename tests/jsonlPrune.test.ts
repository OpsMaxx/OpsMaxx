import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneJsonl } from '../src/main/services/jsonlPrune'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0)
const line = (agoDays: number, id: string): string =>
  JSON.stringify({ id, timestamp: new Date(NOW - agoDays * DAY).toISOString() })

// The newest 100 lines survive regardless of age, so a handful of lines is
// never pruned however old they are -- which is the point of that floor, and
// which made the first version of every test below pass without a prune ever
// happening. Each case therefore needs a log longer than the floor.
const FILLER = 140
const recentFiller = (): string[] =>
  Array.from({ length: FILLER }, (_, i) => line(1, `filler-${i}`))

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sp-prune-'))
  file = join(dir, 'log.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('pruning a log on disk', () => {
  it('removes what is past the horizon and keeps the rest, in order', () => {
    writeFileSync(
      file,
      [line(500, 'old'), line(400, 'older'), ...recentFiller()].join('\n') + '\n'
    )
    expect(pruneJsonl(file, NOW)).toBe(2)
    const left = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(left).toEqual(recentFiller())
  })

  it('does not touch the file at all when nothing is due', () => {
    // A rename a day for no reason is a needless chance to lose a log. The
    // mtime is the observable proof that the common path leaves it alone.
    writeFileSync(file, recentFiller().join('\n') + '\n')
    const before = statSync(file).mtimeMs
    expect(pruneJsonl(file, NOW)).toBeNull()
    expect(statSync(file).mtimeMs).toBe(before)
  })

  it('leaves no temp file behind', () => {
    writeFileSync(file, [line(500, 'old'), ...recentFiller()].join('\n') + '\n')
    expect(pruneJsonl(file, NOW)).toBe(1)
    expect(existsSync(`${file}.pruning`)).toBe(false)
  })

  it('keeps the file readable as JSON lines, with a trailing newline', () => {
    // The next append does `appendFileSync(file, line + '\n')`. If the prune
    // left the file without a trailing newline, that append would glue itself
    // onto the last surviving entry and corrupt both.
    writeFileSync(file, [line(500, 'old'), ...recentFiller()].join('\n') + '\n')
    expect(pruneJsonl(file, NOW)).toBe(1)
    const raw = readFileSync(file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    for (const l of raw.split('\n').filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow()
  })

  it('is a no-op on a file that is not there', () => {
    expect(pruneJsonl(join(dir, 'absent.jsonl'), NOW)).toBeNull()
  })

  it('writes nothing through a symlink someone left at the temp path', () => {
    // `${file}.pruning` is predictable, so anything running as this user can put
    // a symlink there first. writeFileSync FOLLOWS one and truncates the far
    // end, which would turn a prune of an audit log into a write of that log
    // over a file of the attacker's choosing — and `mode: 0o600` does not help,
    // because a mode is only applied when a file is created.
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'do not touch')
    symlinkSync(victim, `${file}.pruning`)
    writeFileSync(file, [line(500, 'old'), ...recentFiller()].join('\n') + '\n')

    expect(pruneJsonl(file, NOW)).toBe(1)

    expect(readFileSync(victim, 'utf8')).toBe('do not touch')
    expect(existsSync(`${file}.pruning`)).toBe(false)
    // And the prune itself still happened, via a file it created exclusively.
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual(recentFiller())
  })

  it('does not follow a dangling symlink at the temp path either', () => {
    // existsSync stats THROUGH a link, so a dangling one reads as absent: an
    // existsSync-guarded unlink would skip it and then create the target it
    // points at. The log still has to get pruned, and the link has to go.
    const target = join(dir, 'not-there-yet.txt')
    symlinkSync(target, `${file}.pruning`)
    writeFileSync(file, [line(500, 'old'), ...recentFiller()].join('\n') + '\n')

    expect(pruneJsonl(file, NOW)).toBe(1)

    expect(existsSync(target)).toBe(false)
    expect(existsSync(`${file}.pruning`)).toBe(false)
  })

  it('prunes despite a temp file a crashed run left behind', () => {
    // The flip side of refusing an existing path: a .pruning file from a process
    // that died mid-rename must not wedge retention for this log forever.
    writeFileSync(`${file}.pruning`, 'half a log from last time')
    writeFileSync(file, [line(500, 'old'), ...recentFiller()].join('\n') + '\n')

    expect(pruneJsonl(file, NOW)).toBe(1)
    expect(existsSync(`${file}.pruning`)).toBe(false)
    expect(lstatSync(file).isSymbolicLink()).toBe(false)
  })

  it('still prunes when a DIRECTORY is sitting at the temp path', () => {
    // `rmSync(tmp, { force: true })` without `recursive` throws EISDIR on a
    // directory, and the catch turns that into "could not prune" — for this log,
    // for every sweep, for the life of the install. One planted directory and
    // retention for that file is off permanently. Same-uid precondition, so this
    // is hardening rather than a hole, but it is one word.
    mkdirSync(`${file}.pruning`)
    writeFileSync(join(`${file}.pruning`, 'decoy'), 'in the way')
    writeFileSync(file, [line(500, 'old'), ...recentFiller()].join('\n') + '\n')

    expect(pruneJsonl(file, NOW)).toBe(1)
    expect(existsSync(`${file}.pruning`)).toBe(false)
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual(recentFiller())
  })

  it('refuses a symlink at the LOG path, the way appendLogLine does', () => {
    // The two modules used to answer the same question differently:
    // appendLogLine refuses a link at a log path, while this read THROUGH one
    // and renamed over it. So a link planted at an audit log meant every append
    // was refused — zero rows, quietly — and then the next daily sweep copied
    // the link TARGET's contents into the real log, which is how the plant
    // became the history.
    const victim = join(dir, 'someone-elses.jsonl')
    writeFileSync(victim, [line(500, 'theirs'), ...recentFiller()].join('\n') + '\n')
    symlinkSync(victim, file)

    expect(pruneJsonl(file, NOW)).toBeNull()
    // Untouched: not pruned, not replaced by a real file, and still a link.
    expect(readFileSync(victim, 'utf8').split('\n').filter(Boolean)).toHaveLength(FILLER + 1)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('refuses a DANGLING symlink at the log path rather than calling it absent', () => {
    // existsSync stats THROUGH a link, so an existsSync-first guard reports a
    // dangling one as "no file here" and returns the quiet no-op that hides it.
    const absent = join(dir, 'not-there.jsonl')
    symlinkSync(absent, file)
    expect(pruneJsonl(file, NOW)).toBeNull()
    expect(existsSync(absent)).toBe(false)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('keeps the mode private after rewriting', () => {
    // These files are 0600 because of what is in them. A prune that recreated
    // them at the default umask would quietly widen every one of them.
    writeFileSync(file, [line(500, 'old'), ...recentFiller()].join('\n') + '\n', { mode: 0o600 })
    expect(pruneJsonl(file, NOW)).toBe(1)
    expect(statSync(file).mode & 0o077).toBe(0)
  })
})
