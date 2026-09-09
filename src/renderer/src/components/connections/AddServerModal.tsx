import { useState, useEffect } from 'react'
import { KeyRound, Lock, UserCheck, FileBadge, FolderOpen, ChevronRight } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { rdpSecretId } from '../../../../shared/rdp'
import { RouteHops } from './RouteHops'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { useVault } from '../../store/vault'
import { VpnTransportSelect } from '../vpn/VpnTransportSelect'
import { adviseOnError } from '../../lib/connectionError'
import type { AuthMethod, Hop, UUID } from '../../types'

// `unavailable` says why rather than hiding the option.
//
// Certificate was offered as an equal fourth choice and revealed no fields at
// all when picked — no certificate file, no signed key, no CA hint. That was
// the visible half. The real defect is in the transport: `asAuth` in
// lib/transport.ts maps every value that is not password or agent to 'key', so
// choosing Certificate did not merely do nothing, it silently connected as
// PRIVATE KEY authentication using whatever key path happened to be set. A
// profile saved that way cannot work and does not say why, and the user's
// choice was reinterpreted without telling them.
//
// Disabled with a reason rather than deleted: the concept exists, OpsMaxx
// reads certificate state elsewhere (shared/access.ts), and an option that
// vanishes teaches a user the product cannot do something when the truth is
// that this build cannot.
const AUTH: {
  id: AuthMethod
  label: string
  icon: React.ReactNode
  unavailable?: string
}[] = [
  { id: 'password', label: 'Password', icon: <Lock size={16} /> },
  { id: 'key', label: 'Private Key', icon: <KeyRound size={16} /> },
  { id: 'agent', label: 'SSH Agent', icon: <UserCheck size={16} /> },
  {
    id: 'certificate',
    label: 'Certificate',
    icon: <FileBadge size={16} />,
    unavailable:
      'Certificate authentication is not implemented in this build. It is disabled rather than hidden because a connection saved with it would silently fall back to private-key authentication.'
  }
]

/**
 * What is still missing before this profile could connect.
 *
 * Returns a field id and a sentence, or null when the form is complete. The
 * button used to be gated on `name && host` alone, so a profile could be saved
 * with an auth method it had no credential for — and the user met that as the
 * undifferentiated "Connection failed" much later, on a different screen.
 *
 * Only ever reports the FIRST thing missing: a form that lights up six errors
 * at once is a form nobody reads.
 */
function missingField(f: {
  name: string
  host: string
  auth: AuthMethod
  keyPath: string
  password: string
  usingVault: boolean
  editing: boolean
  /** RDP only: there is no SSH credential to demand. */
  rdpOnly: boolean
}): { field: string; why: string } | null {
  if (!f.name.trim()) return { field: 'name', why: 'Give this connection a name.' }
  if (!f.host.trim()) return { field: 'host', why: 'Enter the server address.' }
  /**
   * An RDP-only machine has no SSH credential, so none is required.
   *
   * The desktop signs in with the username and the password stored against
   * the record, and the SSH authentication method below describes a
   * connection this server does not accept. Demanding a private key for a
   * Windows box was the concrete shape of "RDP is not mutually exclusive of
   * SSH, even though both are fully separate connections".
   */
  if (f.rdpOnly) return null
  if (f.auth === 'certificate') {
    return { field: 'auth', why: 'Pick an authentication method this build supports.' }
  }
  // The vault entry supplies the credential, so the field below is empty on
  // purpose and must not be reported as missing.
  if (f.usingVault) return null
  // Editing keeps whatever was stored: a blank box means "unchanged", not
  // "cleared", which is what its own placeholder says.
  if (f.editing) return null
  if (f.auth === 'key' && !f.keyPath.trim()) {
    return { field: 'keyPath', why: 'Choose the private key to authenticate with.' }
  }
  if (f.auth === 'password' && !f.password) {
    return { field: 'password', why: 'Enter the password, or switch to a key or the agent.' }
  }
  return null
}

