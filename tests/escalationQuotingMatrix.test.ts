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
  // A harmless first group comes before the payload: only the first group
  // used to be walked when it ended in `\;`.
  "find -exec true \\; -exec sh -c '…' \\;": (s) =>
    `find . -maxdepth 0 -exec true \\; -exec sh -c ${sq(s)} \\;`
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

// DEPTH FOUR IS SAMPLED BY DEFAULT, and the full sweep is opt-in.
//
// Each full depth-four pass evaluates 38,416 commands, many of them long after
// four rounds of quoting: 10-20 seconds apiece on an idle laptop, two or three
// times that on a CI runner, which is a flake waiting to happen and a minute
// added to every run. So CI runs depths one to three IN FULL, plus a
// deterministic slice of depth four -- every SAMPLE_EVERY-th nest in generation
// order, no randomness, so a failure reproduces exactly. SAMPLE_EVERY is prime
// and does not divide the wrapper count, so the slice walks through every
// wrapper in every position rather than landing on one column.
//
// The whole of depth four, before a change to the command walk lands:
//
//   OPSMAXX_FULL_MATRIX=1 npx vitest run tests/escalationQuotingMatrix.test.ts
const FULL = process.env.OPSMAXX_FULL_MATRIX === '1'
const SAMPLE_EVERY = 29
const FULL_SWEEP_MS = 300_000

type Nest = ReturnType<typeof nests>[number]
const depthFour = (all: Nest[]): Nest[] => all.filter((n) => n.depth === 4)
const sampled = (all: Nest[]): Nest[] => depthFour(all).filter((_, i) => i % SAMPLE_EVERY === 0)

const noSudo = group({ terminal: 'allow', sudo: 'deny' })
const shadowDenied: AccessGroup = {
  ...group({ terminal: 'allow', sudo: 'allow' }),
  filePolicies: [{ id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }]
}

const decide = (g: AccessGroup, list: Nest[], bad: (d: string) => boolean): string[] =>
  list.filter((n) => bad(evaluateCommand(g, n.command).decision)).map((n) => `${n.label}: ${n.command}`)

describe('every quoted nest around `sudo reboot`, sudo=deny + terminal=allow', () => {
  const all = nests('sudo reboot', 4)

  it('generates the whole matrix', () => {
    const width = Object.keys(WRAPPERS).length
    expect(all.filter((n) => n.depth === 3)).toHaveLength(width ** 3)
    expect(depthFour(all)).toHaveLength(width ** 4)
    expect(sampled(all).length).toBeGreaterThan(1000)
  })

  it('denies every nest up to depth three', () => {
    expect(decide(noSudo, all.filter((n) => n.depth <= 3), (d) => d !== 'deny')).toEqual([])
  })

  it('never allows a sampled nest at depth four -- it is denied, or asked about', () => {
    expect(decide(noSudo, sampled(all), (d) => d === 'allow')).toEqual([])
  })

  it.runIf(FULL)('never allows ANY nest at depth four', () => {
    expect(decide(noSudo, depthFour(all), (d) => d === 'allow')).toEqual([])
  }, FULL_SWEEP_MS)
})

describe('the same matrix around a harmless `ls /tmp`', () => {
  const all = nests('ls /tmp', 4)

  it('denies nothing up to depth three, nor in the depth-four sample', () => {
    expect(decide(noSudo, [...all.filter((n) => n.depth <= 3), ...sampled(all)], (d) => d === 'deny')).toEqual([])
  })

  it.runIf(FULL)('denies nothing at depth four', () => {
    expect(decide(noSudo, depthFour(all), (d) => d === 'deny')).toEqual([])
  }, FULL_SWEEP_MS)
})

describe('every quoted nest around `cat /etc/shadow`, with a deny rule on it', () => {
  const all = nests('cat /etc/shadow', 4)

  it('meets the path rule in every nest up to depth three', () => {
    expect(decide(shadowDenied, all.filter((n) => n.depth <= 3), (d) => d !== 'deny')).toEqual([])
  })

  it('never allows a sampled nest at depth four', () => {
    expect(decide(shadowDenied, sampled(all), (d) => d === 'allow')).toEqual([])
  })

  it.runIf(FULL)('never allows ANY nest at depth four', () => {
    expect(decide(shadowDenied, depthFour(all), (d) => d === 'allow')).toEqual([])
  }, FULL_SWEEP_MS)
})
