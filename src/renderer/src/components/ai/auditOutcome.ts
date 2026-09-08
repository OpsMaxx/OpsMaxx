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

  // Approved, or never needed approval. What matters now is what happened.
  const who: AuditOutcome['decidedBy'] = e.approval === 'approved' ? 'you' : 'policy'
  const prefix = e.approval === 'approved' ? 'Approved' : 'Allowed'
  const because =
    e.approval === 'approved'
      ? 'You approved this request.'
      : 'The access group allowed this outright, so nothing was asked.'

  if (e.result === 'denied') {
    // Approval said yes and something downstream still said no — a path rule,
    // or a capability the group does not grant. Collapsing this into "denied"
    // would lose exactly the distinction an incident review needs.
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
    tone: e.approval === 'approved' ? 'ok' : 'muted',
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
