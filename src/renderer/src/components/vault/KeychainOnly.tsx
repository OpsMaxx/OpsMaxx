import { useEffect, useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'

/**
 * Connections whose credential is stored only on this computer.
 *
 * The keychain does not sync, so with Sync & devices these are servers and
 * databases every other device of the account can see and cannot log in to —
 * which reads as sync having failed, when it is the one thing sync deliberately
 * does not carry. Moving them makes each credential a vault entry; the record
 * then names that entry, and the other devices use it once a person there
 * confirms it. See main/services/credentialMove.ts and credentialLink.ts.
 *
 * HERE, NOT ON SYNC & DEVICES. That panel is kept out of the vault and the
 * keychain by tests/moduleBoundaries.test.ts, and this writes to both. It is
 * also where the result lands: a list of new entries.
 *
 * Rendered only inside the open vault, so there is no unlock to ask for.
 */
export function KeychainOnly(): React.JSX.Element | null {
  const servers = useApp((s) => s.servers)
  const databases = useApp((s) => s.databases)
  const linkVaultEntries = useApp((s) => s.linkVaultEntries)
  const [ids, setIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const key = [...servers, ...databases].map((r) => r.id).join(',')
  useEffect(() => {
    const all = [...servers, ...databases].map((r) => r.id)
    void window.opsmaxx?.secrets?.keychainOnly?.(all).then((r) => setIds(r ?? []))
    // Keyed on the ids, not the arrays: a status flip on any server would
    // otherwise ask main again on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (ids.length === 0) return null

  const move = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.opsmaxx?.secrets?.moveToVault?.(ids)
      if (!r) return
      if (!r.ok) {
        toast(r.error ?? 'The vault would not take them, so nothing was moved.', 'error')
        return
      }
      // The vault store holds its own copy of the entries while open and saves
      // the whole list back; reloading it is what keeps the next edit here
      // from erasing what main just added.
      await useVault.getState().refresh()
      linkVaultEntries(Object.fromEntries(r.moved.map((m) => [m.id, m.vaultEntryId])))
      const names = new Map([...servers, ...databases].map((x) => [x.id, x.name]))
      if (r.moved.length) {
        toast(
          `${r.moved.length} moved into the vault. Your other devices can use ${r.moved.length === 1 ? 'it' : 'them'} once you confirm there.`,
          'ok'
        )
      }
      for (const sk of r.skipped) toast(`${names.get(sk.id) ?? sk.id} was not moved: ${sk.reason}.`, 'error')
      setIds(r.skipped.map((sk) => sk.id))
    } finally {
      setBusy(false)
    }
  }

  const one = ids.length === 1
  return (
    <div className="vault-bio-offer" role="status">
      <KeyRound size={18} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div className="s-title">
          {one ? 'One connection logs' : `${ids.length} connections log`} in with a password or key kept only on this
          computer
        </div>
        <div className="s-desc">
          Moved into the vault, {one ? 'it travels' : 'they travel'} with your encrypted backups, and to your other
          devices if you use Sync &amp; devices, where each one is confirmed before it is used. Key files stay where
          they are.
        </div>
      </div>
      <button className="btn sm primary" disabled={busy} onClick={() => void move()}>
        {busy ? <Loader2 size={13} className="spin" /> : null} Move into the vault
      </button>
    </div>
  )
}
