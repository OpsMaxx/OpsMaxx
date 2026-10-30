import { sessionModeLabel } from '../../../../shared/mcp'
import type { AuditEntry } from '../../../../shared/mcp'
import type { MessageKey } from '../../../../shared/i18n'
import { t } from '../../lib/i18n'

// One OUTCOME per row, instead of two columns that print the same word twice.
//
// The table had an `APPROVAL` column and a `RESULT` column, and for the case an
// incident reviewer cares about most they both said "denied". Two identical
// cells is not redundancy, it is the space the missing fields needed: which
// session, whether a human decided or the fuse did, and what the command
// actually returned.
//
// The two are NOT the same fact, which is why fusing them takes care rather
// than picking one. `approval` is what the human (or the timer, or the policy)
// answered; `result` is what happened afterwards. A request can be approved and
// then fail, and an approved-then-failed row must not read as a denial.

export type AuditOutcomeTone = 'ok' | 'danger' | 'warn' | 'muted'

export interface AuditOutcome {
  /** The short label the cell shows. */
  label: string
  /** Who or what decided, when anything did. Never guessed. */
  decidedBy: 'you' | 'timeout' | 'policy' | null
  tone: AuditOutcomeTone
  /** The longer sentence, for the title attribute. */
  detail: string
}

type OutcomeFields = Pick<AuditEntry, 'approval' | 'result' | 'exitCode' | 'error' | 'mode'>

/** The outcome, with the session's mode named when the row recorded one. */
export function auditOutcome(e: OutcomeFields): AuditOutcome {
  const o = outcome(e)
  return e.mode
    ? { ...o, detail: t('ai.audit.outcome.withProfile', { detail: o.detail, profile: sessionModeLabel(e.mode) }) }
    : o
}

