// What this installation is, in about thirty lines a person can read before
// they paste it into an issue.
//
// WHAT IS IN HERE, AND WHY THE LIST IS SO SHORT
//
// Every field EXCEPT the crash block is either a version string the platform
// reports, a COUNT, or a BOOLEAN. No hostnames, addresses, usernames, server or
// workspace or database or container names, no file paths, no credential, no
// webhook URL, no remote command output, no terminal text, nothing out of the
// vault or known_hosts.
//
// That is not a redaction policy, it is the shape of the type. The earlier
// design of this feature collected a bundle — remote readings, a file on disk,
// a retention window — and every hard problem it had came from holding text it
// did not author: a pre-auth SSH banner that could split records in the log it
// was appended to, a persistent file that needed mode bits and a symlink check,
// an eviction policy that could be driven. None of those questions exist here,
// because there is nothing to redact and nothing to write. If a field you want
// to add would need a redaction pass, it does not belong in this type.
//
// The one exception is the crash block, and it is an exception on purpose: a
// stack trace is machine-written text nobody here composed, and on a dev
// machine it carries the absolute path of every frame. `scrubPaths` cuts those
// down to the basename, and main puts every crash field through `redactOutput`
// before capping it (see services/diagnostics.ts) so a secret-shaped string in
// an error message is blanked.
//
// Neither pass removes a HOSTNAME or an IP — `Error: getaddrinfo ENOTFOUND
// db-prod.internal.example` comes through whole, because no rule can tell a
// host from a word. So the crash block is the one part of the payload the user
// has to look at, and both screens that copy it now show it first and say so.

/** What the crash screen already holds. Renderer-supplied, because the crash
 *  happened there and main never saw it. */
export interface DiagnosticsCrash {
  message: string
  stack: string | null
  componentStack: string | null
}

/** Counts, never names. "four databases" is support information; which four
 *  they are is the user's estate. */
export interface DiagnosticsCounts {
  workspaces: number
  servers: number
  databases: number
  tunnels: number
  vpnProfiles: number
}

export interface Diagnostics {
  version: string
  /** Update channel: 'stable' or 'beta'. */
  channel: string
  portable: boolean
  packaged: boolean
  platform: string
  arch: string
  /** `os.release()` — a kernel version, not a machine name. */
  osRelease: string
  /**
   * Linux: the name of the password store safeStorage selected —
   * `gnome_libsecret`, `kwallet6`, `basic_text`. `null` on macOS and Windows,
   * where there is only ever one.
   *
   * A STRING, and therefore deliberately not in `config` below: that field is
   * `Record<string, boolean>` so the type forbids it carrying a value, and the
   * fix for needing a string is a typed field of its own, never a looser
   * `config`. It belongs beside `osRelease` for the same reason it is safe to
   * print — it names a component of the OS, not anything the user owns.
   */
  secretStoreBackend: string | null
  electron: string
  chrome: string
  node: string
  /** NODE_MODULE_VERSION. The number a mismatched native module complains about. */
  nodeModuleVersion: string
  counts: DiagnosticsCounts
  /** Ids of the optional modules that are switched on. */
  modulesEnabled: string[]
  /**
   * Feature configuration as BOOLEANS — `Record<string, boolean>` rather than a
   * named interface so the type itself forbids carrying a value.
   *
   * This is the half that is easy to leave out and the half four bugs needed.
   * Each of those was the app believing it was configured and working: a
   * webhook switch left on after its URL was removed, with every alert silently
   * dropped; a "check now" button wired to a cache read. Nothing threw, so no
   * error-shaped field would have shown any of them — but `webhook.enabled:
   * true` beside `webhook.hasUrl: false` is the whole bug on two lines.
   */
  config: Record<string, boolean>
  crash?: DiagnosticsCrash | null
}

/** First line of the text, and how a reader knows what they pasted. */
export const DIAGNOSTICS_HEADING = 'OpsMaxx diagnostics'

/** How many lines of a stack are worth having. Past this it is framework
 *  internals, and the point of the block is to stay readable. */
const STACK_LINES = 24

