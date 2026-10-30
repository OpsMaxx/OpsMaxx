import { useEffect, useRef, useState } from 'react'
import { KeychainOnly } from './KeychainOnly'
import {
  Check,
  Circle,
  Copy,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  Unlock
} from 'lucide-react'
import { useVault, newField, bioBlockedReason } from '../../store/vault'
import { VaultReset } from './VaultReset'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { useApp } from '../../store/app'
import { t as translate, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import {
  VAULT_MIN_PASSWORD,
  VAULT_KIND_LABEL,
  VAULT_KIND_FIELDS,
  VAULT_SECRET_LABEL,
  hiddenFieldsFor,
  type VaultEntry,
  type VaultKind
} from '../../../../shared/vault'

const KINDS: VaultKind[] = ['login', 'url', 'key', 'sshkey', 'note']

// Which of the built-in fields each kind actually shows. The picker used to
// change nothing but an icon in the sidebar: every kind rendered URL, Username
// and Password, so a Note asked for a password and an API key had nowhere
// obvious to put the key. Name, tags, custom fields and notes are on every
// kind and are not listed here.
//
// Switching kind never deletes anything. A value typed under one kind is still
// stored, still searchable, and comes back if the kind is switched back — so
// this only decides what is on screen, which is the one thing it should decide.

function copy(label: string, value: string): void {
  if (!value) return
  window.opsmaxx?.clipboard.write(value)
  toast(translate('vault.editor.copied', { label }))
}

export function VaultView(): React.JSX.Element {
  const t = useT()
  const exists = useVault((s) => s.exists)
  const unlocked = useVault((s) => s.unlocked)
  const refresh = useVault((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The idle-timeout listener that used to live here moved to
  // `startVaultLockWatch` in store/vault.ts, mounted once at app level. It was
  // only ever wired while this view was on screen, so everywhere else the
  // "lock" left every decrypted entry in the store. A view is the wrong scope
  // for a rule about the whole renderer's memory.

  // `null` is "main has not answered yet", and it must not fall through to the
  // create screen. status() reaches safeStorage, which on macOS blocks on a
  // keychain prompt for as long as the user takes to answer it -- and for that
  // whole time a user with a full vault was being shown "Create vault" and two
  // empty password fields.
  if (exists === null) {
    return (
      <div className="main vault-gate">
        <div className="vault-gate-card">
          <div className="vault-gate-icon">
            <Lock size={26} />
          </div>
          <h2>{t('vault.gate.openingTitle')}</h2>
          <p className="faint">{t('vault.gate.openingBody')}</p>
        </div>
      </div>
    )
  }
  if (!exists) return <VaultGate mode="create" />
  if (!unlocked) return <VaultGate mode="unlock" />
  return <VaultBrowser />
}

// Create-master-password and unlock share a layout; only the copy and the
// action differ.
// What the platform actually calls it. Saying "Touch ID" on a Windows machine
// would be worse than saying nothing.
const BIO_LABEL: Record<string, string> = {
  'touch-id': 'Touch ID',
  'windows-hello': 'Windows Hello'
}

// 12, not 8. The vault file is the thing an attacker copies, and against a
// stolen file the master password's length is worth more than anything the
// unlock UI does. Only applies to passwords being chosen now — an existing
// vault is not forced to change on upgrade.
const MIN_PASSWORD = VAULT_MIN_PASSWORD

/**
 * One requirement, and whether it is met yet.
 *
 * The icon is not the only carrier: the row's text says the requirement in
 * words, so it reads the same to somebody who cannot tell the two colours
 * apart. `met` only ever turns a pending dot into a tick — nothing here goes
 * red, because a requirement not yet reached is not an error.
 */
function Rule({ met, children }: { met: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={clsx('vault-rule', met && 'met')}>
      {met ? <Check size={13} /> : <Circle size={13} />}
      <span>{children}</span>
    </div>
  )
}

function VaultGate({ mode }: { mode: 'create' | 'unlock' }): React.JSX.Element {
  const t = useT()
  const create = useVault((s) => s.create)
  const unlock = useVault((s) => s.unlock)
  const error = useVault((s) => s.error)
  const clearError = useVault((s) => s.clearError)
  const busy = useVault((s) => s.busy)
  const stage = useVault((s) => s.stage)

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)

  const bioAvailable = useVault((s) => s.bioAvailable)
  const bioEnabled = useVault((s) => s.bioEnabled)
  const bioKind = useVault((s) => s.bioKind)
  const refreshBiometrics = useVault((s) => s.refreshBiometrics)
  const unlockWithBiometrics = useVault((s) => s.unlockWithBiometrics)
  const canUseBio = mode === 'unlock' && bioAvailable && bioEnabled
  const bioBlocked = useVault(bioBlockedReason)

  useEffect(() => {
    void refreshBiometrics()
  }, [refreshBiometrics])

  // Fired automatically, but only here and only once, and the earlier refusal
  // to do it at all is worth keeping in view rather than deleting.
  //
  // The argument against was: a prompt that appears unbidden every time the app
  // opens trains people to touch the sensor without reading it, which is the
  // habit that makes a prompt worth phishing. That objection is about an
  // UNBIDDEN prompt. This one is not — it fires because the user navigated to
  // the Vault screen and found it locked, which is them asking to open the
  // vault. It never fires from the credential modal, never on app start, and
  // never anywhere else.
  //
  // Once per mount, guarded by a ref: cancelling must leave the password field
  // sitting there, not raise the sheet again. `promptTouchID` rejects on
  // cancel, `unlockWithBiometrics` swallows that into a failed result, and the
  // guard means neither can loop.
  const autoPrompted = useRef(false)
  const autoPrompt = useApp((s) => s.settings.vaultAutoBiometricPrompt)

  useEffect(() => {
    if (!canUseBio || !autoPrompt || autoPrompted.current || busy) return
    autoPrompted.current = true
    void unlockWithBiometrics()
  }, [canUseBio, autoPrompt, busy, unlockWithBiometrics])

  const creating = mode === 'create'
  // Secured and locked both land on this gate and both want the master
  // password, but they are not the same news. Locked means everything that
  // needs a vault credential has stopped; secured means only this screen has.
  // Telling someone their estate stopped being checked when it did not is the
  // kind of wrong that sends them looking for a fault.
  const secured = !creating && stage === 'secured'
  const mismatch = creating && confirm.length > 0 && password !== confirm
  const canSubmit =
    password.length >= (creating ? MIN_PASSWORD : 1) && !mismatch && (!creating || confirm.length > 0)

  const passwordRef = useRef<HTMLInputElement>(null)

  const submit = async (): Promise<void> => {
    if (!canSubmit || busy) return
    const ok = creating ? await create(password) : await unlock(password)
    if (!ok) {
      // The only place this can be fixed is the field the user just typed in,
      // so put the cursor back in it with the attempt selected — the next
      // keystroke replaces it, and nobody has to work out where to try again.
      passwordRef.current?.select()
      passwordRef.current?.focus()
      return
    }
    setPassword('')
    setConfirm('')
    toast(creating ? t('vault.gate.created') : t('vault.gate.unlocked'))
  }

  return (
    <div className="main vault-gate">
      <div className="vault-gate-card">
        <div className="vault-gate-icon">{creating ? <ShieldCheck size={26} /> : <Lock size={26} />}</div>
        <h2>
          {creating
            ? t('vault.gate.createTitle')
            : secured
              ? t('vault.gate.securedTitle')
              : t('vault.gate.lockedTitle')}
        </h2>
        <p className="faint">
          {creating
            ? t('vault.gate.createBody')
            : secured
              ? t('vault.gate.securedBody')
              : t('vault.gate.lockedBody')}
        </p>

        {canUseBio && (
          <button
            className="btn primary"
            style={{ width: '100%', marginBottom: 10 }}
            disabled={busy}
            onClick={() => void unlockWithBiometrics()}
          >
            <Fingerprint size={15} />{' '}
            {t('vault.gate.unlockWith', { method: BIO_LABEL[bioKind] ?? t('vault.gate.biometrics') })}
          </button>
        )}

        {/* Set up for this vault, but not usable right now. Without this the
            button simply is not there, which reads as the feature having broken
            -- and the user is left guessing whether to wait for a prompt that
            is never coming. No BIO_LABEL here on purpose: biometricSupport()
            reports kind 'none' on every unavailable branch, so there is no
            honest name to use. */}
        {!creating && bioBlocked && (
          <div className="s-desc" style={{ marginBottom: 10, textAlign: 'left' }}>
            {t('vault.gate.bioBlocked', { reason: bioBlocked })}
          </div>
        )}

        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <input
            className="input"
            ref={passwordRef}
            type={show ? 'text' : 'password'}
            autoFocus
            style={{ flex: 1 }}
            placeholder={
              creating ? t('vault.gate.passwordMin', { min: MIN_PASSWORD }) : t('vault.gate.password')
            }
            aria-describedby={creating ? 'vault-password-rules' : undefined}
            aria-invalid={creating && password.length > 0 && password.length < MIN_PASSWORD}
            value={password}
            onChange={(e) => {
              clearError()
              setPassword(e.target.value)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          <button
            className="icon-btn"
            title={show ? t('common.hide') : t('common.show')}
            onClick={() => setShow((v) => !v)}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {/**
         * The requirement, while it is being typed against.
         *
         * It used to live in the placeholder and NOWHERE else — and a
         * placeholder disappears the moment there is a character in the field,
         * so the rule was visible only while it was impossible to have broken
         * it. Type six characters and the button is disabled with nothing on
         * screen saying why, which reads as the app being broken rather than
         * as a password being short.
         *
         * `aria-live` because this is the answer to "why can I not continue",
         * and a sighted user gets it by watching the line change.
         */}
        {creating && (
          <div
            id="vault-password-rules"
            className="vault-rules"
            aria-live="polite"
            style={{ marginTop: 8 }}
          >
            <Rule met={password.length >= MIN_PASSWORD}>
              {password.length > 0 && password.length < MIN_PASSWORD
                ? t('vault.gate.ruleLengthToGo', { min: MIN_PASSWORD, left: MIN_PASSWORD - password.length })
                : t('vault.gate.ruleLength', { min: MIN_PASSWORD })}
            </Rule>
            {/**
             * Shown once the password is long enough OR the confirmation has
             * been started, and not before — so it is not a pending rule
             * against a field nobody has reached yet.
             *
             * The first version showed it only when `confirm` had content, and
             * that left the original bug in place one step further along: with
             * twelve characters typed and the confirmation untouched, the
             * button was disabled and every visible rule was met. Confirming
             * IS a requirement, so it has to be on the list.
             */}
            {(confirm.length > 0 || password.length >= MIN_PASSWORD) && (
              <Rule met={confirm.length > 0 && password === confirm}>
                {confirm.length === 0 ? t('vault.gate.ruleConfirm') : t('vault.gate.ruleMatch')}
              </Rule>
            )}
          </div>
        )}

        {creating && (
          <input
            className="input"
            type={show ? 'text' : 'password'}
            style={{ width: '100%', marginTop: 6 }}
            placeholder={t('vault.gate.confirmPassword')}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        )}

        {/* Said here because the create screen is where people look for it and
            do not find it: a fingerprint cannot open a vault that does not
            exist yet — enableBiometricUnlock stores the key already in memory,
            and until a master password derives one there is nothing to store.
            Without this line the absence reads as the feature being missing.
            Gated on bioAvailable so it is never a promise this machine cannot
            keep, which is the whole point of biometricSupport() reporting a
            reason instead of a boolean. */}
        {creating && bioAvailable && (
          <div className="s-desc" style={{ marginTop: 6 }}>
            {t('vault.gate.bioLater', { method: BIO_LABEL[bioKind] ?? t('vault.gate.biometric') })}
          </div>
        )}

        {mismatch && <div className="vault-error">{t('vault.gate.mismatch')}</div>}
        {error && <div className="vault-error">{error}</div>}
        {/* There is no reset link to offer, so say that plainly instead of
            leaving someone hunting for one. Caps lock is the usual culprit. */}
        {error && !creating && (
          <div className="s-desc" style={{ marginTop: 6 }}>
            {canUseBio
              ? t('vault.gate.wrongPasswordHintBio', { method: BIO_LABEL[bioKind] ?? t('vault.gate.biometrics') })
              : t('vault.gate.wrongPasswordHint')}
          </div>
        )}

        <button
          className="btn primary"
          style={{ width: '100%', marginTop: 10, justifyContent: 'center' }}
          disabled={!canSubmit || busy}
          onClick={() => void submit()}
        >
          {creating ? <ShieldCheck size={15} /> : <Unlock size={15} />}
          {creating ? t('vault.gate.createButton') : t('vault.gate.unlockButton')}
        </button>

        {/* Not on the secured screen until an unlock has failed. That screen
            belongs to someone who typed the password this session, so up front
            a delete button is only a footgun -- but typing a password this
            morning is no proof of remembering it this afternoon, and the hint
            above promises a way out "below" on every error. Hiding it here left
            Cmd+Q as the only route to it, and nothing said so.
            `onDone` is not cosmetic -- after a destroy `exists` flips false and
            this same component instance re-renders as mode="create", keeping
            its React state, so the create screen would arrive pre-filled with
            the forgotten password one click from becoming the new one. */}
        {!creating && (!secured || error) && (
          <VaultReset
            onDone={() => {
              setPassword('')
              setConfirm('')
            }}
          />
        )}
      </div>
    </div>
  )
}

// Remembers a decline so the offer is made once, not every unlock. A UI
// preference, so it lives with the UI rather than in the vault file.
const BIO_OFFER_DISMISSED = 'opsmaxx.vault.bioOfferDismissed'

// Offered right after a successful unlock, which is the one moment the value
// is obvious — the user has just typed a long password and is about to do it
// again tomorrow. A toggle in the toolbar is discoverable only by someone
// already looking for it, which is nobody.
function BiometricOffer(): React.JSX.Element | null {
  const t = useT()
  const bioAvailable = useVault((s) => s.bioAvailable)
  const bioEnabled = useVault((s) => s.bioEnabled)
  const bioKind = useVault((s) => s.bioKind)
  const setBiometrics = useVault((s) => s.setBiometrics)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(BIO_OFFER_DISMISSED) === '1')

  if (!bioAvailable || bioEnabled || dismissed) return null
  const label = BIO_LABEL[bioKind] ?? t('vault.gate.biometrics')

  const decline = (): void => {
    localStorage.setItem(BIO_OFFER_DISMISSED, '1')
    setDismissed(true)
  }

  return (
    <div className="vault-bio-offer">
      <Fingerprint size={18} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div className="s-title">{t('vault.bioOffer.title', { method: label })}</div>
        <div className="s-desc">
          {t('vault.bioOffer.intro', { method: label })}
          <br />
          <br />
          <Trans i18nKey="vault.bioOffer.session" values={{ method: label }} components={{ b: <b /> }} />
          <br />
          <Trans i18nKey="vault.bioOffer.persistent" components={{ b: <b /> }} />
        </div>
      </div>
      <button
        className="btn sm primary"
        onClick={() =>
          void setBiometrics(true, 'persistent').then(
            (ok) => ok && toast(t('vault.bioOffer.enabledPersistent', { method: label }), 'ok')
          )
        }
      >
        {t('vault.bioOffer.persistentButton')}
      </button>
      <button
        className="btn sm"
        onClick={() =>
          void setBiometrics(true, 'session').then(
            (ok) => ok && toast(t('vault.bioOffer.enabledSession', { method: label }), 'ok')
          )
        }
      >
        {t('vault.bioOffer.sessionButton')}
      </button>
      <button className="btn sm" onClick={decline}>
        {t('vault.bioOffer.notNow')}
      </button>
    </div>
  )
}

function VaultBrowser(): React.JSX.Element {
  const t = useT()
  const bioAvailable = useVault((s) => s.bioAvailable)
  const bioEnabled = useVault((s) => s.bioEnabled)
  const bioKind = useVault((s) => s.bioKind)
  const bioScope = useVault((s) => s.bioScope)
  const setBiometrics = useVault((s) => s.setBiometrics)
  const refreshBiometrics = useVault((s) => s.refreshBiometrics)

  useEffect(() => {
    void refreshBiometrics()
  }, [refreshBiometrics])

  const entries = useVault((s) => s.entries)
  const selectedId = useVault((s) => s.selectedId)
  const lock = useVault((s) => s.lock)
  const addEntry = useVault((s) => s.addEntry)
  const error = useVault((s) => s.error)
  const [changing, setChanging] = useState(false)

  const entry = entries.find((e) => e.id === selectedId) ?? null

  return (
    <div className="main">
      <div className="viewbar">
        <KeyRound size={14} style={{ color: 'var(--accent-ink)' }} />
        <b>{t('vault.browser.title')}</b>
        <span className="server-meta">{t('vault.browser.entryCount', { count: entries.length })}</span>
        <span className="spacer" />
        {bioAvailable && (
          <button
            className={clsx('btn', 'sm', bioEnabled && 'active')}
            title={
              bioEnabled
                ? t('vault.browser.bioStopTitle', { method: BIO_LABEL[bioKind] ?? t('vault.gate.biometrics') })
                : t('vault.browser.bioStartTitle', { method: BIO_LABEL[bioKind] ?? t('vault.gate.biometrics') })
            }
            onClick={() => void setBiometrics(!bioEnabled)}
          >
            <Fingerprint size={13} />{' '}
            {t('vault.browser.bioState', {
              method: BIO_LABEL[bioKind] ?? t('vault.browser.biometricsLabel'),
              state: bioEnabled
                ? bioScope === 'persistent'
                  ? t('vault.browser.bioOnSaved')
                  : t('vault.browser.bioOnSession')
                : t('vault.browser.bioOff')
            })}
          </button>
        )}
        {/* The upgrade had no control at all: `persistent` was implemented,
            tested and reachable only by calling the store by hand, so a user who
            turned this on and then found the password prompt waiting after a
            restart had no way to say "no, keep it". */}
        {bioAvailable && bioEnabled && bioScope === 'session' && (
          <button
            className="btn sm"
            title={t('vault.browser.keepTitle', { method: BIO_LABEL[bioKind] ?? t('vault.gate.biometrics') })}
            onClick={() =>
              void setBiometrics(true, 'persistent').then(
                (ok) => ok && toast(t('vault.browser.keySaved'), 'ok')
              )
            }
          >
            {t('vault.browser.keep')}
          </button>
        )}
        <button className="btn sm" onClick={() => setChanging((v) => !v)}>
          {t('vault.browser.changePassword')}
        </button>
        <button className="btn sm" onClick={() => void addEntry()}>
          <Plus size={13} /> {t('vault.browser.newEntry')}
        </button>
        <button className="btn sm" onClick={() => void lock()}>
          <Lock size={13} /> {t('vault.browser.lock')}
        </button>
      </div>

      <BiometricOffer />
      <KeychainOnly />

      {/* While the change-password form is open it shows the failure beside the
          field that caused it, so the same sentence is not also floated at the
          top of the view, away from anything that can act on it. */}
      {error && !changing && <div className="vault-error" style={{ margin: 12 }}>{error}</div>}
      {changing && <ChangePassword onDone={() => setChanging(false)} />}

      {entry ? (
        <EntryEditor key={entry.id} entry={entry} />
      ) : (
        <div className="faint" style={{ padding: 24, fontSize: 13 }}>
          <Trans i18nKey="vault.browser.empty" components={{ b: <b /> }} />
        </div>
      )}
    </div>
  )
}

function ChangePassword({ onDone }: { onDone: () => void }): React.JSX.Element {
  const t = useT()
  const changePassword = useVault((s) => s.changePassword)
  const clearError = useVault((s) => s.clearError)
  const error = useVault((s) => s.error)
  const busy = useVault((s) => s.busy)
  const bioEnabled = useVault((s) => s.bioEnabled)
  const bioKind = useVault((s) => s.bioKind)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const currentRef = useRef<HTMLInputElement>(null)

  const ready = !busy && current.length > 0 && next.length >= MIN_PASSWORD

  const close = (): void => {
    clearError()
    onDone()
  }

  const save = async (): Promise<void> => {
    if (!ready) return
    if (await changePassword(current, next)) {
      toast(t('vault.changePassword.changed'), 'ok')
      close()
      return
    }
    // "Incorrect current password" is the only failure this form produces in
    // practice, and it is fixed in the field right here — so the cursor goes
    // back to it with the attempt selected rather than the user being told off
    // from somewhere else on the page.
    currentRef.current?.select()
    currentRef.current?.focus()
  }

  return (
    <div className="vault-panel">
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          ref={currentRef}
          type="password"
          autoFocus
          placeholder={t('vault.changePassword.current')}
          value={current}
          onChange={(e) => {
            clearError()
            setCurrent(e.target.value)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <input
          className="input"
          type="password"
          placeholder={t('vault.changePassword.next', { min: MIN_PASSWORD })}
          value={next}
          onChange={(e) => {
            clearError()
            setNext(e.target.value)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <button className="btn primary sm" disabled={!ready} onClick={() => void save()}>
          {t('common.save')}
        </button>
        <button className="btn sm" onClick={close}>
          {t('common.cancel')}
        </button>
      </div>
      {error && <div className="vault-error">{error}</div>}
      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
        {bioEnabled
          ? t('vault.changePassword.noteBio', { method: BIO_LABEL[bioKind] ?? t('vault.changePassword.biometric') })
          : t('vault.changePassword.note')}
      </div>
    </div>
  )
}

function EntryEditor({ entry }: { entry: VaultEntry }): React.JSX.Element {
  const t = useT()
  const update = useVault((s) => s.updateEntry)
  const remove = useVault((s) => s.deleteEntry)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  // What is typed, kept apart from the parsed list. Showing the list back
  // re-joined it on every keystroke, so "prod," became "prod" and a second tag
  // could never be started. Per entry because the editor is keyed by id.
  const [tagsDraft, setTagsDraft] = useState<string | null>(null)

  const set = (patch: Partial<VaultEntry>): void => void update(entry.id, patch)
  const toggle = (id: string): void => setRevealed((r) => ({ ...r, [id]: !r[id] }))

  const setField = (id: string, patch: Partial<(typeof entry.fields)[number]>): void =>
    set({ fields: entry.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) })

  const workspaces = useApp((s) => s.workspaces)
  const shown = VAULT_KIND_FIELDS[entry.kind] ?? VAULT_KIND_FIELDS.login

  // A value that belongs to a field this kind does not show is still stored and
  // still searchable, but it is now invisible — so say so rather than let it
  // look lost.
  const hiddenWithValue = hiddenFieldsFor(entry)

  return (
    <div className="vault-editor">
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1, fontWeight: 600 }}
          value={entry.name}
          placeholder={t('vault.editor.namePlaceholder')}
          onChange={(e) => set({ name: e.target.value })}
        />
        <select className="input" value={entry.kind} onChange={(e) => set({ kind: e.target.value as VaultKind })}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {VAULT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <button
          className="btn sm danger"
          title={t('vault.editor.deleteTitle')}
          onClick={() => {
            // Same question the sidebar asks. Two delete paths that disagree
            // about whether this is confirmable is worse than either.
            if (
              !window.confirm(t('vault.entry.confirmDelete', { name: entry.name }))
            ) {
              return
            }
            remove(entry.id)
            toast(t('vault.editor.deleted', { name: entry.name }))
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {shown.url && (
        <Row label={t('vault.editor.url')} value={entry.url} onChange={(v) => set({ url: v })} placeholder="https://…" />
      )}
      {shown.username && (
        <Row label={t('vault.editor.username')} value={entry.username} onChange={(v) => set({ username: v })} />
      )}
      {shown.keys && (
        <>
          <Multiline
            label={t('vault.editor.privateKey')}
            value={entry.privateKey ?? ''}
            onChange={(v) => set({ privateKey: v })}
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
            secret
            revealed={!!revealed.__privkey}
            onReveal={() => toggle('__privkey')}
          />
          <Multiline
            label={t('vault.editor.publicKey')}
            value={entry.publicKey ?? ''}
            onChange={(v) => set({ publicKey: v })}
            placeholder="ssh-ed25519 AAAA… user@server"
          />
        </>
      )}
      {shown.secret && (
        <Row
          label={VAULT_SECRET_LABEL[shown.secret]}
          value={entry.password}
          onChange={(v) => set({ password: v })}
          secret
          revealed={!!revealed.__pw}
          onReveal={() => toggle('__pw')}
        />
      )}
      <div className="row" style={{ gap: 6 }}>
        <span className="vault-label">{t('vault.editor.workspace')}</span>
        <select
          className="input"
          style={{ flex: 1 }}
          value={entry.workspaceId ?? ''}
          onChange={(e) => set({ workspaceId: e.target.value || undefined })}
        >
          <option value="">{t('vault.editor.sharedOption')}</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      <Row
        label={t('vault.editor.tags')}
        value={tagsDraft ?? entry.tags.join(', ')}
        onChange={(v) => {
          setTagsDraft(v)
          set({ tags: v.split(',').map((t) => t.trim()).filter(Boolean) })
        }}
        placeholder="prod, aws"
      />

      {hiddenWithValue.length > 0 && (
        <div className="s-desc" style={{ marginTop: 8 }}>
          {t('vault.editor.hiddenFields', {
            fields: hiddenWithValue.join(' and '),
            kind: VAULT_KIND_LABEL[entry.kind].toLowerCase()
          })}
        </div>
      )}

      <div className="vault-section-title">
        {t('vault.editor.customFields')}
        <button className="btn sm" onClick={() => set({ fields: [...entry.fields, newField()] })}>
          <Plus size={13} /> {t('vault.editor.addField')}
        </button>
      </div>

      {entry.fields.map((f) => (
        <div className="row" key={f.id} style={{ gap: 6 }}>
          <input
            className="input"
            style={{ width: 170 }}
            placeholder={t('vault.editor.fieldKey')}
            value={f.key}
            onChange={(e) => setField(f.id, { key: e.target.value })}
          />
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={t('vault.editor.fieldValue')}
            type={f.secret && !revealed[f.id] ? 'password' : 'text'}
            value={f.value}
            onChange={(e) => setField(f.id, { value: e.target.value })}
          />
          <button
            className="icon-btn sm"
            title={f.secret ? t('vault.editor.markedSecret') : t('vault.editor.markSecret')}
            onClick={() => setField(f.id, { secret: !f.secret })}
          >
            {f.secret ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
          {f.secret && (
            <button className="icon-btn sm" title={t('vault.editor.reveal')} onClick={() => toggle(f.id)}>
              {revealed[f.id] ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          )}
          <button
            className="icon-btn sm"
            title={t('vault.editor.copyValue')}
            onClick={() => copy(f.key || t('vault.editor.valueLabel'), f.value)}
          >
            <Copy size={14} />
          </button>
          <button
            className="icon-btn sm"
            title={t('vault.editor.removeField')}
            onClick={() => set({ fields: entry.fields.filter((x) => x.id !== f.id) })}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      <div className="vault-section-title">{t('vault.editor.notes')}</div>
      <textarea
        className="textarea"
        style={{ width: '100%', minHeight: 90 }}
        value={entry.notes}
        spellCheck={false}
        onChange={(e) => set({ notes: e.target.value })}
      />

      <div className="faint" style={{ fontSize: 11 }}>
        {t('vault.editor.updated', { when: new Date(entry.updatedAt).toLocaleString() })}
      </div>
    </div>
  )
}

// PEM material is many lines long and unusable in a single-line input, which
// is why storing the key itself was never practical before.
function Multiline({
  label,
  value,
  onChange,
  placeholder,
  secret,
  revealed,
  onReveal
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  secret?: boolean
  revealed?: boolean
  onReveal?: () => void
}): React.JSX.Element {
  const t = useT()
  const masked = secret && !revealed && value.length > 0
  return (
    <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
      <span className="vault-label" style={{ paddingTop: 8 }}>
        {label}
      </span>
      <textarea
        className="input mono"
        style={{ flex: 1, minHeight: 96, resize: 'vertical', lineHeight: 1.4 }}
        spellCheck={false}
        placeholder={placeholder}
        // A revealed key is shown verbatim; a hidden one shows its shape, so
        // you can tell an entry holds a key without exposing it on screen.
        value={masked ? t('vault.editor.linesHidden', { count: value.split('\n').length }) : value}
        readOnly={masked}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="col" style={{ gap: 4 }}>
        {secret && (
          <button className="icon-btn sm" title={t('vault.editor.reveal')} onClick={onReveal}>
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
        <button className="icon-btn sm" title={t('vault.editor.copyLabel', { label: label.toLowerCase() })} onClick={() => copy(label, value)}>
          <Copy size={14} />
        </button>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  onChange,
  placeholder,
  secret,
  revealed,
  onReveal
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  secret?: boolean
  revealed?: boolean
  onReveal?: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="vault-label">{label}</span>
      <input
        className="input"
        style={{ flex: 1 }}
        type={secret && !revealed ? 'password' : 'text'}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {secret && (
        <button className="icon-btn sm" title={t('vault.editor.reveal')} onClick={onReveal}>
          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      )}
      <button className="icon-btn sm" title={t('vault.editor.copyLabel', { label: label.toLowerCase() })} onClick={() => copy(label, value)}>
        <Copy size={14} />
      </button>
    </div>
  )
}
