import { useCallback, useEffect, useState } from 'react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'
import {
  CRED_PROXY_LOOPBACK_NOTE,
  CRED_PROXY_TOKEN_HEADER,
  CRED_PROXY_TOKEN_NOTE,
  CRED_PROXY_TOKEN_STATE_NOTE,
  credProxyTokenState,
  type CredProxyToken,
  credProxyBaseUrl,
  describeInjection
} from '../../../../shared/credproxy'
import type {
  CredProxyCall,
  CredProxyInjectionKind,
  CredProxyRule,
  CredProxySlot,
  CredProxyStatus
} from '../../../../shared/credproxy'
import type { VaultEntry } from '../../../../shared/vault'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import { Switch } from '../common/Switch'

// The API credential proxy — roadmap item 7, settings half.
//
// What this pane has to make true, beyond letting someone type a rule:
//
//  * The TOKEN's power is stated where the token is, in the sentence next to
//    the copy button, not in a docs page. A token whose holder has not been
//    told what it grants is a token that ends up in a chat window.
//  * "It is only on loopback" is not a permission, and the pane says so —
//    every process running as this user can reach the port.
//  * A rule reads as a SENTENCE about where a credential goes, because that is
//    the thing being authorised. "Billing API — https://api.stripe.com, key
//    from Stripe live key, sent as Authorization: Bearer."
//  * The recent calls are visible here rather than in a separate log, because
//    a rule that quietly stopped matching looks exactly like a rule that is
//    working until you look at whether anything went through it.

type Tone = 'ok' | 'warn' | 'danger'

const INJECTIONS: {
  kind: CredProxyInjectionKind
  labelKey: MessageKey
  needsKey: MessageKey | null
}[] = [
  { kind: 'bearer', labelKey: 'settings.credProxy.injection.bearer', needsKey: null },
  {
    kind: 'header',
    labelKey: 'settings.credProxy.injection.header',
    needsKey: 'settings.credProxy.injection.needsHeader'
  },
  {
    kind: 'query',
    labelKey: 'settings.credProxy.injection.query',
    needsKey: 'settings.credProxy.injection.needsParameter'
  },
  {
    kind: 'basic',
    labelKey: 'settings.credProxy.injection.basic',
    needsKey: 'settings.credProxy.injection.needsUsername'
  }
]

const SLOTS: { slot: CredProxySlot; labelKey: MessageKey }[] = [
  { slot: 'password', labelKey: 'settings.credProxy.slot.password' },
  { slot: 'privateKey', labelKey: 'settings.credProxy.slot.privateKey' },
  { slot: 'username', labelKey: 'settings.credProxy.slot.username' },
  { slot: 'field', labelKey: 'settings.credProxy.slot.field' }
]

interface Draft {
  id?: string
  name: string
  origin: string
  vaultEntryId: string
  slot: CredProxySlot
  fieldKey: string
  kind: CredProxyInjectionKind
  injectionName: string
}

const emptyDraft = (): Draft => ({
  name: '',
  origin: '',
  vaultEntryId: '',
  slot: 'password',
  fieldKey: '',
  kind: 'bearer',
  injectionName: ''
})