/**
 * Absolute paths down to their last segment.
 *
 * A renderer stack frame reads `at render (/Users/someone/OpsMaxx/out/...)`,
 * and under a dev build the leading part of that is the user's home directory
 * and therefore their name. The last segment is the part that identifies the
 * code; everything before it identifies the machine.
 *
 * The match has to START at a boundary — start of line, whitespace, a bracket
 * or a quote — so that ordinary prose like "and/or" in an error message is not
 * treated as a path and silently glued together. An over-eager rule here is
 * worse than a leak: a mangled stack is a stack nobody can read.
 *
 * `=`, `,` and `:` are boundaries too, and `~` is a prefix, because a path does
 * not only arrive after a space. All four shapes were measured surviving the
 * original class intact: `path=/home/u/k.pem`, `~/.ssh/id_rsa`,
 * `host:/var/log/x`, and `foo,/home/u/x`.
 *
 * Deliberate limits:
 *
 *  - The `:` boundary declines a DOUBLE slash, so `https://host/a/b` is left
 *    whole rather than collapsed to `https:b`. A URL is not a path, and
 *    shortening one loses the readable half without removing the host.
 *  - A SPACE inside the run is crossed only when a separator still follows it,
 *    because a path with a space in it is ordinary and the naive run stopped
 *    dead at the first one. `C:\Users\Jane Doe\...\index.js` then kept the
 *    whole remainder — the Windows display name and every segment under it —
 *    since the part after the space starts at a letter and so could not
 *    re-match the prefix, which wants a separator. `/Volumes/My Disk/Users/...`
 *    leaked the volume name and the username the same way. Both were measured.
 *
 *    The separator may now be up to THREE space-separated words further on,
 *    which is what a ONE-word lookahead got wrong: it crossed a space only when
 *    the very next word carried a separator, so a segment of three or more words
 *    stopped the run at the first space — and the half-name before it was then
 *    returned as the basename with the rest of the path left standing beside it.
 *    `C:\Users\Jane Mary Doe\AppData\x.js` printed `Jane Mary Doe\AppData\x.js`,
 *    `/Volumes/My Big Disk/Users/jsmith/x.js` printed
 *    `My Big Disk/Users/jsmith/x.js`, and a DOUBLE space did it too
 *    (`C:\Users\Jane  Doe\app\index.js` → `Jane  Doe\app\index.js`), because the
 *    empty word between two spaces carries no separator either. All four were
 *    measured before and after. Three words covers a five-word segment — a
 *    three-part display name, `Maria de la Cruz`, `My Big External Disk` — and
 *    each run of consecutive spaces spends one of the three.
 *
 *    The word that carries the separator must not itself START a path: not
 *    `/x`, not `~/x`, not `C:\x`, not `scheme://host`. Without that guard the
 *    crossing joins a path to the NEXT path across the prose between them, and
 *    all three were measured: `open .../config.json and C:\Users\...` collapsed
 *    to one run and printed only the second basename (the message test pins
 *    both), `and ~/y` lost the word `and`, and a URL after prose was collapsed
 *    rather than left whole.
 *  - A basename survives, including an identifying one like
 *    `acme_prod_ed25519`. The basename is the entire point of the pass —
 *    `index.js:4821:17` is the one useful thing in a frame — so dropping it
 *    would trade the leak for uselessness.
 *
 * The residual, measured, in full:
 *
 *  - A word with a slash INSIDE it, within three words after a path,
 *    over-reaches: `/etc/x and/or y` → `or`, and now also `/etc/x a b c and/or
 *    y` → `or`, `I/O`, `read/write`. This is the pre-existing `and/or` residual
 *    widened from one intervening word to three — the cost of the fix above, and
 *    the reason the bound is three rather than unlimited.
 *  - A segment of SIX or more space-separated words is still not crossed, and
 *    the old partial behaviour returns there: `/Users/A B C D E F/app/x.js` →
 *    `A B C D E F/app/x.js`.
 *  - A space in the FINAL segment is not crossed — but that one is not a partial
 *    leak, because the text printed is character-for-character what a full
 *    crossing would print: a kept basename keeps its spaces, so `/Users/Jane
 *    Doe` prints `Jane Doe` either way, as `/Users/a/My File.txt` prints
 *    `My File.txt`. Failing closed to `(path)` is not available here — the run
 *    that legitimately ENDS at a filename (`open /etc/hosts and then gave up`)
 *    is locally indistinguishable from it, so failing closed would replace every
 *    such basename with `(path)` and cost the pass its whole point.
 *
 * No catastrophic backtracking. The outer star's two alternatives stay disjoint
 * (one excludes whitespace, the other requires a space), and the added lookahead
 * is bounded to four words, so cost stays LINEAR: measured flat at 23-25 ns per
 * byte from 160 KB to 2.5 MB of the worst adversarial shape (a separator every
 * four words, which makes the whole input one run), 16.7 ms on 820 KB against
 * 4.9 ms for the one-word lookahead. Past ~5 MB in a SINGLE unbroken run the
 * engine throws RangeError rather than hanging; every crash field reaching here
 * is already capped at 4000 characters by `cleanCrashField` in
 * services/diagnostics.ts, a 1250x margin, and nothing else calls this.
 *
 * Neither this nor the redaction pass in main removes hostnames or addresses,
 * which is why nothing in the UI claims the crash block is clean.
 */
