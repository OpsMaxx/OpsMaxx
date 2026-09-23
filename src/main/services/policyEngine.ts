import type { AccessGroup, AiCapability, PermissionValue, PolicyAssignment } from '../../shared/mcp'
import type { VpnKind } from '../../shared/vpn'
import { assessCommand, SUDO_REASON } from '../../shared/commandRisk'

export interface Decision {
  decision: PermissionValue
  reason: string
}

// Server-specific assignment overrides the workspace default; a target with no
// assignment at all carries no restriction, and the session's own group applies.
/**
 * Whether a target carries a deliberate assignment, and to what.
 *
 * `resolveGroupId` collapses two different facts into `null`: "nobody has set
 * anything here" and "somebody set this to No AI Access". Under the old model
 * both denied, so the collapse was harmless. Under the new one the first means
 * "no restriction, the session's group applies" and the second means "this
 * target is off limits" -- and treating an explicit No AI Access as no
 * restriction would silently unlock every target a user had deliberately shut.
 */
export type Restriction =
  | { kind: 'none' }
  | { kind: 'no-ai-access' }
  | { kind: 'group'; groupId: string }

export function resolveRestriction(
  assignments: PolicyAssignment[],
  serverId: string,
  workspaceId: string
): Restriction {
  const found =
    assignments.find((a) => a.scope.level === 'server' && a.scope.serverId === serverId) ??
    assignments.find((a) => a.scope.level === 'workspace' && a.scope.workspaceId === workspaceId)
  if (!found) return { kind: 'none' }
  return found.groupId ? { kind: 'group', groupId: found.groupId } : { kind: 'no-ai-access' }
}

export function resolveGroupId(
  assignments: PolicyAssignment[],
  serverId: string,
  workspaceId: string
): string | null {
  const serverOverride = assignments.find((a) => a.scope.level === 'server' && a.scope.serverId === serverId)
  if (serverOverride) return serverOverride.groupId

  const workspaceDefault = assignments.find(
    (a) => a.scope.level === 'workspace' && a.scope.workspaceId === workspaceId
  )
  if (workspaceDefault) return workspaceDefault.groupId

  return null
}

export function evaluateCapability(group: AccessGroup | null, capability: AiCapability): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this server.' }
  // A group saved before this capability existed has no entry for it. Falling
  // through with `undefined` would read as neither 'deny' nor 'ask' at the call
  // sites and quietly behave like ALLOW, so an upgrade would silently widen
  // what every existing group permits. Absent means denied.
  const value = group.capabilities[capability] ?? 'deny'
  return { decision: value, reason: `${group.name}: ${capability} = ${value}` }
}

const RANK: Record<PermissionValue, number> = { deny: 0, ask: 1, allow: 2 }

// The session's own access group (chosen when the user created the session)
// is a ceiling: a per-server/workspace assignment can only narrow what that
// session is allowed to do, never widen it. Whichever side is more
// restrictive wins.
export function mostRestrictive(a: Decision, b: Decision): Decision {
  return RANK[a.decision] <= RANK[b.decision] ? a : b
}

// Commands that hand the AI an interactive/unrestricted shell as root. These
// are always denied — never ASK, never ALLOW, regardless of access group —
// because approving one is indistinguishable from granting an unrestricted
// root shell, which the brief says must never happen even implicitly.
const UNRESTRICTED_SHELL_PATTERNS = [
  /^sudo\s+-i\b/,
  /^sudo\s+su\b/,
  /^sudo\s+-s\b/,
  /^sudo\s+(?:(?:\/usr)?\/bin\/)?(?:ba|z|da)?sh\b/,
  /^sudo\s+su\s+-/,
  /^su\s+-?\s*$/,
  /^su\s+-\s*\w*$/
]

export interface CommandClassification {
  isSudo: boolean
  isUnrestrictedShell: boolean
  /**
   * Some segment runs under `unshare -r` / `--map-root-user`: root inside a
   * new user namespace only. evaluateCommand asks about it, with that reason.
   */
  namespaceRoot?: boolean
  /**
   * Some segment's command word is computed when it runs -- `$(which sudo)`,
   * `${SUDO:-sudo}`, a backtick -- so nothing here can say what it is.
   * evaluateCommand turns an `allow` into an `ask` for it.
   */
  computedCommand: boolean
}

// ---------------------------------------------------------------------------
// Finding escalation ANYWHERE in a command
// ---------------------------------------------------------------------------
//
// This used to test the start of the string and nothing else -- `^sudo`,
// `^doas`, and the shell patterns above anchored the same way. With sudo=deny
// and terminal=allow, every one of these therefore ran, silently:
//
//   /usr/bin/sudo reboot        env sudo reboot       command sudo systemctl stop nginx
//   true; sudo reboot           pkexec rm -rf /x      su -c "rm -rf /x"
//
// and so did the escalation SHELLS this function exists to refuse whatever the
// group says: `/usr/bin/sudo -i`, `env sudo -i`, `pkexec bash`, `su -c bash`.
//
// So each command segment is looked at, not the string. walkCommand is the
// ONE place that decides what a command line runs, and both classifyCommand
// and extractPathAccesses read its answer, so the escalation check and the
// path rules can never disagree about it:
//
//   * the line is split on ; && || | & and newlines;
//   * shell grammar in front of a command (`if`, `then`, `do`, `!`, `{`, `(`)
//     is stepped over, and so are VAR=value assignments and the wrappers that
//     run the rest of the line (env, command, exec, nohup, nice, timeout,
//     xargs, busybox, setsid, watch, flock, ...) with their own options;
//   * the command word is read the way the shell reads it -- backslashes
//     removed (`\sudo`, `su\do`) and reduced to a basename;
//   * escalators are stepped through to what they run, so `sudo env bash` is
//     judged as bash run as root;
//   * the inside of `$(...)`, backticks, `sh -c`, `su -c`, `env -S`,
//     `flock -c`, `script -c`, `watch` and `eval` is walked the same way, to a
//     depth of three.
//
// ESCALATION IS THE COMMAND WORD, NEVER AN ARGUMENT. `grep sudo auth.log`,
// `echo sudo` and `ls su` mention a name; they do not run it. Treating every
// mention as a run would put a sudo=deny group in front of an agent reading
// its own auth log, and a rule that fires on innocent text teaches people to
// loosen the rule.
//
// BEST-EFFORT, AND ONLY EVER TIGHTER. A command string can always hide what it
// runs -- a variable in an argument, `perl -e`, a script file, `ssh localhost`
// -- so this narrows the forms a model actually emits and does not claim more.
// A command word that is itself computed (`$(which sudo) reboot`) cannot be
// named at all, so it is reported for evaluateCommand to ask about. The old
// start-of-string tests are still OR'd in: nothing that was sudo or refused
// before this is anything less now.
//
// Only the MCP bridge calls this, through evaluateCommand. OpsMaxx's own
// `sudo -n` privileged reads never pass through it.

/** Names that run the rest of the line as another user. */
const ESCALATORS = new Set([
  'sudo', 'doas', 'su', 'pkexec', 'run0', 'runuser', 'systemd-run', 'runas', 'gsudo',
  // Enters another process's namespaces -- commonly pid 1's, which is the host.
  'nsenter'
])

/**
 * The same, as a Windows command word: `C:\Windows\System32\runas.exe`,
 * `gsudo.exe`, and Windows' own `sudo.exe`, whose backslashes `word()` would
 * otherwise read as shell escapes.
 */
const WINDOWS_ESCALATORS = new Set(['runas', 'gsudo', 'sudo'])
const WINDOWS_SHELLS = new Set(['cmd', 'powershell', 'pwsh'])

/** PowerShell commands that run a scriptblock argument. */
// ForEach-Object and Where-Object are left out on purpose: their blocks are
// almost always expressions (`{ $_.Name }`), which would all ask. A command run
// inside one is best-effort, like any command inside an interpreter's code.
const SCRIPTBLOCK_RUNNERS = new Set(['invoke-command', 'icm', 'start-job', 'sajb', 'start-threadjob'])

/** powershell.exe options that take a value, so the value is not read as the command. */
const POWERSHELL_VALUE_OPTIONS =
  /^-(?:ex(?:ecutionpolicy)?|ep|w(?:indowstyle)?|v(?:ersion)?|wd|workingdirectory|o(?:utputformat)?|of|i(?:nputformat)?|if|config(?:urationname)?|psconsolefile|settingsfile|custompipename)$/i

/** Shells: with no `-c`, running one is an interactive shell. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh'])

/**
 * Shell grammar that can stand in front of a command in the same segment, and
 * the words that close a construct (a segment of just `fi` runs nothing).
 */
const GRAMMAR = new Set([
  '!', '{', '}', '(', ')', 'if', 'then', 'do', 'else', 'elif', 'while', 'until', 'fi', 'done', 'esac'
])

