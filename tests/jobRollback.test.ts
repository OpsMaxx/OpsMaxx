import { describe, it, expect } from 'vitest'

import {
  approvalCommands,
  jobApprovalFor,
  verifyJobApproval,
  type JobSpec
} from '../src/shared/jobs'
import { composeJobSpec, EMPTY_JOB_DRAFT } from '../src/shared/jobCompose'

// Item 44's "rollback on the approval".
//
// Written down at the same time as the job, because that is the only moment
// anybody knows how to undo it. Two properties matter and they are separate:
// the rollback is INSIDE the approval record, and it is never run by anything
// except a person pressing a button and answering a second confirmation.

const targets = [{ serverId: 's1', serverName: 'web-1' }]

const spec = (over: Partial<JobSpec> = {}): JobSpec => ({
  kind: 'command',
  title: 'Restart nginx',
  steps: [{ command: 'systemctl restart nginx' }],
  ...over
})

describe('the rollback is covered by the approval that was given', () => {
  it('is part of the approved bytes, not a field beside them', () => {
    const withRb = spec({ rollback: [{ command: 'systemctl stop nginx' }] })
    expect(approvalCommands(withRb)).toEqual([
      'systemctl restart nginx',
      'rollback: systemctl stop nginx'
    ])
  })

  it('refuses a rollback that was edited after the approval was minted', () => {
    // THE assertion. A rollback outside the hash could be swapped for anything
    // between the dialog and the button, under a record that still verifies.
    const approved = spec({ rollback: [{ command: 'systemctl stop nginx' }] })
    const approval = jobApprovalFor(approved, targets, { phrase: null, confirmedAt: 1 })
    const tampered = spec({ rollback: [{ command: 'rm -rf /var/lib' }] })
    expect(verifyJobApproval(approval, tampered, targets).ok).toBe(false)
    expect(verifyJobApproval(approval, approved, targets).ok).toBe(true)
  })

  it('refuses a rollback that was removed after the approval was minted', () => {
    const approved = spec({ rollback: [{ command: 'systemctl stop nginx' }] })
    const approval = jobApprovalFor(approved, targets, { phrase: null, confirmedAt: 1 })
    expect(verifyJobApproval(approval, spec(), targets).ok).toBe(false)
  })

  // A two-step job and a one-step job with an undo are different things, and a
  // prefix is what keeps them from producing the same approved list.
  it('cannot be re-presented as an ordinary second step', () => {
    const asRollback = spec({ steps: [{ command: 'A' }], rollback: [{ command: 'B' }] })
    const asSteps = spec({ steps: [{ command: 'A' }, { command: 'B' }] })
    expect(approvalCommands(asRollback)).not.toEqual(approvalCommands(asSteps))
    const approval = jobApprovalFor(asRollback, targets, { phrase: null, confirmedAt: 1 })
    expect(verifyJobApproval(approval, asSteps, targets).ok).toBe(false)
  })
})

describe('what the composer does with it', () => {
  it('leaves the field off entirely when nobody wrote one', () => {
    // `rollback: []` would read as "an undo was written and it does nothing",
    // and the panel would offer a button for it.
    const s = composeJobSpec({ ...EMPTY_JOB_DRAFT, title: 'x', steps: 'a' })
    expect(s.rollback).toBeUndefined()
  })

  it('drops comments from the rollback the same way it does from the steps', () => {
    const s = composeJobSpec({
      ...EMPTY_JOB_DRAFT,
      title: 'x',
      steps: 'a',
      rollback: '# put it back\nsystemctl stop nginx'
    })
    expect(s.rollback).toEqual([{ command: 'systemctl stop nginx' }])
  })

  it('never marks a rollback step as a reboot, whatever the forward job said', () => {
    // `rebootLast` is about the job's own last step. A rollback that reboots
    // would have to say so as its own job, under its own confirmation.
    const s = composeJobSpec({
      ...EMPTY_JOB_DRAFT,
      title: 'x',
      steps: 'dnf -y update\nreboot',
      rebootLast: true,
      rollback: 'dnf -y history undo last'
    })
    expect(s.rollback?.every((st) => st.reboot === undefined)).toBe(true)
    expect(s.steps[1].reboot).toBe(true)
  })
})

describe('nothing runs it on its own', () => {
  it('is not among the steps the runner executes', async () => {
    // The engine runs `spec.steps`. If a rollback ever reached that array, a
    // gate halt or a failure would undo an estate with nobody deciding to.
    const s = composeJobSpec({
      ...EMPTY_JOB_DRAFT,
      title: 'x',
      steps: 'systemctl start nginx',
      rollback: 'systemctl stop nginx'
    })
    expect(s.steps.map((st) => st.command)).toEqual(['systemctl start nginx'])
  })

  it('is not read by the job runner at all', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '..', 'src/main/services/jobRunner.ts'), 'utf8')
    // Asserted against the source because the alternative is proving a negative
    // by running every path the runner has. A runner that grew a reference to
    // this field is a runner that can undo an estate by itself.
    expect(src).not.toContain('rollback')
  })
})
