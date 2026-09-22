import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  EMPTY_JOB_DRAFT,
  draftFromTemplate,
  sanitiseJobTemplate,
  templateFromDraft,
  templateTerminalText,
  type JobTemplate
} from '../src/shared/jobCompose'
import {
  listJobTemplates,
  removeJobTemplate,
  saveJobTemplate,
  setAsideJobTemplates,
  type JobTemplateDeps
} from '../src/main/services/jobTemplates'
import { refreshMcpDataCache } from '../src/main/services/mcpDataCache'
import { setAssignment, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { setMcpConfig, createSession, resetMcpAuthForTests } from '../src/main/services/mcpAuth'
import { startMcpServer, stopMcpServer } from '../src/main/services/mcpServer'

// Saved job templates: the steps of a job and never where or whether they run.
// broadcast.ts rule 1 -- no saved target set that could drift -- is what these
// assert, at the type, at the sanitiser, on disk, and at the MCP bridge.

const base = {
  id: 'tpl-1',
  name: 'Restart nginx',
  steps: '# reload first\nnginx -t\nsystemctl reload nginx',
  rollback: '',
  rebootLast: false,
  updatedAt: 0
}

describe('a template never holds targets or an approval', () => {
  it('refuses them by type', () => {
    // @ts-expect-error -- `targets` is `never` on a template
    const withTargets: JobTemplate = { ...base, targets: [{ serverId: 's1' }] }
    // @ts-expect-error -- and so is `approval`
    const withApproval: JobTemplate = { ...base, approval: { phrase: 'RUN' } }
    expect(withTargets && withApproval).toBeTruthy()
  })

  it('drops them at runtime, whatever rode along', () => {
    const t = sanitiseJobTemplate({
      ...base,
      targets: [{ serverId: 's1', serverName: 'web', cohort: 'Wave 1' }],
      approval: { phrase: 'RUN', confirmedAt: 1 },
      cohort: 'Wave 1',
      waveSize: 3,
      gate: 'health'
    })
    expect(t).not.toBeNull()
    expect(Object.keys(t!).sort()).toEqual(
      ['id', 'name', 'rebootLast', 'rollback', 'steps', 'updatedAt'].sort()
    )
  })

  it('refuses a template with no command, and strips what could escape a paste', () => {
    expect(sanitiseJobTemplate({ ...base, steps: '# only a note\n\n' })).toBeNull()
    expect(sanitiseJobTemplate({ ...base, name: '   ' })).toBeNull()
    const t = sanitiseJobTemplate({ ...base, steps: 'echo hi\u001b[201~\nrm -rf /tmp/x\u009b' })
    expect(t?.steps).toBe('echo hi[201~\nrm -rf /tmp/x')
  })

  it('round-trips the composer without carrying servers, waves or the gate', () => {
    const draft = {
      ...EMPTY_JOB_DRAFT,
      title: 'Upgrade',
      steps: 'apt-get -y upgrade\nreboot',
      rollback: 'echo nothing to undo',
      rebootLast: true,
      waveSize: 3,
      gate: true
    }
    const t = templateFromDraft(draft, 'tpl-2', draft.title)!
    expect(t).toMatchObject({ name: 'Upgrade', rebootLast: true, rollback: 'echo nothing to undo' })
    expect(t).not.toHaveProperty('waveSize')
    expect(t).not.toHaveProperty('gate')
    // Loading keeps the wave size and gate the operator set for THIS run.
    const loaded = draftFromTemplate(t, { ...EMPTY_JOB_DRAFT, waveSize: 5 })
    expect(loaded).toMatchObject({ title: 'Upgrade', steps: draft.steps, rebootLast: true, waveSize: 5, gate: false })
  })

  it('strips every character the confirmation could not show', () => {
    for (const ch of ['\u200b', '\u200d', '\u200f', '\u061c', '\u2028', '\u2029', '\ufeff', '\u202e', '\u2066', '\u{e0041}']) {
      const t = sanitiseJobTemplate({ ...base, steps: `rm${ch} -rf /tmp/x` })
      expect(t?.steps, JSON.stringify(ch)).toBe('rm -rf /tmp/x')
    }
  })

  it('pastes a tab as a space, so it cannot ask the shell to complete anything', () => {
    expect(templateTerminalText(sanitiseJobTemplate({ ...base, steps: 'cd /srv\tls' })!)).toBe('cd /srv ls')
  })

  it('pastes the commands and not the notes', () => {
    expect(templateTerminalText(sanitiseJobTemplate(base)!)).toBe('nginx -t\nsystemctl reload nginx')
  })
})

describe('the templates file', () => {
  let dir: string
  let deps: JobTemplateDeps
  const file = (): string => join(dir, 'opsmaxx-job-templates.json')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jobtpl-'))
    deps = { dir, now: () => 1234 }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('saves, lists, renames and deletes', () => {
    expect(listJobTemplates(deps)).toEqual({ templates: [], problem: null, path: file() })
    const saved = saveJobTemplate(deps, base)
    expect(saved).toMatchObject({ ok: true, template: { ...base, updatedAt: 1234 } })
    const first = saved.ok ? saved.template : base
    expect(listJobTemplates(deps).templates).toEqual([first])

    const renamed = saveJobTemplate(deps, { ...first, name: 'Reload nginx' })
    expect(renamed).toMatchObject({ ok: true, template: { id: 'tpl-1', name: 'Reload nginx' } })
    expect(listJobTemplates(deps).templates.map((t) => t.name)).toEqual(['Reload nginx'])

    expect(removeJobTemplate(deps, 'tpl-1')).toEqual({ ok: true })
    expect(listJobTemplates(deps).templates).toEqual([])
    expect(removeJobTemplate(deps, 'tpl-1').ok).toBe(false)
  })

  it('never writes targets to disk, even when handed them', () => {
    saveJobTemplate(deps, { ...base, targets: [{ serverId: 's1' }], approval: { phrase: 'RUN' } })
    expect(readFileSync(file(), 'utf8')).not.toMatch(/targets|approval|serverId/)
  })

  it('does not overwrite a file it cannot read', () => {
    writeFileSync(file(), '{ not json', { mode: 0o600 })
    expect(listJobTemplates(deps).problem).toMatch(/could not be read/)
    expect(saveJobTemplate(deps, base).ok).toBe(false)
    expect(removeJobTemplate(deps, 'tpl-1').ok).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe('{ not json')
  })

  // A row this version refuses is left out of the list -- and a save that wrote
  // the list back would have deleted it.
  it('refuses to save over a row it could not validate', () => {
    const oversize = { ...base, id: 'tpl-big', name: 'x'.repeat(121) }
    const before = JSON.stringify({ v: 1, templates: [base, oversize] })
    writeFileSync(file(), before, { mode: 0o600 })

    const read = listJobTemplates(deps)
    expect(read.templates.map((t) => t.id)).toEqual(['tpl-1'])
    expect(read.problem).toMatch(/1 saved template/)

    const saved = saveJobTemplate(deps, { ...base, id: 'tpl-new' })
    expect(saved).toMatchObject({ ok: false, reason: expect.stringMatching(/not rewritten/) })
    expect(removeJobTemplate(deps, 'tpl-1').ok).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  it('refuses to rewrite a file from another version as v1', () => {
    const before = JSON.stringify({ v: 2, templates: [base] })
    writeFileSync(file(), before, { mode: 0o600 })
    expect(listJobTemplates(deps).problem).toMatch(/different version/)
    expect(saveJobTemplate(deps, base).ok).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  it('keeps the readable rows when it sets a file aside for one bad row', () => {
    const oversize = { ...base, id: 'tpl-big', name: 'x'.repeat(121) }
    const before = JSON.stringify({ v: 1, templates: [base, oversize] })
    writeFileSync(file(), before, { mode: 0o600 })
    const aside = join(dir, 'opsmaxx-job-templates-aside.json')
    expect(setAsideJobTemplates(deps)).toEqual({ ok: true, path: aside })
    // The original, bad row and all, is in the aside copy...
    expect(readFileSync(aside, 'utf8')).toBe(before)
    // ...and the good one survives in a file that can be written again.
    const fresh = listJobTemplates(deps)
    expect(fresh).toMatchObject({ problem: null, templates: [{ id: 'tpl-1', name: base.name }] })
    expect(saveJobTemplate(deps, { ...base, id: 'tpl-2' }).ok).toBe(true)
  })

  it('sets a problem file aside, never deletes it, and never overwrites an earlier one', () => {
    expect(setAsideJobTemplates(deps).ok).toBe(false)
    writeFileSync(file(), '{ not json', { mode: 0o600 })
    const aside = join(dir, 'opsmaxx-job-templates-aside.json')
    expect(setAsideJobTemplates(deps)).toEqual({ ok: true, path: aside })
    expect(readFileSync(aside, 'utf8')).toBe('{ not json')
    expect(saveJobTemplate(deps, base).ok).toBe(true)

    writeFileSync(file(), '{ also broken', { mode: 0o600 })
    expect(setAsideJobTemplates(deps).ok).toBe(false)
    expect(readFileSync(aside, 'utf8')).toBe('{ not json')
    expect(readFileSync(file(), 'utf8')).toBe('{ also broken')
  })
})

// ---------------------------------------------------------------------------
// The MCP bridge has no template access
// ---------------------------------------------------------------------------
//
// tests/jobsNotExposed.test.ts already keeps jobTemplates.ts and jobCompose.ts
// out of the bridge's import closure. This is the runtime half: no tool whose
// name, description or input schema speaks of a template, and no literal path
// to the file or the IPC channel in the bridge's source. The import scan in
// tests/jobsNotExposed.test.ts is the guard that cannot be renamed around.

const PORT = 18771
// Names are held to the broad word; descriptions to the specific concepts, so an
// unrelated "template" (trivy's `--format template`, say) cannot turn this red.
const TEMPLATE_NAME = /template|snippet|preset|saved.?command|job.?steps?/i
const TEMPLATE_CONCEPT = /job.?templates?|saved.?(job.?)?templates?|opsmaxx-job-templates|jobTemplates|saved.?commands?/i

describe('the MCP bridge exposes no job template', () => {
  let token: string

  beforeAll(async () => {
    resetMcpAuthForTests()
    resetPolicyCacheForTests()
    refreshMcpDataCache({ workspaces: [{ id: 'ws', name: 'W' }], servers: [] })
    // The most permissive built-in group, so a tool gated off for read-only
    // sessions cannot hide from this listing.
    setAssignment({ level: 'workspace', workspaceId: 'ws' }, 'grp-full')
    setMcpConfig({ enabled: true, port: PORT, approvalTimeoutSeconds: 5 })
    token = createSession({
      agentName: 'TemplateGuard',
      workspaces: [{ id: 'ws', name: 'W' }],
      groupId: 'grp-full',
      groupName: 'Full Access',
      ttlMinutes: 60
    }).token
    const started = await startMcpServer()
    expect(started.ok, `MCP server did not start: ${started.error ?? ''}`).toBe(true)
  })

  afterAll(async () => {
    await stopMcpServer()
  })

  it('serves no tool that reads or writes templates', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
    const client = new Client({ name: 'template-guard', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.length, 'the bridge served no tools — this proves nothing').toBeGreaterThan(0)
      const hits = tools.filter(
        (t) =>
          TEMPLATE_NAME.test(t.name) ||
          TEMPLATE_CONCEPT.test(t.description ?? '') ||
          TEMPLATE_CONCEPT.test(JSON.stringify(t.inputSchema ?? {}))
      )
      expect(hits.map((t) => t.name)).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('recognises the concepts it is looking for, and not an unrelated template', () => {
    for (const d of ['List saved templates', 'Run a job template', 'reads opsmaxx-job-templates.json']) {
      expect(TEMPLATE_CONCEPT.test(d), d).toBe(true)
    }
    expect(TEMPLATE_CONCEPT.test('trivy is read with --format template')).toBe(false)
  })

  it('does not name the file, the channel or the service in its source', () => {
    const cli = readdirSync(resolve(__dirname, '..', 'src/cli')).map((f) => `src/cli/${f}`)
    for (const file of ['src/main/services/mcpServer.ts', ...cli]) {
      const src = readFileSync(resolve(__dirname, '..', file), 'utf8')
      expect(src, file).not.toMatch(/job-templates|jobTemplates|opsmaxx-job-templates/)
    }
  })
})