/** `name()`, `name(){`: a function definition in front of its body. */
const FUNCTION_NAME = /^[A-Za-z_][\w.:-]*\(\)\{?$/

/**
 * A command word the walk cannot read literally: it still holds shell syntax
 * -- an expansion, a glob, a brace list, a paren, a redirection -- after
 * everything it understands has been stepped over. `[` alone is the test
 * builtin and is literal.
 */
const UNREADABLE_WORD = /[(){}$`*?[\]<>%!]|^=/

/**
 * Wrappers that run the rest of the line as a command, and the short options
 * of each that consume the next word. A wrapper not listed takes no values.
 */
const RUNNERS: Record<string, Set<string>> = {
  env: new Set(['-u', '-C', '-S']),
  command: new Set(),
  exec: new Set(['-a']),
  builtin: new Set(),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k']),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s']),
  busybox: new Set(),
  chroot: new Set(['--userspec', '--groups']),
  strace: new Set(['-e', '-o', '-p', '-s', '-u', '-E', '-I', '-b', '-a', '-O', '-S', '-X', '-P', '-U']),
  ltrace: new Set(['-e', '-o', '-p', '-s', '-u', '-n', '-a', '-A', '-D', '-F', '-l', '-w', '-x']),
  firejail: new Set(),
  bwrap: new Set([
    '--chdir', '--uid', '--gid', '--tmpfs', '--proc', '--dev', '--dir', '--unsetenv', '--hostname',
    '--remount-ro', '--mqueue', '--lock-file', '--sync-fd', '--info-fd', '--block-fd', '--userns',
    '--userns2', '--pidns', '--seccomp', '--add-seccomp-fd', '--exec-label', '--file-label', '--cap-add',
    '--cap-drop', '--argv0', '--perms', '--size', '--json-status-fd'
  ]),
  setarch: new Set(),
  prlimit: new Set(['-p']),
  // `. runas …` in PowerShell runs runas; `. ./env.sh` in a POSIX shell reads
  // a script, which is judged by its own name (and is best-effort either way).
  '.': new Set(),
  setsid: new Set(),
  unbuffer: new Set(),
  watch: new Set(['-n', '-q']),
  flock: new Set(['-w', '-E', '-c']),
  chrt: new Set(['-T', '-P', '-D']),
  taskset: new Set()
}

/** Wrappers whose first operand is not the command: a duration, a lock, a priority, a mask. */
const RUNNER_OPERAND = new Set(['timeout', 'flock', 'chrt', 'taskset', 'chroot', 'setarch'])

/**
 * Tools that CHANGE PRIVILEGE, and the options of each that take a value.
 * Read in unwrapSegment rather than stepped over as runners: stepping over
 * them treated `setpriv --reuid 0 reboot` like `nice reboot`.
 */
const SETPRIV_VALUE_OPTIONS = new Set([
  '--reuid', '--regid', '--groups', '--inh-caps', '--ambient-caps', '--bounding-set', '--securebits',
  '--pdeathsig', '--selinux-label', '--apparmor-profile', '--landlock-access', '--landlock-rule'
])
const UNSHARE_VALUE_OPTIONS = new Set(['-S', '-G', '--setuid', '--setgid', '--map-user', '--map-group'])

/** Everything after a command's own options. */
function afterOptions(argv: string[], valueOptions: Set<string>): string[] {
  let i = 1
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '-') {
    if (argv[i] === '--') return argv.slice(i + 1)
    i += valueOptions.has(argv[i]) ? 2 : 1
  }
  return argv.slice(i)
}

/** bwrap options that take TWO values (`--bind SRC DEST`). */
const RUNNER_TWO_VALUES: Record<string, Set<string>> = {
  bwrap: new Set([
    '--bind', '--ro-bind', '--dev-bind', '--bind-try', '--ro-bind-try', '--dev-bind-try', '--symlink',
    '--setenv', '--file', '--bind-data', '--ro-bind-data', '--chmod'
  ])
}

/** Wrapper options whose value is a whole command line of its own. */
const RUNNER_COMMAND_FLAGS: Record<string, Set<string>> = {
  env: new Set(['-S', '--split-string']),
  flock: new Set(['-c', '--command'])
}

/** Short options of the escalators that consume the next word. */
const RUN0_VALUE_FLAGS = [
  '-u', '-g', '-D', '-p', '-E', '-M', '-H', '--user', '--group', '--chdir', '--unit', '--property',
  '--setenv', '--slice', '--description', '--nice', '--machine', '--host', '--uid', '--gid'
]
const ESCALATOR_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-R', '-T']),
  gsudo: new Set(['-u', '-i', '--user', '--integrity', '--loglevel']),
  nsenter: new Set(['-t', '-S', '-G', '--target', '--setuid', '--setgid']),
  doas: new Set(['-u', '-C']),
  pkexec: new Set(['--user']),
  run0: new Set(RUN0_VALUE_FLAGS),
  'systemd-run': new Set(RUN0_VALUE_FLAGS),
  su: new Set(['-c', '-s', '-g', '-G', '-w', '--command', '--shell', '--group', '--supp-group', '--session-command', '--whitelist-environment']),
  runuser: new Set(['-c', '-s', '-g', '-G', '-u', '-w', '--command', '--shell', '--group', '--supp-group', '--user', '--session-command', '--whitelist-environment'])
}

const MAX_DEPTH = 3
const baseName = (t: string): string => t.split('/').pop() ?? t
/** A command word's basename. tokenize has already removed the shell's escapes. */
const word = (t: string): string => baseName(t)
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECTION = /(\d?>>?|<<<|<<-?|<)\s*("[^"]*"|'[^']*'|\S+)/g

/**
 * The same redirections, removed before a segment is split into words -- but
 * only OUTSIDE quotes, and never `<(` or `>(`, which are process
 * substitutions. The plain regex took `<(sudo` out of `eval 'cat <(sudo
 * reboot)'` before the string was ever handed on, so the sudo inside was
 * gone by the time anything looked for it. Quoted strings and escapes are
 * matched first and kept whole.
 */
const withoutRedirections = (segment: string): string =>
  segment.replace(
    /'[^']*'|"(?:[^"\\]|\\.)*"|\\.|(\d?>>?|<<<|<<-?|<)(?!\()\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s'"]+)/g,
    (m, op: string | undefined) => (op ? ' ' : m)
  )

/** Split a short-option cluster: `-Hiu` -> H, i, u (stopping at a value flag). */
function shortLetters(token: string, valueFlags: Set<string>): { letters: string[]; takesNext: boolean } {
  const letters: string[] = []
  for (let i = 1; i < token.length; i++) {
    const l = token[i]
    letters.push(l)
    if (valueFlags.has(`-${l}`)) return { letters, takesNext: i === token.length - 1 }
  }
  return { letters, takesNext: false }
}

/**
 * Step over grammar, assignments and runner wrappers; null if what follows is
 * not a run at all (`command -v sudo`).
 */
function stripRunners(tokens: string[], nested: string[]): string[] | null {
  let t = tokens
  for (;;) {
    for (;;) {
      if (!t.length) break
      const w = t[0]
      // `[[ ... ]]` and `(( ... ))` evaluate an expression and run nothing;
      // a `$(...)` inside one was already collected by walkCommand. `for` and
      // `select` headers likewise: their bodies are later segments.
      if (w === '[[' || w.startsWith('((') || w === 'for' || w === 'select') return []
      if (GRAMMAR.has(w) || ASSIGNMENT.test(w) || FUNCTION_NAME.test(w)) t = t.slice(1)
      // `f ( ) { ... }` and `f () { ... }`: the same definition, spaced out.
      else if (/^[A-Za-z_][\w.:-]*$/.test(w) && t[1] === '(' && t[2] === ')') t = t.slice(3)
      else if (/^[A-Za-z_][\w.:-]*$/.test(w) && t[1] === '()') t = t.slice(2)
      // `case x in *) sudo reboot`: the header, then the arm's pattern.
      else if (w === 'case') {
        const i = t.indexOf('in')
        t = i < 0 ? [] : t.slice(i + 1)
      } else if (/^[^()]*\)$/.test(w) && t.length > 1) t = t.slice(1)
      // `function f { ... }`, `function f() { ... }`
      else if (w === 'function') t = t.slice(2)
      // `coproc sudo reboot`, `coproc NAME { sudo reboot; }`
      else if (w === 'coproc') t = t[2] === '{' ? t.slice(2) : t.slice(1)
      // `(sudo reboot)`: the subshell paren is glued to the command word, and
      // `(ls)` glues the closing one on too.
      else if (/^\(+./.test(w)) t = [w.replace(/^\(+/, ''), ...t.slice(1)]
      else if (t.length === 1 && /^[^(]+\)+$/.test(w)) t = [w.replace(/\)+$/, '')]
      else break
    }
    const name = t.length ? word(t[0]) : ''
    const valueFlags = RUNNERS[name]
    if (!valueFlags) return t
    t = t.slice(1)
    // Options, then (for some) one operand, then options again: flock takes
    // `-c` after its lock file, `flock /tmp/l -c 'sudo reboot'`.
    for (let round = 0; round < 2; round++) {
      while (t.length && t[0].startsWith('-') && t[0] !== '-') {
        const flag = t[0]
        if (flag === '--') {
          t = t.slice(1)
          break
        }
        // `command -v sudo` asks where sudo is; it does not run it.
        if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(flag)) return null
        // `env -S 'sudo -i'`, `flock -c 'sudo reboot'`: a command line of its own.
        const eq = flag.indexOf('=')
        const long = eq < 0 ? flag : flag.slice(0, eq)
        if (RUNNER_COMMAND_FLAGS[name]?.has(long)) {
          if (eq >= 0) {
            nested.push(flag.slice(eq + 1))
            t = t.slice(1)
          } else {
            if (t[1] !== undefined) nested.push(t[1])
            t = t.slice(2)
          }
          continue
        }
        t = t.slice(RUNNER_TWO_VALUES[name]?.has(flag) ? 3 : valueFlags.has(flag) ? 2 : 1)
      }
      // `timeout 5 cmd`, `flock /tmp/l cmd`, `chrt 10 cmd`, `taskset 0x3 cmd`.
      if (round === 0 && RUNNER_OPERAND.has(name) && t.length) t = t.slice(1)
      else break
    }
    // `watch 'sudo reboot'` hands its arguments to `sh -c`.
    if (name === 'watch' && t.length) nested.push(t.join(' '))
  }
}

/**
 * Does this command line, run as another user, leave them in a shell? True for
 * a bare `bash`, and for a shell whose `-c` string is itself a bare shell --
 * `su -c bash`, `sudo sh -c bash` -- which is the same root prompt spelled
 * longer.
 */
function runsBareShell(line: string, depth = 0): boolean {
  return splitSegments(line).some((segment) => {
    const argv = stripRunners(tokenize(segment), [])
    return !!argv?.length && isBareShell(argv, depth)
  })
}

/**
 * The command string a POSIX shell (or `script`) was handed, or undefined.
 *
 * ONE PLACE reads it, because every place that read it separately looked for
 * an exact `-c` and nothing else -- so `bash -lc "sudo …"`, `sh -ec`, `zsh -ic`
 * and `bash -lic`, the form Codex-style agents wrap every command in, were
 * never walked and never met a path rule.
 *
 * For a shell, `-c` is a flag anywhere in an option cluster, and the string is
 * the first operand after the options (`bash -c -x 'cmd'` is legal). `-o`,
 * `+o`, `-O`, `+O`, `--rcfile` and `--init-file` take a value. For `script`,
 * `-c` takes its value directly: the rest of the cluster, or the next word.
 */
function commandString(argv: string[]): string | undefined {
  const isScript = word(argv[0]) === 'script'
  let flagged = false
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--command=')) return a.slice('--command='.length)
    if (a === '--command') return argv[i + 1]
    if (a === '--') return flagged ? argv[i + 1] : undefined
    if (/^[-+][oO]$/.test(a) || a === '--rcfile' || a === '--init-file') {
      i++
      continue
    }
    if (/^-[A-Za-z]+$/.test(a) && a.includes('c')) {
      if (isScript) return a.endsWith('c') ? argv[i + 1] : a.slice(a.indexOf('c') + 1)
      flagged = true
      continue
    }
    if (a.startsWith('-') || (a.startsWith('+') && a.length > 1)) continue
    // The first operand: the command string after a `-c`, or a script file.
    return flagged ? a : undefined
  }
  return undefined
}

/**
 * A shell's first operand -- the script it runs -- when it has no `-c`.
 * Undefined with `-s`, which reads the script from stdin and makes every
 * operand a positional parameter.
 */
function scriptOperand(argv: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) return undefined
    if (/^[-+][oO]$/.test(a) || a === '--rcfile' || a === '--init-file') {
      i++
      continue
    }
    if (a === '--') return argv[i + 1]
    if (a.startsWith('-') || (a.startsWith('+') && a.length > 1)) continue
    return a
  }
  return undefined
}

