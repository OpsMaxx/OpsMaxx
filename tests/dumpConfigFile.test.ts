import { describe, it, expect } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { spawnDump } from '../src/main/services/backup'

// The credential-on-disk half of the mongodump support.
//
// `mongodump` has no password environment variable, so its password goes in a
// config file it is pointed at. That file is the risky part of the feature and
// the pure `dumpCommand` tests cannot see it at all, so this drives the REAL
// spawner against a real process.
//
// The stand-in binary is `sh`. With a config file the runner appends
// `--config <path>`, so inside `sh -c <script> sh ...` the path lands in `$2`
// and the script can print it — which is how a test gets to see a file that is
// deleted a moment later.

const runWithConfig = async (
  script: string,
  contents = 'password: hunter2\n'
): Promise<{ stdout: string; code: number | null }> => {
  const d = await spawnDump({
    binary: 'sh',
    args: ['-c', script, 'sh'],
    env: {},
    configFile: { contents }
  })
  return { stdout: d.stdout.toString('utf8'), code: d.code }
}

describe('the config file mongodump is pointed at', () => {
  it('is written, and carries exactly what was asked for', async () => {
    const r = await runWithConfig('cat "$2"')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('password: hunter2\n')
  })

  // Appended by the runner, not by `dumpCommand`, so the path is never in the
  // pure command object and never anywhere it could be logged.
  it('is passed as --config, after the caller’s own arguments', async () => {
    const r = await runWithConfig('echo "$1"')
    expect(r.stdout.trim()).toBe('--config')
  })

  // A file holding a password must not be readable by other users on the
  // machine. That is the whole reason this is better than `--password` on an
  // argv, and it is worth asserting rather than trusting.
  it('is created 0600, readable by nobody else', async () => {
    const r = await runWithConfig('echo "$2"')
    const path = r.stdout.trim()
    expect(path).not.toBe('')
    // The process has exited, so the file is gone — but its mode was checked
    // by the script below while it still existed.
    // GNU FIRST, and the order is the fix rather than a preference. The BSD
    // spelling was first and the `||` never fired on Linux: `stat -f` there is
    // not "a format string", it is FILESYSTEM STATUS, so it succeeds with exit
    // 0 and prints a block-size report that is not a mode. A fallback chain
    // only works when the first branch FAILS on the platform it is wrong for,
    // and this one did not. `stat -c` is rejected outright by BSD stat, so this
    // order does fail correctly on macOS and falls through.
    const modeRun = await runWithConfig('stat -c "%a" "$2" 2>/dev/null || stat -f "%OLp" "$2"')
    expect(modeRun.stdout.trim()).toBe('600')
    void path
  })

  // THE property. A password left behind on disk after a dump is a credential
  // nobody knows is there.
  it('is deleted once the process has started', async () => {
    const r = await runWithConfig('echo "$2"')
    const path = r.stdout.trim()
    expect(existsSync(path)).toBe(false)
    // Its private directory goes too, not just the file inside it.
    expect(existsSync(dirname(path))).toBe(false)
  })

  // The dump matters more than the tidy-up, but neither may be skipped: a
  // command that fails must still not leave the password behind.
  it('is deleted even when the command fails', async () => {
    const r = await runWithConfig('echo "$2"; exit 3')
    expect(r.code).toBe(3)
    expect(existsSync(r.stdout.trim())).toBe(false)
  })

  // A dump with no password needs no file, and creating an empty one would put
  // a pointless temp directory on disk for every Postgres and MySQL dump.
  it('is not created at all when there is no config to write', async () => {
    const d = await spawnDump({ binary: 'sh', args: ['-c', 'echo "[$1]"', 'sh'], env: {} })
    expect(d.stdout.toString('utf8').trim()).toBe('[]')
  })

  // Written into a private directory rather than beside other temp files, so
  // the name cannot be guessed and nothing else can be dropped in first.
  it('lives in a directory of its own', async () => {
    const r = await runWithConfig('echo "$2"')
    const path = r.stdout.trim()
    expect(dirname(path)).toMatch(/shellpilot-dump-/)
    expect(path.endsWith('/config.yaml')).toBe(true)
  })
})

describe('what the environment path still does', () => {
  // Postgres and MySQL keep their environment variables; the config file is
  // mongo's alternative to one, not a replacement for them.
  it('passes env through without a config file', async () => {
    const d = await spawnDump({
      binary: 'sh',
      args: ['-c', 'echo "$PGPASSWORD"', 'sh'],
      env: { PGPASSWORD: 'from-env' }
    })
    expect(d.stdout.toString('utf8').trim()).toBe('from-env')
    expect(statSync(process.cwd()).isDirectory()).toBe(true)
  })
})
