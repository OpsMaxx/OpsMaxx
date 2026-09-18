import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound } from 'lucide-react'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import type { AgentIdentity, AgentStatus, ApprovalScope } from '../../../../shared/sshAgentHost'

/**
 * Turning the agent on, and the one thing the user has to do afterwards.
 *
 * That last part is most of this panel's job. An agent nothing points at is an
 * agent that does nothing, and the failure is silent: `git push` goes on using
 * `~/.ssh` and the user concludes the feature does not work. So the socket path
 * is shown, with the exact line to put in a shell, and it is copyable.
 */
export function AgentPanel(): React.JSX.Element {
  const settings = useApp((s) => s.settings.sshAgent)
  const setSettings = useApp((s) => s.setSettings)
  const [status, setStatus] = useState<AgentStatus>({ running: false, identities: 0 })
  const [keys, setKeys] = useState<AgentIdentity[]>([])
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    const bridge = window.opsmaxx?.sshAgent
    if (!bridge) return
    setStatus(await bridge.status())
    setKeys(await bridge.identities())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const apply = async (next: Partial<typeof settings>): Promise<void> => {
    const merged = { ...settings, ...next }
    setSettings({ sshAgent: merged })
    const result = await window.opsmaxx?.sshAgent.configure(merged)
    if (result) setStatus(result)
    void refresh()
  }

  const usable = keys.filter((k) => !k.problem)
  const broken = keys.filter((k) => k.problem)
  const envLine = status.path ? `export SSH_AUTH_SOCK="${status.path}"` : ''

  return (
    <div className="agent-panel">
      <label className="setting-row">
        <div>
          <div className="setting-label">Let other tools use the SSH keys in your vault</div>
          <div className="setting-desc">
            Starts an SSH agent that offers the keys stored here to git, ansible, rsync and anything
            else that looks for one. Nothing is signed without asking you first.
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void apply({ enabled: e.target.checked })}
        />
      </label>

      {settings.enabled && status.error && (
        <div className="agent-panel-problem" role="alert">
          <AlertTriangle size={15} aria-hidden /> {status.error}
        </div>
      )}

      {status.running && status.path && (
        <div className="agent-panel-sock">
          <div className="setting-label">Point your shell at it</div>
          {/* The step that is easy to skip and silently fatal: an agent
              nothing points at does nothing, `git push` goes on using ~/.ssh,
              and the user concludes the feature is broken. */}
          <div className="setting-desc">
            Add this to your shell profile, or run it in a terminal to try it now. The path changes
            each time OpsMaxx starts.
          </div>
          <div className="agent-panel-code">
            <code>{envLine}</code>
            <button
              className="btn"
              aria-label="Copy"
              onClick={() => {
                void navigator.clipboard.writeText(envLine)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
                toast('Copied')
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <div className="setting-desc">
            Then <code>ssh-add -l</code> should list {usable.length}{' '}
            {usable.length === 1 ? 'key' : 'keys'}.
          </div>
        </div>
      )}

      <div className="agent-panel-keys">
        <div className="setting-label">
          <KeyRound size={14} aria-hidden /> Keys it can offer
        </div>
        {keys.length === 0 && (
          <div className="setting-desc">
            No SSH keys in the vault yet. Add one with its private key and it appears here.
          </div>
        )}
        {usable.map((k) => (
          <div key={k.entryId} className="agent-panel-key">
            <span>{k.name}</span>
            {/* The fingerprint, so the user can check it against what they see
                on a server rather than taking our word for which key it is. */}
            <code>{k.fingerprint}</code>
          </div>
        ))}
        {broken.map((k) => (
          <div key={k.entryId} className="agent-panel-key agent-panel-key-broken">
            <span>{k.name}</span>
            {/* Shown rather than dropped. A key that silently vanishes is a
                support ticket; one that says why is fixed in ten seconds. */}
            <span className="agent-panel-why">{k.problem}</span>
          </div>
        ))}
      </div>

      {settings.enabled && (
        <>
          <label className="setting-row">
            <div>
              <div className="setting-label">When you approve, remember it for</div>
              <div className="setting-desc">
                What the prompt offers by default. You can always pick something else in the prompt
                itself.
              </div>
            </div>
            <select
              value={settings.defaultScope}
              onChange={(e) => void apply({ defaultScope: e.target.value as ApprovalScope })}
            >
              <option value="once">this signature only</option>
              <option value="window">{settings.windowMinutes} minutes</option>
              <option value="session">until the vault locks</option>
            </select>
          </label>

          <label className="setting-row">
            <div>
              <div className="setting-label">When that time runs out</div>
              {/* Two settings rather than one, because "how long" and "what
                  then" have different right answers: refusing outright is for
                  somebody who wants a key usable for one task and then inert
                  without having to remember to revoke it. */}
              <div className="setting-desc">
                Ask again, or stop using that key entirely until OpsMaxx restarts.
              </div>
            </div>
            <select
              value={settings.onExpiry}
              onChange={(e) => void apply({ onExpiry: e.target.value as 'ask-again' | 'refuse' })}
            >
              <option value="ask-again">ask again</option>
              <option value="refuse">refuse until restart</option>
            </select>
          </label>

          <label className="setting-row">
            <div>
              <div className="setting-label">Stop signing when the vault auto-locks the screen</div>
              <div className="setting-desc">
                The vault keeps resolving credentials for background work after it hides your
                entries. This makes signatures stop at that point too — for when you want the agent
                inert the moment you walk away, rather than only when the vault fully locks.
              </div>
            </div>
            <input
              type="checkbox"
              checked={settings.requireOpenVault}
              onChange={(e) => void apply({ requireOpenVault: e.target.checked })}
            />
          </label>
        </>
      )}
    </div>
  )
}