export function AddServerModal(): React.JSX.Element {
  const setModal = useApp((s) => s.setModal)
  const setActivity = useApp((s) => s.setActivity)
  const addServer = useApp((s) => s.addServer)
  const updateServer = useApp((s) => s.updateServer)
  const openServer = useApp((s) => s.openServer)
  // Set when the modal was opened to edit an existing server.
  const editId = useApp((s) => s.editServerId)
  const existing = useApp((s) => s.servers.find((sv) => sv.id === s.editServerId))

  const [name, setName] = useState(existing?.name ?? '')
  const [host, setHost] = useState(existing?.host ?? '')
  const [port, setPort] = useState(String(existing?.port ?? 22))
  const [username, setUsername] = useState(existing?.username ?? 'root')
  const [auth, setAuth] = useState<AuthMethod>(existing?.auth ?? 'key')
  const [keyPath, setKeyPath] = useState('')
  // Blank means "leave whatever is stored", the same contract the key path box
  // has when editing — see the placeholder.
  const [agentSocket, setAgentSocket] = useState('')
  // '' means "enter a new one"; anything else is a vault entry id.
  const [vaultEntryId, setVaultEntryId] = useState('')
  const [saveToVault, setSaveToVault] = useState(true)
  const [foundKeys, setFoundKeys] = useState<
    { path: string; fileName: string; algorithm: string | null; encrypted: boolean }[]
  >([])
  const [hops, setHops] = useState<Hop[]>(existing?.route ?? [])
  const [vpnProfileId, setVpnProfileId] = useState<UUID | null>(existing?.vpnProfileId ?? null)
  const [sftpOnly, setSftpOnly] = useState(existing?.sftpOnly === true)
  /**
   * Which protocols this record describes, derived from what was saved.
   *
   * One control rather than two booleans, because two booleans could not say
   * "RDP only" — and that was the gap: SSH was assumed by the dialog itself.
   */
  const [speaks, setSpeaks] = useState<'ssh' | 'ssh+rdp' | 'rdp'>(
    existing?.rdpOnly === true ? 'rdp' : existing?.rdp ? 'ssh+rdp' : 'ssh'
  )
  const [rdpUsername, setRdpUsername] = useState(existing?.rdp?.username ?? '')
  const [rdpPassword, setRdpPassword] = useState('')
  const [rdpPort, setRdpPort] = useState(String(existing?.rdp?.port ?? 3389))
  const [rdpDomain, setRdpDomain] = useState(existing?.rdp?.domain ?? '')
  // Defaults on, like RdpSettings.nla: every supported Windows Server requires
  // it by policy, and connecting without it against one of those fails in a way
  // that reads as a wrong password.
  const [rdpNla, setRdpNla] = useState(existing?.rdp?.nla !== false)
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [keepAlive, setKeepAlive] = useState(true)
  const [compression, setCompression] = useState(false)
  const [hostKeyCheck, setHostKeyCheck] = useState(true)
  const [timeout, setTimeoutV] = useState('15')
  const [env, setEnv] = useState('')

  const vaultUnlocked = useVault((s) => s.unlocked)
  const vaultEntries = useVault((s) => s.entries)
  const createVaultEntry = useVault((s) => s.createEntry)

  // A credential is only offered for the method it can actually satisfy: a
  // password entry cannot authenticate a key connection, and vice versa.
  const usableEntries = vaultEntries.filter((e) =>
    auth === 'key' ? !!e.privateKey : auth === 'password' ? !!e.password && !e.privateKey : false
  )
  const usingVault = vaultUnlocked && vaultEntryId !== ''

  const missing = missingField({
    name,
    host,
    auth,
    keyPath,
    password,
    usingVault,
    editing: !!editId,
    rdpOnly: speaks === 'rdp'
  })
  const valid = missing === null

  const pickKey = async (): Promise<void> => {
    const p = await window.opsmaxx?.dialog.openKey()
    if (p) setKeyPath(p)
  }

  // ~/.ssh is hidden and OpenSSH keys have no extension, so the file picker is
  // a bad first experience. Offer what is already there; nothing is selected
  // until the user clicks it.
  useEffect(() => {
    if (auth !== 'key' || foundKeys.length > 0) return
    void window.opsmaxx?.ssh.defaultKeys().then((k) => setFoundKeys(k ?? []))
  }, [auth, foundKeys.length])

  // Retryable on purpose: an OS keychain that refuses a write is usually a
  // login keyring nobody has unlocked yet, which is fixed outside this app and
  // then works. Without the button the credential is simply lost.
  const storeSecret = async (id: string, secret: Record<string, string | undefined>, label: string): Promise<void> => {
    const ok = await window.opsmaxx?.secrets.set(id, JSON.stringify(secret))
    if (ok !== false) return
    toast(`${label} was saved, but this device would not store its credential.`, 'error', {
      label: 'Try again',
      run: () => void storeSecret(id, secret, label)
    })
  }

  // Dial, then hang up. Nothing is saved and nothing is pooled — see sshTest.
  //
  // The form had no feedback loop at all: it has four to six chances to be
  // wrong, and the only way to find out was to save it, open a session, and
  // read a failure on a different screen. Saving PERSISTS the profile before it
  // is known to work, so a first run ends with a connection list holding
  // entries that have never connected.
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const testConnection = async (): Promise<void> => {
    if (!valid || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const fn = window.opsmaxx?.ssh?.test
      if (!fn) {
        // Said, rather than a button that quietly does nothing. The same rule
        // the rest of the app applies to an unwired bridge.
        setTestResult({ ok: false, text: 'This build cannot test a connection. Restart the app to rebuild it.' })
        return
      }
      const r = await fn({
        sessionId: `test-${Date.now()}`,
        serverId: editId ?? undefined,
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim() || 'root',
        auth: auth === 'password' || auth === 'agent' ? auth : 'key',
        password: auth === 'password' ? password || undefined : undefined,
        keyPath: auth === 'key' ? keyPath || undefined : undefined,
        passphrase: auth === 'key' ? passphrase || undefined : undefined,
        // So Test connection exercises the agent the user just typed rather
        // than the one already stored — otherwise the test cannot tell them
        // whether the path they are about to save actually works.
        agentSocket: auth === 'agent' ? agentSocket.trim() || undefined : undefined,
        hops,
        vpnProfileId: vpnProfileId || undefined
      } as never)
      if (r?.ok) {
        setTestResult({ ok: true, text: `Connected to ${host.trim()} as ${username.trim() || 'root'}.` })
        return
      }
      // Through the same classifier the terminal's failure card uses, so a
      // wrong username reads as a wrong username here rather than as the
      // handshake timeout it arrives as.
      const advice = adviseOnError(r?.error)
      setTestResult({ ok: false, text: advice.hint ? `${advice.cause} ${advice.hint}` : advice.cause })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!valid) return
    const fields = {
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim() || 'root',
      auth,
      route: hops,
      vpnProfileId,
      // Only meaningful where there is a shell to withhold. An RDP-only
      // machine has none, and carrying `sftpOnly` there would describe a
      // restriction on a protocol this record says nothing about.
      sftpOnly: speaks === 'rdp' ? false : sftpOnly,
      // Marks which halves are real. Absent means SSH, which is every server
      // saved before this existed.
      ...(speaks === 'rdp' ? { rdpOnly: true } : { rdpOnly: false }),
      // Absent, not a disabled record: `Server.rdp` being undefined is what
      // every other part of the app reads as "this server does not speak RDP",
      // and a kept-but-off object would offer the menu entry anyway.
      rdp: speaks !== 'ssh'
        ? {
            port: Number(rdpPort) || 3389,
            // Absent means "use the server's", which is every record saved
            // before RDP had an account of its own.
            username: rdpUsername.trim() || undefined,
            domain: rdpDomain.trim() || undefined,
            nla: rdpNla
          }
        : undefined
    }
    const id = editId ? (updateServer(editId, fields), editId) : addServer(fields)

    // What gets stored against the server is a reference wherever possible.
    // A credential in the vault is one record — reusable across every server
    // that uses it, and changed in one place when it rotates — whereas a copy
    // per server is what makes rotation a hunt.
    let secret: Record<string, string | undefined> | null = null

    if (usingVault) {
      secret = { vaultEntryId }
    } else if (auth === 'password' && password) {
      secret = saveToVault && vaultUnlocked ? null : { password }
      if (!secret) {
        const entryId = await createVaultEntry('login', {
          name: `${fields.name} (${fields.username})`,
          username: fields.username,
          password,
          tags: ['server']
        })
        // Falling back to the keychain beats losing the credential the user
        // just typed because the vault write failed.
        secret = entryId ? { vaultEntryId: entryId } : { password }
        if (!entryId)
          toast('The vault would not take this credential, so it was kept on this device only.', 'error', {
            label: 'Open vault',
            run: () => setActivity('vault')
          })
      }
    } else if (auth === 'key' && keyPath.trim()) {
      secret = { keyPath: keyPath.trim(), passphrase: passphrase || undefined }
    } else if (auth === 'agent' && agentSocket.trim()) {
      // A socket path is not a credential, but it rides in the same per-server
      // blob because that is where the auth method's details live.
      secret = { agentSocket: agentSocket.trim() }
    }

    if (secret) await storeSecret(id, secret, fields.name)

    /**
     * The desktop's password, under its OWN id.
     *
     * Not merged into the blob above, which is the SSH credential: one secret
     * per server is exactly what made the two protocols share a login, and a
     * box reached as Administrator over RDP and as root over SSH cannot agree
     * on one password. `rdpSecretId` derives the id, so nothing needs
     * migrating — a record with no secret there falls back to the server's.
     *
     * Only written when something was typed: an empty box while editing means
     * "unchanged", which is what its placeholder says.
     */
    if (speaks !== 'ssh' && rdpPassword) {
      await storeSecret(rdpSecretId(id), { password: rdpPassword }, `${fields.name} (RDP)`)
    }

    toast(`${fields.name} ${editId ? 'updated' : 'added'}`, 'ok')
    setModal(null)
    // An RDP-only machine has no terminal to open, and openServer already
    // routes it to its desktop — asked for by name here so the intent is
    // visible at the call site rather than only in the store.
    if (!editId) openServer(id, speaks === 'rdp' ? 'files' : 'terminal')
  }

  return (
    <Modal
      title={editId ? 'Edit Server' : 'Add Server'}
      subtitle={
        editId
          ? 'Change this connection profile'
          : // Not "SSH connection profile". SSH and RDP are separate
            // connections, and naming only one of them in the dialog's own
            // subtitle is what made an RDP-only machine feel unsupported.
            'Describe a machine and how to reach it'
      }
      onClose={() => setModal(null)}
      // The footer is Modal's, not this dialog's.
      //
      // Reported from the running app: the Edit Server dialog showed TWO
      // Cancel buttons — [Cancel] [Test connection] [Save Changes] [Cancel].
      // This form predates the footer refactor and still hand-composed the
      // whole action row, including its own Cancel, while Modal renders one of
      // its own unless `cancelLabel={null}` says the dialog has no way back.
      // Suppressing Modal's would have kept this dialog the one that decides
      // where its confirm sits, which is the exact drift Modal's header comment
      // was written to end. So the row is described instead of drawn: `confirm`
      // is the commit, `footer` the one extra control, `footerNote` the
      // sentence — and this dialog can no longer differ from its neighbours.
      //
      // Says what is missing rather than only going grey. A disabled button
      // with no explanation is a form the user has to guess at, and the
      // previous gate (`name && host`) let a profile be saved with an auth
      // method it had no credential for — met much later as an undifferentiated
      // "Connection failed" on a different screen.
      footerNote={
        <>
          {missing && <span className="field-hint danger">{missing.why}</span>}
          {!missing && testResult && (
            <span className={clsx('field-hint', testResult.ok ? 'ok' : 'danger')}>{testResult.text}</span>
          )}
        </>
      }
      // Beside the primary, where the fields are still editable. A failure
      // reported here can be corrected without saving a profile that does not
      // work and coming back to it.
      footer={
        /**
         * Test connection dials SSH, so it is not offered for a machine that
         * does not speak it. A button that always fails on a Windows box
         * would read as the machine being unreachable rather than as the test
         * being the wrong test.
         */
        speaks === 'rdp' ? null : (
          <button
            className="btn secondary size-28"
            disabled={!valid || testing}
            onClick={() => void testConnection()}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        )
      }
      confirm={{
        label: editId ? 'Save Changes' : 'Add Server',
        onClick: () => void save(),
        disabled: !valid
      }}
    >
      <div className="field">
        <label className="field-label">Connection Name</label>
        <input
          className="input"
          placeholder="Production API"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>

      <div className="field-row">
        <div className="field" style={{ gridColumn: 'span 1' }}>
          <label className="field-label">Server / IP</label>
          <input className="input" placeholder="10.20.0.10" value={host} onChange={(e) => setHost(e.target.value)} />
        </div>
        <div className="field-row" style={{ gridColumn: 'span 1' }}>
          {/* SSH's port, which an RDP-only machine does not have. Its own port
              is set in the RDP section below, and showing both would be two
              fields called Port meaning different things. */}
          {speaks !== 'rdp' && (
            <div className="field">
              <label className="field-label">Port</label>
              <input className="input" value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label className="field-label">Username</label>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
        </div>
      </div>

      {/**
       * SSH authentication, hidden for a machine that does not speak SSH.
       *
       * This is the concrete shape of the complaint: the form demanded an SSH
       * credential — a private key, or a password for port 22 — from a Windows
       * box with nothing listening there. The desktop signs in with the
       * username above and the password stored against the record, so an
       * authentication method for a protocol this server does not accept is
       * not a field to leave blank, it is a question not to ask.
       */}
      {speaks !== 'rdp' && (
        <>
      <div className="field">
        <label className="field-label">Authentication</label>
        <div className="radio-cards">
          {AUTH.map((a) => (
            <button
              key={a.id}
              className={clsx('radio-card', auth === a.id && 'active')}
              disabled={a.unavailable !== undefined && auth !== a.id}
              title={a.unavailable}
              onClick={() => setAuth(a.id)}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
        {/* Shown when the value is SELECTED, not only when hovered — an
            existing profile saved with it opens here, and a tooltip is not a
            way to tell somebody their connection cannot work. The card stays
            enabled in that case so the state is visible rather than a mystery
            selection nothing accounts for. */}
        {AUTH.find((a) => a.id === auth)?.unavailable && (
          <span className="field-hint danger">{AUTH.find((a) => a.id === auth)!.unavailable}</span>
        )}
      </div>

      {auth !== 'agent' && vaultUnlocked && usableEntries.length > 0 && (
        <div className="field">
          <label className="field-label">Credential</label>
          <select className="input" value={vaultEntryId} onChange={(e) => setVaultEntryId(e.target.value)}>
            <option value="">Enter a new one…</option>
            {usableEntries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.username ? ` — ${e.username}` : ''}
              </option>
            ))}
          </select>
          <span className="field-hint">
            {usingVault
              ? 'This server will reference the vault entry. Change the credential there and every server using it follows.'
              : 'Reuse a credential you have already saved, or type a new one below.'}
          </span>
        </div>
      )}

      {auth !== 'agent' && vaultUnlocked && usableEntries.length === 0 && (
        <div className="field">
          <span className="field-hint">
            No saved {auth === 'key' ? 'SSH key' : 'login'} in the vault yet — type one below and it
            will be saved there.
          </span>
        </div>
      )}

      {auth === 'agent' && (
        <div className="field">
          <label className="field-label">Agent socket</label>
          <input
            className="input"
            placeholder={
              editId
                ? 'Leave blank to keep the stored agent'
                : 'Optional — defaults to SSH_AUTH_SOCK'
            }
            value={agentSocket}
            onChange={(e) => setAgentSocket(e.target.value)}
          />
          {/* Worth stating plainly, because the default is wrong more often
              than it looks. A desktop app inherits whatever agent the session
              manager started it with, which on macOS is launchd's own — so a
              user whose keys live in Bitwarden, 1Password or KeePassXC has none
              of them available unless this names their agent. */}
          <span className="field-hint">
            Where your agent listens, e.g. <code>~/.bitwarden-ssh-agent.sock</code>. Leave blank to
            use the agent this app was started with, which is not always the one holding your keys.
          </span>
        </div>
      )}

      {auth === 'key' && !usingVault && (
        <div className="field">
          <label className="field-label">Private key</label>
          <div className="input-group">
            <input
              className="input"
              placeholder="~/.ssh/id_ed25519"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
            />
            <button className="btn" onClick={pickKey}>
              <FolderOpen size={14} /> Browse
            </button>
          </div>
          {foundKeys.length > 0 && (
            <div className="field-hint" style={{ marginTop: 6 }}>
              <span>Found in ~/.ssh:</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {foundKeys.map((k) => (
                  <button
                    key={k.path}
                    className={clsx('btn', 'sm', keyPath === k.path && 'active')}
                    onClick={() => setKeyPath(k.path)}
                    title={k.path}
                  >
                    <KeyRound size={12} /> {k.fileName}
                    {k.algorithm ? ` (${k.algorithm})` : ''}
                    {k.encrypted ? ' \u00b7 passphrase' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          <span className="field-hint">Key path and passphrase are stored in OS secure storage, never in plaintext.</span>
          <input
            className="input"
            type="password"
            placeholder="Key passphrase (optional)"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            style={{ marginTop: 8 }}
          />
        </div>
      )}

      {auth === 'password' && !usingVault && (
        <div className="field">
          <label className="field-label">Password</label>
          <input
            className="input"
            type="password"
            // See AddDatabaseModal: dots are the mask, so a dot placeholder
            // cannot be told apart from a saved password. This one showed them
            // unconditionally, so an edit gave the reader no way to know
            // whether a credential was stored — and leaving it blank on an
            // edit is exactly what keeps it.
            placeholder={editId ? 'Unchanged — leave blank to keep the saved password' : ''}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {vaultUnlocked ? (
            <label className="field-hint row" style={{ gap: 6, cursor: 'pointer', marginTop: 6 }}>
              <input type="checkbox" checked={saveToVault} onChange={(e) => setSaveToVault(e.target.checked)} />
              Save this to the vault as a reusable credential
            </label>
          ) : (
            <span className="field-hint">
              Encrypted with the OS keychain. Unlock the vault first to save it as a reusable
              credential instead.
            </span>
          )}
        </div>
      )}

      </>
      )}

      {/**
       * What the machine speaks, as one choice.
       *
       * This was two independent checkboxes — "Files only (no shell)" and
       * "Also reachable by RDP" — and between them they could not express
       * "RDP only". SSH was assumed by the dialog's own subtitle, so a Windows
       * box with nothing on port 22 had to be given an invented SSH account
       * before it could be saved. The two protocols are separate connections
       * and the form now says so.
       */}
      <div className="col" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
        <span className="field-label">This machine speaks</span>
        <div className="segment">
          {(
            [
              ['ssh', 'SSH'],
              ['ssh+rdp', 'SSH and RDP'],
              ['rdp', 'RDP only']
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={clsx('seg-btn', speaks === value && 'active')}
              onClick={() => setSpeaks(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="field-hint">
          {speaks === 'rdp'
            ? 'No shell, no files and no monitoring — those all need SSH. The server opens on its desktop.'
            : speaks === 'ssh+rdp'
              ? 'One machine, two connections. The desktop signs in with the username and password below, so an account authenticating by key needs a password stored as well.'
              : 'Terminal, files and monitoring, over one authenticated connection.'}
        </span>
      </div>

      {/* The delivery/backup account shape: sshd forces internal-sftp, so
          files work and nothing runs. Only meaningful where there is a shell
          to withhold, so it is not offered for an RDP-only machine. */}
      {speaks !== 'rdp' && (
        <label className="row" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start', marginBottom: 'var(--sp-3)' }}>
          <input
            type="checkbox"
            checked={sftpOnly}
            onChange={(e) => setSftpOnly(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span className="col" style={{ gap: 2 }}>
            <span>Files only (no shell)</span>
            <span className="field-hint">
              For accounts restricted to SFTP — sshd forcing <span className="mono">internal-sftp</span>,
              often chrooted. The server opens on Files, and Terminal and Monitor are not offered
              because they need to run commands.
            </span>
          </span>
        </label>
      )}

      {speaks !== 'ssh' && (
        <div className="col" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)', paddingLeft: 22 }}>
          {/**
           * RDP's own account and password.
           *
           * This is the codependence the report was about, and hiding the SSH
           * fields was only half of it: the desktop resolved its login from
           * `Server.username` and from the ONE secret per server, so a box
           * reached as Administrator over RDP and as root over SSH had to
           * agree on a single password. On Windows they never do.
           *
           * Both are optional and both fall back to the server's, so every
           * record saved before this keeps working exactly as it did.
           */}
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <label className="col" style={{ gap: 2, flex: 1 }}>
              <span className="field-label">
                {speaks === 'rdp' ? 'Sign in as' : 'RDP account (optional)'}
              </span>
              <input
                className="input"
                value={rdpUsername}
                onChange={(e) => setRdpUsername(e.target.value)}
                placeholder={speaks === 'rdp' ? 'Administrator' : username || 'Administrator'}
              />
            </label>
            <label className="col" style={{ gap: 2, flex: 1 }}>
              <span className="field-label">RDP password</span>
              <input
                className="input"
                type="password"
                value={rdpPassword}
                onChange={(e) => setRdpPassword(e.target.value)}
                placeholder={editId ? 'Unchanged' : ''}
              />
            </label>
          </div>
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <label className="col" style={{ gap: 2, width: 110 }}>
              <span className="field-label">RDP port</span>
              <input
                className="input"
                value={rdpPort}
                inputMode="numeric"
                onChange={(e) => setRdpPort(e.target.value)}
                placeholder="3389"
              />
            </label>
            <label className="col" style={{ gap: 2, flex: 1 }}>
              <span className="field-label">Domain (optional)</span>
              <input
                className="input"
                value={rdpDomain}
                onChange={(e) => setRdpDomain(e.target.value)}
                placeholder="CORP"
              />
            </label>
          </div>
          <label className="row" style={{ gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={rdpNla}
              onChange={(e) => setRdpNla(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span className="col" style={{ gap: 2 }}>
              <span>Network Level Authentication</span>
              <span className="field-hint">
                Leave on for Windows, which normally requires it. Turn it off for
                <span className="mono"> xrdp </span>
                on Linux, which is not a CredSSP server and refuses the connection with it on.
              </span>
            </span>
          </label>
        </div>
      )}

      <VpnTransportSelect
        value={vpnProfileId}
        onChange={setVpnProfileId}
        hint="The VPN is the outer transport: any jump hosts below are dialled through it, and so is everything that rides this server — terminals, SFTP, metrics, remote desktops and its SSH tunnels."
      />

      <RouteHops hops={hops} onChange={setHops} excludeServerId={editId} />

      <div className="disclosure">
        <button className="disclosure-head" onClick={() => setAdvanced((v) => !v)}>
          <ChevronRight size={14} className={clsx('chev', advanced && 'open')} style={{ transition: 'transform .12s', transform: advanced ? 'rotate(90deg)' : undefined }} />
          Advanced options
        </button>
        {advanced && (
          <div className="disclosure-body">
            <div className="field-row">
              <div className="field">
                <label className="field-label">Connection timeout (s)</label>
                <input className="input" value={timeout} onChange={(e) => setTimeoutV(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Environment variables</label>
                <input className="input" placeholder="TERM=xterm-256color" value={env} onChange={(e) => setEnv(e.target.value)} />
              </div>
            </div>
            <label className="row" style={{ justifyContent: 'space-between' }}>
              <span className="s-title">Keep-alive</span>
              <span className={clsx('switch', keepAlive && 'on')} onClick={() => setKeepAlive((v) => !v)} />
            </label>
            <label className="row" style={{ justifyContent: 'space-between' }}>
              <span className="s-title">Compression</span>
              <span className={clsx('switch', compression && 'on')} onClick={() => setCompression((v) => !v)} />
            </label>
            <label className="row" style={{ justifyContent: 'space-between' }}>
              <span className="s-title">Strict host key verification</span>
              <span className={clsx('switch', hostKeyCheck && 'on')} onClick={() => setHostKeyCheck((v) => !v)} />
            </label>
          </div>
        )}
      </div>
    </Modal>
  )
}
