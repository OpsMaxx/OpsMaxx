import { describe, expect, it } from 'vitest'
import {
  APPROVAL_RISK_SCALE,
  NO_CONSEQUENCE_TEXT,
  describeConsequence,
  explainRisk,
  formatFuse,
  formatRiskLabel,
  fuseDeadline,
  productionHint,
  riskPosition,
  riskReasons,
  riskTone,
  type ApprovalSubject
} from '../src/shared/approvalRisk'

// The vocabulary half of finding C5.
//
// Everything here is about what the approval modal is allowed to SAY, and every
// case that matters is a case where saying nothing, or saying something
// soothing, would look completely fine on screen: a risk word with no scale, a
// command nobody recognised rendered as blank space, an unknown level quietly
// treated as the bottom of the range.

function subject(over: Partial<ApprovalSubject> = {}): ApprovalSubject {
  return {
    capability: 'sudo',
    action: 'sudo systemctl restart cron',
    risk: 'high',
    serverName: 'k3s-node-01',
    workspaceName: 'Personal',
    ...over
  }
}

describe('the risk scale', () => {
  it('places a level on a scale rather than handing over a bare adjective', () => {
    expect(riskPosition('high')).toEqual({ ordinal: 3, of: 3 })
    expect(riskPosition('medium')).toEqual({ ordinal: 2, of: 3 })
    expect(riskPosition('low')).toEqual({ ordinal: 1, of: 3 })
    expect(formatRiskLabel('high')).toBe('HIGH — 3 of 3')
  })

  it('prints the scale length it actually has, so a fourth level cannot keep rendering as "of 3"', () => {
    expect(formatRiskLabel('medium').endsWith(`of ${APPROVAL_RISK_SCALE.length}`)).toBe(true)
  })

  it('refuses to place a word it does not know, rather than dropping it to the bottom of the scale', () => {
    expect(riskPosition('catastrophic')).toBeNull()
    expect(formatRiskLabel('catastrophic')).toBe("CATASTROPHIC — not on OpsMaxx's 3-level scale")
  })

  it('colours an unrecognised level as danger — the case it understands least is not the case to reassure about', () => {
    expect(riskTone('high')).toBe('danger')
    expect(riskTone('medium')).toBe('warn')
    expect(riskTone('low')).toBe('neutral')
    expect(riskTone('spicy')).toBe('danger')
    expect(riskTone('')).toBe('danger')
  })
})

describe('why this one scored what it scored', () => {
  it('names sudo as the reason a shell command is high, because that is the rule the bridge applies', () => {
    const reasons = riskReasons(subject())
    expect(reasons.some((r) => r.includes('root'))).toBe(true)
  })

  it('says a plain shell command is the agent composing its own command, not that it uses sudo', () => {
    const reasons = riskReasons(subject({ capability: 'terminal', action: 'tail -n 50 /var/log/syslog', risk: 'medium' }))
    expect(reasons.some((r) => r.includes('root'))).toBe(false)
    expect(reasons.some((r) => r.includes('shell command'))).toBe(true)
  })

  it('flags a production-looking name, including one separated by a space rather than a dash', () => {
    expect(productionHint(subject({ serverName: 'Nginx Server Prod' }))).toBe('Nginx Server Prod')
    expect(productionHint(subject({ serverName: 'db-prod-01' }))).toBe('db-prod-01')
    expect(productionHint(subject({ serverName: 'k3s-node-01', workspaceName: 'Production' }))).toBe('Production')
  })

  it('does not read "reproduction" or "prodigy" as production', () => {
    expect(productionHint(subject({ serverName: 'reproduction-box', workspaceName: 'lab' }))).toBeNull()
  })

  it('distinguishes a database read from a statement the engine would not call a read', () => {
    const read = riskReasons(subject({ capability: 'databaseAccess', action: 'SELECT 1', risk: 'low' }))
    const write = riskReasons(subject({ capability: 'databaseAccess', action: 'DELETE FROM users', risk: 'high' }))
    expect(read.some((r) => r.includes('reads from a database'))).toBe(true)
    expect(write.some((r) => r.includes('not classified as a read'))).toBe(true)
  })

  it('says out loud that no reason was recorded, instead of leaving the line blank', () => {
    // viewServer at 'low' matches none of the derivation rules, which is the
    // whole point of the case: an empty reasons list must still produce a
    // sentence, because blank space reads as "nothing to worry about".
    const e = explainRisk(subject({ capability: 'viewServer', action: 'view', risk: 'low', serverName: 'box', workspaceName: 'lab' }))
    expect(e.reasonKnown).toBe(false)
    expect(e.sentence).not.toBe('')
    expect(e.sentence).toContain('did not record why')
  })

  it('tells the operator an unrecognised level is unscored, never that it is safe', () => {
    const e = explainRisk(subject({ risk: 'moderate-ish', capability: 'viewServer', action: 'view', serverName: 'box', workspaceName: 'lab' }))
    expect(e.position).toBeNull()
    expect(e.sentence).toContain('Treat this as unscored, not as safe.')
    expect(e.tone).toBe('danger')
  })

  it('leads with the level word when it has reasons to give', () => {
    expect(explainRisk(subject()).sentence.startsWith('HIGH because: ')).toBe(true)
  })
})

