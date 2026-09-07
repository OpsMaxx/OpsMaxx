import { describe, it, expect } from 'vitest'

import {
  checkDriftWatch,
  driftWatchId,
  driftWatchPhrase,
  driftWatchApprovalSentence,
  DRIFT_WATCH_DENY_DIRS,
  DRIFT_WATCH_DENY_PATHS,
  isCredentialStore,
  verifyDriftWatchApproval,
  type DriftWatchProposal
} from '../src/shared/driftWatch'
import { buildDriftCommand, DRIFT_RULE_ORDER, DRIFT_WATCHES } from '../src/shared/drift'

// Item 46's operator-chosen drift watch. `drift.ts` says why its list is fixed;
// this is the answer to what a typed path needs first, and every test here is
// one of the four gates in that file's header.

const ok = (over: Partial<DriftWatchProposal> = {}): DriftWatchProposal => ({
  path: '/etc/nginx/nginx.conf',
  label: 'nginx',
  comment: '#',
  rules: ['comments', 'trailing-space'],
  ...over
})

const refuse = (over: Partial<DriftWatchProposal>): string => {
  const r = checkDriftWatch(ok(over))
  expect(r.ok).toBe(false)
  return r.ok ? '' : r.reason
}

describe('the path goes into a shell script', () => {
  // `buildDriftCommand` embeds each path inside single quotes. A single quote
  // in the path closes that literal, and everything after it is script.
  it('refuses a quote outright rather than escaping it', () => {
    expect(refuse({ path: "/etc/foo'; id; '" })).toBe('bad-characters')
  })

  it('refuses every shell metacharacter it could be handed', () => {
    for (const bad of ['/etc/a$b', '/etc/a`b', '/etc/a;b', '/etc/a b', '/etc/a\\b', '/etc/a|b', '/etc/a&b', '/etc/a\nb']) {
      expect(refuse({ path: bad })).toBe('bad-characters')
    }
  })

  // The whole reason the allowlist is here rather than at the point of use: a
  // builder that trusts its caller is one that will be called by something else.
  it('lets nothing through that the collector would then embed', () => {
    const r = checkDriftWatch(ok())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const cmd = buildDriftCommand({ watches: [r.watch] })
    expect(cmd).toContain("'/etc/nginx/nginx.conf'")
    // One quoted literal per use, and nothing that reopened one.
    expect(cmd.split("'").length % 2).toBe(1)
  })

  it('accepts the paths the fixed catalogue already uses', () => {
    // If this refused one of them, the rule would be wrong rather than strict.
    for (const w of DRIFT_WATCHES) {
      expect(checkDriftWatch(ok({ path: w.path })).ok).toBe(true)
    }
  })
})

describe('under /etc, and nowhere else', () => {
  it('refuses an absolute path outside it', () => {
    expect(refuse({ path: '/home/ops/.ssh/config' })).toBe('outside-etc')
    expect(refuse({ path: '/var/lib/thing.conf' })).toBe('outside-etc')
  })

  it('refuses a relative path', () => {
    expect(refuse({ path: 'etc/nginx/nginx.conf' })).toBe('not-absolute')
  })

  // Refused as what it IS. Accepting it for starting with the right four
  // characters is exactly how a traversal gets through.
  it('names traversal as traversal rather than as a bad path', () => {
    expect(refuse({ path: '/etc/../root/.ssh/authorized_keys' })).toBe('traversal')
    expect(refuse({ path: '/etc/nginx/../../root/x' })).toBe('traversal')
  })

  it('refuses a path longer than any real one', () => {
    expect(refuse({ path: `/etc/${'a'.repeat(400)}` })).toBe('too-long')
  })
})

describe('credential stores', () => {
  it('refuses the ones it knows by name', () => {
    for (const p of DRIFT_WATCH_DENY_PATHS) {
      expect(isCredentialStore(p)).toBe(true)
    }
    expect(refuse({ path: '/etc/shadow' })).toBe('credential-store')
  })

  it('refuses everything under a private-key directory', () => {
    for (const d of DRIFT_WATCH_DENY_DIRS) {
      expect(isCredentialStore(`${d}anything.conf`)).toBe(true)
    }
  })

  // Deliberately broad. The two mistakes do not cost the same: a wrongly
  // refused config file is a sentence explaining why, and a wrongly accepted
  // one is a private key in an hourly diff on every host in the estate.
  it('refuses a file whose NAME suggests a secret, whatever is in it', () => {
    for (const p of [
      '/etc/app/api-key.conf',
      '/etc/app/secret.conf',
      '/etc/app/db-password',
      '/etc/app/token.json',
      '/etc/app/service.pem',
      '/etc/app/.env',
      '/etc/app/.env.production',
      '/etc/ssh/id_ed25519'
    ]) {
      expect(isCredentialStore(p)).toBe(true)
    }
  })

  it('does not refuse an ordinary configuration file', () => {
    for (const p of ['/etc/nginx/nginx.conf', '/etc/fstab', '/etc/hosts', '/etc/sysctl.conf']) {
      expect(isCredentialStore(p)).toBe(false)
    }
  })

  it('checks the characters before the secret shape', () => {
    // A path that could break out of the shell literal is refused for THAT,
    // named as such. Reporting it as a suspected secret would send somebody
    // looking at the wrong problem.
    expect(refuse({ path: "/etc/app/'key" })).toBe('bad-characters')
  })
})

