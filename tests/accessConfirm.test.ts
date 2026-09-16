import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACCESS_COMMITTED_PREFIX,
  ACCESS_VERIFIED_PREFIX,
  accessBackupPath,
  accessDisarmCommand,
  accessVerifyCommand,
  buildRevokeKeyCommand,
  describeAccessOutcome,
  escalatedFor,
  judgeAccessVerification,
  type AccessCommitEvidence
} from '../src/shared/access'
import {
  AccessCommitter,
  ACCESS_CONFIRM_TIMEOUT_MS,
  accessOpenBudgetMs,
  type AccessCommitRequest,
  type AccessFreshSession
} from '../src/main/services/access'

// Roadmap item 23, rule 2 — the confirmation.
//
// The write half staged a change behind a watchdog the host arms on itself and
// then stopped, because the disarm may only ride a session that authenticated
// AFTER the write, and nothing could produce one. This is the rule that now
// consumes it.
//
// Nothing here asserts that a function was called. What is asserted is which
// COMMANDS reached the host — a confirmation that never left this process is
// exactly as good as none — and, at the bottom, what the real commands do to a
// real file.

const STAGED_AT = 1_800_000_000_000
const TOKEN = 't42'
const KEY_PATH = '/home/ops/.ssh/authorized_keys'

const req = (over: Partial<AccessCommitRequest> = {}): AccessCommitRequest => ({
  serverId: 'a',
  serverName: 'web-1',
  user: 'ops',
  token: TOKEN,
  keyPath: KEY_PATH,
  stagedAt: STAGED_AT,
  rollbackSeconds: 300,
  ...over
})

interface Fake extends AccessFreshSession {
  ran: string[]
  closes: number
}

/**
 * A session that behaves however the test needs, and records what was run on
 * it. Honest by default: it authenticated a second after the write, it is not
 * in the pool, and the host answers the check.
 */
function session(over: Partial<AccessFreshSession> & { verifyOut?: string; verifyCode?: number; verifyErr?: string; disarmCode?: number } = {}): Fake {
  const ran: string[] = []
  const f: Fake = {
    ran,
    closes: 0,
    connectionId: 'fresh#7',
    pooledConnectionIds: ['pooled#1', 'pooled#2'],
    authenticatedAt: STAGED_AT + 1_000,
    exec: async (command) => {
      ran.push(command)
      if (command.includes('SP_M=')) {
        const code = over.disarmCode ?? 0
        return {
          ok: true,
          code,
          stdout: code === 0 ? `${ACCESS_COMMITTED_PREFIX}${KEY_PATH}\n` : '',
          stderr: code === 0 ? '' : 'could not confirm the change'
        }
      }
      const code = over.verifyCode ?? 0
      return {
        ok: true,
        code,
        stdout: over.verifyOut ?? (code === 0 ? `${ACCESS_VERIFIED_PREFIX}${TOKEN}\n` : ''),
        stderr: over.verifyErr ?? ''
      }
    },
    close: () => {
      f.closes += 1
    }
  }
  if (over.connectionId !== undefined) f.connectionId = over.connectionId
  if (over.pooledConnectionIds !== undefined) f.pooledConnectionIds = over.pooledConnectionIds
  if (over.authenticatedAt !== undefined) f.authenticatedAt = over.authenticatedAt
  if (over.exec !== undefined) f.exec = over.exec
  return f
}

const committer = (s: Fake | Error, now = STAGED_AT + 2_000): AccessCommitter =>
  new AccessCommitter({
    openFresh: async () => {
      if (s instanceof Error) throw s
      return s
    },
    now: () => now
  })

const isDisarm = (c: string): boolean => c.includes(': > "$SP_M"')
const isVerify = (c: string): boolean => c.includes(ACCESS_VERIFIED_PREFIX)

