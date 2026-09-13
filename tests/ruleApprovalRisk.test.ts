import { describe, expect, it } from 'vitest'
import { jobApprovalFor, planJob, verifyJobApproval } from '../src/shared/jobs'
import type { JobSpec, JobTargetRef } from '../src/shared/jobs'
import { RULE_UNATTENDED_PHRASE, verifyRuleAction } from '../src/shared/rules'
import { RuleEngine } from '../src/main/services/rules'
import type { RulesFile } from '../src/main/services/rules'

/**
 * A rule's approval has to survive its own re-derivation — including for the
 * rules that are worth having.
 *
 * THE BUG THIS PINS. The creation dialog demands the word UNATTENDED for every
 * job rule and stores it as the approval's `phrase`. `verifyApproval` compares
 * that field against the phrase the RE-DERIVED plan demands whenever the plan
 * asks for a typed word at all — and `planJob` asks for `RUN` as soon as a
 * command is destructive, or the target list passes TYPE_ABOVE_HOSTS. So the
 * record disagreed with itself from the moment it was written, and the rule
 * refused every time it fired, forever, with "this needed the word RUN typed".
 *
 * It shipped because of where the fixtures sat: every engine test uses an
 * ordinary command on two hosts, which yields `{kind:'confirm'}` and skips the
 * phrase comparison entirely; the panel test DOES write a destructive rule but
 * asserts only that the dialog says "destructive" and never submits it. The bug
 * lived in the seam between the two suites, so this file tests the seam — mint
 * the record the panel would mint, then verify it the way a firing does.
 */

const ONE: JobTargetRef[] = [{ serverId: 'a', serverName: 'alpha' }]
const SIX: JobTargetRef[] = Array.from({ length: 6 }, (_, i) => ({
  serverId: `s${i}`,
  serverName: `host-${i}`
}))

/** A minimal engine: no store, no executor — `create` touches neither. */
function engineFor(): RuleEngine {
  let file: RulesFile | null = null
  return new RuleEngine({
    store: null,
    now: () => 1_700_000_000_000,
    read: () => file,
    write: (f: RulesFile) => {
      file = JSON.parse(JSON.stringify(f)) as RulesFile
    },
    notify: () => {},
    resolveTarget: (id: string) => ({ serverId: id }),
    runJob: async () => ({}),
    newId: () => 'id-1',
    version: () => '0.0.0'
  } as never)
}

const specOf = (command: string): JobSpec => ({ kind: 'command', title: 't', steps: [{ command }] })

/**
 * What RulesPanel mints now: the phrase THIS PLAN demands, or null.
 *
 * The same conditional every other approval producer uses (broadcast, jobs,
 * patch, compose, docker). Written out here rather than imported so the test
 * breaks if the panel quietly stops following it again.
 */
const asPanelWouldMint = (spec: JobSpec, targets: JobTargetRef[]) => {
  const c = planJob(spec, targets).confirmation
  return jobApprovalFor(spec, targets, {
    phrase: c.kind === 'type-to-confirm' ? c.phrase : null,
    confirmedAt: 1
  })
}

/** The pre-fix mint: the rule ceremony's word, whatever the plan asked for. */
const asPanelUsedToMint = (spec: JobSpec, targets: JobTargetRef[]) =>
  jobApprovalFor(spec, targets, { phrase: RULE_UNATTENDED_PHRASE, confirmedAt: 1 })

describe('a rule whose job needs a typed word', () => {
  it('verifies when the command is destructive', () => {
    const spec = specOf('rm -rf /var/cache/*')
    expect(planJob(spec, ONE).confirmation.kind, 'fixture no longer exercises the path').toBe(
      'type-to-confirm'
    )
    const verdict = verifyJobApproval(asPanelWouldMint(spec, ONE), spec, ONE)
    expect(verdict.ok, `a destructive rule can never fire: ${JSON.stringify(verdict)}`).toBe(true)
  })

  it('verifies when an ordinary command fans out past the typed-word threshold', () => {
    // The case nobody would guess is broken: no dangerous verb anywhere, just
    // more than five servers. "Clean this up on my eight web boxes" is the most
    // ordinary rule anyone would write.
    const spec = specOf('journalctl --vacuum-size=200M')
    expect(planJob(spec, SIX).confirmation.kind).toBe('type-to-confirm')
    const verdict = verifyJobApproval(asPanelWouldMint(spec, SIX), spec, SIX)
    expect(verdict.ok, `a six-host rule can never fire: ${JSON.stringify(verdict)}`).toBe(true)
  })

  it('still verifies the ordinary case the old fixtures covered', () => {
    // The regression guard on the guard: whatever the fix does to the typed-word
    // path must leave the path that always worked alone.
    const spec = specOf('journalctl --vacuum-size=200M')
    const two = [ONE[0], { serverId: 'b', serverName: 'bravo' }]
    expect(planJob(spec, two).confirmation.kind).toBe('confirm')
    expect(verifyJobApproval(asPanelWouldMint(spec, two), spec, two).ok).toBe(true)
  })

  it('still refuses when the command was edited under the record', () => {
    // The property the whole approval mechanism exists for. A fix that made the
    // phrase check pass by loosening verification would break this, so it is
    // asserted beside the others rather than in another file.
    const spec = specOf('rm -rf /var/cache/*')
    const approval = asPanelWouldMint(spec, ONE)
    const edited = specOf('rm -rf /')
    expect(verifyJobApproval(approval, edited, ONE).ok).toBe(false)
  })

  it('still refuses when a server was added under the record', () => {
    const spec = specOf('rm -rf /var/cache/*')
    const approval = asPanelWouldMint(spec, ONE)
    const grown = [...ONE, { serverId: 'c', serverName: 'charlie' }]
    expect(verifyJobApproval(approval, spec, grown).ok).toBe(false)
  })
})