function outcome(e: OutcomeFields): AuditOutcome {
  const code = e.exitCode !== undefined ? t('ai.audit.outcome.exitCode', { code: e.exitCode }) : ''

  // Timeout first: it is a denial, and it is the one the operator did NOT make.
  // Reporting it as "denied" is the single most misleading thing this table
  // could do, because it says a person decided when nobody did.
  if (e.approval === 'timeout') {
    return {
      label: t('ai.audit.outcome.timedOut'),
      decidedBy: 'timeout',
      tone: 'warn',
      detail: t('ai.audit.outcome.timedOutDetail')
    }
  }
  if (e.approval === 'disconnected') {
    return {
      label: t('ai.audit.outcome.disconnected'),
      decidedBy: null,
      tone: 'muted',
      // The error says which: gone before anyone answered, or approved and
      // gone before it could run. Either way nothing ran.
      detail: e.error
        ? t('ai.audit.outcome.disconnectedError', { error: e.error })
        : t('ai.audit.outcome.disconnectedDetail')
    }
  }
  if (e.approval === 'denied') {
    return {
      label: t('ai.audit.outcome.denied'),
      decidedBy: 'you',
      tone: 'danger',
      detail: t('ai.audit.outcome.deniedDetail')
    }
  }
  // Refused without asking anyone -- the queue was full, or the same thing was
  // just denied. It used to be written as `denied` and read "You refused this
  // request", about a request nobody was shown.
  if (e.approval === 'not-asked') {
    return {
      label: t('ai.audit.outcome.notAsked'),
      decidedBy: 'policy',
      tone: 'warn',
      detail: e.error
        ? t('ai.audit.outcome.notAskedError', { error: e.error })
        : t('ai.audit.outcome.notAskedDetail')
    }
  }

  // Refused by the policy itself, before anything was asked or allowed.
  //
  // gate() writes these as `not-required` + `denied`: no approval was needed
  // because there was nothing to approve. They fell through to the branch
  // below and read "Allowed, then blocked -- the access group allowed this
  // outright", which is the opposite of what happened, on exactly the rows an
  // incident review reads first: a terminal the group denies, the /etc/shadow
  // rule, a server on No AI Access. The rule that refused it is the row's
  // `error`, and the sentence names it.
  if (e.result === 'denied' && (e.approval === 'not-required' || e.approval === undefined)) {
    // Read only refuses every change whatever the group says, so crediting the
    // group with it would send somebody to edit the wrong thing.
    if (e.mode === 'readOnly' || e.error?.startsWith('Read-only mode')) {
      return {
        label: t('ai.audit.outcome.blocked'),
        decidedBy: 'policy',
        tone: 'danger',
        detail: e.error
          ? t('ai.audit.outcome.readOnlyError', { error: e.error })
          : t('ai.audit.outcome.readOnlyDetail')
      }
    }
    return {
      label: t('ai.audit.outcome.blocked'),
      decidedBy: 'policy',
      tone: 'danger',
      detail: e.error
        ? t('ai.audit.outcome.groupRefusedError', { error: e.error })
        : t('ai.audit.outcome.groupRefusedDetail')
    }
  }

  // Approved, or never needed approval. What matters now is what happened.
  //
  // `approved-earlier` used to fall into the policy branch and read "the access
  // group allowed this outright", which is false twice: the group said ask, and
  // a person did answer -- on an earlier request. It is the operator's decision
  // carried forward, and the row says so rather than crediting the policy.
  const human = e.approval === 'approved' || e.approval === 'approved-for-session' || e.approval === 'approved-earlier'
  const who: AuditOutcome['decidedBy'] = human ? 'you' : 'policy'
  const prefixKey: MessageKey =
    e.approval === 'approved-for-session'
      ? 'ai.audit.outcome.prefixApprovedSession'
      : e.approval === 'approved-earlier'
        ? 'ai.audit.outcome.prefixApprovedEarlier'
        : e.approval === 'approved'
          ? 'ai.audit.outcome.prefixApproved'
          : e.approval === 'bypassed'
            ? 'ai.audit.outcome.prefixBypassed'
            : 'ai.audit.outcome.prefixAllowed'
  const prefix = t(prefixKey)
  const becauseKey: MessageKey =
    e.approval === 'approved'
      ? 'ai.audit.outcome.becauseApproved'
      : e.approval === 'approved-for-session'
        ? 'ai.audit.outcome.becauseApprovedSession'
        : e.approval === 'approved-earlier'
          ? // Not "you allowed this for the session": rows written up to
            // 0.50.25 were carried by an "Approve once" click, which the
            // operator never knew was a session grant, and nothing in a row
            // says which era wrote it.
            'ai.audit.outcome.becauseApprovedEarlier'
          : e.approval === 'bypassed'
            ? // Kept apart from "allowed outright": the policy would have asked
              // or refused, and only the session's mode let it through.
              'ai.audit.outcome.becauseBypassed'
            : 'ai.audit.outcome.becauseAllowed'
  const because = t(becauseKey)

  if (e.result === 'denied') {
    // Approval said yes (or Bypass skipped asking) and something downstream still said no. Only a row
    // with a human approval reaches here -- a policy refusal returned above --
    // so "then" is always true of it.
    return {
      label: t('ai.audit.outcome.thenBlocked', { prefix }),
      decidedBy: who,
      tone: 'danger',
      detail:
        e.approval === 'bypassed'
          ? t('ai.audit.outcome.thenBlockedBypass', { because })
          : t('ai.audit.outcome.thenBlockedDetail', { because })
    }
  }
  if (e.result === 'error') {
    return {
      label: t('ai.audit.outcome.failed', { prefix, code }),
      decidedBy: who,
      tone: 'danger',
      detail: e.error
        ? t('ai.audit.outcome.failedError', { because, error: e.error })
        : t('ai.audit.outcome.failedDetail', { because })
    }
  }
  return {
    label: t('ai.audit.outcome.ran', { prefix, code }),
    decidedBy: who,
    tone:
      e.approval === 'bypassed'
        ? 'warn'
        : e.approval === 'approved' || e.approval === 'approved-for-session'
          ? 'ok'
          : 'muted',
    detail: t('ai.audit.outcome.ranDetail', { because })
  }
}

/**
 * The audit log as a file somebody can keep.
 *
 * An audit log that cannot leave the app is not an audit log — it cannot go
 * into an incident write-up, a ticket or a compliance answer. Exported as JSON
 * rather than CSV because entries carry free text (a command, a server error)
 * that would need quoting rules nobody would get right by eye, and because the
 * shape is already the shape main stores.
 *
 * The derived outcome is included ALONGSIDE the raw fields, never instead of
 * them: a reader six months from now should be able to see what the app
 * concluded and still check it against what was recorded.
 */
export function auditExport(entries: readonly AuditEntry[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: entries.length,
      entries: entries.map((e) => ({ ...e, outcome: auditOutcome(e) }))
    },
    null,
    2
  )
}
