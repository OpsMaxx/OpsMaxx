import type { AuditEntry } from '../../../../shared/mcp'

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

export function auditOutcome(e: Pick<AuditEntry, 'approval' | 'result' | 'exitCode' | 'error'>): AuditOutcome {
  const code = e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ''

  // Timeout first: it is a denial, and it is the one the operator did NOT make.
  // Reporting it as "denied" is the single most misleading thing this table
  // could do, because it says a person decided when nobody did.
  if (e.approval === 'timeout') {
    return {
      label: 'Denied — timed out',
      decidedBy: 'timeout',
      tone: 'warn',
      detail:
        'Nobody answered before the approval timeout, so OpsMaxx denied it. That is the fail-closed default, not a decision somebody made.'
    }
  }
  if (e.approval === 'denied') {
    return { label: 'Denied', decidedBy: 'you', tone: 'danger', detail: 'You refused this request.' }
  }
  // Refused without asking anyone -- the queue was full, or the same thing was
  // just denied. It used to be written as `denied` and read "You refused this
  // request", about a request nobody was shown.
  if (e.approval === 'not-asked') {
    return {
      label: 'Denied — not asked',
      decidedBy: 'policy',
      tone: 'warn',
      detail: e.error
        ? `${e.error}. Nobody was shown this request.`
        : 'OpsMaxx did not ask anyone about this request, and it did not run.'
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
    return {
      label: 'Blocked by policy',
      decidedBy: 'policy',
      tone: 'danger',
      detail: e.error
        ? `The access group refused this: ${e.error} Nothing was asked.`
        : 'The access group refused this. Nothing was asked.'
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
  const prefix =
    e.approval === 'approved-for-session'
      ? 'Approved for session'
      : e.approval === 'approved-earlier'
        ? 'Approved earlier'
        : e.approval === 'approved'
          ? 'Approved'
          : 'Allowed'
  const because =
    e.approval === 'approved'
      ? 'You approved this request.'
      : e.approval === 'approved-for-session'
        ? 'You approved this request, and allowed the same on this server for the rest of the session.'
        : e.approval === 'approved-earlier'
          ? // Not "you allowed this for the session": rows written up to
            // 0.50.25 were carried by an "Approve once" click, which the
            // operator never knew was a session grant, and nothing in a row
            // says which era wrote it.
            'Nothing was asked: an approval given earlier in this session covered it.'
          : 'The access group allowed this outright, so nothing was asked.'

  if (e.result === 'denied') {
    // Approval said yes and something downstream still said no. Only a row
    // with a human approval reaches here -- a policy refusal returned above --
    // so "then" is always true of it.
    return {
      label: `${prefix}, then blocked`,
      decidedBy: who,
      tone: 'danger',
      detail: `${because} It was then refused by a path rule or a capability the group does not grant.`
    }
  }
  if (e.result === 'error') {
    return {
      label: `${prefix}, failed${code}`,
      decidedBy: who,
      tone: 'danger',
      detail: e.error ? `${because} The server said: ${e.error}` : `${because} It ran and failed.`
    }
  }
  return {
    label: `${prefix}, ran${code}`,
    decidedBy: who,
    tone: e.approval === 'approved' || e.approval === 'approved-for-session' ? 'ok' : 'muted',
    detail: `${because} It ran and returned success.`
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
