import { useState } from 'react'
import { useVault } from '../../../store/vault'
import { useApp } from '../../../store/app'
import { vaultReference } from '../../../../../shared/apiSecrets'
import { VAULT_MIN_PASSWORD } from '../../../../../shared/vault'
import { Field, Modal } from '../../common/Modal'
import { useT } from '../../../lib/i18n'
import '../nav.css'

/**
 * Move a typed credential into the vault in one step (UX-M14): the same
 * dialog creates the vault when there is none, unlocks it when it is locked,
 * then stores the value and hands back a `vault:<id>#password` reference.
 */
export function MoveToVaultDialog({
  defaultName,
  value,
  onMoved,
  onClose
}: {
  /** Pre-filled entry name, e.g. "<collection> · <field>". */
  defaultName: string
  value: string
  onMoved: (reference: string) => void
  onClose: () => void
}): React.JSX.Element {
  const exists = useVault((s) => s.exists)
  const unlocked = useVault((s) => s.unlocked)
  const busy = useVault((s) => s.busy)
  const vaultError = useVault((s) => s.error)
  const [name, setName] = useState(defaultName)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  const creating = exists === false
  const locked = !creating && !unlocked
  const pwError =
    creating && password && password.length < VAULT_MIN_PASSWORD
      ? t('http.moveToVault.minLength', { min: VAULT_MIN_PASSWORD })
      : creating && again && again !== password
        ? t('http.moveToVault.mismatch')
        : null
  const ready =
    !!name.trim() &&
    !busy &&
    (creating ? password.length >= VAULT_MIN_PASSWORD && again === password : locked ? !!password : true)

  const move = async (): Promise<void> => {
    setError(null)
    const vault = useVault.getState()
    if (creating && !(await vault.create(password))) return
    if (locked && !(await vault.unlock(password))) return
    const id = await useVault.getState().createEntry('login', {
      name: name.trim(),
      password: value,
      workspaceId: useApp.getState().activeWorkspaceId
    })
    if (!id) {
      setError(t('http.moveToVault.storeFailed'))
      return
    }
    onMoved(vaultReference(id, 'password'))
    onClose()
  }

  return (
    <Modal
      title={t('http.moveToVault.title')}
      subtitle={t('http.moveToVault.subtitle')}
      onClose={onClose}
      confirm={{
        label: creating
          ? t('http.moveToVault.createAndMove')
          : locked
            ? t('http.moveToVault.unlockAndMove')
            : t('http.moveToVault.move'),
        onClick: () => void move(),
        disabled: !ready
      }}
      footerNote={error ?? vaultError ?? undefined}
    >
      <Field label={t('http.moveToVault.entryName')} error={name.trim() ? null : t('http.moveToVault.nameRequired')}>
        <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      {creating && (
        <>
          <p>{t('http.moveToVault.noVault')}</p>
          <Field label={t('http.moveToVault.masterPassword')} error={pwError}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label={t('http.moveToVault.masterPasswordAgain')}>
            <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
        </>
      )}
      {locked && (
        <Field label={t('http.moveToVault.vaultPassword')} hint={t('http.moveToVault.vaultPasswordHint')}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}
    </Modal>
  )
}
