import { useState } from 'react'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import type { VaultEntry } from '../../../../shared/vault'

/**
 * Importing a Bitwarden or Vaultwarden vault.
 *
 * TWO STEPS, ALWAYS. Fetch and decrypt, show what would land, and only then
 * write. An import that had already happened by the time it was described is
 * not one anybody can decline -- and merging somebody else's data model into a
 * vault is exactly the operation where seeing it first matters.
 *
 * The master password is typed here and goes to main, which derives the keys
 * and talks to the server. It is never stored and never reaches a relay: this
 * is a direct HTTPS conversation between this machine and the server the user
 * named.
 */
export function BitwardenImport(): React.JSX.Element {
  const entries = useVault((s) => s.entries)
  const [serverURL, setServerURL] = useState('https://vault.bitwarden.com')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{
    entries: VaultEntry[]
    skipped: { name: string; reason: string }[]
  } | null>(null)

  const fetchPreview = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const result = await window.opsmaxx?.importVault.bitwardenPreview({
        serverURL,
        email,
        password,
        twoFactorCode: twoFactorCode || undefined
      })
      if (!result) return
      if (result.error) {
        setError(result.error)
        return
      }
      setPreview({ entries: result.entries ?? [], skipped: result.skipped ?? [] })
    } finally {
      setBusy(false)
    }
  }

  const apply = (): void => {
    if (!preview) return
    // Appended, never merged over. Two entries with the same name from two
    // password managers are two entries, and deciding they are one is a
    // judgement this cannot make for somebody -- deleting the duplicate is
    // reversible, and silently overwriting a password is not.
    void window.opsmaxx?.vault.save([...entries, ...preview.entries]).then(() => {
      toast(`Imported ${preview.entries.length} entries`)
      setPreview(null)
      setPassword('')
    })
  }

  return (
    <div className="bw-import">
      <div className="setting-desc">
        Reads a Bitwarden or Vaultwarden vault into this one, once. It does not keep the two in
        step afterwards, and nothing is sent anywhere else: this machine talks to that server
        directly.
      </div>

      <label className="bw-field">
        <span>Server</span>
        <input value={serverURL} onChange={(e) => setServerURL(e.target.value)} spellCheck={false} />
      </label>
      <label className="bw-field">
        <span>Email</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} />
      </label>
      <label className="bw-field">
        <span>Master password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="bw-field">
        <span>Two-factor code</span>
        <input
          value={twoFactorCode}
          onChange={(e) => setTwoFactorCode(e.target.value)}
          placeholder="only if the account has it"
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <button className="btn" disabled={busy || !email || !password} onClick={() => void fetchPreview()}>
        {busy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
        {busy ? ' Reading…' : ' Show me what would be imported'}
      </button>

      {error && (
        <div className="bw-problem" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>{error}</span>
        </div>
      )}

      {preview && (
        <div className="bw-preview">
          <div className="setting-label">
            {preview.entries.length} {preview.entries.length === 1 ? 'entry' : 'entries'} would be
            added
          </div>
          <ul>
            {preview.entries.slice(0, 50).map((e) => (
              <li key={e.id}>
                {e.name} <span className="bw-kind">{e.kind}</span>
              </li>
            ))}
            {preview.entries.length > 50 && <li>… and {preview.entries.length - 50} more</li>}
          </ul>

          {preview.skipped.length > 0 && (
            <>
              {/* Listed, never dropped. An import that quietly left half a
                  vault behind is one somebody discovers when they need one of
                  the missing passwords. */}
              <div className="setting-label">{preview.skipped.length} could not be imported</div>
              <ul className="bw-skipped">
                {preview.skipped.map((s, i) => (
                  <li key={i}>
                    {s.name} — {s.reason}
                  </li>
                ))}
              </ul>
            </>
          )}

          <button className="btn" onClick={apply} disabled={preview.entries.length === 0}>
            Add these to my vault
          </button>
          <div className="setting-desc">
            Existing entries are left alone. Anything with the same name arrives as a second entry
            rather than replacing yours.
          </div>
        </div>
      )}
    </div>
  )
}
