import { useState } from 'react'
import { KeyRound, Lock, X } from 'lucide-react'
import { useVault } from '../../../store/vault'
import { parseVaultReference } from '../../../../../shared/apiSecrets'
import { Popover } from '../../common/Popover'
import { VaultPicker } from './VaultPicker'
import { UnlockVaultButton } from '../../common/UnlockVaultButton'
import { t as tr, useT } from '../../../lib/i18n'
import '../../common/primitives.css'

export interface VaultValueFieldProps {
  /** A literal, or `vault:<entryId>#password|username`. */
  value: string
  onChange: (value: string) => void
  allowLiteral: boolean
  ariaLabel: string
}

/** How a reference is named on screen: the entry's name, never its value. */
export function vaultLabel(value: string): { name: string; missing: boolean } | null {
  const ref = parseVaultReference(value)
  if (!ref) return null
  const { entries, unlocked } = useVault.getState()
  const entry = entries.find((e) => e.id === ref.entryId)
  const username = ref.field === 'username'
  if (entry)
    return { name: username ? tr('http.vaultField.withUsername', { name: entry.name }) : entry.name, missing: false }
  return unlocked
    ? { name: tr('http.vaultField.gone'), missing: true }
    : { name: username ? tr('http.vaultField.lockedUsername') : tr('http.vaultField.locked'), missing: false }
}

/**
 * A value that is either typed (a literal) or read from the vault when the
 * request is sent. A vault reference shows the entry's name and a lock.
 */
export function VaultValueField({ value, onChange, allowLiteral, ariaLabel }: VaultValueFieldProps): React.JSX.Element {
  // Re-render when the vault opens or its entries change, so a name appears.
  useVault((s) => s.entries)
  const unlocked = useVault((s) => s.unlocked)
  const [picker, setPicker] = useState<DOMRect | null>(null)
  const t = useT()
  const label = vaultLabel(value)
  const pick = (
    <Popover anchor={picker} open={picker !== null} onClose={() => setPicker(null)} ariaLabel={t('http.vaultField.choose')}>
      <VaultPicker
        onPick={(ref) => {
          setPicker(null)
          onChange(ref)
        }}
      />
    </Popover>
  )
  const openPicker = (e: React.MouseEvent<HTMLElement>): void => setPicker(e.currentTarget.getBoundingClientRect())

  if (label) {
    return (
      <div className="hc-vault-value" role="group" aria-label={ariaLabel}>
        <Lock size={12} aria-hidden="true" />
        <span className={label.missing ? 'hc-vault-name is-missing' : 'hc-vault-name'} title={t('http.vaultField.readOnSend')}>
          {label.name}
        </span>
        {unlocked ? (
          <button type="button" className="btn ghost sm" onClick={openPicker}>
            {t('http.vaultField.change')}
          </button>
        ) : (
          <UnlockVaultButton
            reason={t('http.vaultField.unlockReason')}
            label={t('http.vaultField.unlock')}
            className="btn ghost sm"
          />
        )}
        {allowLiteral && (
          <button
            type="button"
            className="btn ghost sm"
            aria-label={t('http.vaultField.stopReading')}
            title={t('http.vaultField.stopReading')}
            onClick={() => onChange('')}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
        {pick}
      </div>
    )
  }
  return (
    <div className="hc-vault-value">
      {allowLiteral ? (
        <input className="hc-input hc-mono" aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <span className="hc-vault-name is-empty">{t('http.vaultField.noEntry')}</span>
      )}
      <button
        type="button"
        className="btn ghost sm"
        aria-label={t('http.vaultField.readFromVault')}
        title={t('http.vaultField.readFromVault')}
        onClick={openPicker}
      >
        <KeyRound size={12} aria-hidden="true" />
        {!allowLiteral && <span>{t('http.vaultField.chooseShort')}</span>}
      </button>
      {pick}
    </div>
  )
}
