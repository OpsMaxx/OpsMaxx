import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { ApprovalRequest, ApprovalScope } from '../../../../shared/mcp'
import { approvalWhere, describeConsequence, formatRiskLabel, riskTone } from '../../../../shared/approvalRisk'
import { bridgeOn } from '../../lib/bridge'
import { WritePreview, capabilityLabel, sessionGrantLabel } from './ApprovalDialog'
import { useArming } from '../../hooks/useArming'
import { useT } from '../../lib/i18n'

export function AiApprovals(): React.JSX.Element {
  // `null` until the first read comes back, NOT `[]`.
  //
  // This panel says "Nothing waiting on you right now", and that sentence is
  // the reason an operator walks away from this screen. Said before the read
  // returned, it is a claim about an agent that may be blocked on a decision
  // this very moment. Of the three screens in this app that assert an absence,
  // this is the one whose absence someone acts on.
  const [approvals, setApprovals] = useState<ApprovalRequest[] | null>(null)
  // A read that FAILED is not an empty list either, and it used to become one:
  // the promise had no rejection path, so a bridge error left the panel saying
  // nothing was waiting, for as long as it stayed open.
  const [unreadable, setUnreadable] = useState(false)
  // What recently resolved, including the ones nobody answered. Its own call:
  // these must never reach the modal queue or the sidebar badge.
  const [recent, setRecent] = useState<ApprovalRequest[]>([])
  // Keyed on the whole list, not a row: a withdrawn row closes up the list and
  // moves a different request's Approve under the pointer, so any change to
  // what is waiting re-arms every yes on the page.
  const { armed, allow, noteKey } = useArming((approvals ?? []).map((a) => a.id).join(','))
  const t = useT()

  const load = (): void => {
    void window.opsmaxx?.aiMcp
      .listApprovals()
      .then((a) => {
        setApprovals(a ?? [])
        setUnreadable(false)
      })
      .catch(() => setUnreadable(true))
    void window.opsmaxx?.aiMcp.recentApprovals?.().then((a) => setRecent(a ?? []))
  }

  useEffect(() => {
    load()
    const off = bridgeOn('aiMcp.onApprovalEvent', window.opsmaxx?.aiMcp?.onApprovalEvent, load)
    const timer = setInterval(load, 3000)
    return () => {
      off?.()
      clearInterval(timer)
    }
  }, [])

  const respond = async (id: string, decision: 'approved' | 'denied', scope?: ApprovalScope): Promise<void> => {
    const bridge = window.opsmaxx?.aiMcp
    await (scope ? bridge?.respondApproval(id, decision, scope) : bridge?.respondApproval(id, decision))
    load()
  }

  return (
    <div className="settings-section">
      <h2>{t('nav.ai.approvals')}</h2>
      <div className="sub">{t('ai.approvals.intro')}</div>

      {unreadable ? (
        <div className="s-desc state-unknown">{t('ai.approvals.unreadable')}</div>
      ) : approvals === null ? (
        <div className="s-desc state-unknown">{t('ai.approvals.checking')}</div>
      ) : approvals.length === 0 ? (
        <div className="s-desc">{t('ai.approvals.nothingWaiting')}</div>
      ) : null}

      {/* Same vocabulary as the modal, from the same module. This list used to
          print a bare "risk: HIGH", which is a word with no scale next to it —
          it cannot be read as the top of three rather than the middle of five,
          and it says nothing about what the action does. Two surfaces showing
          the same request must not disagree about how serious it is. */}
      {(approvals ?? []).map((a) => {
        const subject = {
          capability: a.capability,
          action: a.action,
          risk: a.risk,
          serverName: a.serverName,
          workspaceName: a.workspaceName
        }
        const tone = riskTone(a.risk)
        const consequence = describeConsequence(subject)
        // Same two yeses as the modal, with the same labels from the same
        // function: a grant must read the same wherever it is given.
        const grantLabel = sessionGrantLabel(a)
        return (
        <div className="list-row" key={a.id}>
          <div>
            <div className="r-title">{a.agentName}</div>
            <div className="r-sub">
              {approvalWhere(a)} ·{' '}
              <span
                style={{
                  color:
                    tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--text-muted)',
                  fontWeight: 600
                }}
              >
                {formatRiskLabel(a.risk)}
              </span>
            </div>
            <div className="r-sub" style={{ color: consequence.known ? 'var(--text-muted)' : 'var(--warn)' }}>
              {consequence.text}
            </div>
            <div className="r-sub mono">{a.action}</div>
            <div className="r-sub">{t('ai.approvals.permission', { permission: capabilityLabel(a.capability) })}</div>
            {a.policyReason && <div className="r-sub">{t('ai.approvals.rule', { rule: a.policyReason })}</div>}
            {a.contentPreview && <WritePreview agentName={a.agentName} preview={a.contentPreview} />}
            {a.contentPreview && grantLabel && (
              <div className="r-sub" style={{ color: 'var(--warn)' }}>
                {t('ai.approval.laterWritesUnseen')}
              </div>
            )}
          </div>
          <div className="spacer" />
          <button className="btn sm danger" onClick={() => respond(a.id, 'denied')}>
            <X size={13} /> {t('ai.approvals.deny')}
          </button>
          {grantLabel && (
            <button
              className="btn sm"
              aria-disabled={!armed}
              onKeyDown={noteKey}
              onClick={(e) => {
                if (allow(e)) void respond(a.id, 'approved', 'session')
              }}
            >
              {grantLabel}
            </button>
          )}
          <button
            className="btn sm"
            aria-disabled={!armed}
            onKeyDown={noteKey}
            onClick={(e) => {
              if (allow(e)) void respond(a.id, 'approved', 'once')
            }}
          >
            <Check size={13} /> {t('ai.approvals.approveOnce')}
          </button>
        </div>
        )
      })}

      {/* A TIMED-OUT REQUEST USED TO LEAVE NO TRACE HERE. finish() deletes it
          from the pending map, so the row simply vanished on the next poll and
          the only record was an audit line on another page — while the agent
          had been told a human refused it. These are read-only: the request is
          resolved and the agent has long since been answered. */}
      {recent.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>{t('ai.approvals.recentTitle')}</h3>
          <div className="sub">{t('ai.approvals.recentSub')}</div>
          {recent.map((a) => (
            <div className="list-row" key={a.id} style={{ opacity: 0.75 }}>
              <div>
                <div className="r-title">
                  {a.agentName} ·{' '}
                  <span style={{ color: a.status === 'approved' ? 'var(--text-muted)' : 'var(--warn)' }}>
                    {a.status === 'timeout'
                      ? t('ai.approvals.timedOut')
                      : a.status === 'disconnected'
                        ? t('ai.approvals.disconnected')
                        : a.grantedScope === 'session'
                          ? t('ai.approvals.approvedSession')
                          : a.status === 'approved'
                            ? t('ai.approvals.approved')
                            : a.status === 'denied'
                              ? t('ai.approvals.denied')
                              : a.status}
                  </span>
                </div>
                <div className="r-sub">{approvalWhere(a)}</div>
                <div className="r-sub mono">{a.action}</div>
                {a.policyReason && <div className="r-sub">{t('ai.approvals.rule', { rule: a.policyReason })}</div>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
