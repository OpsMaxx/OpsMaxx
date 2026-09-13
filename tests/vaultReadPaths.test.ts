import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which modules may call `vaultList()`.
 *
 * The vault has two read paths and the difference between them is a security
 * property, not a style preference:
 *
 *   vaultList()               the IPC read. Resets the human-idle timer and
 *                             refuses unless the vault is fully open.
 *   vaultEntriesForResolve()  the background read. Touches no timer and works
 *                             while the vault is secured.
 *
 * They used to be one function, and that is the whole bug this change exists
 * to fix. A monitoring sweep resolving a credential every couple of minutes
 * postponed the idle timer for as long as the app ran, so on an estate that
 * sampled, the vault never secured itself and the protection was not real; on
 * one that did not — pooled SSH connections get reused without re-resolving —
 * the timer fired and every background consumer stopped at once.
 *
 * A type cannot say "IPC handlers only", so this says it instead. If you are
 * here because this test went red: you are probably writing something
 * unattended, and `vaultEntriesForResolve()` is the function you want. If you
 * really are on a path where a person pressed something — a vault WRITE, or
 * the handler behind `vault:list` — add the file below and say why.
 */
const ALLOWED = new Map<string, string>([
  ['src/main/services/vault.ts', 'defines both paths, and is the only file that may'],
  ['src/main/index.ts', 'the vault:list IPC handler, which is the human read by definition'],
  [
    'src/main/services/cicd/wiring.ts',
    'creates and deletes a vault entry from the connect modal — a write, so it needs the vault open'
  ],
  [
    'src/main/services/vpn/vaultBridge.ts',
    'stages and deletes VPN secrets during a profile import — a write, from a person'
  ]
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('the two vault read paths', () => {
  it('keeps vaultList() out of unattended code', () => {
    const offenders: string[] = []
    for (const file of sourceFiles('src/main')) {
      const rel = file.replaceAll('\\', '/')
      if (ALLOWED.has(rel)) continue
      if (/\bvaultList\s*\(/.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
    expect(offenders, 'use vaultEntriesForResolve() for unattended reads').toEqual([])
  })

  it('names a real reason for every file that is allowed to', () => {
    // A guard whose allow-list can grow silently is not a guard. Every entry
    // has to carry the argument for why that file is a human path.
    for (const [file, why] of ALLOWED) expect(why.length, file).toBeGreaterThan(20)
  })
})
