import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunDir, createStateDir, sweepRunDirs, vpnRunRoot, vpnStateRoot } from '../src/main/services/vpn/runDir'

/**
 * What survives a restart, and what must not.
 *
 * A Tailscale node's directory holds its private key, and that key is the
 * whole of what makes it the SAME device on the tailnet next time. It was kept
 * at `join(runDir, '..')` — a sibling of the run directories, which puts it
 * inside the run root — and the run root is emptied at startup by
 * `sweepRunDirs([])` with an empty keep list, on every launch.
 *
 * So the identity was destroyed every time the app started: the node
 * registered afresh, the admin console filled with `opsmaxx`, `opsmaxx-1`,
 * and the authorisation had to be done again after every restart.
 *
 * The two roots look alike and are opposites. These tests are the difference.
 */

describe('the two roots', () => {
  it('are not the same directory, and neither contains the other', () => {
    const run = vpnRunRoot()
    const state = vpnStateRoot()
    expect(run).not.toBe(state)
    expect(state.startsWith(run + '/')).toBe(false)
    expect(run.startsWith(state + '/')).toBe(false)
  })
})

describe('the startup sweep', () => {
  it('empties the run root wholesale, which is what it is for', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opsmaxx-run-'))
    try {
      await createRunDir('run-1', root)
      // And a stray sibling, which is exactly the shape the node identity had.
      mkdirSync(join(root, 'tailscale-abc'), { recursive: true })
      writeFileSync(join(root, 'tailscale-abc', 'tailscaled.state'), 'the node key')

      await sweepRunDirs([], root)

      expect(existsSync(join(root, 'run-1'))).toBe(false)
      // The point of the whole change: anything left here goes, so identity
      // cannot live here.
      expect(existsSync(join(root, 'tailscale-abc'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('does not reach into the durable root', async () => {
    const run = mkdtempSync(join(tmpdir(), 'opsmaxx-run-'))
    const state = mkdtempSync(join(tmpdir(), 'opsmaxx-state-'))
    try {
      const dir = await createStateDir('tailscale-abc', state)
      writeFileSync(join(dir, 'tailscaled.state'), 'the node key')
      await createRunDir('run-1', run)

      await sweepRunDirs([], run)

      // The run directory is gone and the identity is not.
      expect(existsSync(join(run, 'run-1'))).toBe(false)
      expect(existsSync(join(dir, 'tailscaled.state'))).toBe(true)
    } finally {
      rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      rmSync(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})

describe('a durable directory', () => {
  it('is reused rather than replaced, so the key is still there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opsmaxx-state-'))
    try {
      const first = await createStateDir('tailscale-abc', root)
      writeFileSync(join(first, 'tailscaled.state'), 'the node key')
      const second = await createStateDir('tailscale-abc', root)
      expect(second).toBe(first)
      expect(existsSync(join(second, 'tailscaled.state'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('refuses a profile id that would escape the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opsmaxx-state-'))
    try {
      await expect(createStateDir('..', root)).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