export function scrubPaths(text: string): string {
  return text.replace(
    /(?:(?<=^|[\s('"[,=])(?:file:\/\/)?(?:[A-Za-z]:)?~?|(?<=[^\s:]:)(?![/\\]{2}))[/\\](?:[^\s)'"\]]| (?=(?:[^\s)'"\]]* ){0,3}(?![~/\\]|[A-Za-z]:[/\\]|[A-Za-z][\w+.-]*:\/\/)[^\s)'"\]]*[/\\]))*/gm,
    (match) => {
      const tail = match.split(/[/\\]/).filter(Boolean).pop()
      return tail === undefined ? '(path)' : tail
    }
  )
}

/** Newlines out of a single-line field. A message that could inject its own
 *  `key: value` line would make the text say things nobody measured. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Indented so a line-based reader can tell a continuation line from a field.
 *
 * Split on every LineTerminator, not just `\n`. `\p{Zl}` is U+2028 and `\p{Zp}`
 * is U+2029 — each category holds exactly that one character — and both are
 * written as properties because a literal one in a regex is a syntax error and
 * an escaped one is unreadable. `split('\n')` left them inside a line, so a
 * single physical line went through this function unindented while `<pre>` and
 * GitHub both RENDER it as a break: a forged `[crash]`-style section heading
 * that the indent is supposed to make impossible. `err.stack` opens with
 * `${name}: ${message}`, and that message can come from remote text — an SSH
 * banner, a server's own error string — so it is not this file's to trust.
 * `oneLine` needs no equivalent: JS `\s` already covers both.
 */
const block = (text: string): string[] =>
  scrubPaths(text)
    .split(/\r?\n|\p{Zl}|\p{Zp}/u)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .slice(0, STACK_LINES)
    .map((l) => `  ${l}`)

/** The whole payload as plain text: `key: value` lines under `[section]`
 *  headings, continuation lines indented by two spaces. */
export function formatDiagnostics(d: Diagnostics): string {
  const lines = [
    DIAGNOSTICS_HEADING,
    `version: ${d.version}`,
    `channel: ${d.channel}`,
    `portable: ${d.portable}`,
    `packaged: ${d.packaged}`,
    `platform: ${d.platform} ${d.arch} ${d.osRelease}`,
    // Omitted rather than printed as "none" on the two platforms where the
    // question has no answer, so its presence alone says "this is a Linux
    // keyring report". `oneLine` because it is the only string field here that
    // this file did not compose: Electron picks it from a fixed set of names,
    // and a single-line field should not be trusted to stay single-line just
    // because today's list happens to be.
    ...(d.secretStoreBackend === null
      ? []
      : [`secretStoreBackend: ${oneLine(d.secretStoreBackend)}`]),
    `electron: ${d.electron}`,
    `chrome: ${d.chrome}`,
    `node: ${d.node}`,
    `nodeModuleVersion: ${d.nodeModuleVersion}`,
    '',
    '[counts]',
    ...Object.entries(d.counts).map(([k, n]) => `${k}: ${n}`),
    '',
    '[modules]',
    `enabled: ${d.modulesEnabled.length > 0 ? d.modulesEnabled.join(' ') : 'none'}`,
    '',
    '[config]',
    ...Object.entries(d.config).map(([k, v]) => `${k}: ${v}`)
  ]

  if (d.crash) {
    lines.push('', '[crash]', `message: ${oneLine(scrubPaths(d.crash.message))}`)
    if (d.crash.stack) lines.push('stack:', ...block(d.crash.stack))
    if (d.crash.componentStack) lines.push('componentStack:', ...block(d.crash.componentStack))
  }

  return `${lines.join('\n')}\n`
}
