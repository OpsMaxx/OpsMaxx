import { describe, it, expect } from 'vitest'

import {
  COMPOSE_BACKUP_MARKER,
  applyComposeImageEdit,
  buildComposeBackupReadCommand,
  composeBackupPath,
  composeServiceImage,
  parseComposeBackupRead,
  planComposeRevert,
  revertDescription
} from '../src/shared/compose'
import { ComposeReader } from '../src/main/services/compose'

// Deployment rollback for compose — "we shipped v2, it is bad, put v1 back."
//
// THE ROADMAP'S PREMISE WAS WRONG, and finding that out was most of the work.
// It said the app does not remember the previous tag and so "a small per-project
// last applied image record is new". It does not need one: the write path has
// always run `cp -p <file> <file>.opsmaxx-bak` BEFORE writing, so the
// previous version of the file is already on the host — a better record than
// anything this app could keep, because it survives the app being closed or run
// from somebody else's laptop and cannot drift from the file it describes.

const FILE = `# the edge stack
services:
  gateway:
    image: nginx:1.29-alpine
    ports:
      - "80:80"
  cache:
    image: "redis:7.4-alpine" # pinned
  builder:
    build:
      context: .
      image: ignore-me:1
`

/** The same stack as it was before the bad deploy. */
const BACKUP = FILE.replace('nginx:1.29-alpine', 'nginx:1.27-alpine')

describe('the previous tag comes off the host, not out of a new record', () => {
  it('reads what a service used to be pinned to, from the backup file itself', () => {
    expect(composeServiceImage(BACKUP, 'gateway')).toEqual({ ok: true, image: 'nginx:1.27-alpine' })
    // Quoting and trailing comments are the file's business, not the value's.
    expect(composeServiceImage(FILE, 'cache')).toEqual({ ok: true, image: 'redis:7.4-alpine' })
  })

  // ONE locator, shared with the editor. They were the same twenty lines twice
  // for about an hour, which is exactly long enough for the two to disagree
  // about which `image:` belongs to a service.
  it('never reads an image out of a nested block', () => {
    const r = composeServiceImage(FILE, 'builder')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('built, not pulled')
  })

  it('plans the revert as an ordinary edit of the current file', () => {
    const r = planComposeRevert(FILE, BACKUP, 'gateway')
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.reason)
    expect(r.from).toBe('nginx:1.29-alpine')
    expect(r.to).toBe('nginx:1.27-alpine')
    expect(r.plan.line).toBe(4)
  })

  // THE POINT. A file restore would also undo every unrelated change made in
  // between — a port, an environment variable, a service a colleague added this
  // morning. Only the one line moves.
  it('changes exactly the one line and nothing a colleague did since', () => {
    const withExtra = FILE.replace('      - "80:80"', '      - "80:80"\n      - "443:443"')
    const r = planComposeRevert(withExtra, BACKUP, 'gateway')
    if (!r.ok) throw new Error(r.reason)
    const out = applyComposeImageEdit(withExtra, r.plan)
    expect(out).toContain('nginx:1.27-alpine')
    // The port the backup has never heard of is still there.
    expect(out).toContain('- "443:443"')
    expect(out.split('\n').length).toBe(withExtra.split('\n').length)
  })

  it('promises nothing about the tag it is going back to', () => {
    const r = planComposeRevert(FILE, BACKUP, 'gateway')
    if (!r.ok) throw new Error(r.reason)
    const d = revertDescription(r)
    expect(d).toContain('immediately before OpsMaxx last edited this file')
    expect(d).toContain('not a guarantee')
    expect(d).not.toMatch(/last known good|working version|safe/i)
  })
})

