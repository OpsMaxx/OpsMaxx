import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  buildDockerHealthLogCommand,
  DOCKER_HEALTH_LOG_KEPT,
  healthHeadline,
  healthRank,
  parseDockerHealthLogs,
  sortUnhealthyFirst,
  type DockerHealthLog
} from '../src/shared/docker'
import { redactOutput } from '../src/main/services/secretRedaction'

// Item 42's health log row. The fixture is four real containers inspected in one
// call: one unhealthy whose healthcheck echoes credentials, one with no
// healthcheck at all, one inside a five-minute start period failing every
// check, and one passing -- plus docker's error line for a ref that is not
// there.

const DIR = fileURLToPath(new URL('./fixtures/docker/health', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const logs = (): DockerHealthLog[] => parseDockerHealthLogs(read('health-log.txt'))
const one = (n: string): DockerHealthLog => logs().find((l) => l.container === n)!

describe('reading the log', () => {
  it('was captured with the template the command builds', () => {
    const cmd = buildDockerHealthLogCommand(['sphc2-leaky-1'])
    const tmpl = "{{.Name}}|{{if .State.Health}}{{json .State.Health}}{{else}}null{{end}}"
    expect(cmd).toContain(tmpl)
    expect(read('command.txt')).toContain(tmpl)
  })

  it('guards the template so one plain container cannot cost the rest', () => {
    // Without `{{if .State.Health}}`, a container with no healthcheck fails the
    // template for the WHOLE invocation.
    expect(buildDockerHealthLogCommand(['a'])).toContain('{{if .State.Health}}')
  })

  it('skips the line docker prints for a ref that is not there', () => {
    expect(read('health-log.txt')).toContain('error: no such object')
    expect(logs()).toHaveLength(4)
  })

  it('drops a row with no container name rather than keeping a nameless one', () => {
    // A line beginning with the separator has an empty name. Reporting health
    // against '' would put a row on screen that names no container.
    expect(parseDockerHealthLogs('|{"Status":"healthy","FailingStreak":0,"Log":[]}')).toEqual([])
  })

  it('strips the leading slash docker puts on a name', () => {
    expect(logs().every((l) => !l.container.startsWith('/'))).toBe(true)
  })
})

describe('the three things a status alone does not say', () => {
  // `.State.Health` is null for a container with no healthcheck. Not healthy,
  // not unknown -- absent, and the word this must never print for it is
  // "healthy".
  it('reports no healthcheck as no healthcheck', () => {
    const plain = one('sphc2-plain-1')
    expect(plain.status).toBeNull()
    expect(plain.entries).toEqual([])
    expect(healthHeadline(plain)).toContain('no healthcheck')
    expect(healthHeadline(plain)).not.toContain('healthy:')
  })

  // Measured: FailingStreak 24 with five entries kept. The log is a sample.
  it('says the log is a sample when the streak is longer than it', () => {
    const sick = one('sphc2-leaky-1')
    expect(sick.failingStreak).toBe(24)
    expect(sick.entries).toHaveLength(DOCKER_HEALTH_LOG_KEPT)
    expect(sick.sampled).toBe(true)
    expect(healthHeadline(sick)).toContain('24 checks in a row')
    expect(healthHeadline(sick)).toContain('keeps only the last 5')
  })

  it('does not claim a sample when docker kept the whole streak', () => {
    expect(one('sphc3-good-1').sampled).toBe(false)
  })

  // Measured: inside a 300s start_period, a check exiting 1 reports
  // `Status: starting` and `FailingStreak: 0`.
  it('says a starting container is failing when every logged check failed', () => {
    const slow = one('sphc3-slowstart-1')
    expect(slow.status).toBe('starting')
    expect(slow.failingStreak).toBe(0)
    expect(slow.entries.map((e) => e.exitCode)).toEqual([1])
    expect(healthHeadline(slow)).toContain('every check it has run has failed')
    expect(healthHeadline(slow)).toContain('start period is hiding that')
  })

  it('leaves a genuinely starting container alone', () => {
    const fresh: DockerHealthLog = { ...one('sphc3-slowstart-1'), entries: [] }
    expect(healthHeadline(fresh)).toContain('not calling it unhealthy yet')
  })
})

describe('worst first', () => {
  it('puts the unhealthy one first and the failing starter behind it', () => {
    expect(sortUnhealthyFirst(logs()).map((l) => l.container)).toEqual([
      'sphc2-leaky-1',
      'sphc3-slowstart-1',
      'sphc3-good-1',
      'sphc2-plain-1'
    ])
  })

  it('ranks a failing starter above a healthy container, not below it', () => {
    expect(healthRank(one('sphc3-slowstart-1'))).toBeLessThan(healthRank(one('sphc3-good-1')))
  })

  it('ranks a failing starter above a genuinely starting one', () => {
    // The two carry the SAME status word. Only the log's exit codes separate
    // them, and the one that has never passed is the one worth looking at.
    const failing = one('sphc3-slowstart-1')
    const fresh: DockerHealthLog = { ...failing, container: 'fresh', entries: [] }
    expect(healthRank(failing)).toBeLessThan(healthRank(fresh))
    expect(sortUnhealthyFirst([fresh, failing]).map((l) => l.container)).toEqual([
      'sphc3-slowstart-1',
      'fresh'
    ])
  })

  it('does not drop a status it has never seen, and does not promote it', () => {
    const odd: DockerHealthLog = { ...one('sphc3-good-1'), container: 'odd', status: 'draining' }
    expect(healthHeadline(odd)).toContain('does not know')
    // Listed, and behind everything this build can actually grade -- a word
    // nobody has seen is not evidence of a problem OR of health.
    expect(sortUnhealthyFirst([odd, one('sphc2-leaky-1'), one('sphc3-good-1')]).map((l) => l.container)).toEqual([
      'sphc2-leaky-1',
      'sphc3-good-1',
      'odd'
    ])
  })
})

describe('what the healthcheck printed', () => {
  // Measured: the output is the check's own stdout, verbatim. This one carried
  // a URL with a password in it, a query token and a bearer header.
  it('keeps the output raw in the shared parser', () => {
    const out = one('sphc2-leaky-1').entries[0].output
    expect(out).toContain('s3cr3t')
    expect(out).toContain('Bearer')
  })

  // ...and main's redactor, which is what the output passes through before it
  // crosses IPC, removes all three. A shared parser promising redaction it
  // cannot enforce would be worse than not promising it.
  it('is stripped of all three secrets by the redactor it goes through', () => {
    const out = redactOutput(one('sphc2-leaky-1').entries[0].output)
    expect(out).not.toContain('s3cr3t')
    expect(out).not.toContain('abc123def')
    expect(out).not.toContain('eyJhbGciOi.payload.sig')
    expect(out).toContain('[REDACTED]')
  })
})
