import { randomUUID } from 'node:crypto'

import type { OpenVpnSpec, VpnProfile, VpnSpec } from '../../../shared/vpn'
import { isVaultLockedError, resolveVpnSecrets } from '../credentialResolver'
import { VpnError, toVpnResult } from './errors'
import { parseOvpn } from './parsers/ovpn'
import { stageImportedSecrets } from './vaultBridge'
import {
  assertEditable,
  ovpnEditChange,
  redactInlineBlocks,
  restoreInlineBlocks,
  type InlineTag,
  type OvpnEditChange
} from './ovpnEdit'

// Editing a stored `.ovpn`, main-process half.
//
// TWO IPC CALLS AND A SESSION BETWEEN THEM, because the thing the renderer must
// never hold is the thing the edit is made of. `ovpnEdit.ts` swaps every inline
// block for a placeholder; the blocks themselves stay HERE, in a map keyed by
// the edit's own id, and are put back when the edit comes home.
//
// WHY THE OLD VAULT ENTRY IS NOT TOUCHED. Committing an edit stages a NEW entry
// and hands back a new spec, exactly as `vpnCommitImport` does. The renderer
// saves the profile against the new entry and THEN deletes the old one through
// the channel that already exists. That order is the whole decision:
//
//   * save-then-delete leaves an orphaned vault entry if anything fails in
//     between -- recoverable, invisible, and cleanable later;
//   * delete-then-save leaves a profile pointing at a vault entry that is gone,
//     which is a VPN that cannot connect and a config body nobody has.
//
// An abandoned edit therefore leaves an orphan. That is not a hazard this
// introduces: `vpnCommitImport` already stages before the renderer saves and
// has always had the same property. It is written down here rather than
// discovered.

interface EditSession {
  vaultEntryId: string
  blocks: { tag: InlineTag; body: string }[]
  /** What was handed out, so the change summary compares against what the
   *  operator actually saw rather than against the stored body. */
  redacted: string
  at: number
}

const sessions = new Map<string, EditSession>()

/** An edit older than this is not one somebody is still working on, and its
 *  blocks are key material sitting in memory. */
export const EDIT_SESSION_TTL_MS = 30 * 60_000

function sweep(now: number): void {
  for (const [id, s] of sessions) {
    if (now - s.at > EDIT_SESSION_TTL_MS) sessions.delete(id)
  }
}

/** Called when the vault locks. Key material does not outlive the unlock that
 *  made it readable. */
export function forgetVpnEdits(): void {
  sessions.clear()
}

export type VpnEditReadResult =
  | { ok: true; editId: string; text: string; blocks: InlineTag[] }
  | { ok: false; error: string; errorCode: string }

/**
 * Hand out the config with every inline block replaced.
 *
 * Takes a whole profile rather than a vault id: reading the body goes through
 * `resolveVpnSecrets`, which is the one place that knows how a ref maps to a
 * vault field, and a second reader here would be a second thing to keep in step.
 */
export async function vpnEditRead(profile: VpnProfile): Promise<VpnEditReadResult> {
  try {
    if (profile.spec.kind !== 'openvpn') {
      throw new VpnError('config-invalid', 'Only an OpenVPN profile has a configuration to edit.')
    }
    const secrets = await resolveVpnSecrets(profile)
    const body = secrets.configBody ?? ''
    assertEditable(body)
    const { text, blocks } = redactInlineBlocks(body)
    const editId = randomUUID()
    const now = Date.now()
    sweep(now)
    sessions.set(editId, {
      vaultEntryId: (profile.spec as OpenVpnSpec).configRef.vaultEntryId,
      blocks,
      redacted: text,
      at: now
    })
    return { ok: true, editId, text, blocks: blocks.map((b) => b.tag) }
  } catch (e) {
    if (isVaultLockedError(e)) {
      return {
        ok: false,
        error: 'Unlock the vault before editing a VPN profile — its configuration is stored there.',
        errorCode: 'vault-locked'
      }
    }
    const r = toVpnResult(e)
    return { ok: false, error: r.error ?? 'The configuration could not be read.', errorCode: r.errorCode ?? 'internal' }
  }
}

export type VpnEditCommitResult =
  | {
      ok: true
      spec: VpnSpec
      /** The entry the profile should now point at. */
      vaultEntryId: string
      /** The entry the caller should delete AFTER it has saved the profile.
       *  Never before: see the header. */
      replacedVaultEntryId: string
      change: OvpnEditChange
      /** Whatever the sanitiser dropped from the edited file, as at import. */
      stripped: unknown[]
      warnings: string[]
    }
  | { ok: false; error: string; errorCode: string }

/**
 * Put the blocks back, sanitise, and stage.
 *
 * The sanitiser is `parseOvpn` and nothing else. An edit is exactly as
 * trustworthy as an import, and it goes through the same door.
 */
export async function vpnEditCommit(
  editId: string,
  name: string,
  workspaceId: string,
  edited: string
): Promise<VpnEditCommitResult> {
  try {
    const session = sessions.get(editId)
    if (session === undefined) {
      return {
        ok: false,
        // Not "try again": the blocks are gone, so the edit on screen can no
        // longer be completed and saying otherwise wastes somebody's work
        // twice.
        error:
          'This edit has expired or the vault was locked since it started, so its certificates and keys are no longer held. Open the profile and edit it again.',
        errorCode: 'config-invalid'
      }
    }
    const restored = restoreInlineBlocks(edited, session.blocks)
    if (!restored.ok) return { ok: false, error: restored.detail, errorCode: 'config-rejected' }

    const parsed = parseOvpn(restored.body)
    if (!parsed.ok || !parsed.spec) {
      return {
        ok: false,
        error: parsed.error ?? 'The edited configuration was rejected.',
        errorCode: parsed.errorCode ?? 'config-rejected'
      }
    }

    const staged = await stageImportedSecrets(name, workspaceId, 'openvpn', parsed.secrets ?? {})
    const spec: VpnSpec = {
      ...(parsed.spec as OpenVpnSpec),
      configRef: { ...staged.refs.configBody! }
    }
    // Cleared on success only. A failed commit keeps the session, because the
    // operator still has the edit on screen and a second attempt is the normal
    // response to a sanitiser refusal.
    sessions.delete(editId)
    return {
      ok: true,
      spec,
      vaultEntryId: staged.vaultEntryId,
      replacedVaultEntryId: session.vaultEntryId,
      change: ovpnEditChange(session.redacted, edited, restored.removed),
      stripped: parsed.stripped,
      warnings: parsed.warnings
    }
  } catch (e) {
    if (isVaultLockedError(e)) {
      return {
        ok: false,
        error: 'Unlock the vault before saving this edit — the configuration is stored there.',
        errorCode: 'vault-locked'
      }
    }
    const r = toVpnResult(e)
    return { ok: false, error: r.error ?? 'The edit could not be saved.', errorCode: r.errorCode ?? 'internal' }
  }
}

/** Abandon an edit. The blocks are key material and do not wait for the TTL
 *  when somebody has already pressed cancel. */
export function vpnEditCancel(editId: string): void {
  sessions.delete(editId)
}

/** Test seam. */
export function vpnEditSessionCountForTests(): number {
  return sessions.size
}
