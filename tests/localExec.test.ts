import { describe, it, expect } from 'vitest'
import { platform } from 'node:process'
import { localExec } from '../src/main/services/localExec'
import { LOCAL_TARGET, isLocalTarget, targetLabel } from '../src/shared/execTarget'

// The POSIX shell forms below are what the shared command builders emit. Windows
// takes a different shell and would need its own strings, so the behaviour is
// asserted where it is actually exercised rather than approximated everywhere.
const posix = platform !== 'win32'

describe.runIf(posix)('localExec', () => {
  it('returns stdout and a zero exit for a command that works', async () => {
    const r = await localExec('echo hello')
    expect(r.ok).toBe(true)
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.stderr).toBe('')
    expect(r.truncated).toBe(false)
    expect(r.elided).toBe(0)
  })

  // Three of the host-facts probes use exit status as their API, so a runner
  // that flattened failure into ok:false with no code would break them.
  it('keeps the exit code and stderr of a command that fails', async () => {
    const r = await localExec('echo problem >&2; exit 3')
    expect(r.ok).toBe(false)
    expect(r.code).toBe(3)
    expect(r.stderr.trim()).toBe('problem')
  })

  it('reports a missing binary as a failure rather than throwing', async () => {
    const r = await localExec('definitely-not-a-real-binary-xyz')
    expect(r.ok).toBe(false)
    expect(r.code).not.toBe(0)
  })

  it('kills a command that outlives its timeout', async () => {
    const started = Date.now()
    const r = await localExec('sleep 30', 400)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Timed out/)
    // Killed, not waited out.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  // The cap is why a `docker logs` on a chatty container cannot exhaust main's
  // heap. `elided` has to carry the number, not just the flag.
  it('caps output and counts what it dropped', async () => {
    const r = await localExec('head -c 400000 /dev/zero | tr "\\0" "a"')
    expect(r.ok).toBe(true)
    expect(r.stdout.length).toBe(200_000)
    expect(r.truncated).toBe(true)
    expect(r.elided).toBeGreaterThan(0)
  })

  it('runs through a shell, so pipes and redirection work', async () => {
    const r = await localExec('printf "b\\na\\n" | sort | tr -d "\\n"')
    expect(r.stdout).toBe('ab')
  })

  // The login shell is what puts Homebrew, asdf and Docker Desktop on PATH.
  // Electron's own PATH frequently has none of them.
  it('applies the login shell PATH', async () => {
    const r = await localExec('echo $PATH')
    expect(r.ok).toBe(true)
    expect(r.stdout.trim().length).toBeGreaterThan(0)
  })

  /**
   * The commands come from the shared builders, which target the POSIX shell
   * `ssh host 'command'` lands in. Running them under the user's own shell is
   * not equivalent: zsh sets `nomatch`, so an unquoted glob that sh passes
   * through as a literal makes zsh abort the whole command.
   *
   * This is not hypothetical. The Kubernetes reader asks for
   * `custom-columns=…containerStatuses[*].ready…`; under zsh that failed with
   * "no matches found" while the identical string works on every server in the
   * estate — a local target that looked like an unreachable cluster.
   */
  it('passes an unmatched glob through, as a POSIX shell does', async () => {
    const r = await localExec('echo custom-columns=READY:.status.containerStatuses[*].ready')
    expect(r.ok).toBe(true)
    expect(r.stdout.trim()).toBe('custom-columns=READY:.status.containerStatuses[*].ready')
    expect(r.stderr).not.toMatch(/no matches found/i)
  })
})

describe('the local target marker', () => {
  it('recognises the marker and nothing else', () => {
    expect(isLocalTarget(LOCAL_TARGET)).toBe(true)
    expect(isLocalTarget({ local: true })).toBe(true)
    // The difference decides whether a command runs here or on production, so
    // anything short of an exact `true` is a server config.
    expect(isLocalTarget({ local: 'yes' })).toBe(false)
    expect(isLocalTarget({ local: 1 })).toBe(false)
    expect(isLocalTarget({ host: 'example.com', local: false })).toBe(false)
    expect(isLocalTarget({ host: 'example.com' })).toBe(false)
    expect(isLocalTarget(null)).toBe(false)
    expect(isLocalTarget(undefined)).toBe(false)
    expect(isLocalTarget('local')).toBe(false)
  })

  it('names the target for a person', () => {
    expect(targetLabel(LOCAL_TARGET, undefined)).toBe('this machine')
    expect(targetLabel({ host: 'h' }, 'web-01')).toBe('web-01')
    expect(targetLabel({ host: 'h' }, undefined)).toBe('the server')
  })
})
