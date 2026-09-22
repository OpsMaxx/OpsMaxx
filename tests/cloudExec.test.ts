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
import {
  checkExecutable,
  detectProvider,
  resetCloudBinaryCache
} from '../src/main/services/cloud/binaries'
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
let realPath = ''

// The fake CLI is a /bin/sh shim, so this suite is POSIX-only. CI runs the
// full suite on ubuntu, and the Windows job runs a different, narrower set --
// but a contributor on Windows running `npm test` would otherwise meet a wall
// of failures about a shell that is not there, which says nothing useful about
// the code under test. Skipped loudly rather than silently.
const POSIX_ONLY = process.platform !== 'win32'
if (!POSIX_ONLY) {
  console.warn(
    'SKIPPING cloudExec tests on Windows: the CLI fixture is a /bin/sh shim. ' +
      'Detection and the argv guards are covered on POSIX in CI.'
  )
}

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
  if (!POSIX_ONLY) return
  // mkdtempSync needs the parent to exist.
  mkdirSync(TREE_ROOT, { recursive: true })
  dir = mkdtempSync(join(TREE_ROOT, 'bin-'))
  argvLog = join(dir, 'argv.log')
  installFake('gcloud', 'gcp')
  installFake('aws', 'aws')
  installFake('az', 'azure')
  realPath = process.env.PATH ?? ''
  process.env.OPSMAXX_CLOUD_BIN_DIR = dir
  process.env.FAKE_CLOUD_ARGV_LOG = argvLog
  process.env.FAKE_CLOUD_MODE = 'ok'
  delete process.env.FAKE_CLOUD_STDOUT
  resetCloudBinaryCache()
})

afterEach(() => {
  if (!POSIX_ONLY) return
  // Restored, not left mutated: a test that rewrites PATH and walks away
  // changes the environment every later test in this worker runs in.
  process.env.PATH = realPath
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

describe.skipIf(!POSIX_ONLY)('detecting a provider CLI', () => {
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

  it(
    'reports a missing tool as absent rather than throwing',
    async () => {
      process.env.OPSMAXX_CLOUD_BIN_DIR = join(dir, 'nowhere')
      resetCloudBinaryCache()
      // PATH may legitimately contain a real gcloud on a developer machine, so
      // this asserts only that the call is total - never that nothing is found.
      const got = await detectProvider('gcp')
      expect(typeof got.installed).toBe('boolean')
      if (!got.installed) expect(got.error).toBeTruthy()
    },
    // A minute, because on a machine that HAS the tool this shells out to it.
    //
    // The override above says where to look first, not where to look only, and
    // the fixed list it falls through to includes /usr/lib/google-cloud-sdk and
    // /snap/bin -- which is exactly where a CI runner has the Google Cloud SDK.
    // So there the call finds the real gcloud and runs `gcloud --version`, and
    // a cold start of that under load went past the default 15s and failed the
    // build. Locally, with no gcloud on PATH, the same test finishes in about a
    // second. Tolerating a real tool is this test's stated intent, so it has to
    // tolerate the time one takes.
    60_000
  )

  // The rules below are asserted against checkExecutable directly rather than
  // through detectProvider. Planting a bad candidate and asserting "nothing was
  // found" only holds on a machine with no real CLI installed: it passed on a
  // laptop without gcloud and failed on a CI runner that ships the Google Cloud
  // SDK, because detection correctly rejected the fixture and then correctly
  // found the real one. The rule is what this file is about; what else happens
  // to be on the machine is not.
  it('accepts an ordinary executable', async () => {
    expect(await checkExecutable(join(dir, 'gcloud'))).toBe(null)
  })

  it('refuses a binary that is not executable', async () => {
    chmodSync(join(dir, 'gcloud'), 0o644)
    expect(await checkExecutable(join(dir, 'gcloud'))).toMatch(/not executable/)
  })

  it('refuses a binary under a world-writable directory', async () => {
    // Anyone who can write the directory can replace what is in it, which is
    // the substitution attack the check exists for.
    chmodSync(dir, 0o777)
    try {
      expect(await checkExecutable(join(dir, 'gcloud'))).toMatch(/world-writable/)
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('refuses a relative path and one that is not there', async () => {
    expect(await checkExecutable('gcloud')).toMatch(/relative path/)
    expect(await checkExecutable(join(dir, 'nope'))).toMatch(/does not exist/)
  })
})

describe.skipIf(!POSIX_ONLY)('running a provider command', () => {
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

  // The absent-CLI case lives in cloudExecMissingCli.test.ts, where detection
  // is stubbed: it cannot be asserted here without assuming the machine has no
  // gcloud, which CI runners do have.
})
