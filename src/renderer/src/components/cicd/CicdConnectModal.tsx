import { useState } from 'react'
import { Field, Modal } from '../common/Modal'
import { useWorkspaceServers, useWorkspaceVpns, useApp } from '../../store/app'
import { clsx } from '../../lib/format'
import { maskToken } from '../../../../shared/tokenDisplay'
import type { CicdBridge, CicdConnection, CicdProvider, CicdRoute } from '../../../../shared/cicd'

/**
 * Connect a CI account. ONE modal, progressively revealed.
 *
 * Not a wizard, and that is a constraint rather than a preference:
 * `components/onboarding/setupQuestions.ts` says outright that this audience
 * closes multi-step wizards. The shape follows `AddApiModal` — a `.segment`
 * picker, a hint line that changes with the choice, then `Field`s — and the
 * provider choice changes exactly three things: the URL placeholder, the token
 * help block, and what Verify probes. Everything else is the same form.
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
  why: string
}

interface ProviderDef {
  id: CicdProvider
  label: string
  placeholder: string
  /** What the URL field means for this provider — all three differ. */
  urlHint: string
  /** Jenkins authenticates as a user; the other two carry identity in the token. */
  needsUsername: boolean
  /** `null` where the provider HAS no scopes. Not an empty checklist. */
  scopes: Scope[] | null
  /** Where the token is made. `base` is whatever the user has typed so far. */
  tokenUrl: (base: string) => string
  tokenLinkLabel: string
  /** The honest caveat about what that link does and does not do. */
  linkNote: string
  /** What the Verify button actually asks for. */
  verifyNote: string
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
    urlHint:
      'The web URL you use, not an API root. github.com and GitHub Enterprise have different API hosts and OpsMaxx derives the right one.',
    needsUsername: false,
    scopes: [
      { name: 'repo', why: 'Read runs, jobs and logs in private repositories.' },
      { name: 'workflow', why: 'Start a run. Leave it off for a read-only connection.' }
    ],
    tokenUrl: (base) =>
      `${trimSlash(base) || 'https://github.com'}/settings/tokens/new?scopes=repo,workflow&description=OpsMaxx`,
    tokenLinkLabel: 'Create a classic token',
    linkNote:
      'That link pre-ticks both boxes, but only for a CLASSIC token. A fine-grained token takes no scope parameters at all — the link cannot do the work, so set Actions to Read (and Read and write, if you want to start runs) by hand.',
    verifyNote: 'Verify asks GitHub who the token belongs to and reads the scopes it granted.',
    readScope: 'repo',
    writeScope: 'workflow'
  },
  {
    id: 'gitlab',
    label: 'GitLab CI',
    placeholder: 'https://gitlab.com',
    urlHint: 'The instance URL. OpsMaxx appends /api/v4 itself.',
    needsUsername: false,
    scopes: [
      { name: 'read_api', why: 'Read pipelines, jobs and job traces.' },
      { name: 'api', why: 'Start a pipeline. Leave it off for a read-only connection.' }
    ],
    tokenUrl: (base) =>
      `${trimSlash(base) || 'https://gitlab.com'}/-/user_settings/personal_access_tokens?name=OpsMaxx&scopes=read_api`,
    tokenLinkLabel: 'Create a personal access token',
    linkNote:
      'That link pre-fills the name and ticks read_api. Add api yourself if this connection should be able to start pipelines.',
    verifyNote:
      'Verify reads the token back from GitLab, which reports its own scopes and expiry.',
    readScope: 'read_api',
    writeScope: 'api'
  },
  {
    id: 'jenkins',
    label: 'Jenkins',
    placeholder: 'https://jenkins.example.internal',
    urlHint:
      'Including the context path if the admin chose one — Jenkins sits wherever it was installed, and OpsMaxx does not guess.',
    needsUsername: true,
    // Deliberately null, and the UI says so instead of drawing an empty list.
    scopes: null,
    tokenUrl: (base) => `${trimSlash(base)}/me/security`,
    tokenLinkLabel: 'Open your Jenkins token page',
    linkNote:
      'Jenkins API tokens have no scopes at all. The token carries your whole account — every permission your user has, including starting builds — so there is no read-only version of it. Create it on an account that has only what you want OpsMaxx to do.',
    verifyNote:
      'Jenkins reports neither scopes nor an expiry, so Verify performs one read and tells you what it managed to see.'
  }
]

function trimSlash(s: string): string {
  return s.trim().replace(/\/+$/, '')
}

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'dialling' }
  | { kind: 'ok'; identity: string; scopes?: string[]; expiresAt?: number }
  | { kind: 'failed'; error: string }

