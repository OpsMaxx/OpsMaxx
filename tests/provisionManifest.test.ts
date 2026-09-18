import { describe, it, expect } from 'vitest'
import {
  IMPLEMENTED_SECTIONS,
  PROVISION_MANIFEST_VERSION,
  planProvision
} from '../src/shared/provision'

/**
 * Reading a provisioning manifest.
 *
 * The format is designed in full and implemented in part, so most of what
 * matters here is what it does about the parts it cannot do -- and about the
 * one field that is a delivery mechanism if it is got wrong.
 */

const valid = {
  version: PROVISION_MANIFEST_VERSION,
  description: 'A laptop for the on-call rotation',
  opsmaxx: { bundle: { kind: 'file' as const, path: '/tmp/backup.spbackup' } }
}

describe('what it will do', () => {
  it('plans a restore', () => {
    const plan = planProvision(valid)
    expect(plan.problems).toEqual([])
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].kind).toBe('restore')
    // Says which way round the merge goes, in the summary, because "restore"
    // alone does not tell somebody whether their current data survives.
    expect(plan.steps[0].summary).toContain('replacing')
  })

  it('says when a restore would keep what is already there', () => {
    const plan = planProvision({ ...valid, opsmaxx: { ...valid.opsmaxx, merge: true } })
    expect(plan.steps[0].summary).toContain('keeping')
  })
})

describe('the hook', () => {
  const withHook = {
    ...valid,
    postRestore: {
      interpreter: 'bash' as const,
      script: 'echo hello\nrm -rf /tmp/something',
      describes: 'sets up the work directory'
    }
  }

  it('shows the script in full, exactly as it will run', () => {
    // A summary here would be a summary somebody approves INSTEAD of the
    // script, which is the whole failure this format is shaped to prevent: a
    // manifest arrives by email, and a hook that runs on anything less than a
    // read-it-yourself confirmation is a delivery mechanism.
    const plan = planProvision(withHook)
    const hook = plan.steps.find((s) => s.kind === 'hook')
    expect(hook?.detail).toBe('echo hello\nrm -rf /tmp/something')
  })

  it('carries the author’s description without believing it', () => {
    const plan = planProvision(withHook)
    const hook = plan.steps.find((s) => s.kind === 'hook')
    // Both are shown: what the author says it does, next to what it does.
    expect(hook?.summary).toContain('sets up the work directory')
    expect(hook?.detail).toContain('rm -rf')
  })

  it('says so when a hook describes itself as nothing', () => {
    const plan = planProvision({ ...withHook, postRestore: { interpreter: 'sh', script: 'true' } })
    expect(plan.steps.find((s) => s.kind === 'hook')?.summary).toContain('does not describe')
  })

  it('refuses an interpreter it does not know', () => {
    // NOT "run it with the default shell", and not a shebang. An interpreter
    // this build does not know is a script it cannot honestly describe before
    // running.
    const plan = planProvision({
      ...valid,
      postRestore: { interpreter: 'python', script: 'import os' }
    })
    expect(plan.problems.join(' ')).toContain('not one of bash, sh, pwsh or powershell')
    expect(plan.steps.find((s) => s.kind === 'hook')).toBeUndefined()
  })

  it('refuses an empty hook', () => {
    const plan = planProvision({ ...valid, postRestore: { interpreter: 'bash', script: '   ' } })
    expect(plan.problems.join(' ')).toContain('no script')
  })
})

describe('the parts this build cannot do', () => {
  it('names them rather than skipping them', () => {
    // An unimplemented section silently skipped is a machine somebody believes
    // is provisioned.
    const plan = planProvision({
      ...valid,
      packages: { manager: 'brew', install: ['ripgrep'] },
      runtimes: { versions: { node: '24' } },
      dotfiles: { repository: 'git@example:dotfiles' }
    })
    expect(plan.unsupported.map((u) => u.section).sort()).toEqual(['dotfiles', 'packages', 'runtimes'])
    for (const u of plan.unsupported) {
      // Each says why, not just that. "Unsupported" alone reads like a bug.
      expect(u.reason.length).toBeGreaterThan(20)
    }
    // And the restore still happens: a manifest asking for more than this
    // build can do is not a manifest it should refuse outright.
    expect(plan.steps).toHaveLength(1)
  })

  it('names a section it has never heard of', () => {
    const plan = planProvision({ ...valid, somethingNew: {} })
    expect(plan.unsupported[0].section).toBe('somethingNew')
  })

  it('only claims the two it really implements', () => {
    expect([...IMPLEMENTED_SECTIONS]).toEqual(['opsmaxx', 'postRestore'])
  })
})