describe('the disarm is issued only after an independent session', () => {
  it('confirms the change once a fresh session has proved the server still lets us in', async () => {
    const s = session()
    const report = await committer(s).confirm({}, req())

    expect(s.ran.filter(isVerify)).toHaveLength(1)
    expect(s.ran.filter(isDisarm)).toHaveLength(1)
    // The order is the rule: proved first, confirmed second, on the same
    // connection.
    expect(s.ran.findIndex(isVerify)).toBeLessThan(s.ran.findIndex(isDisarm))
    expect(report.outcome).toBe('committed')
    expect(report.backupPath).toBe('/home/ops/.ssh/authorized_keys.opsmaxx-t42.bak')
  })

  it('issues nothing at all when no second session can be opened', async () => {
    // The host may have rejected the key the change just installed, or it may
    // be unreachable. Both mean the same thing, and the same thing is done:
    // nothing, and the host restores itself.
    const report = await committer(new Error('All configured authentication methods failed')).confirm({}, req())
    expect(report.outcome).toBe('reverted-verification-failed')
    expect(report.detail).toContain('All configured authentication methods failed')
    // The sentence no longer claims the previous file IS back — that is a
    // claim about something this process cannot see. It says the rollback was
    // proved running before anything was replaced, and where it restores from.
    expect(report.detail).toContain('armed and confirmed running')
    expect(report.detail).toContain('/home/ops/.ssh/authorized_keys.opsmaxx-t42.bak')
  })

  it('does not confirm when the check fails on the server', async () => {
    const s = session({ verifyCode: 3, verifyErr: 'no staged change with this token is waiting here\n' })
    const report = await committer(s).confirm({}, req())
    expect(s.ran.filter(isDisarm)).toEqual([])
    expect(report.outcome).toBe('reverted-verification-failed')
    expect(report.detail).toContain('no staged change with this token is waiting here')
  })

  it('does not confirm when the session authenticated BEFORE the change was written', async () => {
    // The exact shape a "verify" step on the job engine's pooled transport
    // would have had: a session that was already open, answering a command.
    const s = session({ authenticatedAt: STAGED_AT - 1 })
    const report = await committer(s).confirm({}, req())
    expect(s.ran.filter(isDisarm)).toEqual([])
    expect(report.outcome).toBe('reverted-verification-failed')
    expect(report.detail).toContain('authenticated before the change was written')
  })

  it('does not confirm when the session is one the pool is holding', async () => {
    const s = session({ connectionId: 'pooled#2' })
    const report = await committer(s).confirm({}, req())
    expect(s.ran.filter(isDisarm)).toEqual([])
    expect(report.outcome).toBe('reverted-verification-failed')
    expect(report.detail).toContain('the same already-authenticated transport that wrote the file')
  })

  it('does not confirm a change staged on some other server', async () => {
    // A session that landed somewhere else answers, and answers about a
    // different change. The token in the output is what ties the two together.
    const s = session({ verifyOut: `${ACCESS_VERIFIED_PREFIX}t99\n` })
    const report = await committer(s).confirm({}, req())
    expect(s.ran.filter(isDisarm)).toEqual([])
    expect(report.outcome).toBe('reverted-verification-failed')
    expect(report.detail).toContain('not the server and account the change was made on')
  })

  it('does not confirm after the window has closed, however well the check went', async () => {
    const s = session({ authenticatedAt: STAGED_AT + 400_000 })
    const report = await committer(s, STAGED_AT + 400_000).confirm({}, req())
    expect(s.ran).toEqual([])
    expect(report.outcome).toBe('reverted-unconfirmed')
    expect(report.detail).toContain('300-second window closed')
  })

  it('reports a confirmation that could not be written as unconfirmed, not as a failure', async () => {
    // Verified, and then the marker could not be created. Nothing is wrong with
    // the change; the host is simply about to undo it.
    const s = session({ disarmCode: 3 })
    const report = await committer(s).confirm({}, req())
    expect(s.ran.filter(isDisarm)).toHaveLength(1)
    expect(report.outcome).toBe('reverted-unconfirmed')
    expect(report.detail).toContain('could not be written')
  })

  it('closes its session on every path, so a confirmation leaves no way in behind it', async () => {
    for (const s of [session(), session({ verifyCode: 3 }), session({ connectionId: 'pooled#1' })]) {
      await committer(s).confirm({}, req())
      expect(s.closes).toBe(1)
    }
  })

  it('answers rather than throwing when the session dies mid-check', async () => {
    const s = session()
    s.exec = async () => {
      throw new Error('Not connected')
    }
    const report = await committer(s).confirm({}, req())
    expect(report.outcome).toBe('reverted-verification-failed')
    expect(report.detail).toContain('Not connected')
  })
})

