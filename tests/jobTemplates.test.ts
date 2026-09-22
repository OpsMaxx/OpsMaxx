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

  it('pastes the commands and not the notes', () => {
    expect(templateTerminalText(sanitiseJobTemplate(base)!)).toBe('nginx -t\nsystemctl reload nginx')
  })
})

describe('the templates file', () => {
  let dir: string
  let deps: JobTemplateDeps
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jobtpl-'))
    deps = { dir, now: () => 1234 }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('saves, lists, renames and deletes', () => {
    expect(listJobTemplates(deps)).toEqual([])
    const saved = saveJobTemplate(deps, base)
    expect(saved).toMatchObject({ ...base, updatedAt: 1234 })
    expect(listJobTemplates(deps)).toEqual([saved])

    const renamed = saveJobTemplate(deps, { ...saved, name: 'Reload nginx' })
    expect(listJobTemplates(deps)).toEqual([renamed])
    expect(renamed?.name).toBe('Reload nginx')

    expect(removeJobTemplate(deps, 'tpl-1')).toBe(true)
    expect(listJobTemplates(deps)).toEqual([])
    expect(removeJobTemplate(deps, 'tpl-1')).toBe(false)
  })

  it('never writes targets to disk, even when handed them', () => {
    saveJobTemplate(deps, { ...base, targets: [{ serverId: 's1' }], approval: { phrase: 'RUN' } })
    const raw = readFileSync(join(dir, 'opsmaxx-job-templates.json'), 'utf8')
    expect(raw).not.toMatch(/targets|approval|serverId/)
  })

  it('does not overwrite a file it cannot read', () => {
    const path = join(dir, 'opsmaxx-job-templates.json')
    writeFileSync(path, '{ not json', { mode: 0o600 })
    expect(listJobTemplates(deps)).toBeNull()
    expect(saveJobTemplate(deps, base)).toBeNull()
    expect(removeJobTemplate(deps, 'tpl-1')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })
})

// ---------------------------------------------------------------------------
// The MCP bridge has no template access
// ---------------------------------------------------------------------------
//
// tests/jobsNotExposed.test.ts already keeps jobTemplates.ts and jobCompose.ts
// out of the bridge's import closure. This is the runtime half: no tool whose
// name or input schema speaks of a template, and no literal path
// to the file or the IPC channel in the bridge's source.

const PORT = 18771
const TEMPLATE = /template|snippet|saved.?command/i

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
        (t) => TEMPLATE.test(t.name) || TEMPLATE.test(JSON.stringify(t.inputSchema ?? {}))
      )
      expect(hits.map((t) => t.name)).toEqual([])
    } finally {
      await client.close()
    }
  })

  it('does not name the file, the channel or the service in its source', () => {
    const cli = readdirSync(resolve(__dirname, '..', 'src/cli')).map((f) => `src/cli/${f}`)
    for (const file of ['src/main/services/mcpServer.ts', ...cli]) {
      const src = readFileSync(resolve(__dirname, '..', file), 'utf8')
      expect(src, file).not.toMatch(/job-templates|jobTemplates|opsmaxx-job-templates/)
    }
  })
})