describe('versions', () => {
  it('refuses a manifest from the future rather than guessing', () => {
    // A newer manifest may mean something different by a field this build
    // thinks it understands, and a machine somebody is setting up is the worst
    // place to guess.
    const plan = planProvision({ ...valid, version: PROVISION_MANIFEST_VERSION + 1 })
    expect(plan.problems.join(' ')).toContain('Upgrade OpsMaxx')
    expect(plan.steps).toEqual([])
  })

  it('refuses one with no version at all', () => {
    const { version: _drop, ...noVersion } = valid
    expect(planProvision(noVersion).problems.join(' ')).toContain('which version')
  })

  it('refuses something that is not a manifest', () => {
    for (const junk of [null, 'a string', 42, []]) {
      expect(planProvision(junk).problems.length).toBeGreaterThan(0)
    }
  })
})

describe('a manifest that asks for nothing', () => {
  it('says so rather than reporting success', () => {
    const plan = planProvision({ version: PROVISION_MANIFEST_VERSION })
    expect(plan.problems.join(' ')).toContain('nothing this build can do')
  })
})

/**
 * Applying one.
 *
 * The restore is mocked out; what these check is the ordering and the
 * refusals, which is where the damage lives.
 */
describe('applying', () => {
  it('will not run the hook without approval', async () => {
    const { apply } = await import('../src/main/services/provision')
    const result = await apply({
      manifest: {
        version: PROVISION_MANIFEST_VERSION,
        postRestore: { interpreter: 'sh', script: 'echo should-not-run' }
      },
      passphrase: '',
      hookApproved: false
    })
    // A manifest arrives by email. A hook that runs on anything less than a
    // read-it-yourself confirmation is a delivery mechanism, not a feature.
    expect(result.ok).toBe(false)
    expect(result.failed).toContain('not approved')
  })

  it('runs an approved hook and hands back what it said', async () => {
    const { apply } = await import('../src/main/services/provision')
    const result = await apply({
      manifest: {
        version: PROVISION_MANIFEST_VERSION,
        postRestore: { interpreter: 'sh', script: 'echo provisioned-ok' }
      },
      passphrase: '',
      hookApproved: true
    })
    expect(result.ok).toBe(true)
    // An operator whose setup failed needs what the script said, not "the hook
    // failed".
    expect(result.hookOutput).toContain('provisioned-ok')
  })

  it('reports a failing hook with its output', async () => {
    const { apply } = await import('../src/main/services/provision')
    const result = await apply({
      manifest: {
        version: PROVISION_MANIFEST_VERSION,
        postRestore: { interpreter: 'sh', script: 'echo about-to-fail >&2; exit 3' }
      },
      passphrase: '',
      hookApproved: true
    })
    expect(result.ok).toBe(false)
    expect(result.hookOutput).toContain('about-to-fail')
  })

  it('does not inherit the app’s environment', async () => {
    const { apply } = await import('../src/main/services/provision')
    process.env.OPSMAXX_PROVISION_PROBE = 'must-not-leak'
    try {
      const result = await apply({
        manifest: {
          version: PROVISION_MANIFEST_VERSION,
          postRestore: {
            interpreter: 'sh',
            script: 'echo "probe=[${OPSMAXX_PROVISION_PROBE:-}]"'
          }
        },
        passphrase: '',
        hookApproved: true
      })
      // The app's environment carries whatever OpsMaxx was launched with,
      // which on a desktop includes session secrets on some platforms. A
      // provisioning hook has no business inheriting them.
      expect(result.hookOutput).toContain('probe=[]')
    } finally {
      delete process.env.OPSMAXX_PROVISION_PROBE
    }
  })

  it('refuses a manifest whose problems it already found', async () => {
    const { apply } = await import('../src/main/services/provision')
    const result = await apply({
      manifest: { version: PROVISION_MANIFEST_VERSION + 1 } as never,
      passphrase: '',
      hookApproved: true
    })
    expect(result.ok).toBe(false)
    expect(result.done).toEqual([])
  })
})
