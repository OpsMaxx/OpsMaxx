import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildFilePushCommand,
  checkFilePush,
  filePushJobSpec,
  FILE_PUSH_MAX_BYTES
} from '../src/shared/fileStep'
import { verifyJobApproval, jobApprovalFor } from '../src/shared/jobs'

// Item 34c. Everything here runs the command through a real /bin/sh, because
// the properties that matter are what is left on disk when a step fails --
// and a command that is only read looks right in every one of those cases.

const trees: string[] = []
afterAll(() => {
  for (const t of trees) rmSync(t, { recursive: true, force: true })
})

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

function tree(existing?: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sp-push-'))
  trees.push(dir)
  const file = join(dir, 'app.conf')
  if (existing !== undefined) writeFileSync(file, existing)
  return { dir, file }
}

function run(cmd: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

const push = (file: string, content: string, o = {}): string =>
  buildFilePushCommand(file, content, sha(content), { sudo: false, ...o })

describe('what it will not write', () => {
  it('refuses the files that decide who can log in', () => {
    for (const p of [
      '/home/ops/.ssh/authorized_keys',
      '/root/.ssh/authorized_keys2',
      '/etc/shadow',
      '/etc/passwd',
      '/etc/sudoers',
      '/etc/sudoers.d/ops',
      '/home/ops/.ssh/id_ed25519',
      '/etc/ssl/private/site.key'
    ]) {
      expect(checkFilePush(p, 'x'), p).toMatchObject({ ok: false })
    }
  })

  it('points at the screen that does have a rollback', () => {
    const r = checkFilePush('/home/ops/.ssh/authorized_keys', 'x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('puts it back if that fails')
  })

  it('refuses a relative path, a traversal, and shell characters', () => {
    for (const p of ['etc/app.conf', '/etc/../etc/shadow', '/etc/app conf', "/etc/a'b", '/etc/$(id)']) {
      expect(checkFilePush(p, 'x'), p).toMatchObject({ ok: false })
    }
  })

  it('refuses an empty file, which is almost always a mistake', () => {
    expect(checkFilePush('/etc/app.conf', '')).toMatchObject({ ok: false })
  })

  it('refuses more than anybody reads before agreeing to it', () => {
    expect(checkFilePush('/etc/app.conf', 'x'.repeat(FILE_PUSH_MAX_BYTES + 1))).toMatchObject({ ok: false })
  })
})

describe('writing a file, through a real shell', () => {
  it('writes the bytes and keeps the previous copy', () => {
    const { file } = tree('old contents\n')
    const r = run(push(file, 'new contents\n', { expectedBefore: sha('old contents\n') }))
    expect(r.code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('new contents\n')
    expect(readFileSync(`${file}.opsmaxx-bak`, 'utf8')).toBe('old contents\n')
    expect(r.out).toContain('WROTE:')
  })

  it('writes a file that was not there, and says it was new', () => {
    const { file } = tree()
    const r = run(push(file, 'hello\n', { expectedBefore: null }))
    expect(r.code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('hello\n')
    expect(r.out).toContain('(new file)')
    // Nothing to back up, so nothing left behind.
    expect(existsSync(`${file}.opsmaxx-bak`)).toBe(false)
  })

  it('applies the mode before the file becomes live', () => {
    const { file } = tree()
    run(push(file, 'secret\n', { expectedBefore: null, mode: '0600' }))
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600')
  })

  it('handles content a heredoc would break', () => {
    // userUnits.ts learned this the expensive way: a heredoc joined into a
    // one-line command is broken by the join, the file is never written, and
    // the exit code is still 0.
    const nasty = "line one\nEOF\n$(id) `id` 'quoted' \"double\"\n\ttab\n"
    const { file } = tree()
    expect(run(push(file, nasty, { expectedBefore: null })).code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(nasty)
  })
})

describe('what it leaves behind when it refuses', () => {
  // THE tests. A command that is only read looks correct in all of these.
  it('changes nothing when the file moved underneath', () => {
    const { file } = tree('what we read\n')
    writeFileSync(file, 'somebody else edited it\n')
    const r = run(push(file, 'ours\n', { expectedBefore: sha('what we read\n') }))
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('changed on the server since it was read')
    expect(readFileSync(file, 'utf8')).toBe('somebody else edited it\n')
    expect(existsSync(`${file}.opsmaxx-new`)).toBe(false)
  })

  it('changes nothing when a file expected to be new already exists', () => {
    const { file } = tree('already here\n')
    const r = run(push(file, 'ours\n', { expectedBefore: null }))
    expect(r.code).not.toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('already here\n')
  })

  it('changes nothing when the bytes that arrived are not the bytes approved', () => {
    // The command carries the approved sha256. Corrupting the content without
    // the hash is what a truncated transfer looks like.
    const { file } = tree('old\n')
    const cmd = buildFilePushCommand(file, 'intended\n', sha('something else\n'), {
      sudo: false,
      expectedBefore: sha('old\n')
    })
    const r = run(cmd)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('not the file that was approved')
    expect(readFileSync(file, 'utf8')).toBe('old\n')
    expect(existsSync(`${file}.opsmaxx-new`)).toBe(false)
  })
})

describe('the approval covers the bytes', () => {
  const targets = [{ serverId: 's1', serverName: 'web-1' }]

  it('does not verify once the content has been swapped', () => {
    const spec = filePushJobSpec('/etc/app.conf', 'approved\n', sha('approved\n'), { sudo: false })
    const approval = jobApprovalFor(spec, targets, { phrase: null, confirmedAt: 1 })
    const swapped = filePushJobSpec('/etc/app.conf', 'something else\n', sha('something else\n'), {
      sudo: false
    })
    expect(verifyJobApproval(approval, swapped, targets).ok).toBe(false)
    expect(verifyJobApproval(approval, spec, targets).ok).toBe(true)
  })

  it('makes the post-step its own step, so it is graded and shown like any other', () => {
    const spec = filePushJobSpec('/etc/nginx/nginx.conf', 'x\n', sha('x\n'), {
      after: 'nginx -t && systemctl reload nginx'
    })
    expect(spec.steps).toHaveLength(2)
    expect(spec.steps[1].command).toBe('nginx -t && systemctl reload nginx')
  })
})
