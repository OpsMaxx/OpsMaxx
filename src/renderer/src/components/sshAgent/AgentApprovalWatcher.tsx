import { useEffect, useState } from 'react'
import { KeyRound, ShieldAlert, Network } from 'lucide-react'
import type { AgentApprovalRequest, ApprovalScope } from '../../../../shared/sshAgentHost'

/**
 * The prompt that appears when something asks the agent to sign.
 *
 * MOUNTED AT APP LEVEL, like the AI approval watcher and the SSH prompt, and
 * for a stronger reason than either: the thing asking is almost never OpsMaxx.
 * It is `git push` in a terminal, or ansible, or a script. The user is looking
 * at something else entirely, so a prompt that only appeared on a settings page
 * would be a prompt nobody answers and a command that hangs for two minutes.
 *
 * The prompt NAMES THE KEY. "An application wants to use an SSH key" is a
 * question nobody can answer; "git is asking to authenticate with Production
 * key" is one they can. Where the agent knows the destination it shows that
 * too, and where it does not it says so -- a signature going somewhere the
 * agent cannot see is worth knowing about, not worth hiding.
 */
export function AgentApprovalWatcher(): React.JSX.Element | null {
  const [queue, setQueue] = useState<AgentApprovalRequest[]>([])

  useEffect(() => {
    const bridge = window.opsmaxx?.sshAgent
    if (!bridge) return
    // Read once on mount as well as subscribing: a prompt raised while no
    // window was open would otherwise never be seen, and the caller would wait
    // out the full timeout for a dialog that was never drawn.
    void bridge.pending().then(setQueue)
    return bridge.onApprovalEvent((e) => {
      setQueue((held) =>
        e.type === 'created'
          ? [...held.filter((r) => r.id !== e.request.id), e.request]
          : held.filter((r) => r.id !== e.request.id)
      )
    })
  }, [])

  const request = queue[0]
  if (!request) return null

  const answer = (allow: boolean, scope: ApprovalScope = 'once'): void => {
    void window.opsmaxx?.sshAgent.resolve(request.id, allow ? { allow: true, scope } : { allow: false })
    setQueue((held) => held.filter((r) => r.id !== request.id))
  }

  return (
    <div className="agent-approval-scrim" role="dialog" aria-modal="true">
      <div className="agent-approval">
        <KeyRound size={28} className="agent-approval-icon" aria-hidden />
        <h2>Something wants to use an SSH key</h2>

        <dl className="agent-approval-facts">
          <dt>Key</dt>
          <dd>
            {request.identity.name}
            <span className="agent-approval-fp">{request.identity.fingerprint}</span>
          </dd>

          <dt>Going to</dt>
          <dd>
            {request.destination ? (
              <>
                <span className="agent-approval-fp">{request.destination.hostKeyFingerprint}</span>
                {request.destination.forwarded && (
                  <span className="agent-approval-warn">
                    <Network size={13} aria-hidden /> a forwarded connection — this request came from
                    another machine
                  </span>
                )}
              </>
            ) : (
              <span className="agent-approval-warn">
                <ShieldAlert size={13} aria-hidden /> the client did not say, so the key could be used
                for anything
              </span>
            )}
          </dd>
        </dl>

        {/* Refuse first, and focused. The safe answer should be the one a
            reflexive Return produces -- the expensive mistake here is allowing
            something you did not mean to, and it is not reversible. */}
        <div className="agent-approval-actions">
          <button className="btn" autoFocus onClick={() => answer(false)}>
            Refuse
          </button>
          <button className="btn" onClick={() => answer(true, 'once')}>
            Allow once
          </button>
          <button className="btn" onClick={() => answer(true, 'window')}>
            Allow for a while
          </button>
          <button className="btn" onClick={() => answer(true, 'session')}>
            Allow until the vault locks
          </button>
        </div>

        {queue.length > 1 && (
          <p className="fine">{queue.length - 1} more waiting.</p>
        )}
      </div>
    </div>
  )
}
