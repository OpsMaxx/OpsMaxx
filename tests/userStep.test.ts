import { describe, it, expect } from 'vitest'

import {
  checkUserStep,
  userJobSpec,
  PROTECTED_USERS,
  USER_ACTIONS,
  type UserAction
} from '../src/shared/userStep'
import { planJob } from '../src/shared/jobs'

// Item 34d. The constraint that shapes the whole file is that NO PASSWORD EVER
// REACHES A STEP -- not from the vault, not redacted, not piped.
//
// The reason is the approval record rather than the terminal. A step's text is
// stored, hashed, compared and rendered; redaction happens at the writer, which
// is one of those four places. A password in a step is a password in a record
// that outlives the job.

const targets = [{ serverId: 's1', serverName: 'web-1' }]
const every = (i: { action: UserAction; user: string; group?: string; expiry?: string }): string[] =>
  userJobSpec({ ...i, group: i.group ?? 'docker' }).steps.map((s) => s.command)

describe('no password, by construction', () => {
  it('has no action that sets one', () => {
    // If an action for it ever appears, this list changes and somebody has to
    // read the comment at the top of userStep.ts before shipping it.
    expect([...USER_ACTIONS]).toEqual(['create', 'lock', 'unlock', 'add-group', 'set-expiry', 'delete'])
  })

  it('never puts -p on useradd, and creates the account locked', () => {
    const cmds = every({ action: 'create', user: 'deploy' })
    expect(cmds[0]).not.toContain('-p')
    expect(cmds[0]).toBe("sudo -n useradd -m 'deploy'")
    // And says what state it left the account in, rather than assuming.
    expect(cmds[1]).toContain('passwd -S')
  })

  it('puts no password in any command of any action', () => {
    for (const a of USER_ACTIONS) {
      for (const c of every({ action: a, user: 'deploy', expiry: '2027-01-01' })) {
        expect(c, `${a}: ${c}`).not.toMatch(/-p\s|--password|chpasswd|openssl passwd/)
      }
    }
  })
})

describe('the accounts it will not touch', () => {
  it('refuses root and the system accounts, at any strength', () => {
    for (const u of PROTECTED_USERS) {
      for (const a of USER_ACTIONS) {
        expect(checkUserStep({ action: a, user: u, group: 'docker' }), `${a} ${u}`).toMatchObject({ ok: false })
      }
    }
  })

  it('explains that it can take away the way back in', () => {
    const r = checkUserStep({ action: 'lock', user: 'root' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('only way back into a server')
  })
})

describe('the user name, which runs as root', () => {
  it('refuses anything that is not a POSIX user name', () => {
    for (const bad of ['deploy; rm -rf /', 'Deploy', '1deploy', '-rf', 'de ploy', "d'x", 'deploy$(id)']) {
      expect(checkUserStep({ action: 'lock', user: bad }), bad).toMatchObject({ ok: false })
    }
  })

  it('allows the ones that are', () => {
    for (const good of ['deploy', '_svc', 'app-runner', 'ci_2']) {
      expect(checkUserStep({ action: 'lock', user: good }), good).toEqual({ ok: true })
    }
  })
})

describe('locking an account actually closes it', () => {
  // `usermod -L` locks the PASSWORD and does not stop a key login. An operator
  // who locks an account believes it is shut.
  it('expires the account as well as locking the password', () => {
    const cmd = every({ action: 'lock', user: 'deploy' })[0]
    expect(cmd).toContain('-L')
    expect(cmd).toContain('-e 1')
  })

  it('undoes both when unlocking', () => {
    const cmd = every({ action: 'unlock', user: 'deploy' })[0]
    expect(cmd).toContain('-U')
    expect(cmd).toContain("-e ''")
  })
})

describe('deleting is two different acts and says which', () => {
  it('keeps the home directory unless asked, and the title says so', () => {
    const kept = userJobSpec({ action: 'delete', user: 'deploy' })
    expect(kept.steps[0].command).toBe("sudo -n userdel 'deploy'")
    expect(kept.title).toContain('home kept')

    const gone = userJobSpec({ action: 'delete', user: 'deploy', removeHome: true })
    expect(gone.steps[0].command).toContain('-r')
    expect(gone.title).toContain('AND its home directory')
  })

  it('checks the account is actually gone, as an absence', () => {
    const v = userJobSpec({ action: 'delete', user: 'deploy' }).steps[1].command
    expect(v).toContain('still present')
    expect(v).toContain('exit 1')
  })

  it('is graded destructive, so it has to be typed out', () => {
    // `userdel` is on assessCommand's destructive list.
    const p = planJob(userJobSpec({ action: 'delete', user: 'deploy' }), targets)
    expect(p.risk).toBe('destructive')
    expect(p.confirmation.kind).toBe('type-to-confirm')
  })
})

describe('the expiry date', () => {
  it('takes one format and refuses the rest', () => {
    expect(checkUserStep({ action: 'set-expiry', user: 'deploy', expiry: '2027-01-01' })).toEqual({ ok: true })
    for (const bad of ['01/01/2027', 'tomorrow', '2027-1-1', "2027-01-01'"]) {
      expect(checkUserStep({ action: 'set-expiry', user: 'deploy', expiry: bad }), bad).toMatchObject({ ok: false })
    }
  })

  it('treats an empty date as clearing it, which is a real thing to want', () => {
    expect(checkUserStep({ action: 'set-expiry', user: 'deploy', expiry: '' })).toEqual({ ok: true })
    expect(userJobSpec({ action: 'set-expiry', user: 'deploy', expiry: '' }).steps[0].command).toContain("-E '-1'")
  })
})
