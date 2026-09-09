import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import type { NgrokSpec, NgrokTunnel, VpnProfile } from '../../types'

/**
 * Creating an ngrok profile.
 *
 * ngrok is configured here rather than imported. It does have a config file
 * format, but that is not the unit of exchange: what a user has is an account
 * and a port they want published, and both are chosen here. The file this app
 * writes is generated from these fields at start, and carries no secret.
 *
 * The authtoken comes from the vault rather than a text box, for the reason
 * every credential in this app does: one record, rotated in one place, and it
 * travels inside an encrypted backup where a value kept in the OS keychain
 * cannot.
 */

/** A blank tunnel. `acknowledgedExposure` starts FALSE, deliberately. */
function blankTunnel(n: number): NgrokTunnel {
  return {
    name: n === 0 ? 'web' : `endpoint-${n + 1}`,
    proto: 'http',
    localPort: 3000,
    acknowledgedExposure: false
  }
}

export function NgrokSetup({
  existing,
  onClose,
  onDone
}: {
  /**
   * The profile being edited, or absent when creating one.
   *
   * Editing goes through this form rather than the generic profile form,
   * because the generic one branches on kind and has no ngrok branch — so
   * without this an ngrok profile could be created and then never changed, and
   * rotating an authtoken would mean deleting the profile and building it
   * again.
   */
  existing?: VpnProfile & { spec: NgrokSpec }
  onClose: () => void
  onDone: (p: VpnProfile) => void
}): React.JSX.Element {
  const upsertVpnProfile = useApp((s) => s.upsertVpnProfile)
  const activeId = useApp((s) => s.activeId)
  const vaultUnlocked = useVault((s) => s.unlocked)
  const vaultEntries = useVault((s) => s.entries)

  const [name, setName] = useState(existing?.name ?? 'ngrok')
  // The stored ref, so an edit shows which credential is in use rather than
  // presenting an empty picker over a profile that already has one.
  const [entryId, setEntryId] = useState(existing?.spec.authtokenRef?.vaultEntryId ?? '')
  const [tunnels, setTunnels] = useState<NgrokTunnel[]>(
    existing?.spec.tunnels.length ? existing.spec.tunnels : [blankTunnel(0)]
  )

  /**
   * Entries that could hold an authtoken.
   *
   * An API-key entry is the natural home for one, and a login entry's password
   * slot works too — both end up in the same place. A key entry (`privateKey`)
   * is excluded: a private key is not an authtoken, and offering it would be
   * offering something that cannot work.
   */
  const usable = vaultEntries.filter((e) => !!e.password && !e.privateKey)

  const patch = (i: number, next: Partial<NgrokTunnel>): void =>
    setTunnels((ts) => ts.map((t, j) => (j === i ? { ...t, ...next } : t)))

  const ready =
    name.trim() !== '' &&
    entryId !== '' &&
    tunnels.length > 0 &&
    tunnels.every(
      (t) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(t.name) &&
        Number.isInteger(t.localPort) &&
        t.localPort > 0 &&
        t.localPort < 65536 &&
        t.acknowledgedExposure
    ) &&
    new Set(tunnels.map((t) => t.name)).size === tunnels.length

  const save = (): void => {
    if (!ready) return
    const spec: NgrokSpec = {
      kind: 'ngrok',
      authtokenRef: { vaultEntryId: entryId, field: 'token' },
      tunnels
    }
    const profile: VpnProfile = {
      id: existing?.id ?? `vpn-${crypto.randomUUID()}`,
      workspaceId: existing?.workspaceId ?? activeId(),
      name: name.trim(),
      // Never on by default for a NEW profile. Starting this publishes a port
      // to the internet, which is not a thing that should happen because the
      // app launched — but an existing profile keeps whatever the user chose.
      autoStart: existing?.autoStart ?? false,
      spec
    }
    upsertVpnProfile(profile)
    toast(`${profile.name} saved`, 'ok')
    onDone(profile)
  }

  return (
    <Modal
      title={existing ? 'Edit ngrok' : 'Add ngrok'}
      subtitle="Publish a port on this machine to a public URL"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label className="field-label">Authtoken</label>
        {vaultUnlocked && usable.length > 0 ? (
          <select className="input" value={entryId} onChange={(e) => setEntryId(e.target.value)}>
            <option value="">Choose a vault entry…</option>
            {usable.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.username ? ` — ${e.username}` : ''}
              </option>
            ))}
          </select>
        ) : (
          // No text box as a fallback. A token typed here would have to be
          // stored somewhere, and the only place it belongs is the vault — so
          // the honest answer is to send the user there rather than to accept
          // it and keep it somewhere worse.
          <span className="field-hint">
            {vaultUnlocked
              ? 'Add your ngrok authtoken to the vault first, then pick it here.'
              : 'Unlock the vault to choose the authtoken.'}
          </span>
        )}
        <span className="field-hint">
          Stored in the vault and handed to the agent through its environment — never written into a
          config file and never on a command line.
        </span>
      </div>

      <div className="field">
        <label className="field-label">Endpoints</label>
        <div className="col" style={{ gap: 10 }}>
          {tunnels.map((t, i) => (
            <div key={i} className="col" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="input"
                  style={{ maxWidth: 140 }}
                  placeholder="name"
                  value={t.name}
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                <select
                  className="input"
                  style={{ maxWidth: 90 }}
                  value={t.proto}
                  onChange={(e) => patch(i, { proto: e.target.value as NgrokTunnel['proto'] })}
                >
                  <option value="http">http</option>
                  <option value="tcp">tcp</option>
                  <option value="tls">tls</option>
                </select>
                <input
                  className="input"
                  style={{ maxWidth: 110 }}
                  placeholder="local port"
                  value={String(t.localPort)}
                  onChange={(e) => patch(i, { localPort: Number(e.target.value) || 0 })}
                />
                <input
                  className="input"
                  placeholder={t.proto === 'tcp' ? 'reserved address (optional)' : 'domain (optional)'}
                  value={t.domain ?? ''}
                  onChange={(e) => patch(i, { domain: e.target.value.trim() || undefined })}
                />
                {tunnels.length > 1 && (
                  <button
                    className="btn sm"
                    title="Remove"
                    onClick={() => setTunnels((ts) => ts.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              {/* The gate. Per endpoint, and unticked by default, because this
                  is the one control that decides whether a port on this machine
                  becomes reachable from the whole internet. The driver refuses
                  to start without it as well — this box is not the only thing
                  standing between a click and a public URL. */}
              <label className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={t.acknowledgedExposure}
                  onChange={(e) => patch(i, { acknowledgedExposure: e.target.checked })}
                />
                <span className="field-hint">
                  I understand this makes <b>localhost:{t.localPort || '?'}</b> reachable from the
                  public internet by anyone with the URL.
                  {!t.domain && ' The URL changes every time this starts.'}
                </span>
              </label>
            </div>
          ))}
          <button
            className="btn sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setTunnels((ts) => [...ts, blankTunnel(ts.length)])}
          >
            <Plus size={13} /> Add another endpoint
          </button>
          <span className="field-hint">
            Some ngrok plans allow only one endpoint per agent. If a second is refused, that is the
            account rather than this profile.
          </span>
        </div>
      </div>
    </Modal>
  )
}