describe('what it refuses, and why each is its own answer', () => {
  it('says there is nothing to undo when this app never wrote the file', () => {
    const r = planComposeRevert(FILE, null, 'gateway')
    expect(r).toMatchObject({ ok: false, refusal: 'no-backup' })
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('only written when OpsMaxx itself edits the file')
  })

  // An empty `.opsmaxx-bak` is a file that IS there with nothing in it —
  // what an interrupted `cp` leaves behind. Calling that "there is no backup
  // beside this compose file" is false in the direction that stops somebody
  // going to look at the file that is sitting right there.
  it('does not call an empty backup file a missing one', () => {
    const r = planComposeRevert(FILE, '', 'gateway')
    expect(r).toMatchObject({ ok: false })
    if (r.ok) throw new Error('unreachable')
    expect(r.refusal).not.toBe('no-backup')
    expect(r.reason).not.toMatch(/there is no OpsMaxx backup/i)
  })

  it('says so when the service never moved', () => {
    const r = planComposeRevert(FILE, FILE, 'gateway')
    expect(r).toMatchObject({ ok: false, refusal: 'same-image' })
  })

  it('separates a service missing from the backup from one missing from the file', () => {
    const noService = 'services:\n  other:\n    image: busybox:1.37\n'
    expect(planComposeRevert(FILE, noService, 'gateway')).toMatchObject({
      ok: false,
      refusal: 'not-in-backup'
    })
    expect(planComposeRevert(noService, BACKUP, 'gateway')).toMatchObject({
      ok: false,
      refusal: 'not-in-file'
    })
  })

  // The backup is a file on a host. It is input, not a record this app wrote
  // and can vouch for, so its value is validated on the way out as well as in.
  it('refuses a backup whose image value is not a valid reference', () => {
    const evil = FILE.replace('nginx:1.29-alpine', 'nginx:1.27 alpine; rm -rf /')
    const r = planComposeRevert(FILE, evil, 'gateway')
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The three-way read, which is the reason this is not two lines of code
// ---------------------------------------------------------------------------

describe('absent, refused and could-not-ask are three different answers', () => {
  it('asks in a way that says which of the three it is', () => {
    const c = buildComposeBackupReadCommand('/srv/edge/compose.yaml')
    expect(c).toContain(composeBackupPath('/srv/edge/compose.yaml'))
    expect(c).toContain(`${COMPOSE_BACKUP_MARKER} absent`)
    expect(c).toContain(`${COMPOSE_BACKUP_MARKER} denied`)
    expect(c).toContain(`${COMPOSE_BACKUP_MARKER} present`)
  })

  it('reads the state before the content, so a file cannot restate it', () => {
    const hostile = `${COMPOSE_BACKUP_MARKER} present\nservices:\n  x:\n    image: a:1\n${COMPOSE_BACKUP_MARKER} absent\n`
    expect(parseComposeBackupRead(hostile)?.state).toBe('present')
    expect(parseComposeBackupRead(`${COMPOSE_BACKUP_MARKER} absent\n`)).toEqual({
      state: 'absent',
      text: ''
    })
    expect(parseComposeBackupRead('nothing here')).toBeNull()
    expect(parseComposeBackupRead(`${COMPOSE_BACKUP_MARKER} maybe\n`)).toBeNull()
  })
})

describe('the service layer keeps a silent host and an absent backup apart', () => {
  const svc = (
    exec: (cfg: unknown, cmd: string) => Promise<Record<string, unknown>>
  ): ComposeReader =>
    new ComposeReader({
      exec: (cfg: unknown, cmd: string) => exec(cfg, cmd)
    } as never)

  const ok = (stdout: string): Record<string, unknown> => ({ ok: true, code: 0, stdout, stderr: '' })

  it('reports a host that did not answer as unreachable, never as “no backup”', async () => {
    const r = await svc(() => Promise.resolve({ ok: false, error: 'connect ETIMEDOUT' })).planRevert(
      {},
      { path: '/srv/edge/compose.yaml', service: 'gateway' }
    )
    expect(r).toMatchObject({ ok: false, refusal: 'unreachable' })
    if (r.ok) throw new Error('unreachable')
    // The sentence a person reads must not be the reassuring one.
    expect(r.reason).not.toMatch(/no backup|nothing to roll back/i)
  })

  it('reports a backup it may not read as refused, not as absent', async () => {
    const r = await svc(() =>
      Promise.resolve(ok(`${COMPOSE_BACKUP_MARKER} denied\n`))
    ).planRevert({}, { path: '/srv/edge/compose.yaml', service: 'gateway' })
    expect(r).toMatchObject({ ok: false, refusal: 'backup-denied' })
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('not a report that there is none')
  })

  // A host that answered with something this build cannot read is not a host
  // with no backup. Nothing is assumed from an answer nobody could parse.
  it('assumes nothing when the answer does not parse', async () => {
    const r = await svc(() => Promise.resolve(ok('bash: line 1: syntax error\n'))).planRevert(
      {},
      { path: '/srv/edge/compose.yaml', service: 'gateway' }
    )
    expect(r).toMatchObject({ ok: false, refusal: 'unreadable' })
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toContain('nothing was assumed')
  })

  it('plans the revert when both files are there', async () => {
    const r = await svc((_c, cmd) =>
      Promise.resolve(
        ok(cmd.includes(COMPOSE_BACKUP_MARKER) ? `${COMPOSE_BACKUP_MARKER} present\n${BACKUP}` : FILE)
      )
    ).planRevert({}, { path: '/srv/edge/compose.yaml', service: 'gateway' })
    expect(r).toMatchObject({ ok: true, from: 'nginx:1.29-alpine', to: 'nginx:1.27-alpine' })
  })

  it('writes nothing while planning', async () => {
    const sent: string[] = []
    await svc((_c, cmd) => {
      sent.push(cmd)
      return Promise.resolve(
        ok(cmd.includes(COMPOSE_BACKUP_MARKER) ? `${COMPOSE_BACKUP_MARKER} present\n${BACKUP}` : FILE)
      )
    }).planRevert({}, { path: '/srv/edge/compose.yaml', service: 'gateway' })
    for (const c of sent) {
      expect(c).not.toContain('tee ')
      expect(c).not.toContain('mv ')
      expect(c).not.toContain('cp -p')
    }
  })
})
