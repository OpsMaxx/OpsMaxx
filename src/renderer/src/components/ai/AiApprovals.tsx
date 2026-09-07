import { useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { ApprovalRequest } from '../../../../shared/mcp'
import { describeConsequence, formatRiskLabel, riskTone } from '../../../../shared/approvalRisk'
import { bridgeOn } from '../../lib/bridge'

export function AiApprovals(): React.JSX.Element {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])

  const load = (): void => {
    void window.opsmaxx?.aiMcp.listApprovals().then((a) => setApprovals(a ?? []))
  }

  useEffect(() => {
    load()
    const off = bridgeOn('aiMcp.onApprovalEvent', window.opsmaxx?.aiMcp?.onApprovalEvent, load)
    const t = setInterval(load, 3000)
    return () => {
      off?.()
      clearInterval(t)
    }
  }, [])

  const respond = async (id: string, decision: 'approved' | 'denied'): Promise<void> => {
    await window.opsmaxx?.aiMcp.respondApproval(id, decision)
    load()
  }

  return (
    <div className="settings-section">
      <h2>Approvals</h2>
      <div className="sub">
        Actions an access group marked ASK wait here for your decision. An AI agent can never approve
        its own request — only this UI can.
      </div>

      {approvals.length === 0 && <div className="s-desc">Nothing waiting on you right now.</div>}

      {/* Same vocabulary as the modal, from the same module. This list used to
          print a bare "risk: HIGH", which is a word with no scale next to it —
          it cannot be read as the top of three rather than the middle of five,
          and it says nothing about what the action does. Two surfaces showing
          the same request must not disagree about how serious it is. */}
      {approvals.map((a) => {
        const subject = {
          capability: a.capability,
          action: a.action,
          risk: a.risk,
          serverName: a.serverName,
          workspaceName: a.workspaceName
        }
        const tone = riskTone(a.risk)
        const consequence = describeConsequence(subject)
        return (
        <div className="list-row" key={a.id}>
          <div>
            <div className="r-title">{a.agentName}</div>
            <div className="r-sub">
              {a.workspaceName} / {a.serverName} ·{' '}
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
          </div>
          <div className="spacer" />
          <button className="btn sm danger" onClick={() => respond(a.id, 'denied')}>
            <X size={13} /> Deny
          </button>
          <button className="btn sm primary" onClick={() => respond(a.id, 'approved')}>
            <Check size={13} /> Approve once
          </button>
        </div>
        )
      })}
    </div>
  )
}