function isBareShell(argv: string[], depth = 0): boolean {
  // cmd / PowerShell: bare unless told to run something and exit.
  if (WINDOWS_SHELLS.has(commandName(argv[0]).toLowerCase())) {
    return !argv.slice(1).some((a) => /^(?:\/[cr].*|-c|-command|-file|-encodedcommand)$/i.test(a))
  }
  if (!SHELLS.has(word(argv[0]))) return false
  const line = commandString(argv)
  if (line === undefined) return true
  return depth < MAX_DEPTH && runsBareShell(line, depth + 1)
}

/** What the escalator in `argv[0]` runs, and whether it is a shell. */
function escalation(argv: string[], nested: string[], name = word(argv[0])): { shell: boolean; target: string[] } {
  const valueFlags = ESCALATOR_VALUE_FLAGS[name] ?? new Set<string>()
  // `su --help`, `pkexec --version`: asks the tool about itself, runs nothing.
  if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '--version')) return { shell: false, target: [] }
  // `runas /user:Administrator "cmd /c ..."`: the options are `/x`, and the
  // program is one quoted command line. No program is a usage message.
  if (name === 'runas') {
    const program = argv.slice(1).filter((a) => !a.startsWith('/'))
    if (!program.length) return { shell: false, target: [] }
    const line = program.join(' ')
    nested.push(line)
    return { shell: runsBareShell(line), target: [] }
  }
  // `gsudo -k` / `-K` clear its credential cache; they run nothing.
  if (name === 'gsudo' && argv.slice(1).every((a) => a === '-k' || a === '-K')) {
    return { shell: argv.length === 1, target: [] }
  }
  // su and runuser take options AFTER the user name too (`su root -c id`), so
  // their whole line is read; the others stop at the first word they run.
  const suLike = name === 'su' || name === 'runuser'
  let rest = argv.slice(1)
  let target: string[] | null = null
  let shellFlag = false
  let command: string | null = null
  let namedUser = false
  while (rest.length) {
    const flag = rest[0]
    if (flag === '--') {
      target = rest.slice(1)
      break
    }
    if (!flag.startsWith('-') || flag === '-') {
      // `runuser -u user cmd`: with -u, the first word is the command.
      if (!suLike || (name === 'runuser' && namedUser)) {
        target = rest
        break
      }
      rest = rest.slice(1) // a user name, or `-` meaning a login shell
      continue
    }
    if (flag.startsWith('--')) {
      const eq = flag.indexOf('=')
      const long = eq < 0 ? flag : flag.slice(0, eq)
      const attached = eq < 0 ? undefined : flag.slice(eq + 1)
      if (long === '--login' || (long === '--shell' && (name === 'sudo' || name === 'doas'))) shellFlag = true
      if (long === '--command' || long === '--session-command') command = attached ?? rest[1] ?? ''
      if (long === '--user') namedUser = true
      rest = rest.slice(attached === undefined && valueFlags.has(long) ? 2 : 1)
      continue
    }
    const { letters, takesNext } = shortLetters(flag, valueFlags)
    // sudo -i / -s, doas -s: a login or plain shell as the target user.
    if ((name === 'sudo' || name === 'doas') && letters.some((l) => l === 'i' || l === 's')) shellFlag = true
    if (suLike && letters.includes('l')) shellFlag = true
    if (suLike && letters.includes('u')) namedUser = true
    const last = letters[letters.length - 1]
    if (suLike && last === 'c') command = takesNext ? (rest[1] ?? '') : flag.slice(flag.indexOf('c') + 1)
    rest = rest.slice(takesNext ? 2 : 1)
  }
  if (command !== null) {
    nested.push(command)
    return { shell: runsBareShell(command), target: [] }
  }
  // su, and runuser without `-u user -- cmd`: the result is that user's shell.
  if (name === 'su') return { shell: true, target: [] }
  if (name === 'runuser') return namedUser && target?.length ? { shell: false, target } : { shell: true, target: [] }
  // pkexec, run0, systemd-run and gsudo with nothing to run start a shell.
  if (name === 'pkexec' || name === 'run0' || name === 'systemd-run' || name === 'gsudo' || name === 'nsenter') {
    return { shell: !target?.length, target: target ?? [] }
  }
  return { shell: shellFlag, target: target ?? [] }
}

/** What one segment runs, once everything in front of the working command is stepped over. */
interface SegmentFacts {
  /** The segment as written, redirections included. */
  segment: string
  /** The first command after grammar, assignments and runners -- `sudo -i` for `env sudo -i`. */
  head: string[]
  /** Some escalator stood between the segment and the command it runs. */
  escalated: boolean
  /** ...and the result is an interactive shell as that user. */
  shell: boolean
  /** The working command's own word is computed when it runs. */
  computed: boolean
  /** Some `unshare -r` stood in front of it: root, but only in a new user namespace. */
  nsRoot?: boolean
  /** The command that does the work: past runners AND escalators. Empty if none. */
  argv: string[]
}

/** parallel options that take a value. */
const PARALLEL_VALUE_OPTIONS = new Set(['-j', '-S', '-a', '-I', '-n', '-N', '-P', '--jobs', '--sshlogin', '--arg-file'])

/**
 * `siblings` receives further argvs this segment runs in its own right, each to
 * be walked exactly as the segment itself is -- every find -exec target, not
 * the first one only.
 */