describe('what the action will do', () => {
  it('describes a service restart as the dropped connections it is, not as "restarts a service"', () => {
    const c = describeConsequence(subject())
    expect(c.known).toBe(true)
    expect(c.text).toContain('Restarts cron on k3s-node-01')
    expect(c.text).toContain('dropped')
    expect(c.text).toContain('It runs as root.')
  })

  it('says a stop stays stopped, because that is the half an operator forgets', () => {
    const c = describeConsequence(subject({ action: 'systemctl stop nginx', capability: 'terminal' }))
    expect(c.text).toContain('leaves it stopped')
  })

  it('separates enable from start — a boot-time change looks like nothing happened', () => {
    const c = describeConsequence(subject({ action: 'systemctl enable nginx', capability: 'terminal' }))
    expect(c.text).toContain('starts at boot')
    expect(c.text).toContain('does not start or stop the service right now')
  })

  it('warns that a firewall edit over SSH can lock this very connection out', () => {
    const c = describeConsequence(subject({ action: 'ufw default deny incoming', capability: 'terminal' }))
    expect(c.text).toContain('lock this very connection out')
  })

  it('says explicitly that it cannot describe a command it does not recognise', () => {
    const c = describeConsequence(subject({ capability: 'terminal', action: 'flarb --quux /opt/thing', risk: 'medium' }))
    expect(c.known).toBe(false)
    expect(c.text).toBe(NO_CONSEQUENCE_TEXT)
  })

  it('has no catch-all sentence for shell commands — "runs a command on the host" would pass the check and teach nothing', () => {
    // If a fallback is ever added for terminal/sudo, this fails: an unknown
    // command must reach NO_CONSEQUENCE_TEXT and nothing else.
    for (const action of ['zzz', 'make -j8', '/opt/vendor/bin/agentctl sync --force']) {
      expect(describeConsequence(subject({ capability: 'terminal', action, risk: 'medium' })).known).toBe(false)
    }
  })

  it('describes a read as the contents leaving the host, since nothing on the host changes', () => {
    const c = describeConsequence(subject({ capability: 'readFiles', action: 'read /etc/shadow', risk: 'low' }))
    expect(c.known).toBe(true)
    expect(c.text).toContain('/etc/shadow')
    expect(c.text).toContain('left it')
  })

  it('strips the byte count out of a write path rather than printing it inside the filename', () => {
    const c = describeConsequence(subject({ capability: 'writeFiles', action: 'write /etc/hosts (91 bytes)', risk: 'medium' }))
    expect(c.text).toContain('Overwrites /etc/hosts on')
    expect(c.text).not.toContain('91 bytes)')
  })

  it('refuses on an unknown capability just as firmly as on an unknown command', () => {
    const c = describeConsequence(subject({ capability: 'teleport', action: 'do the thing', risk: 'high' }))
    expect(c.known).toBe(false)
    expect(c.text).toBe(NO_CONSEQUENCE_TEXT)
  })
})

describe('the fuse', () => {
  it('formats a countdown the way a clock does', () => {
    expect(formatFuse(103_000)).toBe('1:43')
    expect(formatFuse(60_000)).toBe('1:00')
    expect(formatFuse(9_400)).toBe('0:10')
  })

  it('never counts below zero once the deadline has passed', () => {
    expect(formatFuse(-5_000)).toBe('0:00')
  })

  it('shows no countdown at all rather than a guessed one when the timeout is unknown', () => {
    expect(formatFuse(null)).toBeNull()
    expect(fuseDeadline('2026-09-07T10:00:00.000Z', null)).toBeNull()
    expect(fuseDeadline('2026-09-07T10:00:00.000Z', 0)).toBeNull()
  })

  it('gives up on an unparseable createdAt instead of dating the fuse from now', () => {
    expect(fuseDeadline('not a date', 120)).toBeNull()
  })

  it('deadlines from when the request was made, not from when the modal opened', () => {
    expect(fuseDeadline('2026-09-07T10:00:00.000Z', 120)).toBe(Date.parse('2026-09-07T10:02:00.000Z'))
  })
})
