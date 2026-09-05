import { describe, it, expect } from 'vitest'

import {
  assignWaves,
  checkJobDraft,
  composeJobSpec,
  parseJobSteps,
  EMPTY_JOB_DRAFT,
  JOB_MAX_STEPS,
  type JobDraft
} from '../src/shared/jobCompose'
import { planJob } from '../src/shared/jobs'

const draft = (over: Partial<JobDraft> = {}): JobDraft => ({
  ...EMPTY_JOB_DRAFT,
  title: 'Restart nginx',
  steps: 'systemctl restart nginx',
  ...over
})

const servers = (n: number): { serverId: string; serverName: string }[] =>
  Array.from({ length: n }, (_, i) => ({ serverId: `s${i}`, serverName: `web-0${i}` }))

describe('what the operator typed, turned into steps', () => {
  it('drops blank lines and the notes people leave themselves', () => {
    // `#` is a comment to sh, so shipping the line would "work" -- and the
    // approval record would carry prose as a step.
    expect(parseJobSteps('  systemctl restart nginx  \n\n# check it after\nsystemctl status nginx')).toEqual([
      'systemctl restart nginx',
      'systemctl status nginx'
    ])
  })

  it('keeps the order, because a job is a sequence', () => {
    expect(parseJobSteps('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })
})

describe('what the composer refuses, and says why', () => {
  it('will not build a job with no title, no step or no server', () => {
    expect(checkJobDraft(draft({ title: '   ' }), 1)).toMatchObject({ ok: false })
    expect(checkJobDraft(draft({ steps: '\n# only a comment\n' }), 1)).toMatchObject({ ok: false })
    expect(checkJobDraft(draft(), 0)).toMatchObject({ ok: false })
  })

  it('gives a reason a person can act on rather than grey out a button', () => {
    const r = checkJobDraft(draft(), 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('server')
  })

  it('refuses more steps than the dialog can show, because that dialog is the point', () => {
    const many = Array.from({ length: JOB_MAX_STEPS + 1 }, (_, i) => `echo ${i}`).join('\n')
    expect(checkJobDraft(draft({ steps: many }), 1)).toMatchObject({ ok: false })
  })

  // A gate with one wave gates nothing, and the operator who ticked it believes
  // otherwise. That is the failure worth a sentence: they think they are
  // protected.
  it('refuses a health gate that would never gate anything', () => {
    expect(checkJobDraft(draft({ gate: true, waveSize: 0 }), 6)).toMatchObject({ ok: false })
    expect(checkJobDraft(draft({ gate: true, waveSize: 6 }), 6)).toMatchObject({ ok: false })
    expect(checkJobDraft(draft({ gate: true, waveSize: 2 }), 6)).toEqual({ ok: true })
  })

  it('accepts an ordinary one-server job', () => {
    expect(checkJobDraft(draft(), 1)).toEqual({ ok: true })
  })
})

describe('the spec that gets approved', () => {
  it('declares the reboot on the last step rather than leaving it to be sniffed', () => {
    // A DECLARED reboot gets reboot-and-wait; a sniffed one gets `unreachable`.
    const spec = composeJobSpec(draft({ steps: 'dnf -y update\nreboot', rebootLast: true }))
    expect(spec.steps.map((s) => s.reboot)).toEqual([undefined, true])
  })

  it('leaves every step ordinary when nobody said it reboots', () => {
    const spec = composeJobSpec(draft({ steps: 'a\nb' }))
    expect(spec.steps.every((s) => s.reboot === undefined)).toBe(true)
  })

  it('carries the gate into the spec, where the approval record can hold it', () => {
    expect(composeJobSpec(draft({ gate: true })).gate).toBe('health')
    expect(composeJobSpec(draft({ gate: false })).gate).toBeUndefined()
  })
})

describe('waves, and the confirmation they size', () => {
  // planJob sizes the confirmation on the LARGEST COHORT, not the total. That
  // is the whole reason waves exist -- twelve servers three at a time is a
  // blast radius of three -- and getting the cohort wrong in the panel would
  // ask for a weaker confirmation than the run deserves.
  it('labels servers into waves of the size asked for', () => {
    const w = assignWaves(servers(5), 2).map((t) => t.cohort)
    expect(w).toEqual(['Wave 1', 'Wave 1', 'Wave 2', 'Wave 2', 'Wave 3'])
  })

  it('puts everything in one wave when the size is 0', () => {
    expect(new Set(assignWaves(servers(4), 0).map((t) => t.cohort)).size).toBe(1)
  })

  it('makes the confirmation follow the wave rather than the total', () => {
    const spec = composeJobSpec(draft({ steps: 'systemctl restart nginx' }))
    const all = planJob(spec, assignWaves(servers(12), 0))
    const waved = planJob(spec, assignWaves(servers(12), 3))
    expect(all.blastRadius).toBe(12)
    expect(waved.blastRadius).toBe(3)
    // Twelve at once is the one that has to be typed out.
    expect(all.confirmation.kind).toBe('type-to-confirm')
    expect(waved.confirmation.kind).not.toBe('type-to-confirm')
  })
})
