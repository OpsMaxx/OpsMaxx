import { useEffect, useState } from 'react'
import { Eye, EyeOff, Fingerprint, Lock, ShieldCheck } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useVault } from '../../store/vault'
import { useVaultPrompt } from '../../store/vaultPrompt'
import { VAULT_MIN_PASSWORD } from '../../../../shared/vault'

const BIO_LABEL: Record<string, string> = {
  'touch-id': 'Touch ID',
  'windows-hello': 'Windows Hello'
}

// Mounted once at the app root. Something needed a vault credential and the
// vault was locked — so ask, here, and let the caller carry on, instead of
// failing with instructions the user has to go and follow somewhere else
// before starting over.
//
// ---------------------------------------------------------------------------
// TWO DIFFERENT DIALOGS, AND THEY MUST NOT BE THE SAME ONE
// ---------------------------------------------------------------------------
//
// This used to render one dialog for both cases. When no vault existed it said:
//
//     title   Vault locked
//     body    There is no vault on this machine yet, so this credential
//             cannot be read.
//     button  Unlock and continue
//
// with a single password field. Three contradictions in one dialog — a vault
// that does not exist cannot be locked, you cannot unlock something that must
// first be created, and the user is WRITING a secret into the vault rather than
// reading one out of it.
//
// The damage was not the wording. `unlock()` on a machine with no vault creates
// one, so the user typed one unverified string, once, and it silently became
// the unrecoverable key to their whole estate. The proper create-vault screen
// in VaultView has everything this lacked: a confirm field, a minimum length,
// and the sentence that says losing it is final. None of that reached the
// person who arrived here instead.
//
// So when there is no vault this is not a gate at all — it is the create
// screen, wearing the caller's context as its subtitle.
export function VaultUnlockModal(): React.JSX.Element | null {
  const open = useVaultPrompt((s) => s.open)
  const reason = useVaultPrompt((s) => s.reason)
  const finish = useVaultPrompt((s) => s.finish)

  const unlock = useVault((s) => s.unlock)
  const createVault = useVault((s) => s.create)
  const busy = useVault((s) => s.busy)
  const error = useVault((s) => s.error)
  const clearError = useVault((s) => s.clearError)
  const exists = useVault((s) => s.exists)
  const bioAvailable = useVault((s) => s.bioAvailable)
  const bioEnabled = useVault((s) => s.bioEnabled)
  const bioKind = useVault((s) => s.bioKind)
  const refreshBiometrics = useVault((s) => s.refreshBiometrics)
  const unlockWithBiometrics = useVault((s) => s.unlockWithBiometrics)

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)

  // THREE states, not two. `exists` is `boolean | null` and the null means the
  // probe has not answered yet — so `!exists` would read "still checking" as
  // "there is no vault" and put the user in front of a create-vault form, with
  // a master-password field, for a vault that may well already exist. Writing
  // it as `exists === false` keeps the unknown its own case, which is the same
  // rule the fleet reads follow: a value nobody has measured is not a zero.
  const checking = exists === null
  const creating = exists === false
  const canUseBio = bioAvailable && bioEnabled && !creating && !checking

  // Only meaningful while creating, and only once the user has typed something
  // into the second field — showing "does not match" against an empty box is a
  // complaint about work not yet done.
  const mismatch = creating && confirm.length > 0 && password !== confirm
  // Nothing is submittable while the probe is outstanding: `submit` branches on
  // `creating` to choose between create() and unlock(), and choosing either one
  // on a guess is how a vault gets created over one that already exists.
  const ready =
    !busy &&
    !checking &&
    (creating ? password.length >= VAULT_MIN_PASSWORD && confirm === password : password.length > 0)

  useEffect(() => {
    if (open) void refreshBiometrics()
  }, [open, refreshBiometrics])

  // Same as the main gate: the prompt is not fired automatically. See the note
  // there — an unbidden biometric prompt teaches the reflex that makes prompts
  // phishable, and this one is a gate rather than a cryptographic step.

  if (!open) return null

  const close = (ok: boolean): void => {
    setPassword('')
    setConfirm('')
    finish(ok)
  }

  const submit = async (): Promise<void> => {
    if (!ready) return
    const done = creating ? await createVault(password) : await unlock(password)
    if (done) close(true)
  }

  return (
    <Modal
      title={checking ? 'Vault' : creating ? 'Create your vault' : 'Vault locked'}
      subtitle={reason}
      onClose={() => close(false)}
    >
      <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 12 }}>
        {creating ? (
          <ShieldCheck size={18} style={{ color: 'var(--accent-ink)', marginTop: 2 }} />
        ) : (
          <Lock size={18} style={{ color: 'var(--accent-ink)', marginTop: 2 }} />
        )}
        <div className="s-desc">
          {checking
            ? 'Checking this machine for a vault…'
            : creating
              ? `There is no vault on this machine yet, so there is nowhere to keep this secret. The vault keeps passwords, SSH keys and other secrets encrypted here, so OpsMaxx can use them without you retyping them. Pick a master password to protect it — it is never stored anywhere, so if you lose it the contents cannot be recovered.`
              : 'This credential is stored in your vault. Unlock it to continue — it stays unlocked for the rest of this session.'}
        </div>
      </div>

      {canUseBio && (
        <button
          className="btn primary"
          style={{ width: '100%', marginBottom: 10 }}
          disabled={busy}
          onClick={() => void unlockWithBiometrics().then((ok) => ok && close(true))}
        >
          <Fingerprint size={15} /> Unlock with {BIO_LABEL[bioKind] ?? 'biometrics'}
        </button>
      )}

      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          type={show ? 'text' : 'password'}
          autoFocus
          placeholder={
            creating ? `Master password (min ${VAULT_MIN_PASSWORD} characters)` : 'Master password'
          }
          value={password}
          onChange={(e) => {
            clearError()
            setPassword(e.target.value)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <button className="icon-btn" title={show ? 'Hide' : 'Show'} onClick={() => setShow((v) => !v)}>
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>

      {/* The field that was missing. Without it a typo becomes the key to
          everything and is discovered on the next unlock, by which time the
          contents are gone. */}
      {creating && (
        <input
          className="input"
          style={{ marginTop: 6, width: '100%' }}
          type={show ? 'text' : 'password'}
          placeholder="Confirm master password"
          value={confirm}
          onChange={(e) => {
            clearError()
            setConfirm(e.target.value)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      )}

      {mismatch && (
        <div className="vault-error" style={{ marginTop: 8 }}>
          The two passwords do not match.
        </div>
      )}
      {error && (
        <div className="vault-error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      {/* Says what happens to the work the user is in the middle of. Without
          it, a cautious person cancelling a mid-flow gate has no idea whether
          the config they just pasted survives — so they guess, and half of them
          guess wrong. */}
      <div className="s-desc" style={{ marginTop: 10 }}>
        Cancelling leaves what you were doing as it is; nothing you have entered is discarded.
        {creating && ' You can turn on biometric unlock in the Vault once this is set up.'}
      </div>

      {/* Cancel first, primary last — the order every other dialog in the app
          uses. This one had them the other way round, so on the single dialog
          that creates an unrecoverable secret the muscle-memory click position
          was the confirm. */}
      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button className="btn sm" onClick={() => close(false)}>
          Cancel
        </button>
        <button className="btn sm primary" disabled={!ready} onClick={() => void submit()}>
          {checking ? 'Checking…' : creating ? 'Create vault and continue' : 'Unlock and continue'}
        </button>
      </div>
    </Modal>
  )
}
