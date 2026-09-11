import { useEffect, useState } from 'react'
import { Clock, Octagon, ShieldAlert, X } from 'lucide-react'
import type { ApprovalRequest, AuditEntry, McpAgentSession } from '../../../../shared/mcp'
import { describeConsequence, describeDenial, explainRisk } from '../../../../shared/approvalRisk'
import { duration } from '../../lib/format'
import {
  canExtendFuse,
  deferApproval,
  denyAndStopAllAi,
  extendApprovalFuse,
  respondToApproval,
  useApprovalFuse
} from '../../store/approvalQueue'

// The approval modal.
//
// WHAT THIS SCREEN IS. Everywhere else in OpsMaxx the person confirming an
// action is the person who started it, and the dialog only has to describe the
// blast radius. Here they did not start it, are probably part-way through
// something else, and have no idea what the agent is pursuing. Before this
// rewrite the modal showed four labelled facts — agent, workspace/server,
// action, and the bare word HIGH — which is less than the same app shows a
// human who cordons a node they asked to cordon themselves.
//
// So the order is deliberate and it is not the order the data arrives in:
// consequence in plain English first, the command underneath it as EVIDENCE
// rather than as the headline, then who is asking and how long they have been
// connected. An operator who reads only the first sentence should still have
// read the most important thing on the screen.
//
// THE BUTTON WEIGHTING IS INVERTED ON HIGH RISK, on purpose. The affirmative
// used to be the filled accent button in the macOS default position, so the
// tired Return-press approved. In a dialog where the safe answer is usually
// "no", the visual weight belongs on Deny; Approve stays a perfectly ordinary
// button, reachable and unhidden, because the goal is a considered yes and not
// a hard one.

const AUDIT_WINDOW = 500

interface Provenance {
  /** When the session connected, or null when nothing could say. */
  startedAt: string | null
  /** The access group named on the session, or null. */
  groupName: string | null
  /** False only while the fallback read is still in flight. */
  sessionRead: boolean
  /** Recorded actions this session has already taken, or null if unreadable. */
  actions: number | null
  /** True when the count came from a filled tail read, so it is a floor. */
  capped: boolean
}

/**
 * Who is asking, and how much they have already done.
 *
 * MAIN'S ANSWER FIRST. The request now carries the session's start, its access
 * group and an exact action count, because main holds the session record and
 * can read the whole audit log rather than a tail of it. When they are there,
 * both IPC round-trips below are skipped: they were two reads per modal for
 * facts the process raising the request already knew.
 *
 * THE READS STAY, as the fallback for a request that arrives without them —
 * and they stay honest. Both can fail, and when they do this reports null
 * rather than 0: "this session has taken no actions" and "OpsMaxx could not
 * find out" are opposite pieces of news, and rendering the second as the first
 * is exactly the failure this product's rules forbid. The tail read also
 * reports `capped`, so a number derived from a truncated window can never be
 * printed with the flat confidence of main's exact one.
 */
function useProvenance(request: ApprovalRequest): Provenance {
  const knownStart = request.sessionStartedAt ?? null
  const knownActions = request.actionsThisSession

  const initial = (): Provenance => ({
    startedAt: knownStart,
    groupName: request.sessionGroupName ?? null,
    sessionRead: knownStart !== null,
    actions: typeof knownActions === 'number' ? knownActions : null,
    capped: false
  })

  const [p, setP] = useState<Provenance>(initial)

  useEffect(() => {
    let live = true
    setP(initial())

    if (knownStart === null) {
      void window.opsmaxx?.aiMcp
        ?.listSessions?.()
        .then((all: McpAgentSession[] | undefined) => {
          if (!live) return
          const found = all?.find((s) => s.id === request.sessionId) ?? null
          setP((prev) => ({
            ...prev,
            startedAt: found?.createdAt ?? null,
            groupName: found?.groupName ?? null,
            sessionRead: true
          }))
        })
        .catch(() => live && setP((prev) => ({ ...prev, sessionRead: true })))
    }

    if (typeof knownActions !== 'number') {
      void window.opsmaxx?.aiMcp
        ?.listAudit?.(AUDIT_WINDOW)
        .then((entries: AuditEntry[] | undefined) => {
          if (!live || !entries) return
          setP((prev) => ({
            ...prev,
            actions: entries.filter((e) => e.sessionId === request.sessionId).length,
            // listAudit returns the tail of the file. A full window means older
            // entries exist that were not read, so the count is a floor and the
            // sentence has to say "at least" — a count presented as exact when it
            // is a tail read is a measured-looking number nobody measured.
            capped: entries.length >= AUDIT_WINDOW
          }))
        })
        .catch(() => {})
    }

    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id, request.sessionId, knownStart, knownActions, request.sessionGroupName])

  return p
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
      <div style={{ width: 132, flex: 'none', color: 'var(--text-faint)', fontSize: 11 }}>{label}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, minWidth: 0 }}>{children}</div>
    </div>
  )
}

