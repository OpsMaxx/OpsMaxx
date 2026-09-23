import { useEffect, useState } from 'react'
import { Database } from 'lucide-react'
import { Field, Modal } from '../common/Modal'
import { useApp, useWorkspaceServers } from '../../store/app'
import { toast } from '../../store/toast'
import { useVault } from '../../store/vault'
import type { VaultEntryDescriptor, VaultIndexResult } from '../../../../shared/vaultIndex'
import { useVaultPrompt } from '../../store/vaultPrompt'
import { clsx } from '../../lib/format'
import { KIND_COLOR } from './DatabaseSidebar'
import { VpnTransportSelect } from '../vpn/VpnTransportSelect'
import { saveDatabaseEdit, useDbEditor } from '../../store/dbEditor'
import { displayHostFromUri } from '../../../../shared/dbAddress'
import { dbConnectConfig } from '../../lib/dbConfig'
import { adviseOnError } from '../../lib/connectionError'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import type { DbKind, UUID } from '../../types'
import { Switch } from '../common/Switch'

// Per-engine, and `dbLabel`/`dbPlaceholder` are REQUIRED fields rather than a
// ternary at the input, because a ternary is how two of the five came to be
// wrong: `kind === 'mongodb' ? 'admin' : kind === 'redis' ? '0' : 'postgres'`
// quietly told a MySQL user that a Postgres system database was the example,
// and told a SQL Server user the same. The mapping existed; it just had a
// default that was only correct for the engine it was written for.
//
// A record keyed on DbKind cannot be added to without answering for every
// column, so the next engine cannot inherit somebody else's system database.
const KINDS: {
  id: DbKind
  label: string
  port: number
  /** What this engine calls the thing, in its own words. */
  dbLabel: string
  /** A real database name on a stock install of THIS engine. */
  dbPlaceholder: string
}[] = [
  { id: 'postgres', label: 'PostgreSQL', port: 5432, dbLabel: 'Database', dbPlaceholder: 'postgres' },
  { id: 'mysql', label: 'MySQL', port: 3306, dbLabel: 'Database', dbPlaceholder: 'mysql' },
  { id: 'mssql', label: 'SQL Server', port: 1433, dbLabel: 'Database', dbPlaceholder: 'master' },
  { id: 'mongodb', label: 'MongoDB', port: 27017, dbLabel: 'Database', dbPlaceholder: 'admin' },
  // Redis numbers its databases rather than naming them, so the label changes
  // too — "Database: mydb" is not a thing a Redis user can type.
  { id: 'redis', label: 'Redis', port: 6379, dbLabel: 'Database (index)', dbPlaceholder: '0' }
]

const kindOf = (k: DbKind): (typeof KINDS)[number] => KINDS.find((x) => x.id === k)!