describe('the unattended ceremony is recorded, not merely performed', () => {
  // It used to live entirely in the creation dialog's own state: `RuleEngine.create`
  // validated no part of it, `sanitiseRule` carried the approval through
  // untouched, and nothing downstream could tell a rule that went through the
  // ceremony from one that skipped it. "A human typed the word" was a claim the
  // renderer made about itself, and every other route to the channel ignored it.
  //
  // Not a security boundary — main cannot see what was typed into a renderer,
  // and a caller determined to lie sends `true`. What it stops is the claim
  // being made by silence, and it puts the assertion in the file beside the rule.
  it('refuses a job rule that does not claim it', () => {
    const spec = specOf('journalctl --vacuum-size=200M')
    const draft = {
      name: 'no ceremony',
      trigger: { kind: 'disk', event: 'raised' },
      limit: { maxFirings: 1, windowMs: 3_600_000 },
      action: {
        type: 'job',
        spec,
        targets: ONE,
        approval: jobApprovalFor(spec, ONE, { phrase: null, confirmedAt: 1 })
      }
    }
    const engine = engineFor()
    expect(engine.create(draft as never), 'a job rule was created without the gate').toBeNull()
  })

  it('creates a job rule that does claim it, and records when', () => {
    const spec = specOf('journalctl --vacuum-size=200M')
    const engine = engineFor()
    const made = engine.create({
      name: 'with ceremony',
      trigger: { kind: 'disk', event: 'raised' },
      limit: { maxFirings: 1, windowMs: 3_600_000 },
      unattended: true,
      action: {
        type: 'job',
        spec,
        targets: ONE,
        approval: jobApprovalFor(spec, ONE, { phrase: null, confirmedAt: 1 })
      }
    } as never)
    expect(made).not.toBeNull()
    expect(made!.unattendedAt, 'the ceremony was not recorded').toBeGreaterThan(0)
  })

  it('asks nothing of a notify rule, which carries no authority', () => {
    const engine = engineFor()
    const made = engine.create({
      name: 'just tell me',
      trigger: { kind: 'disk', event: 'raised' },
      limit: { maxFirings: 1, windowMs: 3_600_000 },
      action: { type: 'notify' }
    } as never)
    expect(made, 'a notify rule was made to perform a ceremony').not.toBeNull()
    expect(made!.unattendedAt).toBe(0)
  })
})

describe('a rule saved before the fix', () => {
  it('is refused, and told why in a sentence that names the way out', () => {
    // Its record carries UNATTENDED where the plan demands RUN, so it can never
    // verify. It is NOT re-minted: rewriting it would fabricate a RUN nobody
    // typed, inside a record kept and written to the approval log.
    const spec = specOf('rm -rf /var/cache/*')
    const legacy = {
      id: 'r-old',
      name: 'old',
      enabled: true,
      trigger: { kind: 'disk', event: 'raised' },
      filter: {},
      limit: { maxFirings: 1, windowMs: 3_600_000 },
      armedAt: 1,
      unattendedAt: 0,
      action: { type: 'job', spec, targets: ONE, approval: asPanelUsedToMint(spec, ONE) }
    }
    const verdict = verifyRuleAction(legacy as never)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toMatch(/created before a fix/i)
    expect(verdict.ok === false && verdict.reason).toMatch(/delete it and create it again/i)
    // And it must not claim anything ran.
    expect(verdict.ok === false && verdict.reason).toMatch(/nothing has run/i)
  })

  it('does not re-word a refusal that is real drift', () => {
    // An edited command on a correctly-minted rule is not the legacy shape, and
    // must keep its own refusal — otherwise the new sentence would tell somebody
    // to re-create a rule whose command had been tampered with.
    const spec = specOf('rm -rf /var/cache/*')
    const drifted = {
      id: 'r-drift',
      name: 'drifted',
      enabled: true,
      trigger: { kind: 'disk', event: 'raised' },
      filter: {},
      limit: { maxFirings: 1, windowMs: 3_600_000 },
      armedAt: 1,
      unattendedAt: 1,
      action: {
        type: 'job',
        spec: specOf('rm -rf /'),
        targets: ONE,
        approval: asPanelWouldMint(spec, ONE)
      }
    }
    const verdict = verifyRuleAction(drifted as never)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).not.toMatch(/created before a fix/i)
  })
})
