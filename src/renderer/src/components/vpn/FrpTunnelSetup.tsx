import { useState } from 'react'
import { Field, Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import {
  delegationRecord,
  isDelegatableDomain,
  publicHostFrom,
  publicUrl
} from '../../../../shared/frpTunnel'
import type { FrpPublicHost, FrpSpec, FrpTokenResult, VpnProfile } from '../../../../shared/vpn'
import { Switch } from '../common/Switch'
import { useT } from '../../lib/i18n'

/**
 * `vpn.frpToken`, read off the bridge rather than called through it.
 *
 * The preload declaration for this channel lives in a file another agent holds
 * this session and is delivered as a patch, so the typed bridge does not name
 * it yet. Reading it through a narrow local type is what `bridgeHas` already
 * assumes anyway — every renderer call site has to survive a preload bundle
 * older than the renderer (see lib/bridge.ts) — and it keeps the argument and
 * result types checked rather than reaching for `any`.
 *
 * Once the patch is applied this can become a plain `window.opsmaxx.vpn`
 * call and this type can go.
 */
type FrpTokenChannel = (req: {
  profileName: string
  workspaceId: string
  token: string
  replaces?: string
}) => Promise<FrpTokenResult>

function frpTokenChannel(): FrpTokenChannel | undefined {
  const vpn = window.opsmaxx?.vpn as unknown as
    | { frpToken?: FrpTokenChannel }
    | undefined
  return typeof vpn?.frpToken === 'function' ? vpn.frpToken.bind(vpn) : undefined
}

/**
 * The one-time setup, and the only place OpsMaxx says what frp cannot do
 * for you.
 *
 * ngrok hands out a URL because ngrok runs the server it resolves to. frp does
 * not; somebody has to point a domain at a host they control. That is a real
 * cost and pretending otherwise would be the whole feature's undoing — a URL
 * that looks like magic and then 404s at the DNS layer is worse than the form
 * it replaced, because the form never claimed to have finished.
 *
 * So the cost is paid here, once, in full, with the actual DNS record written
 * out to be copied. And then it is over: `FrpPublicHost.confirmedAt` is
 * stamped, `frpPublishReadiness` starts answering yes, and nothing in this pane
 * mentions domains again.
 *
 * What it deliberately does NOT do is check. There is no resolver call, no
 * "verifying…" spinner, no green tick. OpsMaxx cannot see the operator's
 * zone, and a check that passed because a stale cache answered would be a
 * worse lie than no check at all. The confirmation records that the operator
 * says the record exists, and the wording says exactly that.
 */

interface FrpTunnelSetupProps {
  workspaceId: string
  /** An existing frp profile to promote into the tunnel host, if there is one
   *  worth reusing. A fresh profile otherwise. */
  existing?: VpnProfile | null
  onClose: () => void
  /** The saved profile, so the caller can carry straight on into a publish. */
  onDone: (profile: VpnProfile) => void
}

const SCHEMES: FrpPublicHost['scheme'][] = ['https', 'http']

export function FrpTunnelSetup({
  workspaceId,
  existing,
  onClose,
  onDone
}: FrpTunnelSetupProps): React.JSX.Element {
  const t = useT()
  const upsertVpnProfile = useApp((s) => s.upsertVpnProfile)
  const base = existing?.spec.kind === 'frp' ? existing.spec : null

  const [name, setName] = useState(existing?.name ?? t('vpn.frp.setup.defaultName'))
  const [serverAddr, setServerAddr] = useState(base?.serverAddr ?? '')
  const [serverPort, setServerPort] = useState(base?.serverPort ?? 7000)
  const [token, setToken] = useState('')
  const [baseDomain, setBaseDomain] = useState(base?.publicHost?.baseDomain ?? '')
  const [scheme, setScheme] = useState<FrpPublicHost['scheme']>(base?.publicHost?.scheme ?? 'https')
  const [vhostPort, setVhostPort] = useState<string>(String(base?.publicHost?.port ?? ''))
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)

  // The token channel is newer than some preload bundles (see lib/bridge.ts).
  // Without it the setup still completes — it just cannot finish the one step
  // that needs main, and says so rather than silently dropping the token.
  const storeToken = frpTokenChannel()

  const domainOk = isDelegatableDomain(baseDomain)
  const serverOk = serverAddr.trim().length > 0 && serverPort > 0 && serverPort < 65536
  const ready = domainOk && serverOk && confirmed && !saving

  const record = delegationRecord(baseDomain, serverAddr)
  const example = domainOk
    ? publicUrl(
        publicHostFrom({
          baseDomain,
          scheme,
          port: vhostPort ? Number(vhostPort) : undefined,
          now: 1
        }),
        'staging'
      )
    : null

  const finish = async (): Promise<void> => {
    if (!ready) return
    setSaving(true)
    try {
      let tokenRef = base?.auth.tokenRef
      if (token.trim() && storeToken) {
        const stored = await withVaultUnlock(t('vpn.frp.setup.unlockReason', { name: name.trim() }), () =>
          storeToken({
            profileName: name.trim() || t('vpn.frp.setup.defaultName'),
            workspaceId,
            token: token.trim(),
            ...(tokenRef?.vaultEntryId ? { replaces: tokenRef.vaultEntryId } : {})
          })
        )
        if (!stored?.ok || !stored.tokenRef) {
          // The dialog stays open with everything still typed in, so the user
          // can unlock the vault and press Finish again rather than starting
          // the setup over.
          toast(stored?.error ?? t('vpn.frp.setup.tokenNotSaved'), 'error')
          return
        }
        tokenRef = stored.tokenRef
      }

      // Preserve whatever the existing profile already had. A tunnel host
      // promoted from an imported frpc.toml keeps its proxies, its transport
      // and — if it authenticates by OIDC and no token was typed — its auth.
      const auth: FrpSpec['auth'] = tokenRef
        ? { ...(base?.auth ?? { method: 'token' }), method: 'token', tokenRef }
        : (base?.auth ?? { method: 'token' })

      const spec: FrpSpec = {
        ...(base ?? {
          kind: 'frp',
          transport: { protocol: 'tcp', tlsEnable: true },
          proxies: [],
          visitors: []
        }),
        kind: 'frp',
        serverAddr: serverAddr.trim(),
        serverPort,
        auth,
        publicHost: publicHostFrom({
          baseDomain,
          scheme,
          port: vhostPort ? Number(vhostPort) : undefined
        })
      }

      const profile: VpnProfile = {
        id: existing?.id ?? `vpn-${crypto.randomUUID()}`,
        workspaceId,
        name: name.trim() || t('vpn.frp.setup.defaultName'),
        autoStart: existing?.autoStart ?? false,
        spec
      }
      upsertVpnProfile(profile)
      toast(t('vpn.frp.setup.saved', { name: profile.name }), 'ok')
      onDone(profile)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={t('vpn.frp.setup.title')}
      subtitle={t('vpn.frp.setup.subtitle')}
      size="lg"
      onClose={onClose}
      confirm={{ label: t('vpn.frp.setup.finish'), disabled: !ready, onClick: () => void finish() }}
    >
      <div className="col" style={{ gap: 14 }}>
        {/* Said once, here, and nowhere else in this pane. */}
        <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          {t('vpn.frp.setup.intro')}
        </p>

        <Field label={t('vpn.frp.setup.name')}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="field-row">
          <Field
            label={t('vpn.frp.setup.serverAddr')}
            required
            error={
              serverAddr.trim() === '' ? t('vpn.frp.setup.serverAddrMissing') : null
            }
          >
            <input
              className="input"
              placeholder="frp.example.com"
              value={serverAddr}
              onChange={(e) => setServerAddr(e.target.value)}
            />
          </Field>
          <Field
            label={t('vpn.frp.setup.controlPort')}
            required
            error={serverPort > 0 && serverPort < 65536 ? null : t('vpn.frp.setup.portRange')}
          >
            <input
              className="input"
              type="number"
              placeholder="7000"
              value={serverPort || ''}
              onChange={(e) => setServerPort(Number(e.target.value))}
            />
          </Field>
        </div>

        <Field
          label={t('vpn.frp.setup.token')}
          hint={
            storeToken
              ? t('vpn.frp.setup.tokenHint')
              : t('vpn.frp.setup.tokenUnsupported')
          }
        >
          <input
            className="input"
            type="password"
            placeholder={
              base?.auth.tokenRef
                ? t('vpn.frp.setup.tokenStoredPlaceholder')
                : t('vpn.frp.setup.tokenPlaceholder')
            }
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={!storeToken}
          />
        </Field>

        <div className="divider" />

        <div className="field-row">
          <Field
            label={t('vpn.frp.setup.domain')}
            required
            error={
              baseDomain.trim() === ''
                ? t('vpn.frp.setup.domainMissing')
                : domainOk
                  ? null
                  : t('vpn.frp.setup.domainInvalid')
            }
          >
            <input
              className="input"
              placeholder="tunnel.example.com"
              value={baseDomain}
              onChange={(e) => setBaseDomain(e.target.value)}
            />
          </Field>
          <Field label={t('vpn.frp.setup.servedOver')}>
            <select
              className="input"
              value={scheme}
              onChange={(e) => setScheme(e.target.value as FrpPublicHost['scheme'])}
            >
              {SCHEMES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('vpn.frp.setup.urlPort')}>
            <input
              className="input"
              type="number"
              placeholder={scheme === 'https' ? '443' : '80'}
              value={vhostPort}
              onChange={(e) => setVhostPort(e.target.value)}
            />
          </Field>
        </div>
        {scheme === 'https' && (
          // frp does not terminate TLS for a plain local HTTP service. Someone
          // has to — Caddy, nginx, a load balancer — and a scheme picked as a
          // wish fails in the browser rather than here, where it could be
          // explained.
          <span className="field-hint">
            {t('vpn.frp.setup.httpsNote')}
          </span>
        )}

        <div className="field">
          <span className="field-label">{t('vpn.frp.setup.dnsRecord')}</span>
          <code
            className="input"
            style={{ display: 'block', fontSize: 12, padding: '6px 8px', userSelect: 'text' }}
          >
            {record}
          </code>
          <span className="field-hint">
            {example
              ? t('vpn.frp.setup.wildcardExample', { url: example })
              : t('vpn.frp.setup.wildcardNote')}
          </span>
        </div>

        {/* The gate. Not a check: nothing here resolves the name, and a green
            tick this app cannot honestly earn is exactly the kind of magic
            this whole flow exists to avoid. */}
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <Switch
            checked={confirmed}
            label={t('vpn.frp.setup.confirmLabel')}
            style={{ marginTop: 1 }}
            onChange={setConfirmed}
          />
          <span style={{ fontSize: 12, color: confirmed ? 'var(--text-muted)' : 'var(--warn)' }}>
            {t('vpn.frp.setup.confirmText')}
          </span>
        </label>
      </div>
    </Modal>
  )
}