function unwrapSegment(
  tokens: string[],
  nested: string[],
  stdinFed = false,
  siblings: string[][] = []
): Omit<SegmentFacts, 'segment'> {
  const head = stripRunners(tokens, nested) ?? []
  let t = head
  let escalated = false
  let shell = false
  // Set when the command hands over something this walk cannot read at all,
  // such as a base64 PowerShell command.
  let unreadable = false
  let nsRoot = false
  const done = (argv: string[]): Omit<SegmentFacts, 'segment'> => ({
    head,
    escalated,
    shell,
    // FAIL TOWARD ASK. A command word that still holds shell syntax after
    // everything the walk understands -- `$(which sudo)`, `{sudo,reboot}`,
    // `f(){sudo` -- is one this code cannot name, so it is reported for
    // evaluateCommand to ask about rather than guessed at.
    computed: unreadable || (argv.length > 0 && argv[0] !== '[' && UNREADABLE_WORD.test(argv[0])),
    nsRoot,
    argv
  })
  // Bounded: every pass consumes at least the command word.
  for (let pass = 0; pass <= MAX_DEPTH * 3; pass++) {
    const stripped = pass === 0 ? t : stripRunners(t, nested)
    if (!stripped?.length) return done([])
    // `$HOME/bin/tool`, `~/bin/tool`: only the home directory is computed, so
    // the literal basename is judged -- `~/bin/sudo` is still sudo.
    let argv = [stripped[0].replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/)/, ''), ...stripped.slice(1)]
    // `cmd.exe/c runas …`: cmd takes a switch glued straight onto its name.
    const glued = /^(.*\bcmd(?:\.exe)?)(\/[a-z].*)$/i.exec(argv[0])
    if (glued) argv = [glued[1], glued[2], ...argv.slice(1)]
    const windowsName = commandName(argv[0]).toLowerCase()
    const name = !ESCALATORS.has(word(argv[0])) && WINDOWS_ESCALATORS.has(windowsName) ? windowsName : word(argv[0])

    // sudoedit edits its operands as root; they are files, not a command.
    if (name === 'sudoedit') {
      escalated = true
      return done([])
    }
    // `machinectl shell [user@]host [cmd ...]`: bare, it is a shell.
    if (name === 'machinectl' && argv[1] === 'shell') {
      escalated = true
      let i = 2
      while (i < argv.length && argv[i].startsWith('-')) i++
      const cmd = argv.slice(i + 1)
      if (!cmd.length) {
        shell = true
        return done([])
      }
      t = cmd
      continue
    }
    // `capsh … -- ARGS` hands ARGS to /bin/bash.
    // `nsenter --help`, `sudo --version`: the tool describing itself. (The
    // start-of-string sudo/doas test still counts those two as sudo.)
    const privileged = ESCALATORS.has(name) || name === 'capsh' || name === 'setpriv' || name === 'unshare'
    if (privileged && argv.length === 2 && (argv[1] === '--help' || argv[1] === '--version')) return done([])
    // `capsh` changes identity with --user/--uid/--gid, and `capsh … -- ARGS`
    // hands ARGS to /bin/bash -- a bare `--` is a shell.
    if (name === 'capsh') {
      if (argv.some((a) => /^--(?:user|uid|gid)=/.test(a) || a === '--')) escalated = true
      const dash = argv.indexOf('--')
      if (dash >= 0) {
        t = ['bash', ...argv.slice(dash + 1)]
        continue
      }
      return done(argv)
    }
    // `setpriv` sets the real and effective ids and the groups; given any of
    // those it is an escalation. Otherwise (`setpriv --dump`, a capability
    // tweak) it is stepped over like a runner.
    if (name === 'setpriv') {
      if (argv.some((a) => /^--(?:reuid|regid|ruid|euid|rgid|egid|init-groups|clear-groups|keep-groups|groups)\b/.test(a))) {
        escalated = true
      }
      const target = afterOptions(argv, SETPRIV_VALUE_OPTIONS)
      if (!target.length) return done([])
      t = target
      continue
    }
    // `unshare -r` / `--map-root-user` is root only inside a new user
    // namespace, and it is everyday rootless tooling -- so it asks rather than
    // being refused as sudo.
    if (name === 'unshare') {
      if (argv.some((a) => a === '--map-root-user' || /^-[A-Za-z]*r[A-Za-z]*$/.test(a))) nsRoot = true
      const target = afterOptions(argv, UNSHARE_VALUE_OPTIONS)
      if (!target.length) return done([])
      t = target
      continue
    }
    if (ESCALATORS.has(name)) {
      escalated = true
      const e = escalation(argv, nested, name)
      if (e.shell) shell = true
      if (!e.target.length) return done([])
      t = e.target
      continue
    }

    // The working command. Some of them run a command line of their own.
    if (SHELLS.has(name)) {
      const line = commandString(argv)
      if (line !== undefined) nested.push(line)
      else {
        // No command string: the shell runs its stdin, or a script. Fed by a
        // pipe (`echo "sudo reboot" | sh`), a here-string or here-doc, an
        // input redirection, or a process substitution in place of the
        // script, what it runs is not on this line to read -- so it asks.
        const script = scriptOperand(argv)
        if (
          (script === undefined && stdinFed) ||
          (script !== undefined && /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|<\(.*)$/.test(script))
        ) {
          unreadable = true
        }
      }
    }
    // More commands that run a command of their own.
    //
    // find: `-exec CMD … ;` / `+`, `-execdir`, `-ok`, `-okdir` run CMD per file,
    // as an argv, not a command line. EVERY action group is collected, and
    // each is walked as its own argv, exactly as this segment is. Joining
    // them with spaces took `bash -lc "cat /etc/shadow"` apart; walking only
    // the first missed the rest.
    //
    // A segment that starts like the middle of a find expression -- a
    // predicate or operator (`-o`, `-name`, `-fprint`, `-exec`), with `!`, `(`
    // and `\(` already stepped over as grammar -- and holds an action is the
    // tail of a find whose `;` was left unescaped: the shell split it there.
    // It runs nothing in a real shell, and it is walked all the same -- the
    // cheap direction to be wrong in. No real command word starts with `-`,
    // so `echo -exec` or `grep -- -exec` are never read this way.
    const findAction = /^-(?:exec|execdir|ok|okdir)$/
    const findTail = argv[0].startsWith('-') && argv.some((a) => findAction.test(a))
    if (name === 'find' || findTail) {
      const from = name === 'find' ? 1 : 0
      const targets: string[][] = []
      for (let i = from; i < argv.length; i++) {
        if (!findAction.test(argv[i])) continue
        const end = argv.findIndex((a, j) => j > i && (a === ';' || a === '+'))
        const cmd = argv.slice(i + 1, end < 0 ? undefined : end)
        if (cmd.length) targets.push(cmd)
        if (end < 0) break
        i = end
      }
      if (targets.length) {
        siblings.push(...targets)
        return done([])
      }
    }
    if (name === 'sg') {
      // `sg [-] GROUP [-c] "command"`
      const rest = argv.slice(1).filter((a) => a !== '-')
      const cmd = rest.slice(1).filter((a) => a !== '-c')
      if (cmd.length) nested.push(cmd.join(' '))
    }
    if (name === 'parallel') {
      // `parallel [opts] TEMPLATE ::: args` runs the template per argument;
      // with no template, each argument is itself the command.
      let i = 1
      while (i < argv.length && argv[i].startsWith('-') && !argv[i].startsWith(':::')) {
        i += PARALLEL_VALUE_OPTIONS.has(argv[i]) ? 2 : 1
      }
      const sep = argv.findIndex((a, j) => j >= i && /^::::?\+?$/.test(a))
      const template = argv.slice(i, sep < 0 ? undefined : sep)
      if (template.length) nested.push(template.join(' '))
      else if (sep >= 0) for (const a of argv.slice(sep + 1)) if (!/^::::?\+?$/.test(a)) nested.push(a)
    }
    // cmd and PowerShell run a command line too: everything after `/c` or
    // `/k`, or after `-Command` (which PowerShell lets you shorten to `-c`).
    // A base64 `-EncodedCommand` cannot be read here, so it is asked about.
    const windows = commandName(argv[0]).toLowerCase()
    if (windows === 'cmd') {
      // cmd is not parsed, it is failed toward ask. Its switches may be glued
      // together or onto the command (`/C/Crunas`, `/cRUNAS`), `/r` is `/c`,
      // `^` is its escape (`ru^nas`), and it expands `%VAR%` and, with
      // `/v:on`, `!VAR!` itself -- after any `&` inside the string, too, so a
      // `%` anywhere cannot be read the way cmd reads it. The carets are
      // stripped so the command is still seen and judged; any `^`, `%`, `!`
      // or `/v:on` also asks.
      const first = argv.findIndex((a, i) => i > 0 && a.startsWith('/'))
      if (first >= 0) {
        let line = argv.slice(first).join(' ')
        let runs = false
        for (let m = /^\s*\/([a-z])(:\w+)?/i.exec(line); m; m = /^\s*\/([a-z])(:\w+)?/i.exec(line)) {
          if (/^v$/i.test(m[1]) && /^:on$/i.test(m[2] ?? '')) unreadable = true
          line = line.slice(m[0].length)
          if (/^[ckr]$/i.test(m[1])) runs = true
        }
        line = line.trim()
        if (runs && line) {
          if (/[\^%!]/.test(line)) unreadable = true
          nested.push(line.replace(/\^/g, ''))
        }
      }
    }
    if (windows === 'powershell' || windows === 'pwsh') {
      if (argv.some((a) => /^-e(?:c|n\w*)?$/i.test(a))) unreadable = true
      // `-Command` (or any prefix of it) takes the rest of the line; with no
      // switch at all, the first word that is not an option starts an
      // implicit -Command: `powershell Start-Process cmd -Verb RunAs`.
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i]
        if (/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a)) {
          if (i + 1 < argv.length) nested.push(argv.slice(i + 1).join(' '))
          break
        }
        if (/^-f(?:i(?:l(?:e)?)?)?$/i.test(a)) break
        if (a.startsWith('-')) {
          if (POWERSHELL_VALUE_OPTIONS.test(a)) i++
          continue
        }
        nested.push(argv.slice(i).join(' '))
        break
      }
    }
    // PowerShell's eval.
    if ((windows === 'iex' || windows === 'invoke-expression') && argv.length > 1) nested.push(argv.slice(1).join(' '))
    // A PowerShell scriptblock runs its body: `Invoke-Command { runas … }`,
    // `icm -ScriptBlock { … }`, `Start-Job { … }`. The body is walked; a block
    // handed over some other way (a variable) cannot be read, so it asks.
    if (SCRIPTBLOCK_RUNNERS.has(windows)) {
      const rest = argv.slice(1).join(' ')
      const open = rest.indexOf('{')
      const close = rest.lastIndexOf('}')
      if (open >= 0 && close > open) nested.push(rest.slice(open + 1, close))
      else unreadable = true
    }
    // `Start-Process <file> -Verb RunAs` is PowerShell's sudo.
    if (['start-process', 'saps', 'start'].includes(windows)) {
      const runas = argv.some((a, i) => /^-verb:runas$/i.test(a) || (/^-verb$/i.test(a) && /^runas$/i.test(argv[i + 1] ?? '')))
      if (runas) {
        escalated = true
        const fp = argv.findIndex((a) => /^-filepath$/i.test(a))
        const file = fp >= 0 ? argv[fp + 1] : argv.slice(1).find((a) => !a.startsWith('-'))
        const al = argv.findIndex((a) => /^-argumentlist$/i.test(a))
        const args = al >= 0 ? (argv[al + 1] ?? '') : ''
        if (file) {
          const line = `${file} ${args}`.trim()
          nested.push(line)
          if (runsBareShell(line)) shell = true
        }
        return done([])
      }
    }
    // A shell -- POSIX, cmd or PowerShell -- left open as the other user.
    if (escalated && isBareShell(argv)) shell = true
    if (name === 'eval' && argv.length > 1) nested.push(argv.slice(1).join(' '))
    if (name === 'script') {
      const line = commandString(argv)
      if (line !== undefined) nested.push(line)
    }
    return done(argv)
  }
  return done([])
}

/**
 * Where the `(` opened just before `from` closes, or -1.
 *
 * Quotes, escapes and backticks are skipped over, nested parens counted, and a
 * `case` arm's `pattern)` is not taken for the close: inside `case … esac`, a
 * `)` at the depth the `case` began is the end of a pattern, which is exactly
 * where the innermost-only regex this replaced came apart --
 * `$(case a in a) sudo reboot;; esac)` never reached the walk at all.
 */