describe('the three outcomes read as three different things', () => {
  const base = { serverName: 'web-1', user: 'ops', backupPath: '/b.bak', rollbackSeconds: 300 }

  it('says committed, says rejected and says unconfirmed in three distinct sentences', async () => {
    const committed = describeAccessOutcome({ ...base, outcome: 'committed', reason: '' })
    const failed = describeAccessOutcome({ ...base, outcome: 'reverted-verification-failed', reason: 'the server said no.' })
    const unconfirmed = describeAccessOutcome({ ...base, outcome: 'reverted-unconfirmed', reason: 'nobody was there.' })

    expect(committed).toBe(
      "Committed on web-1. A second session authenticated after the change and called off the server's rollback, so ops's authorized_keys is now permanent. The previous file is at /b.bak until the 300-second window closes, after which the server removes it."
    )
    expect(failed).toBe(
      "Reverted on web-1: the check failed. the server said no. The server's rollback was armed and confirmed running before anything was replaced, and was left armed, so ops's previous authorized_keys should be back within 300s of the change. It is restored from /b.bak; if you can still reach the server, that is where to look."
    )
    expect(unconfirmed).toBe(
      "Reverted on web-1: nothing confirmed it in time. nobody was there. That is the dead-man's switch doing its job rather than the change failing — ops's previous authorized_keys is back, the server is exactly as it was, and it can be staged again."
    )
    expect(new Set([committed, failed, unconfirmed]).size).toBe(3)
  })

  it('does not call the third one a failure', async () => {
    // An operator taught that the safety net is a fault is an operator who will
    // want it turned off.
    const unconfirmed = describeAccessOutcome({ ...base, outcome: 'reverted-unconfirmed', reason: 'x.' })
    expect(unconfirmed).toContain('rather than the change failing')
    expect(unconfirmed).toContain('can be staged again')
    expect(unconfirmed).not.toContain('the check failed')
  })
})

describe('a change staged as another account', () => {
  // The bug this covers shipped and reached an operator. The staged write
  // escalated -- `sudo -n -H -u raymon` -- so the backup and the marker landed
  // in /home/raymon/.ssh. The confirmation did not, so both commands resolved
  // `$HOME` as the CONNECTING account, looked in the wrong home, and found
  // nothing. The check reported "no staged change with this token is waiting
  // here", the change was judged rejected, and the host put the old file back
  // on a revocation that had worked perfectly.
  //
  // Sudo was never the problem, which is what made it hard to read: the same
  // passwordless sudo that wrote the file is right there in the sudo log.

  const escalated = (): { c: AccessCommitter; f: Fake } => {
    const f = session()
    return { c: new AccessCommitter({ openFresh: async () => f, now: () => STAGED_AT + 2_000 }), f }
  }

  it('runs the check as the account whose file was staged', async () => {
    const { c, f } = escalated()
    await c.confirm({}, req({ user: 'raymon', escalateAs: 'raymon' }))

    // Not "contains sudo": the whole script has to be inside the wrapper, or
    // the parts outside it run as the wrong user.
    expect(f.ran[0].startsWith("sudo -n -H -u raymon sh -c '")).toBe(true)
    expect(f.ran[0]).toContain('.opsmaxx-')
  })

  it('writes the confirmation marker as that account too', async () => {
    // The marker's only job is to exist where the watchdog is looking. Written
    // into the connecting account's home it disarms nothing, and the host
    // rolls back a change that passed its check -- which is the failure the
    // plan builder already warns about in the comment above its own disarm.
    const { c, f } = escalated()
    const r = await c.confirm({}, req({ user: 'raymon', escalateAs: 'raymon' }))

    expect(r.outcome).toBe('committed')
    expect(f.ran).toHaveLength(2)
    expect(f.ran[1].startsWith("sudo -n -H -u raymon sh -c '")).toBe(true)
    expect(f.ran[1]).toContain('SP_M=')
  })

  it('leaves the ordinary change with no sudo in it at all', async () => {
    // The default path must not acquire an escalation nobody asked for.
    const { c, f } = escalated()
    await c.confirm({}, req())

    expect(f.ran).toHaveLength(2)
    for (const command of f.ran) expect(command).not.toMatch(/\bsudo\b/)
  })

  it('refuses an account name it cannot vouch for rather than quoting it', async () => {
    // Same rule as every other place this name reaches a shell. A committer
    // that sanitised instead would be the one place in the feature that did.
    const { c } = escalated()
    await expect(c.confirm({}, req({ escalateAs: 'ray;mon' }))).rejects.toThrow()
  })
})

