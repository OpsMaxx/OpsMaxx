// Writing ONE variable into a project's `.env`, with the value coming from the
// vault and never from a window.
//
// ======================================================================
// WHY THIS IS NOT `writeImageTag` WITH A DIFFERENT REGEX
// ======================================================================
//
// The image-tag edit plans in main, sends the plan to the renderer, shows it,
// and re-checks `before` when the operator confirms. That works because a
// compose `image:` line is not a secret and may be displayed.
//
// A `.env` LINE IS THE SECRET. `NAME=value` is the thing `shared/compose.ts` is
// organised around never reading: its header records that `docker compose
// config` prints `REDIS_PASSWORD: hunter2` and that the whole module exists to
// keep that off the wire. So there is no plan-then-confirm round trip here,
// because the plan would carry the line it is about.
//
// Instead the whole operation happens in main: read the file, resolve the vault
// value, plan, apply, write. The plan never leaves the process, which also
// means it cannot go stale between planning and applying -- the failure the
// image edit's `before` check exists to catch cannot occur, rather than being
// caught.
//
// What crosses IPC is a REQUEST -- the path, the variable name, and which vault
// entry to take the value from -- and a RESULT that says which line changed and
// nothing about what is on it.
//
// ======================================================================
// THE QUOTING, MEASURED
// ======================================================================
//
// Against docker engine 29.5.3 / compose v2, end to end: `.env` bytes on disk,
// through compose's interpolation, into the actual process environment of a
// running container, read back with `env -0 | base64` so that no shell, no YAML
// rendering and no `docker compose config` output escaping sits between the
// value written and the value checked. The first two attempts at that harness
// were WRONG in ways that looked like the escaper was wrong -- `printf "$V"`
// inside the container let its own shell expand `$b` and turn `$$` into PID 1,
// and `config --format json` re-escapes `$` as `$$` on the way out. The
// recorded fixtures are `tests/fixtures/compose/env-escaping.*`.
//
// What that measured:
//
//  * `FOO=abc # def` yields `abc`. AN INLINE `#` STARTS A COMMENT, so an
//    unquoted value is truncated at the first one.
//  * `FOO=trail   ` yields `trail`. Trailing whitespace is stripped.
//  * A repeated name takes the LAST occurrence, so editing the first one
//    silently does nothing -- which is why a duplicate is refused below.
//  * `export FOO=v` IS honoured, so `export` lines count as occurrences.
//  * Inside DOUBLE quotes, `$` interpolates (`"a${NOPE}b"` became `ab`) and
//    backslash escapes are processed (`"a\nb"` became a real newline).
//  * Inside SINGLE quotes nothing is processed -- but there is no escape for a
//    single quote inside them at all: `'it'"'"'s'`, which is the shell's own
//    trick, is a PARSE ERROR from compose ("unexpected character").
//
// So single quotes cannot carry an apostrophe, and apostrophes appear in real
// passwords. Double quotes with all three escapes can carry everything, and
// that is what `escapeEnvValue` emits: `\` first, then `"`, then `$`.

/** `.env` names as compose accepts them. The leading digit is excluded because
 *  a POSIX environment variable may not start with one. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateEnvName(name: unknown): boolean {
  return typeof name === 'string' && name.length <= 256 && ENV_NAME_RE.test(name)
}

/**
 * Quote a value so compose reads back exactly the bytes given.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. `\` is escaped FIRST: doing it after the
 * others would also escape the backslashes this function just added, turning
 * `"` into a literal `\"` in the value rather than an escaped quote.
 */
export function escapeEnvValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$')}"`
}

/** `.env` files are configuration. Anything this large is not one, and the cap
 *  also bounds what a compromised host can make this process hold. */
export const ENV_MAX_FILE_BYTES = 256 * 1024

export type EnvWritePlan =
  | {
      ok: true
      name: string
      /** 1-based. `null` when the variable is absent and the line is appended. */
      line: number | null
      action: 'replace' | 'append'
    }
  | { ok: false; reason: string }

/**
 * Decide where the variable goes. Reads names and NOTHING to the right of the
 * first `=`.
 *
 * There is deliberately no "the value is already correct, skip" case: knowing
 * that would mean reading the existing value and comparing it against the
 * vault's, which is exactly the read this module exists to avoid. A write that
 * changes nothing is harmless; a comparison that holds two secrets to find out
 * is not.
 */
export function planEnvWrite(fileText: string, name: string): EnvWritePlan {
  if (!validateEnvName(name)) return { ok: false, reason: `\`${name}\` is not a valid variable name` }
  const lines = fileText.split('\n')
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // No `#` guard here: a comment cannot match the name pattern below, because
    // `#` is not a legal first character of a variable name. A second check
    // would read as though it were the one keeping the invariant.
    if (line.trim() === '') continue
    // `export NAME=` is honoured by compose (measured), so it counts. The name
    // is matched up to the first `=` and the rest of the line is never looked
    // at -- there is no capture group for it.
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m !== null && m[1] === name) hits.push(i + 1)
  }
  if (hits.length > 1) {
    return {
      ok: false,
      // Measured: compose takes the LAST one. Writing to the first would leave
      // the operator looking at a changed file and a stack still using the old
      // value, which is the worst outcome available here.
      reason: `\`${name}\` is set ${hits.length} times in this file (lines ${hits.join(', ')}). Compose uses the last one, so changing any single line would not reliably change what the stack sees. Remove the duplicates first.`
    }
  }
  if (hits.length === 1) return { ok: true, name, line: hits[0], action: 'replace' }
  return { ok: true, name, line: null, action: 'append' }
}

/**
 * Produce the new file text.
 *
 * MAIN ONLY. This is the one function here that touches a value, and its
 * result is a file body that contains a secret -- it must never be returned
 * over IPC, logged, or put in an error message.
 */
export function applyEnvWrite(fileText: string, plan: EnvWritePlan, value: string): string {
  if (!plan.ok) throw new Error('refusing to apply an env write that was not planned')
  if (typeof value !== 'string') throw new Error('refusing to write a non-string env value')
  const entry = `${plan.name}=${escapeEnvValue(value)}`
  const lines = fileText.split('\n')
  if (plan.action === 'append') {
    // A file that does not end in a newline would otherwise have the new
    // variable appended to whatever its last line is.
    const body = fileText === '' || fileText.endsWith('\n') ? fileText : `${fileText}\n`
    return `${body}${entry}\n`
  }
  const idx = (plan.line ?? 0) - 1
  if (idx < 0 || idx >= lines.length) {
    throw new Error('refusing to apply an env write past the end of the file')
  }
  // Re-checked against the text being written to, not against text from an
  // earlier read: `planEnvWrite` and this call happen in one main-process
  // operation, so disagreement here is a bug rather than a race.
  const again = planEnvWrite(fileText, plan.name)
  if (!again.ok || again.action !== 'replace' || again.line !== plan.line) {
    throw new Error('refusing to apply an env write: the file no longer matches the plan')
  }
  lines[idx] = entry
  return lines.join('\n')
}

/** The sentence the UI puts on screen. The operator is choosing a vault entry
 *  for a name whose current value this app has never read, and saying so is the
 *  difference between a deliberate trade and a missing feature. */
export const ENV_WRITE_DISCLOSURE =
  'OpsMaxx has never read this file’s values and does not read them to make this change: it writes the value you pick from the vault over the line with this name, or adds the line if there is none. It cannot tell you whether the value is already the same one.'
