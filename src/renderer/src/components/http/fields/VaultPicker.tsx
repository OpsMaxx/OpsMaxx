import { useState } from 'react'
import { Lock } from 'lucide-react'
import { useVault } from '../../../store/vault'
import { vaultReference, type VaultField } from '../../../../../shared/apiSecrets'
import { UnlockVaultButton } from '../../common/UnlockVaultButton'

/**
 * A list of vault entries to read a value from. It never shows a value: an
 * entry is named, and the choice is a `vault:<id>#field` reference.
 */
export function VaultPicker({ onPick }: { onPick: (reference: string) => void }): React.JSX.Element {
  const unlocked = useVault((s) => s.unlocked)
  const exists = useVault((s) => s.exists)
  const entries = useVault((s) => s.entries)
  const [query, setQuery] = useState('')
  const [field, setField] = useState<VaultField>('password')

  if (exists === false) {
    return <p className="hc-vault-note">There is no vault yet. Create one from Vault in the sidebar.</p>
  }
  if (!unlocked) {
    return (
      <div className="hc-vault-note">
        <p>The vault is locked.</p>
        <UnlockVaultButton reason="Choose a vault entry to read this value from." />
      </div>
    )
  }
  const q = query.trim().toLowerCase()
  const shown = entries.filter((e) => !q || e.name.toLowerCase().includes(q))
  return (
    <div className="hc-vault-picker">
      <input
        className="hc-input"
        aria-label="Filter vault entries"
        placeholder="Filter entries"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div role="radiogroup" aria-label="Field to read" className="hc-vault-field">
        {(['password', 'username'] as const).map((f) => (
          <label key={f}>
            <input type="radio" name="hc-vault-field" checked={field === f} onChange={() => setField(f)} />{' '}
            {f === 'password' ? 'Password' : 'Username'}
          </label>
        ))}
      </div>
      <ul className="hc-vault-list" aria-label="Vault entries">
        {shown.map((e) => (
          <li key={e.id}>
            <button type="button" className="hc-vault-entry" onClick={() => onPick(vaultReference(e.id, field))}>
              <Lock size={12} aria-hidden="true" />
              <span>{e.name}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="hc-vault-note">No entries match.</li>}
      </ul>
    </div>
  )
}