describe('the watch it builds', () => {
  it('keys the id on the path, not the label', () => {
    const a = checkDriftWatch(ok({ label: 'nginx' }))
    const b = checkDriftWatch(ok({ label: 'the web server' }))
    expect(a.ok && b.ok && a.watch.id).toBe(b.ok ? b.watch.id : '')
    expect(driftWatchId('/etc/nginx/nginx.conf')).toContain('/etc/nginx/nginx.conf')
  })

  it('falls back to the path when no label was typed', () => {
    const r = checkDriftWatch(ok({ label: '   ' }))
    expect(r.ok && r.watch.label).toBe('/etc/nginx/nginx.conf')
  })

  it('keeps the rules in the catalogue’s order rather than the order typed', () => {
    const r = checkDriftWatch(ok({ rules: ['trailing-space', 'comments'] }))
    expect(r.ok && r.watch.rules).toEqual(
      DRIFT_RULE_ORDER.filter((x) => x === 'comments' || x === 'trailing-space')
    )
  })

  it('refuses a watch with no rules, which would compare nothing', () => {
    expect(refuse({ rules: [] })).toBe('no-rules')
  })

  it('refuses a rule this build does not have', () => {
    expect(refuse({ rules: ['no-such-rule' as never] })).toBe('unknown-rule')
  })

  it('falls back to # for a comment character it will not put in a regex', () => {
    const r = checkDriftWatch(ok({ comment: 'not a comment char' }))
    expect(r.ok && r.watch.comment).toBe('#')
  })

  it('keeps a comment character it recognises', () => {
    expect(checkDriftWatch(ok({ comment: ';' })).ok && checkDriftWatch(ok({ comment: ';' })).ok).toBe(true)
    const r = checkDriftWatch(ok({ comment: ';' }))
    expect(r.ok && r.watch.comment).toBe(';')
  })

  it('refuses a path already watched', () => {
    const first = checkDriftWatch(ok())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = checkDriftWatch(ok(), [first.watch])
    expect(again.ok).toBe(false)
    expect(again.ok ? '' : again.reason).toBe('duplicate')
  })

  it('says the read is unprivileged, because it is', () => {
    const r = checkDriftWatch(ok())
    expect(r.ok && r.watch.note).toContain('never with sudo')
  })
})

describe('the approval names the path', () => {
  // A generic word would make one approval reusable for any watch: the dialog
  // says one path and the store keeps another, and nothing in the record shows
  // the difference.
  it('cannot be replayed for a different path', () => {
    const typed = driftWatchPhrase('/etc/nginx/nginx.conf')
    expect(verifyDriftWatchApproval('/etc/nginx/nginx.conf', typed)).toBe(true)
    expect(verifyDriftWatchApproval('/etc/ssl/private/site.key', typed)).toBe(false)
  })

  it('does not accept a near miss', () => {
    const p = '/etc/nginx/nginx.conf'
    expect(verifyDriftWatchApproval(p, 'watch /etc/nginx/nginx.conf')).toBe(false)
    expect(verifyDriftWatchApproval(p, 'WATCH')).toBe(false)
    expect(verifyDriftWatchApproval(p, '')).toBe(false)
  })

  it('accepts the phrase with surrounding whitespace, which is a paste', () => {
    expect(verifyDriftWatchApproval('/etc/fstab', `  ${driftWatchPhrase('/etc/fstab')}\n`)).toBe(true)
  })

  it('says what the operator is asserting before they type it', () => {
    const s = driftWatchApprovalSentence('/etc/nginx/nginx.conf')
    expect(s).toContain('every server in this workspace')
    expect(s).toContain('once an hour')
    expect(s).toContain('Confirm it is configuration and not a credential store')
    // The limit is stated rather than implied.
    expect(s).toContain('no redaction pattern catches every secret format')
  })
})
