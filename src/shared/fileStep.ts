import type { JobSpec, JobStep } from './jobs'

// Item 34c: the third typed step kind, and the one with real bytes in it.
//
// THE APPROVAL COVERS THE CONTENT, not a description of it. The file's bytes go
// into the command as base64 and its sha256 goes in beside them, so
// `verifyApproval`'s literal comparison covers what will be written -- a job
// whose content was swapped between the dialog and the run does not verify.
// That is the same property item 44's rollback needed and for the same reason:
// a field beside the approved commands is a field nobody checks.
//
// THE HOST DECIDES WHETHER THE FILE MOVED, not this side. cronEdit.ts makes the
// argument at length: a check made here is a check about a file we are no
// longer looking at. So the expected sha256 of what is already there travels
// INTO the command, and the host refuses if the file has changed underneath.
//
// BASE64 RATHER THAN A HEREDOC. userUnits.ts learned this the expensive way: a
// heredoc joined into a one-line command is broken by the join, the file is
// never written, and the exit code is still 0.

/** Bigger than this and the dialog stops being something a person reads before
 *  agreeing to it, which is the point of the dialog. Not a technical limit. */
export const FILE_PUSH_MAX_BYTES = 64 * 1024

/**
 * Paths this refuses to write, whatever the operator types.
 *
 * Each one has a path in this app that is safer than a file push, or is a file
 * whose format has rules a byte-for-byte overwrite does not know:
 *
 *  - authorized_keys is item 36's, which stages, verifies and rolls back.
 *  - shadow, passwd, group and sudoers have their own tools for a reason; a
 *    malformed sudoers locks out root, and `visudo -c` exists because of it.
 *  - a private key is never something to push from here.
 */
const REFUSED_PATHS = [
  /(^|\/)\.ssh\/authorized_keys2?$/,
  /^\/etc\/(shadow|gshadow|passwd|group|sudoers)$/,
  /^\/etc\/sudoers\.d\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx)$/
]

export type FileStepCheck = { ok: true } | { ok: false; reason: string }

export function checkFilePush(path: string, content: string): FileStepCheck {
  const p = path.trim()
  if (p === '') return { ok: false, reason: 'Give the full path of the file to write.' }
  if (!p.startsWith('/')) {
    return { ok: false, reason: 'The path must be absolute. A relative path means a different file depending on which directory the step happens to start in.' }
  }
  // Checked on the literal text rather than after a normalise, because the
  // string that reaches the host is this one.
  if (p.includes('..')) return { ok: false, reason: 'The path may not contain "..".' }
  if (/[\s'"$`;|&<>()*?[\]{}]/.test(p)) {
    return { ok: false, reason: 'The path may not contain spaces, quotes or shell characters. This text is used on a server as root.' }
  }
  if (p.length > 512) return { ok: false, reason: 'That path is longer than any real one.' }
  for (const rx of REFUSED_PATHS) {
    if (rx.test(p)) {
      return {
        ok: false,
        reason: `ShellPilot will not write ${p} from here. Files that decide who can log in, or that hold a private key, are changed through the key and access screen — which stages the change, verifies it over a fresh session and puts it back if that fails. A file push has none of that.`
      }
    }
  }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes === 0) return { ok: false, reason: 'The file is empty. Writing an empty file over a real one is almost always a mistake; if it is not, delete the file instead.' }
  if (bytes > FILE_PUSH_MAX_BYTES) {
    return { ok: false, reason: `That file is ${Math.round(bytes / 1024)} KB, and anything over ${FILE_PUSH_MAX_BYTES / 1024} KB is more than anybody reads before agreeing to it.` }
  }
  return { ok: true }
}

export interface FilePushOpts {
  sudo?: boolean
  /** sha256 of what the operator was SHOWN as already being there, or null for
   *  "this file should not exist yet". The host checks it. */
  expectedBefore?: string | null
  /** Mode as four octal digits. Applied before the file becomes live. */
  mode?: string
  /** Run after the write, and only if it succeeded — `nginx -t`, say. Its own
   *  text, so it is in the approval like everything else. */
  after?: string
}

