import { describe, it, expect } from 'vitest'

import {
  githubOutcome,
  gitlabOutcome,
  jenkinsOutcome,
  type CicdOutcome,
  type CicdStatus
} from '../src/shared/cicd'

/**
 * The three status mappers, against EVERY value each provider documents.
 *
 * The adapters exercise these in passing. This file exercises them on purpose,
 * because they are the one piece of logic every part of the module depends on
 * and the failure mode is silent: an unmapped status does not throw, it renders
 * as `unknown` — "we could not read this" — which is a lie about a build that
 * was read perfectly well and failed.
 *
 * `startup_failure` is the reason this file exists. It is absent from GitHub's
 * documented enum and emitted in production whenever a workflow's YAML fails to
 * parse, so the user breaks their workflow file and the panel shrugs.
 */

const ALL: CicdStatus[] = [
  'queued',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
  'manual',
  'unknown'
]

describe('jenkinsOutcome', () => {
  it('maps every documented result', () => {
    const table: [boolean, string | null, CicdOutcome][] = [
      [true, null, { status: 'running' }],
      // `building` wins: Jenkins leaves the PREVIOUS result in place on some
      // paths while a new build runs, and reading that as the current outcome
      // reports a finished state for a build still going.
      [true, 'SUCCESS', { status: 'running' }],
      [false, 'SUCCESS', { status: 'success' }],
      [false, 'UNSTABLE', { status: 'success', warning: true }],
      [false, 'FAILURE', { status: 'failed' }],
      [false, 'ABORTED', { status: 'canceled' }],
      [false, 'NOT_BUILT', { status: 'skipped' }],
      [false, null, { status: 'unknown' }],
      [false, 'SOMETHING_NEW', { status: 'unknown' }]
    ]
    for (const [building, result, want] of table) {
      expect(jenkinsOutcome(building, result), `${building} / ${result}`).toEqual(want)
    }
  })

  it('never reports UNSTABLE as a failure', () => {
    // An unstable build passed and something in it complained. Folding it into
    // `failed` misreports a large share of real Jenkins estates.
    expect(jenkinsOutcome(false, 'UNSTABLE').status).toBe('success')
    expect(jenkinsOutcome(false, 'UNSTABLE').warning).toBe(true)
  })
})

describe('gitlabOutcome', () => {
  it('maps every status GitLab documents for pipelines and jobs', () => {
    // Both endpoints share a vocabulary, so this list is the union of the two
    // documented enums. A value missing here becomes `unknown` in the panel.
    const table: [string, CicdStatus][] = [
      ['created', 'queued'],
      ['waiting_for_resource', 'queued'],
      ['preparing', 'queued'],
      ['waiting_for_callback', 'queued'],
      ['pending', 'queued'],
      ['scheduled', 'queued'],
      ['running', 'running'],
      ['success', 'success'],
      ['failed', 'failed'],
      ['canceling', 'canceled'],
      ['canceled', 'canceled'],
      ['skipped', 'skipped'],
      ['manual', 'manual']
    ]
    for (const [raw, want] of table) {
      expect(gitlabOutcome(raw).status, raw).toBe(want)
    }
  })

  it('folds the transient canceling into canceled rather than inventing a state', () => {
    expect(gitlabOutcome('canceling')).toEqual(gitlabOutcome('canceled'))
  })

  it('has no warning state — GitLab has no unstable', () => {
    for (const [raw] of Object.entries({ success: 1, failed: 1, manual: 1 })) {
      expect(gitlabOutcome(raw).warning).toBeUndefined()
    }
  })
})

describe('githubOutcome', () => {
  it('maps every documented status before completion', () => {
    const table: [string, CicdStatus][] = [
      ['queued', 'queued'],
      ['requested', 'queued'],
      ['pending', 'queued'],
      ['waiting', 'queued'],
      ['in_progress', 'running']
    ]
    for (const [raw, want] of table) {
      // The conclusion is null until a run completes, and must not be consulted.
      expect(githubOutcome(raw, null).status, raw).toBe(want)
      expect(githubOutcome(raw, 'success').status, `${raw} with a stale conclusion`).toBe(want)
    }
  })

  it('maps every documented conclusion, plus the one GitHub does not document', () => {
    const table: [string | null, CicdOutcome][] = [
      ['success', { status: 'success' }],
      ['neutral', { status: 'success', warning: true }],
      ['failure', { status: 'failed' }],
      ['timed_out', { status: 'failed' }],
      // Undocumented, emitted in production: the workflow YAML did not parse.
      // It also arrives with ZERO jobs attached.
      ['startup_failure', { status: 'failed' }],
      ['cancelled', { status: 'canceled' }],
      ['skipped', { status: 'skipped' }],
      ['stale', { status: 'skipped' }],
      ['action_required', { status: 'manual' }],
      [null, { status: 'unknown' }]
    ]
    for (const [conclusion, want] of table) {
      expect(githubOutcome('completed', conclusion), String(conclusion)).toEqual(want)
    }
  })

  it('reports a broken workflow file as failed, never as unknown', () => {
    // The whole point. `unknown` is reserved for "we could not read it", and
    // rendering a parse failure that way sends the user looking at their
    // network instead of their YAML.
    expect(githubOutcome('completed', 'startup_failure').status).toBe('failed')
    expect(githubOutcome('completed', 'startup_failure').status).not.toBe('unknown')
  })
})

describe('the normalized vocabulary', () => {
  it('is the only thing the three mappers can produce', () => {
    const produced = new Set<string>()
    for (const r of [null, 'SUCCESS', 'UNSTABLE', 'FAILURE', 'ABORTED', 'NOT_BUILT', 'junk']) {
      produced.add(jenkinsOutcome(false, r).status)
      produced.add(jenkinsOutcome(true, r).status)
    }
    for (const s of ['created', 'running', 'success', 'failed', 'canceled', 'skipped', 'manual', 'junk']) {
      produced.add(gitlabOutcome(s).status)
    }
    for (const s of ['queued', 'in_progress', 'completed', 'junk']) {
      for (const c of ['success', 'failure', 'neutral', 'stale', 'action_required', null, 'junk']) {
        produced.add(githubOutcome(s, c).status)
      }
    }
    for (const s of produced) expect(ALL).toContain(s as CicdStatus)
  })

  it('treats an unrecognised value from any provider as unknown, not as success', () => {
    // A provider adding a status we have never seen must never render green.
    expect(jenkinsOutcome(false, 'BRAND_NEW').status).toBe('unknown')
    expect(gitlabOutcome('brand_new').status).toBe('unknown')
    expect(githubOutcome('completed', 'brand_new').status).toBe('unknown')
    expect(githubOutcome('brand_new', null).status).toBe('unknown')
  })
})
