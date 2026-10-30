import { useState } from 'react'
import { Field, Modal } from '../common/Modal'
import { useWorkspaceServers, useWorkspaceVpns, useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { maskToken } from '../../../../shared/tokenDisplay'
import { withoutVaultMarker } from '../../lib/withVaultUnlock'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'
import type { CicdBridge, CicdConnection, CicdProvider, CicdRoute } from '../../../../shared/cicd'

/**
 * Connect a CI account. ONE modal, progressively revealed.
 *
 * Not a wizard, and the reason stands on its own rather than citing another
 * file's: this is ONE form with three provider variants, and the provider choice
 * changes exactly three things — the URL placeholder, the token help block, and
 * what Verify probes. Split into steps it would be three screens of the same
 * fields. The shape: a `.segment` picker, a hint line that changes with the
 * choice, then `Field`s.
 *
 * (It used to cite the first-run card as precedent. That card is now six screens,
 * for reasons that are about four unrelated questions rather than one form — so
 * the citation would have inverted itself, which is what cross-references do.)
 *
 * Verify dials, reports, and saves nothing, exactly like
 * `AddServerModal.testConnection`. A token that can read but not start a build
 * SUCCEEDS PARTIALLY: read-only is a legitimate way to use this module, and a
 * form that treats it as a failure is a form that tells the user to hand over
 * more access than they wanted to.
 *
 * THIS COMPONENT NEVER STORES THE TOKEN. It hands it to `onSave` alongside the
 * connection and forgets it; `CicdConnection.vaultEntryId` is filled in by
 * whoever writes the vault entry. This module is forbidden from importing
 * `store/vault` or the `vault`/`secrets` bridge namespaces
 * (`MODULE_FORBIDDEN_IMPORTS`), which is the mechanical half of the same rule.
 */

interface Scope {
  name: string
  whyKey: MessageKey
}

interface ProviderDef {
  id: CicdProvider
  label: string
  placeholder: string
  /**
   * The URL this provider has for everyone, filled in ready to be used.
   *
   * `null` for Jenkins, and that is the point of the field rather than an
   * omission: every Jenkins lives at an address only its admin knows, so a
   * default there would be a guess presented as an answer. GitHub and GitLab
   * each have exactly one public host, and making somebody type
   * `https://github.com` before they can paste a token is a step with no
   * decision in it. Enterprise users overwrite it, which is one edit either way.
   */
  defaultUrl: string | null
  /** What the URL field means for this provider — all three differ. */
  urlHintKey: MessageKey
  /** Jenkins authenticates as a user; the other two carry identity in the token. */
  needsUsername: boolean
  /** `null` where the provider HAS no scopes. Not an empty checklist. */
  scopes: Scope[] | null
  /** Where the token is made. `base` is whatever the user has typed so far. */
  tokenUrl: (base: string) => string
  tokenLinkLabelKey: MessageKey
  /** The honest caveat about what that link does and does not do. */
  linkNoteKey: MessageKey
  /** What the Verify button actually asks for. */
  verifyNoteKey: MessageKey
  /** Scope that only reads. Absent where the concept does not apply. */
  readScope?: string
  /** Scope that can start a run. */
  writeScope?: string
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'github',
    label: 'GitHub Actions',
    placeholder: 'https://github.com',
    defaultUrl: 'https://github.com',
    urlHintKey: 'cicd.connect.github.urlHint',
    needsUsername: false,
    scopes: [
      { name: 'repo', whyKey: 'cicd.connect.github.scopeRepo' },
      { name: 'workflow', whyKey: 'cicd.connect.github.scopeWorkflow' }
    ],
    tokenUrl: (base) =>
      `${trimSlash(base) || 'https://github.com'}/settings/tokens/new?scopes=repo,workflow&description=OpsMaxx`,
    tokenLinkLabelKey: 'cicd.connect.github.tokenLink',
    linkNoteKey: 'cicd.connect.github.linkNote',
    verifyNoteKey: 'cicd.connect.github.verifyNote',
    readScope: 'repo',
    writeScope: 'workflow'
  },
  {
    id: 'gitlab',
    label: 'GitLab CI',
    placeholder: 'https://gitlab.com',
    defaultUrl: 'https://gitlab.com',
    urlHintKey: 'cicd.connect.gitlab.urlHint',
    needsUsername: false,
    scopes: [
      { name: 'read_api', whyKey: 'cicd.connect.gitlab.scopeReadApi' },
      { name: 'api', whyKey: 'cicd.connect.gitlab.scopeApi' }
    ],
    tokenUrl: (base) =>
      `${trimSlash(base) || 'https://gitlab.com'}/-/user_settings/personal_access_tokens?name=OpsMaxx&scopes=read_api`,
    tokenLinkLabelKey: 'cicd.connect.gitlab.tokenLink',
    linkNoteKey: 'cicd.connect.gitlab.linkNote',
    verifyNoteKey: 'cicd.connect.gitlab.verifyNote',
    readScope: 'read_api',
    writeScope: 'api'
  },
  {
    id: 'jenkins',
    label: 'Jenkins',
    placeholder: 'https://jenkins.example.internal',
    // No default, deliberately. See `defaultUrl`.
    defaultUrl: null,
    urlHintKey: 'cicd.connect.jenkins.urlHint',
    needsUsername: true,
    // Deliberately null, and the UI says so instead of drawing an empty list.
    scopes: null,
    tokenUrl: (base) => `${trimSlash(base)}/me/security`,
    tokenLinkLabelKey: 'cicd.connect.jenkins.tokenLink',
    linkNoteKey: 'cicd.connect.jenkins.linkNote',
    verifyNoteKey: 'cicd.connect.jenkins.verifyNote'
  }
]

