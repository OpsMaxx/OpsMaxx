import { KeyRound, Lock, Globe, StickyNote, User, FileKey, Shield, Trash2 } from 'lucide-react'
import { useVault } from '../../store/vault'
import { clsx } from '../../lib/format'
import { useApp } from '../../store/app'
import { useT } from '../../lib/i18n'
import { vaultMatches, vaultEntriesFor, isSharedVaultEntry, type VaultKind } from '../../../../shared/vault'

const KIND_ICON: Record<VaultKind, React.ReactNode> = {
  login: <User size={13} className="faint" />,
  url: <Globe size={13} className="faint" />,
  key: <KeyRound size={13} className="faint" />,
  sshkey: <FileKey size={13} className="faint" />,
  note: <StickyNote size={13} className="faint" />,
  vpn: <Shield size={13} className="faint" />
}

export function VaultSidebar(): React.JSX.Element {
  const t = useT()
  const unlocked = useVault((s) => s.unlocked)
  const entries = useVault((s) => s.entries)
  const selectedId = useVault((s) => s.selectedId)
  const select = useVault((s) => s.select)
  const remove = useVault((s) => s.deleteEntry)
  const query = useVault((s) => s.query)
  const setQuery = useVault((s) => s.setQuery)
  const activeWorkspaceId = useApp((s) => s.activeWorkspaceId)

  if (!unlocked) {
    return (
      <div className="tree-section">
        <div className="faint" style={{ padding: '10px 12px', fontSize: 12, display: 'flex', gap: 6 }}>
          <Lock size={13} /> {t('vault.sidebar.locked')}
        </div>
      </div>
    )
  }

  // Entries belonging to this workspace, plus the shared ones. Hidden from
  // view, not cryptographically separated — the vault is still one encrypted
  // file under one master password, and SECURITY.md says so.
  const visible = vaultEntriesFor(entries, activeWorkspaceId)
  const shown = visible.filter((e) => vaultMatches(e, query))
  const hiddenCount = entries.length - visible.length

  return (
    <>
      <div className="sidebar-search">
        <input
          className="input"
          style={{ height: 30, width: '100%' }}
          placeholder={t('vault.sidebar.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="tree-section">
        <div className="tree-section-label">
          {t('vault.sidebar.entries')} <span className="count">{shown.length}</span>
        </div>
        {hiddenCount > 0 && (
          // Saying nothing here would recreate the original confusion in the
          // opposite direction: entries you saved would simply be missing.
          <div className="faint" style={{ padding: '2px 12px 6px', fontSize: 11 }}>
            {t('vault.sidebar.hiddenCount', { count: hiddenCount })}
          </div>
        )}
        {shown.map((e) => (
          <div
            key={e.id}
            className={clsx('tree-row', selectedId === e.id && 'active')}
            onClick={() => select(e.id)}
            title={e.url || e.username || e.name}
          >
            {KIND_ICON[e.kind]}
            {isSharedVaultEntry(e) && (
              <span className="faint" style={{ fontSize: 'var(--fs-xs)' }} title={t('vault.sidebar.sharedTitle')}>
                {t('vault.sidebar.shared')}
              </span>
            )}
            <span className="label">{e.name}</span>
            {/* Deleting was only reachable by selecting an entry and finding the
                bin in the editor, and it happened on the first click with no
                confirmation -- for a secret that cannot be recovered afterwards.
                The row's own control asks first, and names what it is about to
                destroy so the answer is to a question and not to a reflex. */}
            <button
              className="faint"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 4px',
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                color: 'inherit'
              }}
              title={t('vault.sidebar.deleteEntry', { name: e.name })}
              aria-label={t('vault.sidebar.deleteEntry', { name: e.name })}
              onClick={(ev) => {
                ev.stopPropagation()
                if (
                  !window.confirm(t('vault.entry.confirmDelete', { name: e.name }))
                ) {
                  return
                }
                void remove(e.id)
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="faint" style={{ padding: '8px 10px', fontSize: 12 }}>
            {entries.length ? t('vault.sidebar.noMatches') : t('vault.sidebar.noEntries')}
          </div>
        )}
      </div>
    </>
  )
}