describe('the judgement itself', () => {
  const evidence = (over: Partial<AccessCommitEvidence> = {}): AccessCommitEvidence => ({
    session: {
      connectionId: 'fresh#1',
      pooledConnectionIds: ['pooled#1'],
      authenticatedAt: STAGED_AT + 1
    },
    verify: { ok: true, code: 0, stdout: `${ACCESS_VERIFIED_PREFIX}${TOKEN}`, stderr: '' },
    ...over
  })

  const judge = (over: Partial<Parameters<typeof judgeAccessVerification>[0]> = {}): ReturnType<typeof judgeAccessVerification> =>
    judgeAccessVerification({
      token: TOKEN,
      stagedAt: STAGED_AT,
      rollbackSeconds: 300,
      now: STAGED_AT + 2_000,
      evidence: evidence(),
      ...over
    })

  it('commits only when every one of the four conditions holds', async () => {
    expect(judge()).toEqual({ commit: true, outcome: 'committed', reason: '' })
  })

  it('checks the deadline first, because past it nothing else can be true', async () => {
    // The host has already put the old file back and deleted the backup. A
    // marker written now confirms nothing, and reporting `committed` off it
    // would be a lie told to the one person who needs the truth.
    const v = judge({ now: STAGED_AT + 300_000 })
    expect(v.commit).toBe(false)
    expect(v.outcome).toBe('reverted-unconfirmed')
  })

  it('treats a session with no evidence at all as a failed check, never as a pass', async () => {
    expect(judge({ evidence: { session: null, verify: null } }).outcome).toBe('reverted-verification-failed')
    expect(judge({ evidence: evidence({ verify: null }) }).commit).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The confirmation, actually run against a staged file
// ---------------------------------------------------------------------------
//
// The harness that found five bugs in the write half. Asserting on the text of
// a `[ -f ]` proves nothing about whether a late confirmation can resurrect a
// change the host has already put back.

const trees: string[] = []
afterAll(() => {
  for (const t of trees) rmSync(t, { recursive: true, force: true })
})

const A = 'AAAAC3NzaC1lZDI1NTE5AAAAIJp0kFqDkGDMEnCH7mFY3sBRb+tSVEyKvJhLhZ+SHDdw'
const B = 'AAAAC3NzaC1lZDI1NTE5AAAAIN+Qq8Z0mHqxr4RMlBFPHU6JmsFvNzZYuHkWkQrgnJ2s'

interface Host {
  home: string
  file: string
  run: (command: string) => { code: number; out: string }
  read: () => string
}

function fakeHome(lines: string[]): Host {
  const home = mkdtempSync(join(tmpdir(), 'sp-confirm-'))
  trees.push(home)
  mkdirSync(join(home, '.ssh'), { recursive: true })
  const file = join(home, '.ssh/authorized_keys')
  writeFileSync(file, lines.join('\n'))
  return {
    home,
    file,
    run: (command) => {
      try {
        const out = execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          env: { HOME: home, PATH: '/usr/bin:/bin' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        return { code: 0, out }
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string }
        return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
      }
    },
    read: () => readFileSync(file, 'utf8')
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(process.platform === 'win32')('the wrong home, run for real', () => {
  it('cannot find a change staged in another account and says exactly that', async () => {
    // The reported failure, reproduced without needing sudo: two homes stand
    // in for the two accounts, and the only thing that differs between the
    // staged write and the check is which HOME the script resolves.
    const staged = fakeHome([`ssh-ed25519 ${A} alice@laptop`, `ssh-ed25519 ${B} bob@desktop`, ''])
    const connecting = fakeHome([`ssh-ed25519 ${B} bob@desktop`, ''])
    staged.run(buildRevokeKeyCommand({ path: staged.file, blob: A, token: 'w1', rollbackSeconds: 2 }))

    const wrong = connecting.run(accessVerifyCommand('w1'))
    expect(wrong.code).toBe(3)
    expect(wrong.out).toContain('no staged change with this token is waiting here')

    // And the same check against the home the change was actually staged in
    // passes, so what failed is the account the script ran as and nothing else.
    const right = staged.run(accessVerifyCommand('w1'))
    expect(right.code).toBe(0)
    expect(right.out).toContain(`${ACCESS_VERIFIED_PREFIX}w1`)
    await sleep(3000)
  })

  it('keeps the whole verification inside the escalation wrapper', () => {
    // `sh -n` over the wrapped text: if the quoting were wrong the script
    // would not parse, and a half-wrapped command would run its tail as the
    // connecting account.
    expect(() =>
      execFileSync('sh', ['-n'], { input: escalatedFor('raymon', accessVerifyCommand('w2')) })
    ).not.toThrow()
    expect(() =>
      execFileSync('sh', ['-n'], { input: escalatedFor('raymon', accessDisarmCommand('/home/raymon/.ssh/authorized_keys', 'w2')) })
    ).not.toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('the confirmation, run for real', () => {
  it('finds the staged change and then makes it permanent', async () => {
    const h = fakeHome([`ssh-ed25519 ${A} alice@laptop`, `ssh-ed25519 ${B} bob@desktop`, ''])
    h.run(buildRevokeKeyCommand({ path: h.file, blob: A, token: 'c1', rollbackSeconds: 2 }))

    const v = h.run(accessVerifyCommand('c1'))
    expect(v.code).toBe(0)
    expect(v.out).toContain(`${ACCESS_VERIFIED_PREFIX}c1`)

    const d = h.run(accessDisarmCommand(h.file, 'c1'))
    expect(d.code).toBe(0)
    await sleep(3000)
    expect(h.read()).not.toContain(A)
    expect(h.read()).toContain(B)
  })

  it('refuses to confirm a change that was never staged here', async () => {
    // What a session that landed on the wrong host looks like: it authenticates
    // fine and there is nothing of this change to find.
    const h = fakeHome([`ssh-ed25519 ${A} alice@laptop`, ''])
    const v = h.run(accessVerifyCommand('c2'))
    expect(v.code).toBe(3)
    expect(v.out).toContain('no staged change with this token is waiting here')
  })

  it('cannot resurrect a change the server has already put back', async () => {
    // The property the deadline check in judgeAccessVerification mirrors, here
    // on disk. Once the watchdog has fired it deletes the backup, so a late
    // verification fails on the host as well — two independent reasons a
    // confirmation cannot arrive after the fact.
    const h = fakeHome([`ssh-ed25519 ${A} alice@laptop`, `ssh-ed25519 ${B} bob@desktop`, ''])
    h.run(buildRevokeKeyCommand({ path: h.file, blob: A, token: 'c3', rollbackSeconds: 1 }))
    expect(existsSync(accessBackupPath(h.file, 'c3'))).toBe(true)
    await sleep(2500)
    expect(h.read()).toContain(A)

    const v = h.run(accessVerifyCommand('c3'))
    expect(v.code).toBe(3)
    expect(v.out).toContain('no staged change with this token is waiting here')
  })

  it('refuses to build either command from a token it has not validated', async () => {
    // Both interpolate into a command that runs against authorized_keys. "The
    // only caller passes digits" is a property of this week's callers.
    expect(() => accessVerifyCommand('c3"; rm -rf /; "')).toThrow(/unvalidated/)
    expect(() => accessDisarmCommand('/x', '$(id)')).toThrow(/unvalidated/)
  })

  it('uses no sudo in either', async () => {
    expect(accessVerifyCommand('c4')).not.toMatch(/\bsudo\b/)
    expect(accessDisarmCommand('/x', 'c4')).not.toMatch(/\bsudo\b/)
  })
})


// ===========================================================================
// How long the fresh session may take to authenticate
// ===========================================================================
//
// Reported on a server with a second factor: a key change the operator had just
// confirmed came back `reverted-unconfirmed` and was undone.
//
// The cause was two deadlines that disagreed. `sshOpenFresh` defaulted to
// thirty seconds, while the verification-code dialog it can raise waits two
// minutes and the handshake underneath it waits 135 -- extended deliberately
// the moment a challenge arrives, because the only correct deadline for a
// person reading a code off their phone is longer than the dialog they are
// answering. The outer, flat, arbitrary limit won, and cancelled a connection
// mid-answer.
//
// The fix is not a bigger number. It is having ONE deadline again: the host's
// own dead-man's switch, which is the only clock here with a reason.

describe('the budget for opening the verifying session', () => {
  const ROLLBACK = 300

  it('is what is left of the rollback window, less the commands still to run', () => {
    const budget = accessOpenBudgetMs({
      stagedAt: STAGED_AT,
      rollbackSeconds: ROLLBACK,
      now: STAGED_AT + 2_000
    })
    expect(budget).toBe(300_000 - 2_000 - 2 * ACCESS_CONFIRM_TIMEOUT_MS)
  })

  /**
   * The point of the change. A code typed at leisure has to fit, and under the
   * old flat thirty seconds it did not: the handshake's own human-aware
   * deadline is 135 seconds and the outer limit has to leave room for it.
   */
  it('leaves room for a second factor to actually be answered', () => {
    const budget = accessOpenBudgetMs({
      stagedAt: STAGED_AT,
      rollbackSeconds: ROLLBACK,
      now: STAGED_AT + 2_000
    })
    expect(budget).toBeGreaterThan(135_000)
  })

  // Bounded by construction: it can never outlive the window, so a confirmation
  // can never be written against a file the host has already put back.
  it('never reaches past the rollback deadline', () => {
    for (const elapsed of [0, 1_000, 60_000, 250_000, 299_000]) {
      const budget = accessOpenBudgetMs({
        stagedAt: STAGED_AT,
        rollbackSeconds: ROLLBACK,
        now: STAGED_AT + elapsed
      })
      expect(STAGED_AT + elapsed + budget).toBeLessThan(STAGED_AT + ROLLBACK * 1000)
    }
  })

  it('shrinks with a shorter window rather than ignoring it', () => {
    const short = accessOpenBudgetMs({ stagedAt: STAGED_AT, rollbackSeconds: 60, now: STAGED_AT })
    const long = accessOpenBudgetMs({ stagedAt: STAGED_AT, rollbackSeconds: 300, now: STAGED_AT })
    expect(short).toBeLessThan(long)
    expect(short).toBe(60_000 - 2 * ACCESS_CONFIRM_TIMEOUT_MS)
  })

  // A negative delay is not a thing to hand a timer, and past the deadline the
  // pre-check in confirm() has already reported the honest outcome.
  it('is zero rather than negative once the window has closed', () => {
    expect(
      accessOpenBudgetMs({ stagedAt: STAGED_AT, rollbackSeconds: 60, now: STAGED_AT + 120_000 })
    ).toBe(0)
  })

  it('is zero when only the reserved commands would fit', () => {
    expect(
      accessOpenBudgetMs({ stagedAt: STAGED_AT, rollbackSeconds: 40, now: STAGED_AT })
    ).toBe(0)
  })
})

describe('the committer hands that budget to the opener', () => {
  it('does not leave sshOpenFresh\'s own default in charge', async () => {
    let seen: number | undefined = -1
    const s = session()
    const c = new AccessCommitter({
      openFresh: async (_cfg, timeoutMs) => {
        seen = timeoutMs
        return s
      },
      now: () => STAGED_AT + 2_000
    })
    await c.confirm({}, req())
    expect(seen).toBe(
      accessOpenBudgetMs({ stagedAt: STAGED_AT, rollbackSeconds: 300, now: STAGED_AT + 2_000 })
    )
  })
})