export function CicdConnectModal({
  onClose,
  onSave,
  editing,
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
  bridge?: CicdBridge
}): React.JSX.Element {
  const servers = useWorkspaceServers()
  const vpns = useWorkspaceVpns()
  const workspaceId = useApp((s) => s.activeWorkspaceId)

  const [provider, setProvider] = useState<CicdProvider>(editing?.provider ?? 'github')
  const [name, setName] = useState(editing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '')
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
      ? 'Give the account a name — it is what an AI agent and the tree will call it.'
      : baseUrl.trim() === ''
        ? 'A URL is needed before anything can be dialled.'
        : def.needsUsername && username.trim() === ''
          ? 'Jenkins authenticates as a user, so it needs the username the token belongs to.'
          : token.trim() === ''
            ? 'Paste the token. It is sent to the provider and never stored by this panel.'
            : routeKind === 'server' && !serverId
              ? 'Choose which saved server the requests should leave from.'
              : routeKind === 'vpn' && !vpnProfileId
                ? 'Choose which VPN profile the requests should go through.'
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
      title={editing ? `Edit ${editing.name}` : 'Connect a CI account'}
      subtitle="Requests are sent by OpsMaxx, so an internal certificate authority, a bastion or a VPN profile all work."
      size="lg"
      onClose={onClose}
      footerNote={
        <>
          {missing && <span className="field-hint danger">{missing}</span>}
          {!missing && <VerifyNote state={verify} def={def} />}
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
              ? 'This build cannot dial a CI server. Restart the app to rebuild the bridge.'
              : def.verifyNote
          }
          onClick={() => void runVerify()}
        >
          {verify.kind === 'dialling' ? 'Verifying…' : 'Verify'}
        </button>
      }
      confirm={{
        label: editing ? 'Save' : 'Connect',
        // `onSave` is optional only so a test can render this without a store.
        // The panel always supplies one; a build where it does not is a build
        // where nothing could be saved, and that is worth failing loudly in a
        // test rather than quietly grey on screen.
        disabled: missing !== null || !onSave,
        onClick: () => {
          if (missing || !onSave) return
          void Promise.resolve(onSave(draft(), token)).then(onClose)
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
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="field-hint cicd-seg-hint">{def.urlHint}</div>

      <Field label="Name" required>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder={provider === 'jenkins' ? 'Build controller' : 'Platform'}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <Field label="URL" required hint="As you would type it into a browser.">
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
        <Field label="Username" required hint="The Jenkins user the API token belongs to.">
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
      )}

      <Field
        label="Token"
        required
        hint={
          token.trim()
            ? `Sent to the provider and not kept by this panel. It will be stored as ${maskToken(token)}.`
            : 'Sent to the provider when you press Verify. It is never written into opsmaxx-data.json.'
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
        label="Send from"
        hint={
          routeKind === 'server'
            ? 'Hostnames resolve on that server, so a private DNS name or its own loopback works.'
            : routeKind === 'vpn'
              ? 'A userspace VPN changes no route table, so a request has to be sent through the profile deliberately. This is the case with no server in front of it.'
              : 'Requests leave from this machine. That covers SaaS, and anything already reachable.'
        }
      >
        <select
          className="input"
          value={routeKind}
          onChange={(e) => setRouteKind(e.target.value as CicdRoute['kind'])}
        >
          <option value="direct">This machine</option>
          <option value="server">A saved server</option>
          <option value="vpn">A VPN profile</option>
        </select>
      </Field>

      {routeKind === 'server' && (
        <Field label="Server" required>
          <select className="input" value={serverId} onChange={(e) => setServerId(e.target.value)}>
            <option value="">Choose a server…</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {routeKind === 'vpn' && (
        <Field label="VPN profile" required>
          <select
            className="input"
            value={vpnProfileId}
            onChange={(e) => setVpnProfileId(e.target.value)}
          >
            <option value="">Choose a profile…</option>
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
        <span className="grow">Skip certificate checking</span>
      </label>
      {insecureTls && (
        <div className="panel-note is-alarm">
          Every request to this account will accept any certificate, including one an
          attacker on the path presents. An internal certificate authority is the fix;
          this is the fallback.
        </div>
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
  const href = def.tokenUrl(baseUrl)
  return (
    <div className="cicd-scopes">
      <div className="ui-label">What the token needs</div>
      {def.scopes === null ? (
        <div className="panel-note is-watch">{def.linkNote}</div>
      ) : (
        <>
          <ul className="cicd-scope-list">
            {def.scopes.map((s) => (
              <li key={s.name}>
                <span className="mono">{s.name}</span> — {s.why}
              </li>
            ))}
          </ul>
          <div className="ui-note">{def.linkNote}</div>
        </>
      )}
      <div className="ui-note">
        {/* `openExternal` is not reachable from a module surface, so this is a
            plain link the shell opens, and the URL is shown so somebody can
            paste it themselves. */}
        <a href={href} target="_blank" rel="noreferrer">
          {def.tokenLinkLabel}
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
  if (state.kind === 'idle') return <span className="field-hint">{def.verifyNote}</span>
  if (state.kind === 'dialling') return <span className="field-hint">Dialling {def.label}…</span>
  if (state.kind === 'failed') return <span className="field-hint danger">{state.error}</span>

  const scopes = state.scopes
  const expiry =
    state.expiresAt !== undefined
      ? ` Expires ${new Date(state.expiresAt).toLocaleDateString()}.`
      : ''

  // Jenkins reports no scopes at all, so absence is not "no permissions".
  if (!scopes || scopes.length === 0) {
    return (
      <span className="field-hint state-ok">
        Reached {def.label} as {state.identity}.
        {def.scopes === null
          ? ' Jenkins reports no scopes, so what this token can do is whatever that account can do.'
          : ' The provider reported no scope list.'}
        {expiry}
      </span>
    )
  }

  const canRead = def.readScope === undefined || scopes.includes(def.readScope)
  const canTrigger = def.writeScope !== undefined && scopes.includes(def.writeScope)

  if (!canRead) {
    return (
      <span className="field-hint state-watch">
        Reached {def.label} as {state.identity}, but the token is missing{' '}
        <span className="mono">{def.readScope}</span> and cannot read runs.{expiry}
      </span>
    )
  }

  return (
    <span className={clsx('field-hint', canTrigger ? 'state-ok' : 'state-watch')}>
      Reached {def.label} as {state.identity}.{' '}
      {canTrigger
        ? 'This token can read runs and start them.'
        : `Read-only: without ${def.writeScope} this connection can watch pipelines but not start one. That is a fine way to use it.`}
      {expiry}
    </span>
  )
}