function closingParen(s: string, from: number): number {
  let depth = 1
  const caseAt: number[] = []
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = closingQuote(s, i)
      if (end < 0) return -1
      i = end
      continue
    }
    // A word at a word boundary: track `case` ... `esac`.
    if (/[A-Za-z_]/.test(c) && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      const w = /^[A-Za-z_]\w*/.exec(s.slice(i))![0]
      if (w === 'case') caseAt.push(depth)
      else if (w === 'esac') caseAt.pop()
      i += w.length - 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      if (caseAt.length && caseAt[caseAt.length - 1] === depth) continue
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Where the quote (or backtick) opening at `at` closes, or -1. */
function closingQuote(s: string, at: number): number {
  const q = s[at]
  for (let i = at + 1; i < s.length; i++) {
    if (q !== "'" && s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === q) return i
  }
  return -1
}

/**
 * The command lines a string runs by substitution: `$(…)`, `<(…)`, `>(…)`
 * and backticks, found by a scanner that respects quotes and escapes and
 * matches parens properly -- so a substitution with parens of its own, or a
 * `case` inside it, is read whole. Nothing is expanded inside single quotes,
 * and `<(` inside double quotes is only text, as in the shell. `ok` is false
 * when something opens and never closes.
 */
function substitutions(command: string): { inner: string[]; ok: boolean } {
  const inner: string[] = []
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote === "'") {
      if (c === "'") quote = null
      continue
    }
    if (c === '\\') {
      i++
      continue
    }
    if (c === '`') {
      const end = closingQuote(command, i)
      if (end < 0) return { inner, ok: false }
      // Inside backquotes `\``, `\$` and `\\` stand for the character itself
      // -- it is the only way backquotes nest -- and inside double quotes so
      // does `\"`. Walked raw, `echo \`echo \\\`sudo reboot\\\`\``
      // never reached its sudo.
      const escapes = quote === '"' ? /\\([`$\\"])/g : /\\([`$\\])/g
      inner.push(command.slice(i + 1, end).replace(escapes, '$1'))
      i = end
      continue
    }
    const opens = command.startsWith('$(', i) || (!quote && (command.startsWith('<(', i) || command.startsWith('>(', i)))
    if (opens) {
      const arithmetic = command.startsWith('$((', i)
      const end = closingParen(command, i + 2)
      if (end < 0) return { inner, ok: false }
      const body = command.slice(i + 2, end)
      // `$(( … ))` is arithmetic, not a command -- but a `$(…)` inside it runs.
      if (arithmetic) {
        const deeper = substitutions(body.slice(1, -1))
        if (!deeper.ok) return { inner, ok: false }
        inner.push(...deeper.inner)
      } else inner.push(body)
      i = end
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
  }
  return { inner, ok: quote === null }
}

/**
 * Every segment of a command line, and of every command line nested inside it,
 * with what each one runs. The single walk both the escalation check and the
 * path rules read.
 */
function walkCommand(command: string, visit: (facts: SegmentFacts) => void, depth = 0): void {
  const nested: string[] = []
  // `$(...)`, `<(...)`, `>(...)` and backticks run whatever they hold.
  const subs = substitutions(command)
  nested.push(...subs.inner)

  // A string whose quotes or substitutions do not close is one the shell will
  // read differently from anything here: fail toward ask.
  if (!subs.ok || !quotesBalanced(command)) {
    visit({ segment: '', head: [], escalated: false, shell: false, computed: true, argv: [] })
  }

  const piped: boolean[] = []
  splitSegments(command, piped).forEach((segment, i) => {
    // Redirection targets are files, never the command; the path rules read
    // them off `segment` directly.
    const tokens = tokenize(withoutRedirections(segment))
    // Does this segment's stdin come from somewhere other than the terminal:
    // a pipe, or an input redirection (`<`, `<<`, `<<<`) that is not a
    // process substitution? A shell with no command string runs it.
    const redirectedIn = [...segment.matchAll(REDIRECTION)].some((m) => m[1].startsWith('<') && !m[2].startsWith('('))
    const walkArgv = (text: string, argv: string[], fed: boolean): void => {
      const siblings: string[][] = []
      visit({ segment: text, ...unwrapSegment(argv, nested, fed, siblings) })
      // Redirections belong to the segment they were written on, so a
      // sibling carries none of its own.
      for (const sibling of siblings) walkArgv('', sibling, false)
    }
    walkArgv(segment, tokens, piped[i] || redirectedIn)
  })
  if (depth < MAX_DEPTH) for (const inner of nested) walkCommand(inner, visit, depth + 1)
  // Nested deeper than the walk goes: whatever is down there was not read, so
  // it fails toward ask like any other command that cannot be named.
  else if (nested.length) visit({ segment: '', head: [], escalated: false, shell: false, computed: true, argv: [] })
}

export function classifyCommand(command: string): CommandClassification {
  const trimmed = command.trim()
  const out: CommandClassification = {
    // The original start-of-string tests, kept so this can only get stricter.
    isSudo: /^sudo\b/.test(trimmed) || /^doas\b/.test(trimmed),
    isUnrestrictedShell: UNRESTRICTED_SHELL_PATTERNS.some((rx) => rx.test(trimmed)),
    computedCommand: false
  }
  walkCommand(trimmed, (f) => {
    // The start-of-segment patterns, against the segment with its command
    // word read as the shell reads it: `/usr/bin/sudo -i` reads as `sudo -i`.
    if (f.head.length) {
      const normal = [word(f.head[0]), ...f.head.slice(1)].join(' ')
      if (UNRESTRICTED_SHELL_PATTERNS.some((rx) => rx.test(normal))) out.isUnrestrictedShell = true
    }
    if (f.escalated) out.isSudo = true
    if (f.shell) out.isUnrestrictedShell = true
    if (f.computed) out.computedCommand = true
    if (f.nsRoot) out.namespaceRoot = true
  })
  // A refused shell is an escalation too, whatever spelled it.
  if (out.isUnrestrictedShell) out.isSudo = true
  return out
}


// Absolute paths a command will read or write, as far as that can be told from
// a command line.
//
// The point is that `execute_command "cat /etc/shadow"` and
// `read_file /etc/shadow` must not disagree. Path rules only ever applied to
// the SFTP tools, so the seeded /etc/shadow and /root/.ssh/** denies were
// bypassed by the tool an agent reaches for first.
//
// This is deliberately best-effort and deliberately narrow:
//
//   * Only ABSOLUTE paths are considered. A relative operand cannot be matched
//     against a pattern like "/etc/shadow" without knowing the remote working
//     directory, and treating every bare word as a path would put a file
//     decision in front of commands that touch no files at all.
//   * Only well-known file-reading and file-writing commands are inspected.
//     Guessing at arbitrary binaries would produce noise, not safety.
//
// So `cd /root/.ssh && cat id_rsa` still gets through, and always will while
// commands are strings. It closes the direct, obvious form — which is the form
// a model actually emits — and it never widens anything: the result is folded
// in with mostRestrictive.
// Compared against commandName(), which lowercases nothing — so POSIX stays
// case-sensitive. The Windows and PowerShell names below are additionally
// matched case-insensitively, because `TYPE` and `Get-Content` are the same
// command as `type` and `get-content` on a shell that does not care.
const READ_COMMANDS = new Set([
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'rev', 'strings', 'xxd', 'od', 'hexdump',
  'base64', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'wc', 'cut', 'sort', 'uniq',
  'grep', 'egrep', 'fgrep', 'rgrep', 'awk', 'diff', 'cmp', 'file', 'stat', 'readlink', 'realpath'
])

// cmd.exe and PowerShell. Without these, fixing the path shapes alone would
// still have missed `type C:\Users\me\.ssh\id_rsa` — the path is recognised but
// nothing marks the command as one that reads a file.
const WINDOWS_READ_COMMANDS = new Set([
  'type', 'get-content', 'gc', 'select-string', 'get-filehash', 'format-hex', 'import-csv'
])

const WINDOWS_WRITE_COMMANDS = new Set([
  'del', 'erase', 'rd', 'rmdir', 'ren', 'rename', 'move', 'copy', 'xcopy', 'robocopy',
  'set-content', 'add-content', 'out-file', 'remove-item', 'ri', 'new-item', 'set-acl'
])

const WRITE_COMMANDS = new Set([
  'tee', 'truncate', 'shred', 'rm', 'unlink', 'install', 'ln', 'touch', 'mkdir', 'rmdir',
  'chmod', 'chown', 'chgrp', 'dd'
])

// Read their source operands and write their last one.
const COPY_COMMANDS = new Set(['cp', 'mv', 'rsync', 'scp'])

// Wrappers whose own flags precede the command that matters.
const PREFIXES = new Set(['sudo', 'doas', 'command', 'env', 'nohup', 'time', 'nice', 'ionice', 'stdbuf'])

// Short flags on those wrappers that consume the next token, so `sudo -u root
// cat /etc/shadow` does not stop at "root" and conclude the command was `root`.
const PREFIX_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-R']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e'])
}

export interface PathAccess {
  path: string
  mode: 'read' | 'write'
}

// Splits on the shell operators that start a new command, respecting quotes so
// a separator inside an argument is not treated as one.
function splitSegments(command: string, piped?: boolean[]): string[] {
  const out: string[] = []
  // One entry per separator: whether it was a single `|`.
  const fed: boolean[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    // POSIX quoting, as tokenize reads it: nothing escapes inside single
    // quotes; inside double quotes and outside quotes a backslash takes the
    // next character with it, so `\;` and `"a\"b"` never end a segment.
    if (quote === "'") {
      if (c === quote) quote = null
      current += c
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      current += c + command[i + 1]
      i++
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(current)
      fed.push(false)
      current = ''
      i++
      continue
    }
    // A lone `&` backgrounds one command and starts the next. `2>&1`, `&>`
    // and `>&` are redirections, not separators.
    if (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<' && command[i + 1] !== '>') {
      out.push(current)
      fed.push(false)
      current = ''
      continue
    }
    if (c === ';' || c === '|' || c === '\n') {
      out.push(current)
      fed.push(c === '|')
      current = ''
      continue
    }
    current += c
  }
  out.push(current)
  // `piped[i]` says whether segment i reads the output of the one before it,
  // for walkCommand's `… | sh` rule. Kept in step with the empty-segment
  // filter below.
  const kept = out.map((segment, i) => ({ segment, piped: fed[i - 1] ?? false })).filter((x) => x.segment.trim())
  piped?.push(...kept.map((x) => x.piped))
  return kept.map((x) => x.segment)
}