export function CredProxyPanel(): React.JSX.Element {
  const t = useT()
  const [status, setStatus] = useState<CredProxyStatus | null>(null)
  // `null` until read. The sentence this guards is REASSURING -- "the proxy
  // will refuse everything, that is the safe state" -- and a false reassurance
  // is worse than a false alarm: it tells an operator the credential proxy is
  // locked down at a moment when it may hold permissive rules nobody has
  // fetched yet.
  const [rules, setRules] = useState<CredProxyRule[] | null>(null)
  // And the case that would otherwise wait forever: no channel means no rules
  // are coming, which is a definite answer rather than a pending one.
  const [unavailable, setUnavailable] = useState(false)
  const [calls, setCalls] = useState<CredProxyCall[]>([])
  const [entries, setEntries] = useState<VaultEntry[]>([])
  // `null` until read, like every other list in this app that says an absence.
  const [tokens, setTokens] = useState<CredProxyToken[] | null>(null)
  const [newTokenName, setNewTokenName] = useState('')
  const [newTokenExpiry, setNewTokenExpiry] = useState('')

  const loadTokens = useCallback(async (): Promise<void> => {
    const list = await window.opsmaxx?.credproxy?.tokens?.()
    setTokens(list ?? [])
  }, [])

  const createToken = async (): Promise<void> => {
    const res = await window.opsmaxx?.credproxy?.createToken?.(
      newTokenName.trim(),
      // A date input gives a day, and a token should last to the END of the day
      // it names rather than expiring at midnight as somebody starts work.
      newTokenExpiry === '' ? null : new Date(`${newTokenExpiry}T23:59:59Z`).toISOString()
    )
    if (res?.ok && res.token) {
      await navigator.clipboard?.writeText(res.token).catch(() => {})
      setMsg({
        tone: 'ok',
        text: t('settings.credProxy.token.created', { name: newTokenName.trim() })
      })
      setNewTokenName('')
      setNewTokenExpiry('')
      await loadTokens()
    } else {
      setMsg({ tone: 'danger', text: res?.error ?? t('settings.credProxy.token.createFailed') })
    }
  }

  const copyToken = async (id: string): Promise<void> => {
    const value = await window.opsmaxx?.credproxy?.tokenValue?.(id)
    if (value) {
      await navigator.clipboard?.writeText(value).catch(() => {})
      setMsg({ tone: 'ok', text: t('settings.credProxy.token.copied') })
    } else {
      setMsg({ tone: 'danger', text: t('settings.credProxy.token.unreadable') })
    }
  }

  const revokeToken = async (id: string, name: string): Promise<void> => {
    // Revoking is not reversible and stops whatever holds it, so it asks --
    // and names the token, so the answer is to a question rather than a reflex.
    if (!window.confirm(t('settings.credProxy.token.revokeConfirm', { name }))) {
      return
    }
    const res = await window.opsmaxx?.credproxy?.revokeToken?.(id)
    if (res?.ok) {
      setMsg({ tone: 'ok', text: t('settings.credProxy.token.revoked', { name }) })
      await loadTokens()
    } else {
      setMsg({ tone: 'danger', text: res?.error ?? t('settings.credProxy.token.revokeFailed') })
    }
  }
  const [draft, setDraft] = useState<Draft | null>(null)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const [portDraft, setPortDraft] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const api = window.opsmaxx?.credproxy
    if (!api) {
      setUnavailable(true)
      return
    }
    setUnavailable(false)
    const [s, r, c] = await Promise.all([api.status(), api.rules(), api.calls(50)])
    if (s) {
      setStatus(s)
      setPortDraft(String(s.port))
    }
    if (r) setRules(r)
    if (c) setCalls(c)
  }, [])

  useEffect(() => {
    void refresh()
    void loadTokens()
  }, [refresh, loadTokens])

  // The vault list is read only to name entries in the picker. Its VALUES are
  // never used here — a rule stores an entry id, and main reads the credential
  // at request time.
  useEffect(() => {
    void window.opsmaxx?.vault?.list().then((res) => {
      if (res?.ok && res.entries) setEntries(res.entries)
    })
  }, [])

  // Polled while the pane is open. Calls happen on the proxy's own path, which
  // has nothing to tell a settings screen, and they move on the order of a
  // request rather than a frame. The interval dies with the pane.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  const toggle = async (on: boolean): Promise<void> => {
    setMsg(null)
    const api = window.opsmaxx?.credproxy
    if (!api) return
    if (!on) {
      const s = await api.stop()
      if (s) setStatus(s)
      return
    }
    const port = Number(portDraft)
    const res = await api.start(Number.isInteger(port) && port > 0 ? port : undefined)
    if (!res) return
    if (res.status) setStatus(res.status)
    if (!res.ok) setMsg({ tone: 'danger', text: res.error ?? t('settings.credProxy.startFailed') })
  }



  const save = async (): Promise<void> => {
    if (!draft) return
    setMsg(null)
    const res = await window.opsmaxx?.credproxy?.saveRule({
      id: draft.id,
      name: draft.name,
      origin: draft.origin,
      credential: {
        vaultEntryId: draft.vaultEntryId,
        slot: draft.slot,
        ...(draft.slot === 'field' ? { fieldKey: draft.fieldKey } : {})
      },
      injection: { kind: draft.kind, name: draft.injectionName },
      enabled: true
    })
    if (!res) return
    if (!res.ok) {
      setMsg({ tone: 'danger', text: res.error })
      return
    }
    setDraft(null)
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    await window.opsmaxx?.credproxy?.removeRule(id)
    await refresh()
  }

  const entryName = (id: string): string =>
    entries.find((e) => e.id === id)?.name ?? t('settings.credProxy.entryMissing')

  const needsKey = INJECTIONS.find((i) => i.kind === draft?.kind)?.needsKey
  const needs = needsKey ? t(needsKey) : null

  return (
    <div className="credproxy-panel">
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.credProxy.title')}</div>
          <div className="s-desc">
            {t('settings.credProxy.descIntro')}
            <br />
            {t('settings.credProxy.descOptIn')}
          </div>
        </div>
        <Switch
          checked={!!status?.listening}
          label={t('settings.credProxy.switchLabel')}
          onChange={(v) => void toggle(v)}
        />
      </div>

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.credProxy.port.title')}</div>
          <div className="s-desc">
            {status?.address
              ? t('settings.credProxy.port.listening', { address: status.address })
              : t('settings.credProxy.port.notListening')}{' '}
            {CRED_PROXY_LOOPBACK_NOTE}
          </div>
        </div>
        <input
          className="input"
          style={{ width: 90 }}
          aria-label={t('settings.credProxy.port.aria')}
          value={portDraft}
          onChange={(e) => setPortDraft(e.target.value)}
          onBlur={() => {
            if (status?.listening) void toggle(true)
          }}
        />
      </div>

      {status?.parked && (
        <div className="s-note warn" role="status">
          {status.parked.reason === 'vault-locked'
            ? (
                <>
                  {t('settings.credProxy.parked.vaultLocked', {
                    count: status.parked.calls,
                    time: new Date(status.parked.since).toLocaleTimeString()
                  })}{' '}
                  <UnlockVaultButton reason={t('settings.credProxy.parked.unlockReason')} />
                </>
              )
            : t('settings.credProxy.parked.entryEmpty', {
                count: status.parked.calls,
                time: new Date(status.parked.since).toLocaleTimeString()
              })}
        </div>
      )}

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.credProxy.tokens.title')}</div>
          <div className="s-desc">
            <Trans
              i18nKey="settings.credProxy.tokens.header"
              values={{ header: CRED_PROXY_TOKEN_HEADER }}
              components={{ code: <code /> }}
            />{' '}
            {CRED_PROXY_TOKEN_NOTE}
            <br />
            {t('settings.credProxy.tokens.perCaller')}
          </div>
        </div>
        <div className="row-actions">
          <input
            className="input"
            placeholder={t('settings.credProxy.tokens.namePlaceholder')}
            aria-label={t('settings.credProxy.tokens.nameAria')}
            value={newTokenName}
            onChange={(e) => setNewTokenName(e.target.value)}
            style={{ width: 190 }}
          />
          <input
            className="input"
            type="date"
            aria-label={t('settings.credProxy.tokens.expiryAria')}
            title={t('settings.credProxy.tokens.expiryTitle')}
            value={newTokenExpiry}
            onChange={(e) => setNewTokenExpiry(e.target.value)}
            style={{ width: 150 }}
          />
          <button className="btn primary" disabled={newTokenName.trim() === ''} onClick={() => void createToken()}>
            {t('settings.credProxy.tokens.create')}
          </button>
        </div>
      </div>

      {tokens === null ? (
        <div className="s-note state-unknown">{t('settings.credProxy.tokens.reading')}</div>
      ) : tokens.length === 0 ? (
        <div className="s-note">{t('settings.credProxy.tokens.none')}</div>
      ) : (
        <ul className="credproxy-rules">
          {tokens.map((tok) => {
            const state = credProxyTokenState(tok, Date.now())
            return (
              <li key={tok.id} className="credproxy-rule">
                <div>
                  <div className="r-title">
                    {tok.name}{' '}
                    <span className={clsx(state === 'active' ? 'ok' : 'state-unknown')}>
                      · {t(`settings.credProxy.tokens.state.${state}`)}
                    </span>
                  </div>
                  <div className="r-sub">
                    {tok.expiresAt
                      ? t('settings.credProxy.tokens.ends', {
                          date: new Date(tok.expiresAt).toLocaleDateString()
                        })
                      : t('settings.credProxy.tokens.noEnd')}
                    {' · '}
                    {/* The only thing that makes an unused token safe to revoke,
                        and the only reason anybody ever does. */}
                    {tok.lastUsedAt
                      ? t('settings.credProxy.tokens.lastUsed', {
                          when: new Date(tok.lastUsedAt).toLocaleString()
                        })
                      : t('settings.credProxy.tokens.neverUsed')}
                  </div>
                  <div className="r-sub faint">{CRED_PROXY_TOKEN_STATE_NOTE[state]}</div>
                </div>
                <div className="row-actions">
                  {state === 'active' && (
                    <>
                      <button className="btn sm" onClick={() => void copyToken(tok.id)}>
                        {t('common.copy')}
                      </button>
                      <button className="btn sm danger outline" onClick={() => void revokeToken(tok.id, tok.name)}>
                        {t('settings.credProxy.tokens.revoke')}
                      </button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {msg && (
        <div className={clsx('s-note', msg.tone)} role="status">
          {msg.text}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.credProxy.rules.title')}</div>
          <div className="s-desc">{t('settings.credProxy.rules.desc')}</div>
        </div>
        <button className="btn" onClick={() => setDraft(emptyDraft())}>
          {t('settings.credProxy.rules.add')}
        </button>
      </div>

      {unavailable && (
        <div className="s-note state-unknown">{t('settings.credProxy.rules.unavailable')}</div>
      )}

      {!unavailable && rules === null && !draft && (
        <div className="s-note state-unknown">{t('settings.credProxy.rules.reading')}</div>
      )}

      {rules?.length === 0 && !draft && (
        <div className="s-note">{t('settings.credProxy.rules.none')}</div>
      )}

      <ul className="credproxy-rules">
        {(rules ?? []).map((r) => (
          <li key={r.id} className="credproxy-rule">
            <div>
              <div className="rule-name">{r.name}</div>
              <div className="rule-detail">
                {t(r.enabled ? 'settings.credProxy.rules.detail' : 'settings.credProxy.rules.detailOff', {
                  origin: r.origin,
                  entry: entryName(r.credential.vaultEntryId),
                  injection: describeInjection(r.injection)
                })}
              </div>
              {status?.listening && (
                <div className="rule-detail">
                  <Trans
                    i18nKey="settings.credProxy.rules.pointClient"
                    values={{ url: credProxyBaseUrl(status.port, r.origin) }}
                    components={{ code: <code /> }}
                  />
                </div>
              )}
            </div>
            <div className="row-actions">
              <button
                className="btn"
                onClick={() =>
                  setDraft({
                    id: r.id,
                    name: r.name,
                    origin: r.origin,
                    vaultEntryId: r.credential.vaultEntryId,
                    slot: r.credential.slot,
                    fieldKey: r.credential.fieldKey ?? '',
                    kind: r.injection.kind,
                    injectionName: r.injection.name ?? ''
                  })
                }
              >
                {t('common.edit')}
              </button>
              <button className="btn danger outline" onClick={() => void remove(r.id)}>
                {t('common.remove')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {draft && (
        <div className="credproxy-draft">
          <input
            className="input"
            aria-label={t('settings.credProxy.draft.nameAria')}
            placeholder={t('settings.credProxy.draft.namePlaceholder')}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className="input"
            aria-label={t('settings.credProxy.draft.destinationAria')}
            placeholder="https://api.example.com"
            value={draft.origin}
            onChange={(e) => setDraft({ ...draft, origin: e.target.value })}
          />
          <div className="s-desc">{t('settings.credProxy.draft.originHint')}</div>
          <select
            className="input"
            aria-label={t('settings.credProxy.draft.vaultEntryAria')}
            value={draft.vaultEntryId}
            onChange={(e) => setDraft({ ...draft, vaultEntryId: e.target.value })}
          >
            <option value="">{t('settings.credProxy.draft.chooseEntry')}</option>
            {entries.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label={t('settings.credProxy.draft.slotAria')}
            value={draft.slot}
            onChange={(e) => setDraft({ ...draft, slot: e.target.value as CredProxySlot })}
          >
            {SLOTS.map((s) => (
              <option key={s.slot} value={s.slot}>
                {t(s.labelKey)}
              </option>
            ))}
          </select>
          {draft.slot === 'field' && (
            <input
              className="input"
              aria-label={t('settings.credProxy.draft.fieldNameAria')}
              placeholder="publishable_key"
              value={draft.fieldKey}
              onChange={(e) => setDraft({ ...draft, fieldKey: e.target.value })}
            />
          )}
          <select
            className="input"
            aria-label={t('settings.credProxy.draft.injectionAria')}
            value={draft.kind}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as CredProxyInjectionKind })
            }
          >
            {INJECTIONS.map((i) => (
              <option key={i.kind} value={i.kind}>
                {t(i.labelKey)}
              </option>
            ))}
          </select>
          {needs && (
            <input
              className="input"
              aria-label={needs}
              placeholder={needs}
              value={draft.injectionName}
              onChange={(e) => setDraft({ ...draft, injectionName: e.target.value })}
            />
          )}
          <div className="row-actions">
            <button className="btn primary" onClick={() => void save()}>
              {t('settings.credProxy.draft.save')}
            </button>
            <button className="btn" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}

      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settings.credProxy.calls.title')}</div>
          <div className="s-desc">{t('settings.credProxy.calls.desc')}</div>
        </div>
      </div>

      {calls.length === 0 ? (
        <div className="s-note">{t('settings.credProxy.calls.none')}</div>
      ) : (
        <ul className="credproxy-calls">
          {calls.map((c) => (
            <li key={c.id} className={clsx('credproxy-call', c.outcome !== 'forwarded' && 'refused')}>
              <span className="call-method">{c.method}</span>
              <span className="call-target">
                {c.origin}
                {c.path}
              </span>
              <span className="call-outcome">
                {c.outcome === 'forwarded' ? `${c.status}` : c.outcome}
              </span>
              <span className="call-rule">{c.ruleName ?? t('settings.credProxy.calls.noRule')}</span>
              <span className="call-ms">{c.ms} ms</span>
              {c.detail && <span className="call-detail">{c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
