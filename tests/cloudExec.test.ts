import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CloudError, type CloudProvider } from '../src/shared/cloud'
import { detectProvider, resetCloudBinaryCache } from '../src/main/services/cloud/binaries'
import { cloudExec, cloudExecOrThrow } from '../src/main/services/cloud/cloudExec'

const FAKE = fileURLToPath(new URL('./fixtures/fake-cloud-cli.mjs', import.meta.url))

// The fixture tree lives inside the checkout rather than in the system temp
// directory. Detection refuses any binary under a world-writable ancestor -
// that is the whole substitution defence - and /tmp is 1777 on Linux, so a
// mkdtemp there would be correctly rejected and the suite would fail for a
// reason that has nothing to do with what it is testing.
const TREE_ROOT = fileURLToPath(new URL('./.tmp-cloudexec', import.meta.url))

let dir = ''
let argvLog = ''

function installFake(name: string, kind: string): void {
  const shim = join(dir, name)
  // A shim rather than a copy, so the fixture stays the single source of truth.
  writeFileSync(
    shim,
    `#!/bin/sh\nFAKE_CLOUD_KIND=${kind} exec "${process.execPath}" "${FAKE}" "$@"\n`
  )
  chmodSync(shim, 0o755)
}

beforeEach(() => {
  // mkdtempSync needs the parent to exist.
  mkdirSync(TREE_ROOT, { recursive: true })
  dir = mkdtempSync(join(TREE_ROOT, 'bin-'))
  argvLog = join(dir, 'argv.log')
  installFake('gcloud', 'gcp')
  installFake('aws', 'aws')
  installFake('az', 'azure')
  process.env.OPSMAXX_CLOUD_BIN_DIR = dir
  process.env.FAKE_CLOUD_ARGV_LOG = argvLog
  process.env.FAKE_CLOUD_MODE = 'ok'
  delete process.env.FAKE_CLOUD_STDOUT
  resetCloudBinaryCache()
})

afterEach(() => {
  delete process.env.OPSMAXX_CLOUD_BIN_DIR
  delete process.env.FAKE_CLOUD_ARGV_LOG
  delete process.env.FAKE_CLOUD_MODE
  delete process.env.FAKE_CLOUD_STDOUT
  resetCloudBinaryCache()
  rmSync(TREE_ROOT, { recursive: true, force: true })
})

const loggedArgv = (): string[][] =>
  existsSync(argvLog)
    ? readFileSync(argvLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : []

describe('detecting a provider CLI', () => {
  it('finds each tool and reports its path and version', async () => {
    const expected: [CloudProvider, string][] = [
      ['gcp', '458.0.1'],
      ['aws', '2.15.30'],
      ['azure', '2.57.0']
    ]
    for (const [provider, version] of expected) {
      const got = await detectProvider(provider)
      expect(got.installed, provider).toBe(true)
      expect(got.supported, provider).toBe(true)
      // The exact path is shown to the user, so it has to be the real one.
      expect(got.executablePath, provider).toBe(join(dir, provider === 'gcp' ? 'gcloud' : provider === 'aws' ? 'aws' : 'az'))
      expect(got.version, provider).toBe(version)
    }
  })

  it('reports a missing tool as absent rather than throwing', async () => {
    process.env.OPSMAXX_CLOUD_BIN_DIR = join(dir, 'nowhere')
    resetCloudBinaryCache()
    // PATH may legitimately contain a real gcloud on a developer machine, so
    // this asserts only that the call is total - never that nothing is found.
    const got = await detectProvider('gcp')
    expect(typeof got.installed).toBe('boolean')
    if (!got.installed) expect(got.error).toBeTruthy()
  })

  it('refuses a binary that is not executable', async () => {
    chmodSync(join(dir, 'gcloud'), 0o644)
    resetCloudBinaryCache()
    process.env.PATH = dir
    const got = await detectProvider('gcp')
    expect(got.installed).toBe(false)
    expect(got.error).toMatch(/not executable/)
  })

  it('refuses a binary under a world-writable directory', async () => {
    // Anyone who can write the directory can replace what is in it, which is
    // the substitution attack the check exists for.
    if (process.platform === 'win32') return
    chmodSync(dir, 0o777)
    resetCloudBinaryCache()
    process.env.PATH = dir
    const got = await detectProvider('gcp')
    expect(got.installed).toBe(false)
    expect(got.error).toMatch(/world-writable/)
    chmodSync(dir, 0o755)
  })
})

describe('running a provider command', () => {
  it('passes the argument array through untouched', async () => {
    // The point of argv arrays: a value that would be syntax in a shell arrives
    // at the far side as one ordinary argument.
    const hostile = 'a b;c&d|e$(f)'
    process.env.FAKE_CLOUD_STDOUT = 'done'
    const res = await cloudExec('gcp', ['compute', 'instances', 'list', hostile])
    expect(res.ok).toBe(true)
    expect(res.stdout).toBe('done')
    // The last entry: detection probes `--version` through the same shim first.
    const calls = loggedArgv()
    expect(calls[calls.length - 1]).toEqual(['compute', 'instances', 'list', hostile])
  })

  it('reports a non-zero exit as a result, not an exception', async () => {
    process.env.FAKE_CLOUD_MODE = 'denied'
    const res = await cloudExec('gcp', ['compute', 'instances', 'list'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(1)
    expect(res.stderr).toMatch(/PERMISSION_DENIED/)
  })

  it('throws a classified fault when the caller demanded success', async () => {
    const cases: [string, string][] = [
      ['expired', 'auth-expired'],
      ['denied', 'iam-permission-denied'],
      ['notfound', 'resource-not-found']
    ]
    for (const [mode, fault] of cases) {
      process.env.FAKE_CLOUD_MODE = mode
      try {
        await cloudExecOrThrow('gcp', ['compute', 'instances', 'list'])
        throw new Error(`expected ${mode} to throw`)
      } catch (e) {
        expect(e, mode).toBeInstanceOf(CloudError)
        expect((e as CloudError).fault, mode).toBe(fault)
      }
    }
  })

  it('redacts a secret out of the failure detail before anyone can log it', async () => {
    process.env.FAKE_CLOUD_MODE = 'secret'
    try {
      await cloudExecOrThrow('gcp', ['compute', 'instances', 'list'])
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CloudError)
      const detail = (e as CloudError).detail ?? ''
      expect(detail, 'the bearer token survived into the error detail').not.toMatch(
        /SUPERSECRETTOKENVALUE/
      )
      expect(detail).toMatch(/REDACTED/)
    }
  })

  it('throws cli-not-installed rather than spawning nothing', async () => {
    process.env.OPSMAXX_CLOUD_BIN_DIR = join(dir, 'nowhere')
    process.env.PATH = join(dir, 'nowhere')
    resetCloudBinaryCache()
    try {
      await cloudExec('gcp', ['compute', 'instances', 'list'])
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CloudError)
      expect((e as CloudError).fault).toBe('cli-not-installed')
    }
  })
})