/**
 * Words, as a POSIX shell reads them.
 *
 * Outside quotes a backslash escapes the next character (`\sudo` is `sudo`);
 * inside double quotes only `\"`, `\\`, `\$`, a backtick and a newline are
 * escapes; inside single quotes nothing is. The tokenizer used to ignore
 * backslashes altogether, so a correctly quoted nest -- `sh -c "sh -c \"sh -c
 * 'sudo reboot'\""`, or the `'\''` that shlex.quote emits -- came apart in
 * the wrong places and the sudo at the bottom was never seen.
 *
 * ONE EXCEPTION: a word that begins like a Windows path (`C:\`, `\\server`)
 * keeps its backslashes. On a Windows target they are separators, not
 * escapes, and the path rules and the Windows escalator names are matched
 * against them; on a POSIX host such a word names nothing either way.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let literal = false
  let quote: string | null = null
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else current += c
      continue
    }
    if (quote === '"') {
      if (c === '\\' && i + 1 < segment.length && '"\\$`\n'.includes(segment[i + 1])) {
        if (segment[i + 1] !== '\n') current += segment[i + 1]
        i++
      } else if (c === '"') quote = null
      else current += c
      continue
    }
    if (!started) literal = /^(?:[A-Za-z]:\\|\\\\)/.test(segment.slice(i))
    if (c === '\\' && !literal) {
      if (i + 1 < segment.length && segment[i + 1] !== '\n') current += segment[i + 1]
      i++
      started = true
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      started = true
      continue
    }
    if (/\s/.test(c)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += c
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * Does every quote close, and does the line not end on a bare backslash? A
 * string that fails this cannot be read the way the shell will read it, so
 * walkCommand fails toward ask on it.
 */
function quotesBalanced(line: string): boolean {
  let quote: string | null = null
  let literal = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = null
      continue
    }
    // tokenize's exception, kept here too: `dir C:\` does not end on an escape.
    if (!quote && (i === 0 || /\s/.test(line[i - 1]))) literal = /^(?:[A-Za-z]:\\|\\\\)/.test(line.slice(i))
    if (c === '\\' && (quote || !literal)) {
      if (i + 1 >= line.length) return false
      i++
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
  }
  return quote === null
}

// Three absolute-path shapes, not one.
//
// This used to be `t.startsWith('/')`, which is every absolute path on Linux
// and none on Windows. The failure was silent and total: a Windows target's
// commands yielded zero PathAccess entries, so the reduce in evaluateCommand
// folded over an empty array and every file rule in the group was skipped —
// while the UI went on showing them as configured. Blanket `readFiles: allow`
// in three of the four built-in groups then let `type C:\Users\me\.ssh\id_rsa`
// straight through.
//
//   POSIX         /etc/shadow
//   drive-letter  C:\Users\me\.ssh   and   C:/Users/me/.ssh
//   UNC           \\server\share\x   and   //server/share/x
//
// Relative paths stay out, for the reason documented at the top of this file:
// we cannot resolve them without knowing the remote working directory.
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/
const UNC = /^[\\/]{2}[^\\/]/

export const isAbsolute = (t: string): boolean =>
  t.startsWith('/') || DRIVE_LETTER.test(t) || UNC.test(t)

export const isWindowsPath = (t: string): boolean =>
  DRIVE_LETTER.test(t) || (UNC.test(t) && t.includes('\\'))

// Both separators mean the same thing on Windows, and a rule written one way
// must match a command written the other. Everything is compared in forward
// slashes; a UNC path keeps its leading pair so `//server/share` cannot be
// confused with an absolute POSIX path.
export const toMatchPath = (t: string): string => t.replace(/\\/g, '/')

// `cat`, `/bin/cat`, `C:\Windows\System32\more.com` and `MORE.COM` are all the
// same command for our purposes. Splitting on `/` alone left every
// backslash-qualified Windows invocation unrecognised.
const commandName = (token: string): string =>
  (token.split(/[\\/]/).pop() ?? '').replace(/\.(exe|com|cmd|bat|ps1)$/i, '')

/** The paths one command's argv reads or writes, onto `found`. */
function pathsFromArgv(tokens: string[], found: PathAccess[]): void {
  if (tokens.length === 0) return

  const name = commandName(tokens[0])
  const lower = name.toLowerCase()
  // PowerShell and cmd flags are `/Q`, `/S`, `-Path` — a `/`-prefixed token
  // is a flag there, not the absolute path it would be on POSIX. Only drop
  // slash-flags when the command is a Windows one, or `cat /etc/shadow`
  // would lose its operand.
  const isWindowsCmd = WINDOWS_READ_COMMANDS.has(lower) || WINDOWS_WRITE_COMMANDS.has(lower)
  const operands = tokens
    .slice(1)
    .filter((t) => !t.startsWith('-'))
    .filter((t) => !(isWindowsCmd && /^\/[A-Za-z?]$/.test(t)))

  if (COPY_COMMANDS.has(name)) {
    // Last operand is the destination; everything before it is a source.
    operands.forEach((t, i) => {
      if (!isAbsolute(t)) return
      found.push({ path: t, mode: i === operands.length - 1 && operands.length > 1 ? 'write' : 'read' })
    })
    return
  }

  // `sed -i` edits in place; without it the operands are only read.
  const mode: 'read' | 'write' | null =
    name === 'sed' || name === 'perl'
      ? tokens.some((t) => /^-\w*i/.test(t))
        ? 'write'
        : 'read'
      : READ_COMMANDS.has(name) || WINDOWS_READ_COMMANDS.has(lower)
        ? 'read'
        : WRITE_COMMANDS.has(name) || WINDOWS_WRITE_COMMANDS.has(lower)
          ? 'write'
          : null
  if (!mode) return

  // grep/awk/sed take a pattern or script before their file operands, but a
  // pattern is not an absolute path, so filtering on that is enough.
  for (const t of operands) {
    if (isAbsolute(t)) found.push({ path: t, mode })
    // dd if=/x of=/y
    const kv = /^(if|of)=(.+)$/.exec(t)
    if (kv && isAbsolute(kv[2])) found.push({ path: kv[2], mode: kv[1] === 'of' ? 'write' : 'read' })
  }
}