function trimSlash(s: string): string {
  return s.trim().replace(/\/+$/, '')
}

const defaultUrlFor = (id: CicdProvider): string | null =>
  PROVIDERS.find((p) => p.id === id)?.defaultUrl ?? null

/** Whether this is still one of the prefills rather than something typed. */
const isDefaultUrl = (url: string): boolean =>
  PROVIDERS.some((p) => p.defaultUrl !== null && p.defaultUrl === trimSlash(url))

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'dialling' }
  | { kind: 'ok'; identity: string; scopes?: string[]; expiresAt?: number }
  | { kind: 'failed'; error: string }

export function CicdConnectModal({
  onClose,
  onSave,
  editing,
  existingNames,
  bridge
}: {
  onClose: () => void
  /**
   * Persist the account and its token. Absent in a build where nothing can
   * store a credential yet, and the Save button then says so on itself rather
   * than silently doing nothing.
   */
  onSave?: (connection: CicdConnection, token: string) => void | Promise<void>
  editing?: CicdConnection
  /**
   * Names already taken, so a second account cannot shadow the first.
   *
   * Not cosmetic, and not a nicety about tidy lists: an AI agent addresses a CI
   * account BY NAME and by nothing else — `resolveCicdOrError` in
   * `src/main/services/mcpServer.ts` lowercases and matches on it, and refuses
   * when more than one matches. Two accounts sharing a name therefore make BOTH
   * of them unreachable from every agent tool, which is a failure that shows up
   * nowhere near this form. The caller passes the workspace's other names; the
   * editing account's own is excluded by the caller, so re-saving without a
   * rename is not an error.
   */
  existingNames?: readonly string[]
  bridge?: CicdBridge
}): React.JSX.Element {
  const t = useT()
  const servers = useWorkspaceServers()
  const vpns = useWorkspaceVpns()
  const workspaceId = useApp((s) => s.activeWorkspaceId)

  const [provider, setProvider] = useState<CicdProvider>(editing?.provider ?? 'github')
  const [name, setName] = useState(editing?.name ?? '')
  // Prefilled for the SaaS providers on a new account. An account being edited
  // keeps its own URL whatever it is, including an empty one.
  const [baseUrl, setBaseUrl] = useState(
    editing?.baseUrl ?? defaultUrlFor(PROVIDERS[0].id) ?? ''
  )
  const [username, setUsername] = useState(editing?.username ?? '')
  // Always empty on open, including when editing. A masked value in a password
  // field is a value the form would have to round-trip, and this module never
  // holds the token long enough to round-trip anything.
  const [token, setToken] = useState('')
  const [routeKind, setRouteKind] = useState<CicdRoute['kind']>(editing?.route.kind ?? 'direct')
  const [serverId, setServerId] = useState(
    editing?.route.kind === 'server' ? editing.route.serverId : ''
  )
  const [vpnProfileId, setVpnProfileId] = useState(
    editing?.route.kind === 'vpn' ? editing.route.vpnProfileId : ''
  )
  const [insecureTls, setInsecureTls] = useState(editing?.insecureTls === true)
  const [verify, setVerify] = useState<VerifyState>({ kind: 'idle' })
  // Saving has its own two states because it can fail, and used to fail in
  // silence: the confirm handler was `.then(onClose)` with no `.catch`, so a
  // rejected save left the button pressed, the modal open and nothing said. The
  // most likely rejection is the most invisible one -- a locked vault, which
  // `createSecret` refuses by design.
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const def = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0]

  const route: CicdRoute =
    routeKind === 'server' && serverId
      ? { kind: 'server', serverId }
      : routeKind === 'vpn' && vpnProfileId
        ? { kind: 'vpn', vpnProfileId }
        : { kind: 'direct' }

  // Only ever the FIRST thing missing: a form that lights up four errors at
  // once is a form nobody reads. Same rule as `missingField` in AddServerModal.
  const missing =
    name.trim() === ''
      ? t('cicd.connect.missing.name')
      : existingNames?.some((n) => n.toLowerCase() === name.trim().toLowerCase())
        ? t('cicd.connect.missing.duplicateName')
        : baseUrl.trim() === ''
          ? t('cicd.connect.missing.url')
          : def.needsUsername && username.trim() === ''
            ? t('cicd.connect.missing.username')
            : token.trim() === ''
              ? t('cicd.connect.missing.token')
              : routeKind === 'server' && !serverId
                ? t('cicd.connect.missing.server')
                : routeKind === 'vpn' && !vpnProfileId
                  ? t('cicd.connect.missing.vpn')
                  : null

  const draft = (): CicdConnection => ({
    id: editing?.id ?? `cicd-${Date.now().toString(36)}`,
    workspaceId: editing?.workspaceId ?? workspaceId,
    name: name.trim(),
    provider,
    baseUrl: trimSlash(baseUrl),
    username: def.needsUsername ? username.trim() : undefined,
    // Filled in by whoever writes the vault entry. Empty here is the honest
    // value: this component has not stored anything.
    vaultEntryId: editing?.vaultEntryId ?? '',
    route,
    caPem: editing?.caPem,
    insecureTls: insecureTls ? true : undefined,
    enabled: editing?.enabled ?? true
  })

  const runVerify = async (): Promise<void> => {
    if (missing || !bridge) return
    setVerify({ kind: 'dialling' })
    try {
      const r = await bridge.verify(draft(), token)
      setVerify(
        r.ok
          ? { kind: 'ok', identity: r.identity, scopes: r.scopes, expiresAt: r.expiresAt }
          : { kind: 'failed', error: r.error }
      )
    } catch (e) {
      setVerify({ kind: 'failed', error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Modal
      title={editing ? t('cicd.connect.editTitle', { name: editing.name }) : t('cicd.connect.title')}
      subtitle={t('cicd.connect.subtitle')}
      size="lg"
      onClose={onClose}
      footerNote={
        <>
          {missing && <span className="field-hint danger">{missing}</span>}
          {/* A failed save outranks the verify note: it is the newer fact, and
              the two describe different halves of the same button press. */}
          {saveError !== null ? (
            <span className="field-hint danger">{saveError}</span>
          ) : (
            !missing && <VerifyNote state={verify} def={def} />
          )}
        </>
      }
      footer={
        <button
          className="btn secondary size-28"
          disabled={missing !== null || verify.kind === 'dialling' || !bridge}
          // The reason lives ON the control. An option that goes grey with no
          // explanation is a form the user has to guess at.
          title={
            !bridge
              ? t('cicd.connect.noBridge')
              : t(def.verifyNoteKey)
          }
          onClick={() => void runVerify()}
        >
          {verify.kind === 'dialling' ? t('cicd.connect.verifying') : t('cicd.connect.verify')}
        </button>
      }
      confirm={{
        label: saving ? t('common.saving') : editing ? t('common.save') : t('cicd.connect.connect'),
        // `onSave` is optional only so a test can render this without a store.
        // The panel always supplies one; a build where it does not is a build
        // where nothing could be saved, and that is worth failing loudly in a
        // test rather than quietly grey on screen.
        disabled: missing !== null || !onSave || saving,
        onClick: () => {
          if (missing || !onSave || saving) return
          setSaveError(null)
          setSaving(true)
          void Promise.resolve(onSave(draft(), token))
            .then(onClose)
            .catch((err: unknown) => {
              // Only on the failure path: the success path has unmounted this
              // component, and setting state there is a warning about nothing.
              setSaving(false)
              // The marker is how the renderer recognises a locked vault
              // without matching an English sentence. Nobody should read it.
              setSaveError(withoutVaultMarker(err instanceof Error ? err.message : String(err)))
            })
        }
      }}
    >
      <div className="segment modal-segment">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={clsx('seg-btn', provider === p.id && 'active')}
            onClick={() => {
              setProvider(p.id)
              // A verify result belongs to the provider it was taken against.
              setVerify({ kind: 'idle' })
              // Swap the prefill, but never a URL the user typed. Only a field
              // that is empty or still holds ANOTHER provider's default is
              // replaced -- so switching github → gitlab → github is free, and
              // a half-typed GitHub Enterprise host survives a misclick.
              setBaseUrl((current) =>
                current.trim() === '' || isDefaultUrl(current) ? (defaultUrlFor(p.id) ?? '') : current
              )
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="field-hint cicd-seg-hint">{t(def.urlHintKey)}</div>

      <Field label={t('cicd.connect.nameLabel')} required>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder={
            provider === 'jenkins' ? t('cicd.connect.namePlaceholderJenkins') : t('cicd.connect.namePlaceholder')
          }
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <Field label={t('cicd.connect.urlLabel')} required hint={t('cicd.connect.urlHint')}>
        <input
          className="input"
          value={baseUrl}
          placeholder={def.placeholder}
          onChange={(e) => {
            setBaseUrl(e.target.value)
            setVerify({ kind: 'idle' })
          }}
        />
      </Field>

      {def.needsUsername && (
        <Field label={t('cicd.connect.usernameLabel')} required hint={t('cicd.connect.usernameHint')}>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
      )}

      <Field
        label={t('cicd.connect.tokenLabel')}
        required
        hint={
          token.trim()
            ? t('cicd.connect.tokenHintTyped', { masked: maskToken(token) })
            : t('cicd.connect.tokenHint')
        }
      >
        <input
          className="input"
          type="password"
          value={token}
          autoComplete="off"
          onChange={(e) => {
            setToken(e.target.value)
            setVerify({ kind: 'idle' })
          }}
        />
      </Field>

      <ScopeHelp def={def} baseUrl={baseUrl} />

      {/**
       * Send from — §5.1. Without it a self-hosted Jenkins behind a bastion and
       * a GitLab on a VPN subnet are simply unreachable, and those are the
       * installs most likely to want this module. `direct` already covers a
       * tunnel the user opened themselves, which is just 127.0.0.1.
       */}
      <Field
        label={t('cicd.connect.routeLabel')}
        hint={
          routeKind === 'server'
            ? t('cicd.connect.routeHintServer')
            : routeKind === 'vpn'
              ? t('cicd.connect.routeHintVpn')
              : t('cicd.connect.routeHintDirect')
        }
      >
        <select
          className="input"
          value={routeKind}
          onChange={(e) => setRouteKind(e.target.value as CicdRoute['kind'])}
        >
          <option value="direct">{t('cicd.connect.routeDirect')}</option>
          <option value="server">{t('cicd.connect.routeServer')}</option>
          <option value="vpn">{t('cicd.connect.routeVpn')}</option>
        </select>
      </Field>

      {routeKind === 'server' && (
        <Field label={t('cicd.connect.serverLabel')} required>
          <select className="input" value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">{t('cicd.connect.chooseServer')}</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {routeKind === 'vpn' && (
        <Field label={t('cicd.connect.vpnLabel')} required>
          <select
            className="input"
            value={vpnProfileId}
            onChange={(e) => setVpnProfileId(e.target.value)}
          >
            <option value="">{t('cicd.connect.chooseVpn')}</option>
            {vpns.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <label className="row cicd-check">
        <input
          type="checkbox"
          checked={insecureTls}
          onChange={(e) => setInsecureTls(e.target.checked)}
        />
        <span className="grow">{t('cicd.connect.skipTls')}</span>
      </label>
      {insecureTls && (
        <div className="panel-note is-alarm">{t('cicd.connect.skipTlsWarning')}</div>
      )}
    </Modal>
  )
}

/**
 * The scope checklist, or the honest statement that there is no such thing.
 *
 * Jenkins is why this is not one component with an empty array: an empty
 * checklist reads as "nothing needed", and the truth is the opposite — the
 * token carries the whole account.
 */
function ScopeHelp({ def, baseUrl }: { def: ProviderDef; baseUrl: string }): React.JSX.Element {
  const t = useT()
  const href = def.tokenUrl(baseUrl)
  return (
    <div className="cicd-scopes">
      <div className="ui-label">{t('cicd.connect.tokenNeeds')}</div>
      {def.scopes === null ? (
        <div className="panel-note is-watch">{t(def.linkNoteKey)}</div>
      ) : (
        <>
          <ul className="cicd-scope-list">
            {def.scopes.map((s) => (
              <li key={s.name}>
                <span className="mono">{s.name}</span> — {t(s.whyKey)}
              </li>
            ))}
          </ul>
          <div className="ui-note">{t(def.linkNoteKey)}</div>
        </>
      )}
      <div className="ui-note">
        {/* `openExternal` is not reachable from a module surface, so this is a
            plain link the shell opens, and the URL is shown so somebody can
            paste it themselves. */}
        <a href={href} target="_blank" rel="noreferrer">
          {t(def.tokenLinkLabelKey)}
        </a>{' '}
        <span className="mono ellipsis">{href}</span>
      </div>
    </div>
  )
}

/**
 * What Verify found.
 *
 * The three outcomes are not ok/failed. A token that reads but cannot start a
 * run is a SUCCESS with a caveat — `watch`, not `alarm` — because connecting
 * read-only is a legitimate thing to want, and a form that calls it a failure
 * is a form arguing for more access than the user chose to give.
 */
function VerifyNote({ state, def }: { state: VerifyState; def: ProviderDef }): React.JSX.Element | null {
  const t = useT()
  if (state.kind === 'idle') return <span className="field-hint">{t(def.verifyNoteKey)}</span>
  if (state.kind === 'dialling') {
    return <span className="field-hint">{t('cicd.connect.dialling', { provider: def.label })}</span>
  }
  if (state.kind === 'failed') return <span className="field-hint danger">{state.error}</span>

  const scopes = state.scopes
  const expiry =
    state.expiresAt !== undefined
      ? ` ${t('cicd.connect.expires', { date: new Date(state.expiresAt).toLocaleDateString() })}`
      : ''

  // Jenkins reports no scopes at all, so absence is not "no permissions".
  if (!scopes || scopes.length === 0) {
    return (
      <span className="field-hint state-ok">
        {t('cicd.connect.reached', { provider: def.label, identity: state.identity })}{' '}
        {def.scopes === null ? t('cicd.connect.jenkinsNoScopes') : t('cicd.connect.noScopeList')}
        {expiry}
      </span>
    )
  }

  const canRead = def.readScope === undefined || scopes.includes(def.readScope)
  const canTrigger = def.writeScope !== undefined && scopes.includes(def.writeScope)

  if (!canRead) {
    return (
      <span className="field-hint state-watch">
        <Trans
          i18nKey="cicd.connect.cannotRead"
          values={{ provider: def.label, identity: state.identity, scope: def.readScope ?? '' }}
          components={{ mono: <span className="mono" /> }}
        />
        {expiry}
      </span>
    )
  }

  return (
    <span className={clsx('field-hint', canTrigger ? 'state-ok' : 'state-watch')}>
      {t('cicd.connect.reached', { provider: def.label, identity: state.identity })}{' '}
      {canTrigger
        ? t('cicd.connect.canTrigger')
        : t('cicd.connect.readOnly', { scope: def.writeScope ?? '' })}
      {expiry}
    </span>
  )
}
