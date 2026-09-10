import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  ACCESS_STATUS_MARKER,
  escalatedFor,
  parseAccessCollection,
  planAccessChange,
  shQuote,
  type AccessChangeTarget,
  type HostAccess,
  type Sha256
} from '../src/shared/access'

/**
 * Revoking a key from an account OpsMaxx is not connected as.
 *
 * Every command this module builds resolves `$HOME/.ssh/authorized_keys`,
 * which is what lets ONE approved command text cover a whole selection — and
 * which also means it can only edit the connecting account's file. Revoking
 * from `raymon` while connected as `usecqa` was refused, on hosts where
 * `usecqa` plainly has passwordless sudo and the READ half had already used it
 * to inventory raymon's keys in the first place.
 *
 * The change runs the same staged write as the target account — `sudo -n -H -u
 * raymon sh -c '<script>'` — rather than as root. What that buys is on the
 * wrapper itself; what it must not cost is anything below.
 */

const sha256: Sha256 = (data) => new Uint8Array(createHash('sha256').update(data).digest())

const A = 'AAAAC3NzaC1lZDI1NTE5AAAAIJp0kFqDkGDMEnCH7mFY3sBRb+tSVEyKvJhLhZ+SHDdw'
const B = 'AAAAC3NzaC1lZDI1NTE5AAAAIN+Qq8Z0mHqxr4RMlBFPHU6JmsFvNzZYuHkWkQrgnJ2s'
const B_FP = 'SHA256:Kh/dB+J46zzk3b+72O1DqnLW16xNkYitzUOrofTSSL8'
/** A certificate issued over A, from `ssh-keygen -s`. `ssh-keygen -l` prints
 *  A_FP for it, because the identity a certificate carries is the key inside
 *  it — which is what makes one account trusting a key both ways two lines for
 *  one fingerprint. */

const OK_STATUS = [
  'accounts ok -',
  'sshd-config ok - /etc/ssh/sshd_config',
  'account-status ok -',
  'sudoers ok -',
  'last-login ok - lastlog'
]

/** A collection, through the real parser. Two keys on `ops`, sshd on the
 *  default key file, and by default the host does not say which key we are on —
 *  which is what most hosts actually do. */
function host(
  over: {
    /** One entry per factor, exactly as sshd would put it on its own line. */
    authinfo?: string[]
    /** Override the length recorded for every factor, so a truncated blob can
     *  be staged without generating a 2049-character key. */
    authinfoLen?: number
    self?: string
    user?: string
    keysStatus?: string
    /** The AuthorizedKeysFile value sshd is configured with. */
    keyfile?: string
    /** The status the sshd-config source reports. `partial` is a config this
     *  collection read only part of. */
    sshdStatus?: string
    /** What the account's authorized_keys2 probe said. */
    keys2?: 'present' | 'unknown'
  } = {}
): HostAccess {
  const user = over.user ?? 'ops'
  return parseAccessCollection(
    [
      'V tz +0000',
      `V self ${over.self ?? 'ops'}`,
      // `A <length-before-truncation> <factor>`, one per line of
      // SSH_AUTH_INFO_0, which is the record the collector actually emits. The
      // length is what tells a factor that fitted from one that was cut, and
      // passing the real length here is what makes the fixtures below able to
      // lie about it deliberately.
      ...(over.authinfo ?? []).map((f) => `A ${over.authinfoLen ?? f.length} ${f}`),
      `V keyfile AuthorizedKeysFile ${over.keyfile ?? '.ssh/authorized_keys'}`,
      `U 1 keys ${over.keysStatus ?? 'ok'} -`,
      `U 1 path /home/${user}/.ssh/authorized_keys`,
      `U 1 name ${user}`,
      ...(over.keys2 ? [`U 1 keys2 ${over.keys2}`] : []),
      `K 1 1 90 ssh-ed25519 ${A} alice@laptop`,
      `K 1 2 90 ssh-ed25519 ${B} bob@desktop`,
      ACCESS_STATUS_MARKER,
      ...OK_STATUS.map((l) =>
        over.sshdStatus && l.startsWith('sshd-config ')
          ? `sshd-config ${over.sshdStatus} - /etc/ssh/sshd_config`
          : l
      )
    ].join('\n'),
    { sha256, now: 1_800_000_000_000 }
  )
}

const target = (
  access: HostAccess,
  user: string,
  escalateAs?: string
): AccessChangeTarget => ({
  serverId: 'a',
  serverName: 'web-1',
  access,
  user,
  ...(escalateAs ? { escalateAs } : {})
})

