import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound } from 'lucide-react'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import { toast } from '../../store/toast'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
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
  const t = useT()
  const settings = useApp((s) => s.settings.sshAgent)
  const setSettings = useApp((s) => s.setSettings)
  const [status, setStatus] = useState<AgentStatus>({ running: false, identities: 0 })
  const [keys, setKeys] = useState<AgentIdentity[]>([])
  const [copied, setCopied] = useState(false)
  // `unlocked` is true in both `open` and `secured`, which is the right
  // question here: the agent resolves through `vaultEntriesForResolve`, so it
  // keeps working while secured and only goes inert on a full lock.
  const vaultLocked = useVault((s) => s.exists === true && !s.unlocked)

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
          <div className="setting-label">{t('sshAgent.panel.enableLabel')}</div>
          <div className="setting-desc">{t('sshAgent.panel.enableDesc')}</div>
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
          <div className="setting-label">{t('sshAgent.panel.pointShell')}</div>
          {/* The step that is easy to skip and silently fatal: an agent
              nothing points at does nothing, `git push` goes on using ~/.ssh,
              and the user concludes the feature is broken. */}
          <div className="setting-desc">{t('sshAgent.panel.pointShellDesc')}</div>
          <div className="agent-panel-code">
            <code>{envLine}</code>
            <button
              className="btn"
              aria-label={t('common.copy')}
              onClick={() => {
                void navigator.clipboard.writeText(envLine)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
                toast(t('common.copied'))
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <div className="setting-desc">
            <Trans
              i18nKey="sshAgent.panel.sshAddList"
              values={{ count: usable.length }}
              components={{ code: <code /> }}
            />
          </div>
        </div>
      )}

      <div className="agent-panel-keys">
        <div className="setting-label">
          <KeyRound size={14} aria-hidden /> {t('sshAgent.panel.keysLabel')}
        </div>
        {/* A LOCKED VAULT IS NOT AN EMPTY ONE.
            `identities()` reads through `vaultEntriesForResolve`, which
            answers nothing while the vault is locked — so every key vanished
            from this list and the panel said "No SSH keys in the vault yet",
            telling the user to add keys they already have. The agent is inert
            at the same time: `canSign()` refuses every signature, so `git
            push` silently falls back to ~/.ssh and the feature looks broken.
            Nothing here said the vault was the reason. */}
        {keys.length === 0 &&
          (vaultLocked ? (
            <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
              <div className="setting-desc grow">{t('sshAgent.panel.locked')}</div>
              <UnlockVaultButton reason={t('sshAgent.panel.unlockReason')} />
            </div>
          ) : (
            <div className="setting-desc">{t('sshAgent.panel.noKeys')}</div>
          ))}
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
              <div className="setting-label">{t('sshAgent.panel.rememberLabel')}</div>
              <div className="setting-desc">{t('sshAgent.panel.rememberDesc')}</div>
            </div>
            <select
              value={settings.defaultScope}
              onChange={(e) => void apply({ defaultScope: e.target.value as ApprovalScope })}
            >
              <option value="once">{t('sshAgent.panel.scope.once')}</option>
              <option value="window">
                {t('sshAgent.panel.scope.window', { count: settings.windowMinutes })}
              </option>
              <option value="session">{t('sshAgent.panel.scope.session')}</option>
            </select>
          </label>

          <label className="setting-row">
            <div>
              <div className="setting-label">{t('sshAgent.panel.expiryLabel')}</div>
              {/* Two settings rather than one, because "how long" and "what
                  then" have different right answers: refusing outright is for
                  somebody who wants a key usable for one task and then inert
                  without having to remember to revoke it. */}
              <div className="setting-desc">{t('sshAgent.panel.expiryDesc')}</div>
            </div>
            <select
              value={settings.onExpiry}
              onChange={(e) => void apply({ onExpiry: e.target.value as 'ask-again' | 'refuse' })}
            >
              <option value="ask-again">{t('sshAgent.panel.expiry.askAgain')}</option>
              <option value="refuse">{t('sshAgent.panel.expiry.refuse')}</option>
            </select>
          </label>

          <label className="setting-row">
            <div>
              <div className="setting-label">{t('sshAgent.panel.requireOpenLabel')}</div>
              <div className="setting-desc">{t('sshAgent.panel.requireOpenDesc')}</div>
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
