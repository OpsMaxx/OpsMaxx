import { describe, expect, it } from 'vitest'
import { evaluateCommand } from '../src/main/services/policyEngine'
import type { AccessGroup } from '../src/shared/mcp'

// A GENERATED matrix, not a list of cases somebody thought of.
//
// The command walk used to split on quotes without reading backslashes, so a
// correctly quoted nest came apart in the wrong places and the sudo at the
// bottom was never seen: a reviewer generating every nest of the forms below
// found 26 of 125 at depth three, and 242 of 625 at depth four, ALLOWED under
// a group that denies sudo. Hand-written cases had passed; the generated set
// had not. So the generated set is the test.
//
// Fourteen wrappers, so 14 + 196 + 2744 + 38416 nests. Every wrapper quotes its
// argument the way a careful tool would -- POSIX
// single quotes with the '\'' idiom shlex.quote emits, or double quotes with
// \ " $ and ` escaped -- and every combination up to depth four is checked.

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const dq = (s: string): string => `"${s.replace(/[\\"$`]/g, '\\$&')}"`

const WRAPPERS: Record<string, (s: string) => string> = {
  eval: (s) => `eval ${sq(s)}`,
  "sh -c '…'": (s) => `sh -c ${sq(s)}`,
  'sh -c "…"': (s) => `sh -c ${dq(s)}`,
  'env -S "…"': (s) => `env -S ${dq(s)}`,
  '$(…)': (s) => `$(${s})`,
  // A substitution with parens of its own: the innermost-only extractor this
  // replaced never walked it at all.
  '$(case … a) …;; esac)': (s) => `echo $(case a in a) ${s};; esac)`,
  'cat <(…)': (s) => `cat <(${s})`,
  // Backquotes nest only by escaping: \, ` and $ inside them are written \\,
  // \` and \$, and the shell takes the escape off before running the body.
  '`…`': (s) => `echo \`${s.replace(/[\\`$]/g, '\\$&')}\``,
  // `-c` inside an option cluster. Only an exact `-c` used to be read, and
  // `bash -lc` is what Codex-style agents wrap every command in.
  "bash -lc '…'": (s) => `bash -lc ${sq(s)}`,
  'sh -ec "…"': (s) => `sh -ec ${dq(s)}`,
  "zsh -ic '…'": (s) => `zsh -ic ${sq(s)}`,
  'bash -lic "…"': (s) => `bash -lic ${dq(s)}`,
  "script -qc '…'": (s) => `script -qc ${sq(s)} /dev/null`,
  // find hands -exec an argv, not a command line; joining it back with spaces
  // took `bash -lc "…"` apart, and every depth-three allow went through here.
  "find -exec sh -c '…' \\;": (s) => `find . -maxdepth 0 -exec sh -c ${sq(s)} \\;`
}

/** Every nest of 1..maxDepth wrappers around `inner`, with its depth and a readable label. */
function nests(inner: string, maxDepth: number): { depth: number; label: string; command: string }[] {
  const out: { depth: number; label: string; command: string }[] = []
  const names = Object.keys(WRAPPERS)
  const grow = (command: string, label: string[], depth: number): void => {
    if (depth > 0) out.push({ depth, label: label.join(' > '), command })
    if (depth === maxDepth) return
    for (const n of names) grow(WRAPPERS[n](command), [n, ...label], depth + 1)
  }
  grow(inner, [], 0)
  return out
}

function group(caps: Partial<AccessGroup['capabilities']>): AccessGroup {
  return {
    id: 'g',
    name: 'Matrix',
    builtIn: false,
    capabilities: {
      viewServer: 'allow',
      terminal: 'allow',
      readFiles: 'allow',
      writeFiles: 'allow',
      sudo: 'deny',
      ...caps
    } as AccessGroup['capabilities'],
    filePolicies: []
  }
}

const noSudo = group({ terminal: 'allow', sudo: 'deny' })
const shadowDenied: AccessGroup = {
  ...group({ terminal: 'allow', sudo: 'allow' }),
  filePolicies: [{ id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }]
}

describe('every quoted nest around `sudo reboot`, sudo=deny + terminal=allow', () => {
  const all = nests('sudo reboot', 4)

  it('generates the whole matrix', () => {
    const width = Object.keys(WRAPPERS).length
    expect(all.filter((n) => n.depth === 3)).toHaveLength(width ** 3)
    expect(all.filter((n) => n.depth === 4)).toHaveLength(width ** 4)
  })

  it('denies every nest up to depth three', () => {
    const allowed = all
      .filter((n) => n.depth <= 3)
      .filter((n) => evaluateCommand(noSudo, n.command).decision !== 'deny')
      .map((n) => `${n.label}: ${n.command}`)
    expect(allowed).toEqual([])
  })

  it('never allows a nest at depth four -- it is denied, or asked about', () => {
    const allowed = all
      .filter((n) => n.depth === 4)
      .filter((n) => evaluateCommand(noSudo, n.command).decision === 'allow')
      .map((n) => `${n.label}: ${n.command}`)
    expect(allowed).toEqual([])
  })
})

describe('the same matrix around a harmless `ls /tmp`', () => {
  it('denies nothing at any depth', () => {
    const denied = nests('ls /tmp', 4)
      .filter((n) => evaluateCommand(noSudo, n.command).decision === 'deny')
      .map((n) => `${n.label}: ${n.command}`)
    expect(denied).toEqual([])
  })
})

describe('every quoted nest around `cat /etc/shadow`, with a deny rule on it', () => {
  const all = nests('cat /etc/shadow', 4)

  it('meets the path rule in every nest up to depth three', () => {
    const allowed = all
      .filter((n) => n.depth <= 3)
      .filter((n) => evaluateCommand(shadowDenied, n.command).decision !== 'deny')
      .map((n) => `${n.label}: ${n.command}`)
    expect(allowed).toEqual([])
  })

  it('never allows a nest at depth four', () => {
    const allowed = all
      .filter((n) => n.depth === 4)
      .filter((n) => evaluateCommand(shadowDenied, n.command).decision === 'allow')
      .map((n) => `${n.label}: ${n.command}`)
    expect(allowed).toEqual([])
  })
})