export function extractPathAccesses(command: string): PathAccess[] {
  const found: PathAccess[] = []

  // Every segment walkCommand visits, not only the outer line's: `sh -c 'cat
  // /etc/shadow'` and `echo $(cat /root/.ssh/id_rsa)` read the file exactly as
  // `cat /etc/shadow` does, and used to reach no path rule. The same walk the
  // escalation check reads, so the two cannot disagree about what runs.
  walkCommand(command, ({ segment, argv }) => {
    // Redirections bind to the segment, not to any particular argv entry, and
    // `> /etc/passwd` is a write however harmless the command in front of it.
    for (const m of segment.matchAll(REDIRECTION)) {
      const target = m[2].replace(/^["']|["']$/g, '')
      if (isAbsolute(target)) found.push({ path: target, mode: m[1].includes('>') ? 'write' : 'read' })
    }

    // The original prefix stripping, kept as it was so nothing it found is
    // lost...
    let tokens = tokenize(withoutRedirections(segment))
    while (tokens.length && PREFIXES.has(commandName(tokens[0]))) {
      const wrapper = commandName(tokens[0])
      const valueFlags = PREFIX_VALUE_FLAGS[wrapper] ?? new Set<string>()
      tokens = tokens.slice(1)
      while (tokens.length && tokens[0].startsWith('-')) {
        const takesValue = valueFlags.has(tokens[0])
        tokens = tokens.slice(takesValue ? 2 : 1)
      }
      // `env FOO=bar cmd` and `sudo FOO=bar cmd`
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1)
    }
    pathsFromArgv(tokens, found)
    // ...and the walk's own answer, which also steps over grammar, the wider
    // set of wrappers and every escalator (timeout, xargs, busybox, pkexec,
    // run0, runuser, ...). Together they can only find more.
    if (argv.join('\u0000') !== tokens.join('\u0000')) pathsFromArgv(argv, found)
  })

  // One entry per path and mode, first occurrence first.
  const seen = new Set<string>()
  return found.filter((f) => {
    const key = `${f.mode}\u0000${f.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function evaluateCommand(group: AccessGroup | null, command: string): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this server.' }

  const terminal = evaluateCapability(group, 'terminal')
  if (terminal.decision === 'deny') return { decision: 'deny', reason: 'Terminal access is denied for this access group.' }

  const { isSudo, isUnrestrictedShell, computedCommand, namespaceRoot } = classifyCommand(command)
  if (isUnrestrictedShell) {
    return {
      decision: 'deny',
      reason: 'Unrestricted privilege-escalation shells (sudo -i, su, sudo bash, ...) are always blocked.'
    }
  }

  // Both branches fall through to the path check below rather than returning:
  // `sudo cat /etc/shadow` under a group with sudo=allow must still be refused
  // by the /etc/shadow rule, not waved through because sudo was permitted.
  let base: Decision
  let sudoGranted = false
  if (isSudo) {
    const sudo = evaluateCapability(group, 'sudo')
    if (sudo.decision === 'deny') return { decision: 'deny', reason: 'Sudo is denied for this access group.' }
    sudoGranted = sudo.decision === 'allow'
    base =
      sudo.decision === 'ask'
        ? { decision: 'ask', reason: 'Sudo commands require approval.' }
        : { decision: 'allow', reason: 'Sudo allowed by access group.' }
  } else {
    base =
      terminal.decision === 'ask'
        ? { decision: 'ask', reason: 'Terminal commands require approval for this access group.' }
        : { decision: 'allow', reason: 'Allowed by access group.' }
  }

  // A command word computed when it runs -- `$(which sudo) reboot`,
  // `${SUDO:-sudo} reboot` -- cannot be named here, so it cannot be graded:
  // it might be sudo, and a group that denies sudo would never know. Asked
  // about rather than refused, because `$HOME/bin/tool` is the same shape and
  // usually harmless; a human can tell which one it is.
  // `unshare -r`: root, but only inside a new user namespace -- everyday
  // rootless tooling, and not the host's root. Asked about, not refused.
  if (base.decision === 'allow' && namespaceRoot) {
    base = {
      decision: 'ask',
      reason: 'Requires approval: it runs as root inside a new user namespace (unshare -r).'
    }
  }
  if (base.decision === 'allow' && computedCommand) {
    base = {
      decision: 'ask',
      reason: 'Requires approval: the command it runs is computed when it runs, so OpsMaxx cannot tell what it is.'
    }
  }

  // THE DANGEROUS FORM IS NEVER GRANTED SILENTLY, WHATEVER THE GROUP SAYS.
  //
  // That sentence is thirty lines further down this file, about DROP TABLE,
  // and the terminal path did not have it. `terminal` is `allow` in all four
  // built-in groups, so `docker volume rm data`, `rm -rf /var/lib` and
  // `systemctl stop postgresql` reached an agent with no approval card at all.
  // Grading them `high` in mcpServer.ts does not fix that on its own: a
  // decision of `allow` never opens a card for a grade to appear on.
  //
  // SUDO IS DELIBERATELY EXEMPT. A group that has explicitly set sudo to
  // `allow` has had that decision made by a human, and re-asking would
  // overrule them -- so a command whose ONLY finding is "runs as root" is left
  // to the sudo branch above. `sudo rm -rf /` still lands here, because its
  // finding is the rm, not the sudo.
  //
  // A GROUP THAT GRANTED SUDO HAS ALREADY ANSWERED THE `elevated` TIER.
  // `sudo docker build`, `sudo systemctl restart`, `sudo apt install` are the
  // ordinary work of an operator who deliberately set sudo to `allow`, and
  // asking anyway made that setting mean nothing: a Full Access session still
  // raised a card on every one of them, and a card nobody answers in 120
  // seconds is a denial. `destructive` is NOT waived — `assessCommand` stops
  // collecting `elevated` reasons the moment a DESTRUCTIVE rule matches, so
  // `sudo rm -rf /var/lib`, `sudo mkfs`, `sudo dd` and `zfs destroy` still ask
  // whatever the group says. That tier is the one no setting may switch off.
  const assessed = assessCommand(command)
  const beyondSudo = assessed.reasons.filter((r) => r !== SUDO_REASON)
  const waived = sudoGranted && assessed.risk === 'elevated'
  if (base.decision === 'allow' && assessed.risk !== 'ordinary' && beyondSudo.length > 0 && !waived) {
    base = {
      decision: 'ask',
      reason: `Requires approval: this command ${beyondSudo.join(', and ')}.`
    }
  }

  // A path rule can only narrow the command decision, never widen it.
  //
  // On an ask-against-ask tie the explicit path rule is the one NAMED. The
  // decision is the same either way -- ask is ask -- but the reason is what
  // gate() keys a remembered approval on, and mostRestrictive keeps its first
  // argument on a tie. So under terminal=ask, `cat /secret/key` used to reach
  // the gate as "Terminal commands require approval", the same question as
  // `ls /tmp`, and an "allow for this session" given about `ls` answered a
  // rule the operator had written specifically to be asked about.
  return extractPathAccesses(command).reduce<Decision>((acc, { path, mode }) => {
    const byPath = evaluateFilePath(group, path, mode)
    if (acc.decision === 'ask' && byPath.decision === 'ask' && byPath.reason.startsWith('Path rule ')) return byPath
    return mostRestrictive(acc, byPath)
  }, base)
}

// Minimal glob support: `**` crosses path segments, `*` stays within one,
// `?` matches a single character. Good enough for policy patterns like
// "/etc/nginx/**" without pulling in a dependency.
//
// `insensitive` is for Windows paths, where casing carries no meaning. Off by
// default so POSIX targets keep the case-sensitive matching they need.
export function globToRegExp(glob: string, insensitive = false): RegExp {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const DOUBLESTAR = ' DOUBLESTAR '
  pattern = pattern.replace(/\*\*/g, DOUBLESTAR)
  pattern = pattern.replace(/\*/g, '[^/]*')
  pattern = pattern.split(`${DOUBLESTAR}/`).join('(?:.*/)?')
  pattern = pattern.split(DOUBLESTAR).join('.*')
  pattern = pattern.replace(/\?/g, '[^/]')
  return new RegExp(`^${pattern}$`, insensitive ? 'i' : undefined)
}

export function evaluateFilePath(
  group: AccessGroup | null,
  path: string,
  mode: 'read' | 'write'
): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this server.' }

  const capability: AiCapability = mode === 'read' ? 'readFiles' : 'writeFiles'
  const blanket = evaluateCapability(group, capability)

  // Compare in forward slashes so a rule written `C:\Users\*\.ssh\**` matches a
  // command written `C:/Users/me/.ssh/id_rsa` and vice versa, and match
  // case-insensitively when either side is a Windows path — `c:\users\me` and
  // `C:\Users\me` are the same file, and a case-sensitive rule there is a rule
  // that does not hold.
  const target = toMatchPath(path)
  const matches = group.filePolicies
    .filter((rule) => {
      const pattern = toMatchPath(rule.pattern)
      const insensitive = isWindowsPath(rule.pattern) || isWindowsPath(path)
      return globToRegExp(pattern, insensitive).test(target)
    })
    .filter((rule) => (mode === 'read' ? rule.read : rule.write) !== undefined)
    .sort((a, b) => b.pattern.length - a.pattern.length)

  const best = matches[0]
  if (best) {
    const value = (mode === 'read' ? best.read : best.write) as PermissionValue
    return { decision: value, reason: `Path rule "${best.pattern}" (${mode}) = ${value}` }
  }

  if (blanket.decision === 'deny') {
    return { decision: 'deny', reason: `${mode === 'read' ? 'Reading' : 'Writing'} files is denied for this access group.` }
  }
  return blanket
}


// Database statements, classified the way commands already are.
//
// databaseAccess defaults to ALLOW in every built-in group, because until now
// nothing was gated on it. Shipping a query tool that simply honoured that
// would hand a Full Access agent a silent DROP TABLE, so this follows the rule
// the codebase already applies to sudo: the dangerous form is never granted
// silently, whatever the group says.
//
// Reads are governed by databaseAccess alone. Anything that writes is also
// bounded by writeFiles — a group whose whole point is that it cannot change
// anything should not be able to change a row either — and can never resolve
// better than ASK.
export type StatementKind = 'read' | 'mutating' | 'destructive'

const DESTRUCTIVE = /^(drop|truncate|alter|create|rename|grant|revoke|flushall|flushdb|shutdown)\b/
const MUTATING =
  /^(insert|update|delete|replace|merge|upsert|copy|load|call|do|set|del|unlink|expire|rpush|lpush|sadd|hset|incr|decr|append|getset|move|migrate|restore|persist|analyze|analyse|vacuum|reindex|cluster)\b/
const READ = /^(select|show|explain|describe|desc|with|values|table|get|mget|keys|scan|type|ttl|exists|llen|lrange|smembers|hget|hgetall|zrange|info|dbsize|find|aggregate|count|distinct|list)\b/

// THE LEADING VERB IS NOT THE STATEMENT. Three ways that breaks, all of them
// found by the audit rather than by these tests, and all of them ending with a
// `read` grade -- which is `low` risk, which is no prompt, on a group whose
// databaseAccess is `allow`. That is every built-in group.
//
// A DENYLIST, and not a proof. A side-effecting function not named here still
// reads as `read`. The allowlist shape would be safer and is not available:
// every honest read calls count(), now() or coalesce(), so "unknown function
// means mutating" would prompt on every query an operator ever runs. What is
// defensible is that the functions somebody reaches for DURING AN INCIDENT --
// when they are in a hurry and an agent is helping -- are the ones here.
const SIDE_EFFECT_FN =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_switch_wal|pg_switch_xlog|pg_promote|pg_reload_conf|pg_rotate_logfile|pg_drop_replication_slot|pg_create_restore_point|\w*_reset)\s*\(/

// `SELECT * INTO newtable FROM t` CREATES A RELATION -- Postgres and MSSQL
// both. The verb is still `select`.
const SELECT_INTO = /^select\b[\s\S]*\binto\s+\S/

// EXPLAIN plans. EXPLAIN ANALYZE **runs the statement**, so
// `explain analyze delete from users` deletes the rows, and every word in
// front of `delete` says this is a read.
const EXPLAIN_OPTS = new Set([
  'analyze', 'analyse', 'verbose', 'costs', 'settings', 'buffers', 'wal',
  'timing', 'summary', 'generic_plan', 'memory', 'serialize', 'format',
  'text', 'json', 'xml', 'yaml', 'on', 'off', 'true', 'false'
])

function stripExplain(s: string): { rest: string; executes: boolean } | null {
  if (!/^explain\b/.test(s)) return null
  let rest = s.slice('explain'.length).trim()
  let executes = false
  const paren = /^\(([^)]*)\)/.exec(rest)
  if (paren) {
    // EXPLAIN (ANALYZE FALSE) does not execute, and saying so costs one test.
    executes = /\banaly[sz]e\b(?!\s*(false|off))/.test(paren[1])
    rest = rest.slice(paren[0].length).trim()
  } else {
    for (;;) {
      const m = /^([a-z_]+)\b/.exec(rest)
      if (!m || !EXPLAIN_OPTS.has(m[1])) break
      if (m[1] === 'analyze' || m[1] === 'analyse') executes = true
      rest = rest.slice(m[0].length).trim()
    }
  }
  return { rest, executes }
}

// Strips leading comments and parenthesised prefixes so the verb is the first
// thing tested, and splits on ; so a read cannot smuggle a write behind one.
function statements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.trim().replace(/^\(+/, '').trim().toLowerCase())
    .filter(Boolean)
}

// Mongo shell statements lead with the collection, not the verb —
// db.users.find({}) — so the leading-verb tests never see the operation.
const MONGO = /^db\.(?:getcollection\(['"]?[\w.$-]+['"]?\)|[\w.$-]+)\.(\w+)\s*\(/
const MONGO_READ = new Set([
  'find', 'findone', 'aggregate', 'count', 'countdocuments', 'estimateddocumentcount',
  'distinct', 'getindexes', 'stats', 'explain', 'watch'
])
const MONGO_DESTRUCTIVE = new Set(['drop', 'dropindex', 'dropindexes', 'renamecollection'])

function classifyMongo(s: string): StatementKind | null {
  if (/^db\.dropdatabase\s*\(/.test(s)) return 'destructive'
  const m = MONGO.exec(s)
  if (!m) return null
  const method = m[1].toLowerCase()
  if (MONGO_DESTRUCTIVE.has(method)) return 'destructive'
  return MONGO_READ.has(method) ? 'read' : 'mutating'
}

export function classifyStatement(sql: string): StatementKind {
  let worst: StatementKind = 'read'
  for (const s of statements(sql)) {
    const mongo = classifyMongo(s)
    if (mongo === 'destructive') return 'destructive'
    if (mongo === 'mutating') {
      worst = 'mutating'
      continue
    }
    if (mongo === 'read') continue

    // Graded by what it RUNS, not by the word in front of it.
    const ex = stripExplain(s)
    if (ex) {
      if (!ex.executes) continue
      if (ex.rest) {
        const inner = classifyStatement(ex.rest)
        if (inner === 'destructive') return 'destructive'
        if (inner === 'mutating') worst = 'mutating'
        continue
      }
    }

    if (DESTRUCTIVE.test(s)) return 'destructive'
    if (MUTATING.test(s) || SIDE_EFFECT_FN.test(s) || SELECT_INTO.test(s)) worst = 'mutating'
    // An unrecognised verb is treated as mutating rather than read. There are
    // far too many dialects to enumerate, and guessing "harmless" is the
    // expensive direction to be wrong in.
    else if (!READ.test(s)) worst = worst === 'read' ? 'mutating' : worst
  }
  return worst
}

export function evaluateDatabaseStatement(group: AccessGroup | null, sql: string): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this workspace.' }

  const access = evaluateCapability(group, 'databaseAccess')
  if (access.decision === 'deny') return { decision: 'deny', reason: 'Database access is denied for this access group.' }

  const kind = classifyStatement(sql)
  if (kind === 'read') return access

  const write = evaluateCapability(group, 'writeFiles')
  if (write.decision === 'deny') {
    return {
      decision: 'deny',
      reason: `This statement ${kind === 'destructive' ? 'changes schema or permissions' : 'modifies data'}, and this access group cannot write.`
    }
  }
  const combined = mostRestrictive(access, write)
  // Never silently: a write or a DDL always surfaces an approval prompt.
  return combined.decision === 'allow'
    ? { decision: 'ask', reason: `Statements that ${kind === 'destructive' ? 'change schema or permissions' : 'modify data'} always require approval.` }
    : combined
}

// Opening a tunnel binds a listener on the user's own machine, so it gets the
// same treatment: bounded by sshTunnel and never granted silently.
export function evaluateTunnelOpen(group: AccessGroup | null): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this workspace.' }
  const tunnel = evaluateCapability(group, 'sshTunnel')
  if (tunnel.decision === 'deny') return { decision: 'deny', reason: 'SSH tunnels are denied for this access group.' }
  return tunnel.decision === 'allow'
    ? { decision: 'ask', reason: 'Opening a tunnel binds a port on your machine and always requires approval.' }
    : tunnel
}

// Defining a tunnel is not the safer half of set_tunnel.
//
// Opening one binds a port; WRITING one decides where that port goes, and it
// survives the session that created it -- the next person to press Start in the
// Tunnels view starts whatever an agent wrote there. A `remote` forward is the
// sharp end: it listens ON THE SERVER, so a non-loopback listen address
// publishes the port to that server's whole network. So this is never silent
// either, and the tool grades a non-loopback remote forward higher again.
export function evaluateTunnelDefine(group: AccessGroup | null): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this workspace.' }
  const tunnel = evaluateCapability(group, 'sshTunnel')
  if (tunnel.decision === 'deny') return { decision: 'deny', reason: 'SSH tunnels are denied for this access group.' }
  return tunnel.decision === 'allow'
    ? { decision: 'ask', reason: 'Defining or removing a tunnel always requires approval.' }
    : tunnel
}

// Changing or deleting a saved connection rides `manageServers`, the capability
// that until recently only added them.
//
// That widening is the reason this exists. A group an administrator set to
// ALLOW meant "add servers without asking me"; it cannot be read as consent to
// rewrite or delete the ones already there, and an upgrade must never turn the
// first into the second in silence. So an `allow` is upgraded to `ask` here --
// the same treatment `evaluateTunnelOpen` and `evaluateVpnControl` give the
// acts that are bigger than the capability's plain reading.
//
// CHANGING IS IN HERE, NOT JUST DELETING, and the first cut of this had only
// deleting. Rewriting a connection is the sharper of the two: deleting "Prod
// DB" is loud and the next call fails, while repointing it is silent and every
// later call -- from this agent, another agent, or the person at the keyboard
// clicking the name in the sidebar -- goes to the new host with the old
// credential. A capability whose plain reading is "may add servers" cannot
// carry that unasked.
//
// gate() carries the second half, and grades the two differently. remove_server
// is per-call: one approval, one deletion, never the next. update_server is
// scoped instead (`elevationScope`), so the first change to a connection asks
// and later changes to THAT connection in that session do not -- an operator
// who has just approved a repoint does not want the same card again for the
// next field. Neither grant reaches the other tool, another server, or the
// session after this one.
export function evaluateServerWrite(group: AccessGroup | null, act: 'change' | 'delete'): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this workspace.' }
  const manage = evaluateCapability(group, 'manageServers')
  if (manage.decision === 'deny')
    return { decision: 'deny', reason: 'Managing servers is denied for this access group.' }
  return manage.decision === 'allow'
    ? {
        decision: 'ask',
        reason:
          act === 'delete'
            ? 'Deleting a saved connection always requires approval.'
            : 'Changing a saved connection always requires approval.'
      }
    : manage
}

// VPN kinds an AI agent may never run, whatever access group governs it.
//
// The same treatment as UNRESTRICTED_SHELL_PATTERNS above, for the same reason.
// Every frp proxy makes a port on the user's own machine reachable from the frp
// server, which is to say from the public internet. An approval prompt would
// not help: "Start VPN office" is indistinguishable, to the person clicking it,
// from consent to publish a port. So it is not expressed as a permission an
// administrator could raise to 'allow' — it is refused here, in code, and the
// user opens an frp profile themselves in OpsMaxx or it does not open.
const AI_REFUSED_VPN_KINDS: ReadonlySet<VpnKind> = new Set<VpnKind>(['frp'])

export function isVpnKindRefusedForAi(kind: VpnKind): boolean {
  return AI_REFUSED_VPN_KINDS.has(kind)
}

// Starting a VPN is a bigger act than opening a tunnel: a tunnel binds one
// port, a VPN changes which network everything downstream of it travels over.
// So it is never silent — not even for a group that says 'allow' — and a stop
// that would cut live sessions surfaces that fact before it happens.
export function evaluateVpnControl(
  group: AccessGroup | null,
  action: 'start' | 'stop',
  hasLiveDependents: boolean
): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this workspace.' }
  const cap = evaluateCapability(group, 'vpnControl')
  if (cap.decision === 'deny') return { decision: 'deny', reason: 'VPN control is denied for this access group.' }
  if (action === 'start') {
    return cap.decision === 'allow'
      ? { decision: 'ask', reason: 'Starting a VPN changes where your traffic goes and always requires approval.' }
      : cap
  }
  if (hasLiveDependents && cap.decision === 'allow') {
    return { decision: 'ask', reason: 'Stopping this VPN will close sessions that depend on it.' }
  }
  return cap
}

// Starting a build is the same shape of act as starting a VPN, one step
// further out. A VPN changes which network the user's own sessions travel
// over; a run starts work on a third party's infrastructure, running a
// definition OpsMaxx has never read, and OpsMaxx cannot stop it once the
// provider has accepted it -- STOP ALL AI ACCESS does not reach a build
// already running.
//
// So 'allow' is not a state this capability can be in at the moment it
// matters. An operator may set ciTrigger to allow on any group, or run a Full
// Access session; both arrive here and both come out as 'ask'. That is
// deliberate and matches the VPN rule stated in docs/AI-SECURITY.md: there is
// no configuration in which a build starts silently at an agent's request.
export function evaluateCiTrigger(group: AccessGroup | null): Decision {
  if (!group) return { decision: 'deny', reason: 'No AI access is assigned to this workspace.' }
  const cap = evaluateCapability(group, 'ciTrigger')
  if (cap.decision === 'deny') return { decision: 'deny', reason: 'CI/CD control is denied for this access group.' }
  return cap.decision === 'allow'
    ? {
        decision: 'ask',
        reason:
          'Starting a build runs whatever that pipeline says, on infrastructure OpsMaxx cannot ' +
          'inspect and cannot stop once it has begun, so it always requires approval.'
      }
    : cap
}