export function AddDatabaseModal(): React.JSX.Element {
  const setModal = useApp((s) => s.setModal)
  const addDatabase = useApp((s) => s.addDatabase)
  const servers = useWorkspaceServers()
  // Set when the dialog was opened to correct an existing connection.
  const editId = useDbEditor((s) => s.editId)
  const existing = useApp((s) => s.databases.find((d) => d.id === editId))

  const [kind, setKind] = useState<DbKind>(existing?.kind ?? 'postgres')
  const [mode, setMode] = useState<'fields' | 'uri'>(existing?.uri ? 'uri' : 'fields')
  const [name, setName] = useState(existing?.name ?? '')
  const [host, setHost] = useState(existing?.host ?? 'localhost')
  const [port, setPort] = useState(String(existing?.port ?? 5432))
  const [username, setUsername] = useState(existing?.username ?? '')
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState(existing?.database ?? '')
  const [ssl, setSsl] = useState(existing?.ssl ?? false)
  const [uri, setUri] = useState('')
  const [sshServerId, setSshServerId] = useState(existing?.sshServerId ?? '')

  const vaultUnlocked = useVault((st) => st.unlocked)
  const vaultEntries = useVault((st) => st.entries)
  /**
   * Only entries that can actually be a database password.
   *
   * A `login` entry is url/username/password, which is exactly a database
   * credential's shape — so this needs no new vault kind. An SSH key entry is
   * excluded because a private key cannot authenticate a database.
   */
  const usableEntries = vaultEntries.filter((e) => !!e.password && !e.privateKey)
  /**
   * The same list as NAMES, for when the vault is secured.
   *
   * `vaultEntries` is empty unless the vault is fully open, so this picker
   * disappeared fifteen minutes after the last vault click and the modal
   * quietly became keychain-only — the user was never shown the choice, so the
   * password went somewhere they did not pick. Descriptors carry no value and
   * resolve while secured, so the option survives. AddServerModal takes the
   * same approach and its comment carries the reasoning about why the username
   * is missing from this half.
   */
  const [descriptors, setDescriptors] = useState<VaultEntryDescriptor[] | null>(null)
  useEffect(() => {
    let live = true
    void (window.opsmaxx?.vaultIndex as { list?: () => Promise<VaultIndexResult> } | undefined)
      ?.list?.()
      .then((r) => {
        if (live) setDescriptors(r?.ok ? r.entries : null)
      })
      .catch(() => {
        if (live) setDescriptors(null)
      })
    return () => {
      live = false
    }
  }, [vaultUnlocked])

  const options: { id: string; name: string; sub: string }[] = vaultUnlocked
    ? usableEntries.map((e) => ({ id: e.id, name: e.name, sub: e.username }))
    : (descriptors ?? [])
        .filter((d) => d.has.password && !d.has.privateKey)
        .map((d) => ({ id: d.id, name: d.name, sub: '' }))

  // Connection strings live in `key` entries, so they are a different list from
  // the passwords above — offering a database password where a whole URI is
  // wanted would produce a connection that fails for a reason nothing explains.
  const uriOptions: { id: string; name: string }[] = vaultUnlocked
    ? vaultEntries.filter((e) => e.kind === 'key' && !!e.password).map((e) => ({ id: e.id, name: e.name }))
    : (descriptors ?? [])
        .filter((d) => d.kind === 'key' && d.has.password)
        .map((d) => ({ id: d.id, name: d.name }))

  // '' means "type a new one"; anything else is a vault entry id.
  const [vaultEntryId, setVaultEntryId] = useState('')
  // The URI shape's reference, kept apart from the password one above. A record
  // has one or the other, never both, and the blob has always said which by
  // which field is present — so a second id rather than a slot discriminator.
  const [vaultUriEntryId, setVaultUriEntryId] = useState('')
  const [saveToVault, setSaveToVault] = useState(true)
  // No `vaultUnlocked &&`: a reference is valid whatever the vault is doing,
  // and resolution at connect time already prompts when it cannot read it.
  const usingVault = vaultEntryId !== ''
  const usingVaultUri = vaultUriEntryId !== ''
  const [vpnProfileId, setVpnProfileId] = useState<UUID | null>(existing?.vpnProfileId ?? null)

  // Whoever opened the dialog owns the target; leaving it set would make the
  // next plain "Add database" open on the connection edited before it.
  useEffect(() => () => useDbEditor.setState({ editId: null }), [])

  const pickKind = (k: DbKind): void => {
    setKind(k)
    setPort(String(KINDS.find((x) => x.id === k)?.port ?? 5432))
  }

  const useUri = mode === 'uri'
  // An edit starts with the stored credential already in the keychain, so an
  // empty password field means "leave it alone" rather than "there isn't one".
  const valid = name.trim() && (useUri ? uri.trim() || !!editId : host.trim())

  // Said under the field, once the user has been in it. Naming what is missing
  // before anything is typed would be an accusation about an untouched form;
  // saying nothing at all is what this dialog used to do, which left "Add
  // Database" greyed out with no statement anywhere of what would ungrey it.
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const problem = (key: string, message: string | null): string | null =>
    touched[key] ? message : null
  const touch = (key: string) => (): void => setTouched((t) => ({ ...t, [key]: true }))

  // Retryable on purpose: an OS keychain that is unavailable is usually a
  // login keyring the user has not unlocked yet, and that is fixed outside
  // this app and then works.
  const storeSecret = async (
    id: string,
    secret: { uri: string } | { password: string } | { vaultEntryId: string } | { vaultUriEntryId: string },
    label: string
  ): Promise<void> => {
    const ok = await window.opsmaxx?.secrets.set(id, JSON.stringify(secret))
    if (ok !== false) return
    toast(`${label} was saved, but this device would not store its password.`, 'error', {
      label: 'Try again',
      run: () => void storeSecret(id, secret, label)
    })
  }

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  /**
   * What to send as the credential for a test, if anything.
   *
   * Main resolves a database's secret by record id, and falls back to the
   * keychain only when neither `password` nor `uri` is present. So:
   *
   *  - typed into the form: sent inline, because there is nothing saved that
   *    would match it — testing what is stored rather than what is on screen
   *    is the one thing this button must not do;
   *  - a vault entry chosen here: read out of the vault and sent inline, for
   *    the same reason. An unsaved connection has no blob for main to find the
   *    reference in;
   *  - left blank while editing: nothing sent, so main resolves whatever is
   *    already stored. That is what makes "I only changed the port" testable
   *    without retyping a password.
   */
  const secretForTest = async (): Promise<{ password?: string; uri?: string }> => {
    const entryId = useUri ? vaultUriEntryId : vaultEntryId
    if (entryId) {
      if (!vaultUnlocked) {
        await useVaultPrompt
          .getState()
          .request('Testing this connection needs the credential in your vault.')
      }
      const value = useVault.getState().entries.find((e) => e.id === entryId)?.password
      // Still locked, or the entry is gone. Send nothing rather than an empty
      // string, which would read as "there is no password" and authenticate as
      // one.
      if (!value) return {}
      return useUri ? { uri: value } : { password: value }
    }
    if (useUri) return uri.trim() ? { uri: uri.trim() } : {}
    return password ? { password } : {}
  }

  const testConnection = async (): Promise<void> => {
    if (!valid || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const fn = window.opsmaxx?.db?.test
      if (!fn) {
        // Said, rather than a button that quietly does nothing — the same rule
        // the rest of the app applies to an unwired bridge.
        setTestResult({
          ok: false,
          text: 'This build cannot test a connection. Restart the app to rebuild it.'
        })
        return
      }
      const cfg = dbConnectConfig(
        {
          // '' for a connection that has not been saved: nothing for main to
          // look up, which is why the secret above goes inline. An edit keeps
          // its id so a blank password field still resolves what is stored.
          id: editId ?? '',
          kind,
          host: useUri ? '' : host.trim(),
          port: Number(port) || kindOf(kind).port,
          username: useUri ? '' : username.trim(),
          database: database.trim(),
          ssl,
          sshServerId: sshServerId || null,
          vpnProfileId
        },
        servers
      )
      const secret = await secretForTest()
      // A stored credential that lives in the vault fails here while the vault
      // is shut; this offers the unlock and runs the test again rather than
      // reporting it as a connection failure.
      const r = await withVaultUnlock(`Testing ${name.trim() || 'this connection'}`, () =>
        fn({ ...cfg, ...secret })
      )
      if (r?.ok) {
        setTestResult({ ok: true, text: r.version ? `Connected. ${r.version}` : 'Connected.' })
        return
      }
      // Through the same classifier the terminal's failure card uses, so a
      // refused port reads as a refused port rather than as the driver's text.
      const advice = adviseOnError(r?.error)
      setTestResult({ ok: false, text: advice.hint ? `${advice.cause} ${advice.hint}` : advice.cause })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!valid) return
    // A parse that did not succeed must never render as though it did. The
    // old derivation here fell back to splitting the string on `/ : ?`, which
    // for an ADO.NET string (no scheme, no `@`, none of those three) returned
    // the WHOLE string — password included — and persisted it as the host.
    // `displayHostFromUri` returns '' instead. See shared/dbAddress.ts.
    const displayHost = useUri ? displayHostFromUri(uri) : host.trim()
    const fields = {
      name: name.trim(),
      kind,
      host: displayHost || existing?.host || '',
      port: Number(port) || KINDS.find((x) => x.id === kind)!.port,
      username: useUri ? '' : username.trim(),
      database: database.trim(),
      ssl,
      uri: useUri,
      folderId: existing?.folderId ?? null,
      sshServerId: sshServerId || null,
      vpnProfileId
    }
    const id = editId ? (saveDatabaseEdit(editId, fields), editId) : addDatabase(fields)
    /**
     * A vault reference beats a typed password, and both beat nothing.
     *
     * Referencing an entry is what makes one database password one record:
     * three connections to the same server stop being three copies rotated in
     * three places. It is also the only form that survives a move to another
     * machine — the OS keychain is machine-local and no backup can carry it,
     * while the vault travels inside the encrypted bundle.
     */
    let secret:
      | { uri: string }
      | { password: string }
      | { vaultEntryId: string }
      | { vaultUriEntryId: string }
      | null = useUri
      ? usingVaultUri
        ? { vaultUriEntryId }
        : uri.trim()
          ? { uri: uri.trim() }
          : null
      : usingVault
        ? { vaultEntryId }
        : password
          ? { password }
          : null

    /**
     * A typed credential goes into the vault unless the user said otherwise,
     * the same default Add Server has.
     *
     * Both shapes, because both are credentials: a password, and a connection
     * string that has a password inside it. The URI half is why this is worth
     * the extra branch — it was the last class the vault could not hold, so a
     * connection saved that way stayed on one machine however much of the rest
     * of the estate moved.
     *
     * Falling back to the keychain beats losing what was just typed, which is
     * why this reassigns rather than refuses.
     */
    const typedSomething = useUri ? !usingVaultUri && !!uri.trim() : !usingVault && !!password
    if (typedSomething && saveToVault) {
      if (!vaultUnlocked) {
        await useVaultPrompt
          .getState()
          .request('Saving this credential into the vault needs your master password.')
      }
      const label = `${fields.name}${!useUri && username.trim() ? ` (${username.trim()})` : ''}`
      const entryId = useUri
        ? await useVault.getState().createEntry('key', {
            // `key`, not `login`: one opaque secret with a label, which is what
            // a connection string is. `login` would leave a username slot empty
            // beside a string that already contains one.
            name: label,
            password: uri.trim(),
            tags: ['database', 'connection-string']
          })
        : await useVault.getState().createEntry('login', {
            name: label,
            username: username.trim(),
            password,
            tags: ['database']
          })
      if (entryId) secret = useUri ? { vaultUriEntryId: entryId } : { vaultEntryId: entryId }
      else
        toast('The vault would not take this credential, so it was kept on this device only.', 'error')
    }

    if (secret) await storeSecret(id, secret, fields.name)
    toast(`${fields.name} ${editId ? 'updated' : 'added'}`, 'ok')
    setModal(null)
  }

  const uriPlaceholder: Record<DbKind, string> = {
    postgres: 'postgresql://user:pass@host:5432/dbname',
    mysql: 'mysql://user:pass@host:3306/dbname',
    mssql: 'Server=server,1433;Database=db;User Id=user;Password=pass;Encrypt=true',
    mongodb: 'mongodb+srv://user:pass@cluster.mongodb.net/dbname',
    redis: 'redis://:pass@host:6379/0'
  }

  return (
    <Modal
      title={editId ? 'Edit Database' : 'Add Database'}
      subtitle={editId ? `Change how OpsMaxx reaches ${existing?.name ?? 'this database'}` : 'Create a database connection profile'}
      onClose={() => setModal(null)}
      footerNote={
        testResult && (
          <span className={clsx('field-hint', testResult.ok ? 'ok' : 'danger')}>{testResult.text}</span>
        )
      }
      // Beside the primary, where the fields are still editable — the same
      // place Add Server puts it. A failure reported here can be corrected
      // without saving a connection that does not work and coming back to it.
      footer={
        <button
          className="btn secondary size-28"
          disabled={!valid || testing}
          onClick={() => void testConnection()}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      }
      confirm={{
        label: editId ? 'Save changes' : 'Add database',
        disabled: !valid,
        onClick: () => void save()
      }}
    >
      <div className="field">
        <label className="field-label">Engine</label>
        <div className="radio-cards" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          {KINDS.map((k) => (
            <button
              key={k.id}
              className={clsx('radio-card', kind === k.id && 'active')}
              onClick={() => pickKind(k.id)}
            >
              <Database size={16} style={{ color: KIND_COLOR[k.id] }} />
              {k.label}
            </button>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <div className="grow">
          <Field
            label="Connection name"
            required
            error={problem('name', name.trim() ? null : 'Give this connection a name.')}
          >
            <input
              className="input"
              placeholder="Production DB"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={touch('name')}
              autoFocus
            />
          </Field>
        </div>
        <div className="field">
          <label className="field-label">Method</label>
          <div className="segment">
            <button className={clsx('seg-btn', !useUri && 'active')} onClick={() => setMode('fields')}>
              Fields
            </button>
            <button className={clsx('seg-btn', useUri && 'active')} onClick={() => setMode('uri')}>
              Connection string
            </button>
          </div>
        </div>
      </div>

      {useUri ? (
        <>
          <Field
            label="Connection string / URI"
            required={!editId}
            error={problem(
              'uri',
              uri.trim() || editId ? null : 'Paste the connection string this database is reached by.'
            )}
          >
            <textarea
              className="textarea"
              style={{ minHeight: 60 }}
              placeholder={editId ? 'Leave blank to keep the saved connection string' : uriPlaceholder[kind]}
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              onBlur={touch('uri')}
            />
          </Field>

          {/* The URI shape's own credential row.
              A connection string carries its password inside it, so until now
              it was the one credential class that had to stay on this machine:
              the OS keychain is machine-local, no backup carries it, and the
              same string used by three connections was three copies. It
              references a `key` entry — url plus one opaque secret, which is
              exactly a connection string's shape. */}
          {uriOptions.length > 0 && (
            <div className="field">
              <label className="field-label">Connection string</label>
              <select
                className="input"
                value={vaultUriEntryId}
                onChange={(e) => setVaultUriEntryId(e.target.value)}
              >
                <option value="">Enter a new one…</option>
                {uriOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                {usingVaultUri
                  ? 'This connection will reference the vault entry. Change the string there and every connection using it follows — and it travels with an encrypted backup, which a string kept only on this device cannot.'
                  : 'Reuse a connection string you have already saved, or type a new one above.'}
              </span>
            </div>
          )}

          {!usingVaultUri && (
            <label className="field-hint row" style={{ gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={saveToVault}
                onChange={(e) => setSaveToVault(e.target.checked)}
              />
              Save this connection string to the vault as a reusable credential
            </label>
          )}

          {kind === 'mongodb' && (
            <div className="field">
              <label className="field-label">Database (optional — overrides the URI default)</label>
              <input className="input" placeholder="from URI" value={database} onChange={(e) => setDatabase(e.target.value)} />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="field-row">
            <Field
              label="Server / IP"
              required
              error={problem('host', host.trim() ? null : 'Name the host this database runs on.')}
            >
              <input
                className="input"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onBlur={touch('host')}
              />
            </Field>
            <Field label="Port">
              <input className="input" value={port} onChange={(e) => setPort(e.target.value)} />
            </Field>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="field-label">Username</label>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            {options.length > 0 && (
              <div className="field">
                <label className="field-label">Credential</label>
                <select
                  className="input"
                  value={vaultEntryId}
                  onChange={(e) => setVaultEntryId(e.target.value)}
                >
                  <option value="">Enter a new one…</option>
                  {options.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                      {e.sub ? ` — ${e.sub}` : ''}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  {usingVault
                    ? 'This database will reference the vault entry. Change the password there and every connection using it follows — and it travels with an encrypted backup, which a password kept only on this device cannot.'
                    : 'Reuse a password you have already saved, or type a new one below.'}
                </span>
              </div>
            )}

            {!usingVault && (
            <div className="field">
              <label className="field-label">Password</label>
              <input
                className="input"
                type="password"
                // Never the mask character. In a type=password field the dots
                // ARE what content looks like, so a dot placeholder is
                // indistinguishable from a stored credential — on a NEW
                // connection it showed eight dots in an empty box, and on an
                // edit the reader could not tell whether anything was saved.
                // Words, or nothing. Blank on an edit genuinely keeps the
                // stored secret, so "Unchanged" is the truth.
                placeholder={editId ? 'Unchanged' : ''}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {/* Ticked by default, matching Add Server. A database password
                  kept only in the OS keychain is the one credential class that
                  could not be a single record — the same password used by three
                  connections was three copies rotated in three places — and it
                  is machine-local, so no backup carries it. */}
              <label className="field-hint row" style={{ gap: 6, cursor: 'pointer', marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={saveToVault}
                  onChange={(e) => setSaveToVault(e.target.checked)}
                />
                Save this to the vault as a reusable credential
              </label>
            </div>
            )}
          </div>

          <div className="field-row">
            <div className="field">
              <label className="field-label">{kindOf(kind).dbLabel}</label>
              <input
                className="input"
                placeholder={kindOf(kind).dbPlaceholder}
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label">TLS / SSL</label>
              <label className="row" style={{ height: 34, gap: 10 }}>
                <Switch checked={ssl} onChange={setSsl} />
                <span className="muted">{ssl ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
          </div>
        </>
      )}

      <div className="field">
        <label className="field-label">SSH tunnel (optional)</label>
        <select className="input" value={sshServerId} onChange={(e) => setSshServerId(e.target.value)}>
          <option value="">Connect directly</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              via {s.name} ({s.username}@{s.host})
            </option>
          ))}
        </select>
        <span className="field-hint">
          Reaches a database that is only routable from the bastion. The server and port above are
          resolved on the server, not on this machine.
          {kind === 'mongodb' && ' mongodb+srv:// strings cannot be tunnelled — use server/port.'}
        </span>
      </div>

      <VpnTransportSelect
        value={vpnProfileId}
        onChange={setVpnProfileId}
        hint={
          sshServerId
            ? 'Both are set, so the VPN goes on the outside: the SSH server above is reached through the VPN, and the database is reached from there exactly as it would be without one.'
            : 'Independent of the SSH tunnel above, and stackable with it: set both and the VPN carries the SSH server, which then reaches the database.'
        }
      />

      <span className="field-hint">Credentials are stored in OS secure storage, never in plaintext.</span>
    </Modal>
  )
}