/**
 * The command, in the order that makes a failure leave the old file in place.
 *
 * Written to a temporary file beside the target and renamed over it, because a
 * rename within a filesystem is atomic and a truncate-then-write is not: a
 * process reading that file during a truncate-then-write sees half of it, and
 * on a config file that is a service restarting into nothing.
 */
export function buildFilePushCommand(
  path: string,
  content: string,
  sha256: string,
  o: FilePushOpts = {}
): string {
  const s = o.sudo === false ? '' : 'sudo -n '
  const p = `'${path.trim()}'`
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  const mode = /^[0-7]{4}$/.test(o.mode ?? '') ? (o.mode as string) : '0644'

  const lines = [
    `SP_F=${p}`,
    'SP_T="$SP_F.shellpilot-new"',
    'SP_B="$SP_F.shellpilot-bak"',
    // What is there now, or the empty string when it is not there at all.
    `SP_NOW=$(${s}sha256sum "$SP_F" 2>/dev/null | cut -d' ' -f1 || true)`
  ]

  if (o.expectedBefore === null) {
    lines.push(
      '[ -z "$SP_NOW" ] || { echo "this file already exists on this server, and this job was confirmed as creating a new one; nothing was changed" >&2; exit 4; }'
    )
  } else if (typeof o.expectedBefore === 'string' && o.expectedBefore !== '') {
    // THE CHECK THAT ACTUALLY HOLDS. Made on the host, at the moment of the
    // write, about the file that is there -- not here, minutes earlier, about
    // a copy.
    lines.push(
      `[ "$SP_NOW" = '${o.expectedBefore}' ] || { echo "this file has changed on the server since it was read, so the change was not applied; look at it again" >&2; exit 4; }`
    )
  }

  lines.push(
    // Decoded to a temporary file first. Nothing has touched the live file yet.
    `printf %s '${b64}' | base64 -d > "$SP_T" || { rm -f "$SP_T"; echo "the new file could not be written; nothing was changed" >&2; exit 3; }`,
    // The bytes that landed, against the bytes that were approved. A truncated
    // transfer produces a valid file of the wrong length, and this is the only
    // step that would notice.
    `SP_GOT=$(${s}sha256sum "$SP_T" | cut -d' ' -f1)`,
    `[ "$SP_GOT" = '${sha256}' ] || { rm -f "$SP_T"; echo "the file that arrived is not the file that was approved; nothing was changed" >&2; exit 5; }`,
    `${s}chmod ${mode} "$SP_T" || { rm -f "$SP_T"; echo "the new file could not be given its permissions; nothing was changed" >&2; exit 3; }`,
    // Backed up only once there is something to replace it with.
    `[ -z "$SP_NOW" ] || ${s}cp -p "$SP_F" "$SP_B" || { rm -f "$SP_T"; echo "the existing file could not be backed up; nothing was changed" >&2; exit 3; }`,
    `${s}mv "$SP_T" "$SP_F" || { echo "the file could not be replaced" >&2; exit 3; }`,
    `echo "WROTE: $SP_F${o.expectedBefore === null ? ' (new file)' : ', previous copy at $SP_B'}"`
  )
  return lines.join('\n')
}

export function filePushJobSpec(
  path: string,
  content: string,
  sha256: string,
  o: FilePushOpts = {}
): JobSpec {
  const steps: JobStep[] = [{ command: buildFilePushCommand(path, content, sha256, o) }]
  // The post-step is its own step so it is graded, shown and recorded like any
  // other -- `nginx -t && systemctl reload nginx` is a service action, and item
  // 34a already decided how those are confirmed.
  if (o.after && o.after.trim() !== '') steps.push({ command: o.after.trim() })
  return {
    kind: 'command',
    title: `Write ${path.trim()}`,
    steps
  }
}
