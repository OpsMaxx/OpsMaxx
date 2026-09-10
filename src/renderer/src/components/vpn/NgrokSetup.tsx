import { useState } from 'react'
import { ExternalLink, Plus, Trash2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { toast } from '../../store/toast'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
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

/** Where an ngrok authtoken is minted. */
const NGROK_TOKEN_URL = 'https://dashboard.ngrok.com/get-started/your-authtoken'

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
  const createEntry = useVault((s) => s.createEntry)

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

  // The inline add. Kept in this dialog rather than routed through the vault
  // screen so the profile being built is still on screen when it finishes.
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('ngrok')
  const [newToken, setNewToken] = useState('')
  const [saving, setSaving] = useState(false)

  const addToken = async (): Promise<void> => {
    setSaving(true)
    try {
      // A login entry, whose password slot is where the picker above already
      // looks — so the thing just written is immediately selectable rather
      // than a shape this form would filter out.
      const id = await createEntry('login', {
        name: newName.trim(),
        password: newToken.trim(),
        notes: 'ngrok authtoken'
      })
      if (!id) {
        // createEntry returns null when the write failed; the vault store
        // surfaces the reason. Saying nothing and selecting nothing would
        // leave a Save button that stays disabled for no visible cause.
        toast('The vault would not take that token.', 'error')
        return
      }
      setEntryId(id)
      setAdding(false)
      setNewToken('')
    } finally {
      setSaving(false)
    }
  }

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
      // `confirm` and the modal's own Cancel, rather than a hand-rolled pair
      // inside `footer` — which is for EXTRA controls and sits beside the
      // Cancel the modal already draws. This dialog shipped with two of them.
      confirm={{ label: 'Save', onClick: save, disabled: !ready }}
    >
      <div className="field">
        <label className="field-label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label className="field-label">Authtoken</label>
        {!vaultUnlocked ? (
          /* The vault is where the token belongs, so unlocking is the step —
             offered here rather than described, the same as everywhere else
             this app needs it. */
          <UnlockVaultButton
            className="btn sm"
            reason="An ngrok authtoken is kept in the vault, so it has to be open to choose or add one."
          />
        ) : (
          <>
            {usable.length > 0 && (
              <select
                className="input"
                value={entryId}
                onChange={(e) => setEntryId(e.target.value)}
              >
                <option value="">Choose a vault entry…</option>
                {usable.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.username ? ` — ${e.username}` : ''}
                  </option>
                ))}
              </select>
            )}

            {/**
             * Adding one HERE, rather than being told to go and do it.
             *
             * The old copy said "add your ngrok authtoken to the vault first,
             * then pick it here" beside a picker that was not rendered at all
             * when the vault held nothing — a sentence naming a task, no
             * control to do it with, and a Save button that could never
             * enable. The user had to leave, find the vault, work out which
             * entry shape a token wants, come back and reopen this.
             *
             * Still the vault and still not a text box on the profile: a token
             * typed into a profile would have to live somewhere, and the only
             * place it belongs is the vault. What changes is that this writes
             * it there instead of describing the trip.
             */}
            {adding ? (
              <div className="col" style={{ gap: 6 }}>
                <input
                  className="input"
                  placeholder="Name it — e.g. ngrok (personal)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <input
                  className="input mono"
                  type="password"
                  placeholder="Paste the authtoken"
                  value={newToken}
                  onChange={(e) => setNewToken(e.target.value)}
                />
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="btn primary sm"
                    disabled={newName.trim() === '' || newToken.trim() === '' || saving}
                    onClick={() => void addToken()}
                  >
                    {saving ? 'Saving…' : 'Save to vault'}
                  </button>
                  <button className="btn sm" onClick={() => setAdding(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => setAdding(true)}>
                  <Plus size={13} /> Add an authtoken
                </button>
                {/* Where the token comes from. A dialog that asks for a
                    credential and does not say where it is minted leaves the
                    reader to go and find out. */}
                <button
                  className="btn ghost sm"
                  onClick={() =>
                    window.open(NGROK_TOKEN_URL, '_blank', 'noopener,noreferrer')
                  }
                >
                  <ExternalLink size={13} /> Get one from ngrok
                </button>
              </div>
            )}
          </>
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
