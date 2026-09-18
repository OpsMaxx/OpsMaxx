import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { planProvision, type ProvisionManifest, type ProvisionPlan } from '../../shared/provision'
import { backupImport } from './backup'

const run = promisify(execFile)

/**
 * Applying a provisioning manifest.
 *
 * TWO CALLS, ALWAYS, AND THE SECOND ONE CANNOT BE REACHED WITHOUT THE FIRST.
 * `preview` reads the manifest and says what would happen; `apply` does it, and
 * takes the plan the user actually saw as an argument rather than re-reading
 * the file. That is not ceremony: a manifest re-read between preview and apply
 * is a manifest that could have changed, and the thing it would change is a
 * script somebody already approved.
 */

/** How long a hook may run before it is killed.
 *
 *  A provisioning hook that has not finished in five minutes is a hook waiting
 *  for input nobody is going to give it -- a `sudo` prompt on a machine with no
 *  terminal attached, most likely -- and a setup that hangs forever is worse
 *  than one that fails. */
const HOOK_TIMEOUT_MS = 5 * 60_000

export function preview(manifest: unknown): ProvisionPlan {
  return planProvision(manifest)
}

export interface ApplyResult {
  ok: boolean
  done: string[]
  failed?: string
  /** The hook's own output, whatever happened. An operator whose setup failed
   *  needs what the script said, not "the hook failed". */
  hookOutput?: string
}

export interface ApplyOptions {
  manifest: ProvisionManifest
  /** The passphrase for the backup bundle. Never in the manifest: a manifest
   *  carrying the passphrase to the bundle it names is a manifest that is the
   *  credential, and those travel by email. */
  passphrase: string
  /**
   * The user has read the script and said yes TO THIS SCRIPT.
   *
   * A boolean rather than a remembered setting, and there is deliberately no
   * "always allow": a manifest arrives by email, from a colleague, out of a
   * repository, and consent to one script is not consent to the next.
   */
  hookApproved: boolean
}

export async function apply(opts: ApplyOptions): Promise<ApplyResult> {
  const plan = planProvision(opts.manifest)
  if (plan.problems.length > 0) {
    return { ok: false, done: [], failed: plan.problems.join(' ') }
  }

  const done: string[] = []

  const section = opts.manifest.opsmaxx
  if (section) {
    if (section.bundle.kind !== 'file') {
      // The addy path needs an attached account and a generation to fetch,
      // which is the session's job rather than this module's. Refused by name
      // rather than silently skipped.
      return {
        ok: false,
        done,
        failed: 'Restoring from an addy generation is not wired up yet; use a bundle file.'
      }
    }
    const result = await backupImport(opts.passphrase, section.bundle.path)
    if (!result.ok) {
      // The hook does NOT run after a failed restore. A script written to
      // configure a restored machine, run against a machine that was not
      // restored, is a script running against unexpected state -- which is the
      // situation it is least likely to have been tested in.
      return { ok: false, done, failed: result.error ?? 'the restore failed' }
    }
    done.push(`restored from ${section.bundle.path}`)
  }

  const hook = opts.manifest.postRestore
  if (hook) {
    if (!opts.hookApproved) {
      return { ok: false, done, failed: 'The post-restore script was not approved, so it was not run.' }
    }
    const output = await runHook(hook.interpreter, hook.script)
    done.push('ran the post-restore script')
    if (!output.ok) {
      return { ok: false, done, failed: output.error, hookOutput: output.text }
    }
    return { ok: true, done, hookOutput: output.text }
  }

  return { ok: true, done }
}

/**
 * Runs the script.
 *
 * Written to a file in a private temporary directory and passed to the named
 * interpreter, rather than piped to a shell's stdin. Two reasons: a script on
 * stdin cannot itself read stdin, which breaks anything interactive in a way
 * that looks like a hang; and an interpreter invoked with a file argument is
 * one whose command line says what it ran, which is what an operator sees in
 * `ps` when they are trying to work out why their machine is busy.
 */
async function runHook(
  interpreter: string,
  script: string
): Promise<{ ok: boolean; text: string; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'opsmaxx-provision-'))
  const ext = interpreter.startsWith('pwsh') || interpreter === 'powershell' ? 'ps1' : 'sh'
  const file = join(dir, `hook.${ext}`)
  // 0600: the script is the user's, it may carry anything, and a
  // world-readable copy in a shared temp directory is a copy.
  writeFileSync(file, script, { mode: 0o600 })

  try {
    const { stdout, stderr } = await run(interpreter, [file], {
      timeout: HOOK_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      // NOT the app's environment. It carries whatever OpsMaxx was launched
      // with, which on a desktop includes the session's own secrets on some
      // platforms -- and a provisioning hook has no business inheriting them.
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
    })
    return { ok: true, text: [stdout, stderr].filter(Boolean).join('\n') }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    return {
      ok: false,
      text: [e.stdout, e.stderr].filter(Boolean).join('\n'),
      error: e.killed
        ? `the script was still running after ${HOOK_TIMEOUT_MS / 60_000} minutes and was stopped; it may have been waiting for input`
        : (e.message ?? 'the script failed')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
