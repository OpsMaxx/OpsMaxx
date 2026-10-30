import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import { useT } from '../../lib/i18n'

// Its own module, not part of VaultView, because VaultUnlockModal is mounted
// at the app root and VaultView is lazy() behind App.tsx:52 -- importing this
// from there pulled the whole vault view into the root bundle and the 33 kB
// chunk stopped being a chunk. Shared from here so the copy for an
// irreversible action still cannot drift between the two screens.
//
// The only way out of a vault whose master password is gone. `vaultDestroy` has
// been plumbed through main, preload and the store since the vault shipped, and
// nothing ever called it -- so the honest answer to "I lost my password" was
// Settings -> Delete all data, which also takes the servers, the keychain
// secrets and the known hosts with it.
//
// Shared by both unlock screens from here rather than written twice, so the
// copy for an irreversible action cannot drift between them.
export function VaultReset({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const t = useT()
  const destroy = useVault((s) => s.destroy)
  const busy = useVault((s) => s.busy)
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')

  // Collapsed by default. Someone who simply mistyped their password should not
  // have to read past a demolition notice to try again.
  if (!open) {
    return (
      <button
        className="btn sm"
        style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
        onClick={() => setOpen(true)}
      >
        {t('vault.reset.lostPassword')}
      </button>
    )
  }

  return (
    <div className="vault-error" style={{ marginTop: 10, textAlign: 'left' }}>
      <div className="s-title">{t('vault.reset.title')}</div>
      <div className="s-desc" style={{ marginTop: 4 }}>
        {t('vault.reset.body')}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="DELETE"
          value={typed}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
        />
        <button
          className="btn sm"
          onClick={() => {
            setOpen(false)
            setTyped('')
          }}
        >
          {t('vault.reset.keep')}
        </button>
        <button
          className="btn sm danger fill"
          disabled={typed !== 'DELETE' || busy}
          onClick={() =>
            void destroy().then((ok) => {
              if (!ok) return
              setOpen(false)
              setTyped('')
              onDone?.()
              toast(t('vault.reset.deleted'), 'ok')
            })
          }
        >
          <Trash2 size={15} /> {t('vault.reset.delete')}
        </button>
      </div>
    </div>
  )
}