const plan = (targets: AccessChangeTarget[]): ReturnType<typeof planAccessChange> =>
  planAccessChange({ kind: 'revoke', fingerprint: B_FP, targets, now: 1_800_000_000_000 })

describe('quoting a script into one shell word', () => {
  it('round-trips through a real shell, single quotes included', () => {
    // The staged write contains `trap '...' EXIT`, so the quote inside a quote
    // is not hypothetical — it is on the line that releases the lock.
    for (const v of [`a'b`, `trap 'x' EXIT`, '$HOME', '"; rm -rf /"', 'back\\slash', "''"]) {
      const out = execFileSync('sh', ['-c', `printf %s ${shQuote(v)}`], { encoding: 'utf8' })
      expect(out).toBe(v)
    }
  })

  it('refuses an account name it cannot vouch for', () => {
    // Refused, never sanitised: the name reaches a shell command, and a name
    // this app will not act on anywhere is not one to quote and hope.
    for (const bad of ['ray mon', 'ray;mon', '../root', '$(id)', '', 'a'.repeat(80)]) {
      expect(() => escalatedFor(bad, 'echo hi')).toThrow()
    }
  })

  it('produces something sh will parse', () => {
    const inner = ["SP_LOCK=\"$HOME/.ssh/.lock\"", "trap 'rmdir \"$SP_LOCK\"' EXIT", 'echo ok'].join('\n')
    expect(() =>
      execFileSync('sh', ['-n'], { input: escalatedFor('raymon', inner) })
    ).not.toThrow()
  })
})

describe('a change against the connecting account', () => {
  it('is exactly what it always was, with no sudo in it', () => {
    // The ordinary path must not acquire an escalation it did not ask for.
    const p = plan([target(host({ self: 'root' }), 'ops')])
    expect(p.write?.command).toBeDefined()
    expect(p.write!.command).not.toMatch(/\bsudo\b/)
    expect(p.disarm.every((d) => !/\bsudo\b/.test(d.command))).toBe(true)
  })
})

describe('a change against another account', () => {
  const escalated = (): ReturnType<typeof planAccessChange> =>
    plan([target(host({ self: 'root', user: 'raymon' }), 'raymon', 'raymon')])

  it('runs the staged write as that account', () => {
    const p = escalated()
    expect(p.write!.command.startsWith("sudo -n -H -u raymon sh -c '")).toBe(true)
  })

  it('wraps the SAME script, unchanged', () => {
    // The whole argument for `-u <user>` over root: not one line of the staged
    // write changes, so its reasoning and its tests carry over intact.
    const direct = plan([target(host({ self: 'root', user: 'raymon' }), 'raymon')])
    const p = escalated()
    const inner = p.write!.command.slice("sudo -n -H -u raymon sh -c ".length)
    // Unwrap the single-quoted word and compare with the unescalated build.
    const unwrapped = execFileSync('sh', ['-c', `printf %s ${inner}`], { encoding: 'utf8' })
    expect(unwrapped).toBe(direct.write!.command)
  })

  it('escalates the confirmation too', () => {
    // The marker lives in the edited account's own ~/.ssh. A disarm running as
    // the connecting user would write it into the wrong home, and the watchdog
    // would roll a committed change back.
    const p = escalated()
    expect(p.disarm).not.toHaveLength(0)
    expect(p.disarm.every((d) => d.command.startsWith('sudo -n -H -u raymon sh -c '))).toBe(true)
  })

  it('still parses as a shell script', () => {
    expect(() =>
      execFileSync('sh', ['-n'], { input: escalated().write!.command })
    ).not.toThrow()
  })

  it('says so in the title, rather than looking like an ordinary change', () => {
    expect(escalated().write!.title).toMatch(/via sudo/)
  })
})

describe('a selection that would need two commands', () => {
  it('blocks the odd host out instead of quietly covering fewer', () => {
    // One confirmation covers one command text. A revocation that silently
    // reached fewer hosts than were selected is the failure this whole feature
    // is shaped around refusing, so the mismatch is a block with a reason.
    const p = planAccessChange({
      kind: 'revoke',
      fingerprint: B_FP,
      targets: [
        target(host({ self: 'root', user: 'raymon' }), 'raymon'),
        {
          ...target(host({ self: 'root', user: 'raymon' }), 'raymon', 'raymon'),
          serverId: 'b',
          serverName: 'web-2'
        }
      ],
      now: 1_800_000_000_000
    })
    expect(p.targets).toHaveLength(1)
    const mixed = p.blocks.filter((b) => b.kind === 'mixed-escalation')
    expect(mixed).toHaveLength(1)
    expect(mixed[0].reason).toMatch(/on its own/)
  })
})
