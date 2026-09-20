import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { atomicWriteFileSync } from './atomicWrite'

// Non-secret application data (workspaces, folders, servers, vpns, tunnels).
// Secrets live separately in secrets.ts. This is a plain JSON snapshot the
// renderer owns; main only reads and writes the blob.
const FILE = join(app.getPath('userData'), 'opsmaxx-data.json')
const BAK = `${FILE}.bak`

/**
 * Whether the blob exists at all, as distinct from whether it can be read.
 *
 * `loadData` returns null for both, which is right for the renderer — it
 * starts clean either way — and wrong for anything that would WRITE based on
 * the answer. Sync did: a corrupt file read as "this machine has nothing", so
 * every collection was adopted from the relay and the file was rebuilt from an
 * empty object, destroying `settings`, `tabs` and every other key that has no
 * relay copy.
 */
export function dataFileExists(): boolean {
  // The PRIMARY only. `loadData` falls back to the backup when the primary
  // fails to parse, so a null answer with the primary present means both were
  // unreadable — which is the state worth refusing to write over. Counting a
  // leftover backup here would make a machine that has simply never saved
  // look corrupt, and that machine is the ordinary fresh install.
  return existsSync(FILE)
}

export function loadData(): unknown | null {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8'))
  } catch (err) {
    console.error('[store] primary data file unreadable, trying backup:', err)
    // A corrupt primary is exactly what the backup copy exists for. Losing
    // every server because of one bad write is not acceptable.
    try {
      if (existsSync(BAK)) return JSON.parse(readFileSync(BAK, 'utf8'))
    } catch (bakErr) {
      console.error('[store] backup unreadable too:', bakErr)
    }
  }
  return null
}

// Written temp-then-rename, like the vault and the workspace locks. Writing
// straight over the live file meant a crash, a power loss or a full disk mid
// write could truncate it — losing every server, database and folder.
export function saveData(data: unknown): void {
  try {
    const json = JSON.stringify(data)
    // Never leave the previous good copy behind on a partial write.
    if (existsSync(FILE)) {
      try {
        copyFileSync(FILE, BAK)
      } catch {
        /* a missing backup must not stop the save */
      }
    }
    atomicWriteFileSync(FILE, json)
  } catch (err) {
    console.error('[store] save failed:', err)
  }
}