export function ApprovalDialog({
  request,
  waiting
}: {
  request: ApprovalRequest
  waiting: number
}): React.JSX.Element {
  const subject = {
    capability: request.capability,
    action: request.action,
    risk: request.risk,
    serverName: request.serverName,
    workspaceName: request.workspaceName,
    // Main's own rule, when the gate() call site recorded one. explainRisk
    // prefers it over the derivation in approvalRisk.ts, which exists now only
    // for a call site that supplied none.
    riskReason: request.riskReason
  }
  const risk = explainRisk(subject)
  const consequence = describeConsequence(subject)
  const fuse = useApprovalFuse(request)
  const prov = useProvenance(request)
  const extendable = canExtendFuse()

  const toneText =
    risk.tone === 'danger' ? 'var(--danger)' : risk.tone === 'warn' ? 'var(--warn)' : 'var(--text-muted)'
  const toneFill =
    risk.tone === 'danger' ? 'var(--danger-soft)' : risk.tone === 'warn' ? 'var(--warn-soft)' : 'var(--bg-elevated)'
  const toneEdge = risk.tone === 'neutral' ? 'var(--border)' : toneText

  return (
    // No click-outside handler, and no bare ✕ — this is not the shared Modal
    // component for exactly that reason. A stray click on the scrim used to
    // dismiss this dialog, and a dismissed dialog left an agent blocked with a
    // burning fuse and nothing on screen to say so.
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal aria-label="AI action requires approval">
        <div className="modal-header">
          <div>
            <h2>
              <ShieldAlert size={15} style={{ verticalAlign: -2, marginRight: 6, color: toneText }} />
              {request.agentName} is asking to act on {request.serverName}
            </h2>
            <div className="sub">
              It is blocked until you answer. {waiting > 1 ? `${waiting - 1} more request(s) behind this one.` : ''}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            {/* The fuse, in the header, because it is a fact about the DIALOG
                and not about the action. Fail-closed on timeout is the right
                default; being fail-closed invisibly is not. Absent entirely
                when the configured timeout could not be read — a countdown is
                a promise about when this dies, and a wrong one is worse than
                none. */}
            {fuse.text !== null && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  justifyContent: 'flex-end',
                  color: fuse.expired || (fuse.msLeft ?? 0) < 30_000 ? 'var(--danger)' : 'var(--text-muted)',
                  fontWeight: 600,
                  fontSize: 12
                }}
              >
                <Clock size={12} />
                {fuse.expired ? 'Expired — waiting for the bridge' : `Auto-denies in ${fuse.text}`}
              </div>
            )}
            {fuse.text !== null &&
              (extendable ? (
                <button
                  className="btn sm"
                  style={{ marginTop: 6 }}
                  onClick={() => void extendApprovalFuse(request.id, 300)}
                >
                  Give me more time
                </button>
              ) : (
                // The honest absence. The timer lives in main's approvals.ts
                // and no IPC reaches it, so a "Give me more time" button here
                // would be a control that looked like it worked and did not.
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-faint)', maxWidth: 210 }}>
                  This build cannot extend the fuse. Decide later keeps it in the status bar — the clock keeps
                  running either way.
                </div>
              ))}
          </div>
        </div>

        <div className="modal-body">
          {/* 1. Risk, as a band with a scale and a reason. The old modal put
              the word HIGH in the fourth of four identical grey rows, which
              gave it the same weight as the workspace name. */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--r-md)',
              background: toneFill,
              border: `1px solid ${toneEdge}`
            }}
          >
            <div style={{ color: toneText, fontWeight: 700, fontSize: 12, letterSpacing: 0.3 }}>{risk.label}</div>
            <div style={{ color: 'var(--text)', fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{risk.sentence}</div>
            {/* WHICH RULE ASKED, not what the action is.
                An operator who has set a session's ceiling to Full Access and is
                still being prompted on every command has no way to find out
                which of the two layers said no -- the ceiling is a cap, the
                workspace or server assignment is the grant, and the effective
                answer is the more restrictive of the two. The policy engine
                names the rule in one sentence and the card was the one place
                not showing it. */}
            {request.policyReason && (
              <div
                style={{
                  color: 'var(--text-muted)',
                  fontSize: 'var(--fs-caption)',
                  marginTop: 6,
                  lineHeight: 1.5
                }}
              >
                Rule: {request.policyReason}
              </div>
            )}
          </div>

          {/* 2. Consequence FIRST, in plain English. */}
          <div
            style={{
              borderLeft: `3px solid ${consequence.known ? 'var(--border-strong)' : 'var(--warn)'}`,
              paddingLeft: 12
            }}
          >
            <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text)' }}>{consequence.text}</div>
            {!consequence.known && (
              <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 6 }}>
                Not being able to describe an action is itself a reason to look harder at it.
              </div>
            )}
          </div>

          {/* 3. The command, as evidence — secondary to the sentence above it. */}
          <div>
            <div style={{ color: 'var(--text-faint)', fontSize: 11, marginBottom: 4 }}>
              What {request.agentName} asked OpsMaxx to run
            </div>
            <pre
              className="mono"
              style={{
                margin: 0,
                padding: '8px 10px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-md)',
                color: 'var(--text-muted)',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all'
              }}
            >
              {request.action}
            </pre>
          </div>

          {/* 4. Provenance. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Row label="Agent">
              {request.agentName}
              {prov.groupName ? ` · access group ${prov.groupName}` : ''}
              {request.toolName ? (
                <span className="mono" style={{ color: 'var(--text-faint)' }}> · called {request.toolName}</span>
              ) : (
                ''
              )}
            </Row>
            <Row label="Where">
              {request.workspaceName} / {request.serverName}
            </Row>
            <Row label="Session">
              {!prov.sessionRead ? (
                'reading…'
              ) : prov.startedAt ? (
                <>
                  connected {duration(Date.parse(prov.startedAt))} ago
                  <span className="mono" style={{ color: 'var(--text-faint)' }}>
                    {' '}
                    ({request.sessionId})
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--warn)' }}>
                  OpsMaxx has no session record for {request.sessionId} — it cannot say who this is or when they
                  connected.
                </span>
              )}
            </Row>
            <Row label="Actions so far">
              {prov.actions === null ? (
                <span style={{ color: 'var(--warn)' }}>
                  OpsMaxx could not read the audit log, so it cannot say whether this is this session’s first
                  action or its fortieth.
                </span>
              ) : (
                // "at least" only for the renderer's own tail read. Main counts
                // the whole log or sends nothing, so a number that came from the
                // request is exact and says so by not hedging — and a hedged
                // number can never be mistaken for one.
                `${prov.capped ? 'at least ' : ''}${prov.actions} recorded before this one`
              )}
            </Row>
            <Row label="What led to this">
              {/* THE ONE FIELD ON THIS SCREEN THE AGENT WROTE.
                  Rendered as an attributed quotation, in the agent's name, and
                  never as OpsMaxx's own voice — the party asking for
                  permission also writes this sentence, so it is evidence about
                  the agent and never evidence about the action. It arrives
                  already flattened, stripped and capped (sanitizeAgentIntent);
                  React escapes what is left; nothing here parses it.

                  Absent is still its own state, and the sentence still names
                  whose gap it is: the bridge offers every gated tool an
                  optional `intent`, so nothing arriving means the agent chose
                  not to say, which is a fact about the agent worth reading. */}
              {request.intent ? (
                <>
                  <span style={{ color: 'var(--text)' }}>“{request.intent}”</span>
                  <div style={{ color: 'var(--text-faint)', fontSize: 11, marginTop: 3 }}>
                    {request.agentName}’s own words, not OpsMaxx’s. Nothing checked whether they are true.
                  </div>
                </>
              ) : (
                <span style={{ color: 'var(--warn)' }}>
                  {request.agentName} sent no reason. OpsMaxx asks for one on every gated call and does not
                  require it, so nothing here knows what task this action belongs to.
                </span>
              )}
            </Row>
            <Row label="If you deny">{describeDenial(subject)}</Row>
          </div>
        </div>

        <div className="modal-footer">
          {/* The kill switch, brought to where the alarm is. Its own copy lives
              three screens away in AI & MCP > Security; this calls the same IPC
              rather than reimplementing any of it. */}
          <button
            className="btn sm"
            style={{ color: 'var(--danger)', borderColor: 'transparent', background: 'transparent' }}
            onClick={() => void denyAndStopAllAi()}
          >
            <Octagon size={13} /> Deny and stop all AI access
          </button>
          <div className="spacer" />
          {/* Labelled, not a bare ✕.
              The choice was between removing the dismiss control entirely and
              naming what it does, and naming it won. A modal with no way out
              traps the operator who wants to go and check something first —
              which is the careful behaviour, the one this dialog most wants —
              and a trapped operator clicks the affirmative to get their screen
              back. Deferring is safe precisely because the default is
              fail-closed: the fuse keeps burning, an unanswered request still
              ends in a denial, and the status-bar chip keeps it visible and
              clickable the whole time. A bare ✕ could not have been used for
              this, because a ✕ does not say whether it denies or defers. */}
          <button className="btn ghost" onClick={() => deferApproval(request.id)}>
            <X size={13} /> Decide later
          </button>
          <button className="btn" onClick={() => void respondToApproval(request.id, 'approved')}>
            Approve once
          </button>
          <button
            className="btn"
            autoFocus
            style={{
              background: 'var(--danger-soft)',
              borderColor: 'var(--danger)',
              color: 'var(--danger)',
              fontWeight: 650
            }}
            onClick={() => void respondToApproval(request.id, 'denied')}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  )
}
