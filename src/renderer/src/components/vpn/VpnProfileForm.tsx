import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Copy, Eye, EyeOff, KeyRound, Plus, ScrollText, Trash2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { bridgeHas } from '../../lib/bridge'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { isCidr, isWireGuardKey, parseVpnEndpoint, tailscaleHostname } from '../../../../shared/vpn'
import { userSuppliesEngine } from '../../../../shared/vpnEngines'
import type {
  FrpProxy,
  FrpSpec,
  OpenVpnAuthMode,
  OpenVpnSpec,
  TailscaleSpec,
  VpnListener,
  VpnProfile,
  VpnValidationIssue,
  WireGuardPeer,
  WireGuardSpec
} from '../../types'
import { BindWarning } from './VpnStatusCard'
import { FrpProxyEditor } from './FrpProxyEditor'
import { Switch } from '../common/Switch'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey } from '../../../../shared/i18n'

/** A keypair that exists only in this form.
 *
 *  Generating or pasting a key used to write it to the vault on the spot, which
 *  meant opening the dialog, pressing Generate, and pressing Cancel left an
 *  entry behind that no profile referenced. Cancel has to mean cancel, so the
 *  pair is held here and written by `save()` or not at all. */
interface PendingKey {
  privateKey: string
  publicKey: string
}

const listStr = (a: string[] | undefined): string => (a ?? []).join(', ')
const parseList = (s: string): string[] =>
  s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

/** Onto the clipboard, with a receipt. A key the user cannot tell they copied
 *  gets copied again, and the second attempt is the one that grabs the wrong
 *  field. */
function copyValue(receipt: string, value: string): void {
  if (!value) return
  window.opsmaxx?.clipboard.write(value)
  toast(receipt, 'ok')
}

const KIND_SUBTITLE: Record<VpnProfile['spec']['kind'], MessageKey> = {
  wireguard: 'vpn.profileForm.kindWireguard',
  openvpn: 'vpn.profileForm.kindOpenvpn',
  frp: 'vpn.profileForm.kindFrp',
  tailscale: 'vpn.profileForm.kindTailscale',
  ngrok: 'vpn.profileForm.kindNgrok'
}

/** Which part of the form the caller wants the user standing in front of.
 *
 *  An error that says "open the profile" and then drops the user at the top of
 *  a long form has moved the search, not ended it. The failure already knows
 *  what is wrong, so it can say where. */
export type VpnFormFocus = 'binaryPath' | 'proxies'

interface VpnProfileFormProps {
  profile: VpnProfile
  onClose: () => void
  focus?: VpnFormFocus
}

export function VpnProfileForm({ profile, onClose, focus }: VpnProfileFormProps): React.JSX.Element {
  const t = useT()
  const upsertVpnProfile = useApp((s) => s.upsertVpnProfile)
  // "Edit New frp client" is what the title said for a profile being created.
  // The caller mints the profile before opening the form, so the honest test is
  // whether the store has seen this id yet.
  const isNew = useApp((s) => !s.vpns.some((v) => v.id === profile.id))
  const [draft, setDraft] = useState<VpnProfile>(profile)
  const [issues, setIssues] = useState<VpnValidationIssue[]>([])

  // validate() is pure and cheap in main — no process, no network — so it can
  // run while the user types. Debounced only enough to collapse a burst.
  useEffect(() => {
    if (!bridgeHas(window.opsmaxx?.vpn as Record<string, unknown> | undefined, 'validate')) return
    let live = true
    const timer = setTimeout(() => {
      void window.opsmaxx?.vpn.validate(draft.spec).then((v) => {
        if (live && v) setIssues(v.issues)
      })
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [draft.spec])

  const byPath = useMemo(() => {
    const m: Record<string, VpnValidationIssue> = {}
    // An error beats a warning on the same field: the blocking problem is the
    // one the user has to fix first.
    for (const i of issues) {
      const held = m[i.path]
      if (!held || (held.severity === 'warning' && i.severity === 'error')) m[i.path] = i
    }
    return m
  }, [issues])

  // Which paths a field actually put on screen this render.
  //
  // The form renders <Issue at="..."> for a hand-picked set of paths, and the
  // validators emit plenty of others — `dns[0]`, `peers[0].allowedIps[1]`,
  // `listeners[0].targetHost`, `proxies[0].secretKeyRef`. Every one of those
  // used to disappear, leaving a greyed Save and "2 problems to fix" with
  // nothing indicating where. Collecting what was shown lets the footer list
  // whatever was not.
  // `issues` is a reset trigger, not an input: the factory ignores it and the
  // dependency exists so a new render's issues start from an empty set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => new Set<string>(), [issues])

  // A keypair the user generated or pasted, held here until Save.
  //
  // It deliberately does not live on the spec. The spec is plain JSON that gets
  // persisted, and a private key has no business in it — that is the whole
  // reason the profile carries a `privateKeyRef` instead. Holding it in form
  // state means Cancel discards it the way Cancel discards every other edit.
  const [pendingKey, setPendingKey] = useState<PendingKey | null>(null)
  const [saving, setSaving] = useState(false)

  /**
   * This machine's own name for a Tailscale node, held until Save.
   *
   * Like `pendingKey` and for the same reason: it does not live on the spec.
   * The spec syncs, and a tailnet hostname names ONE device — so a per-device
   * name in there would reach every paired machine and they would all register
   * under it. It is stored beside the node key in `vpn-state/`, which is a
   * separate write on a channel of its own, so Cancel has to discard it the way
   * Cancel discards every other edit.
   *
   * `''` is "no override", which is what makes the profile's name the default.
   */
  const [deviceName, setDeviceName] = useState('')
  // What main last told us, so Save writes only when the user actually changed
  // it — an unconditional write would rewrite the file on every Save and turn
  // "never set one" into a setting.
  const storedDeviceName = useRef<string>('')
  // A load that lands after the user has started typing must not overwrite
  // them. The window is milliseconds and the cost of losing the edit is that
  // the name silently reverts on Save.
  const deviceNameTouched = useRef(false)

  useEffect(() => {
    if (draft.spec.kind !== 'tailscale') return
    if (!bridgeHas(window.opsmaxx?.vpn as Record<string, unknown> | undefined, 'deviceHostname')) {
      return
    }
    let live = true
    void window.opsmaxx?.vpn.deviceHostname(profile.id).then((name) => {
      if (!live) return
      storedDeviceName.current = name ?? ''
      if (!deviceNameTouched.current) setDeviceName(name ?? '')
    })
    return () => {
      live = false
    }
  }, [profile.id, draft.spec.kind])

  // The validator runs in main against the spec, so it cannot know a key is
  // sitting in this component waiting to be written. Left alone it reports
  // `private-key-missing`, which is an error, which disables Save — and Save is
  // precisely the thing that would store the key. Dropping that one issue while
  // a pending key exists is what makes deferring the write possible at all.
  const blocking = issues.filter(
    (i) => i.severity === 'error' && !(pendingKey && i.code === 'private-key-missing')
  )
  const stripped = draft.spec.strippedDirectives ?? []

  const save = async (): Promise<void> => {
    if (blocking.length > 0 || !draft.name.trim() || saving) return
    const name = draft.name.trim()
    let spec = draft.spec

    // The one write this form performs, and only from here. `stageImportedSecrets`
    // by way of `wireguardKeygen` — the same road an imported key travels, so
    // there is still exactly one way a WireGuard private key enters the vault.
    //
    // Narrowed on `kind` rather than cast. Only the WireGuard field can set a
    // pending key, so a cast would be correct today and quietly wrong the day
    // another engine grows a generated secret — and it would be wrong by
    // reading a `privateKeyRef` off a spec that has no such field.
    if (pendingKey && spec.kind === 'wireguard') {
      const wg: WireGuardSpec = spec
      setSaving(true)
      try {
        const replaces = wg.privateKeyRef?.vaultEntryId
        const stored = await withVaultUnlock(t('vpn.profileForm.keyUnlockReason', { name }), () =>
          Promise.resolve(
            window.opsmaxx?.vpn.wireguardKeygen({
              profileName: name,
              workspaceId: draft.workspaceId,
              privateKey: pendingKey.privateKey,
              // Released only once the replacement is written, so a profile is
              // never left pointing at an entry that no longer exists.
              ...(replaces ? { replaces } : {})
            })
          )
        )
        if (!stored?.ok || !stored.privateKeyRef) {
          // The form stays open with the key still held, so the user can fix
          // whatever went wrong and press Save again rather than losing it.
          toast(stored?.error ?? t('vpn.profileForm.keyNotSaved'), 'error')
          return
        }
        spec = { ...wg, privateKeyRef: stored.privateKeyRef }
      } finally {
        setSaving(false)
      }
    }

    // The per-device name, which is a separate write to a separate store —
    // `vpn-state/`, not the profile. Before `upsertVpnProfile`, because a
    // refusal here has to leave the form open with the field still holding
    // what the user typed; closing first would discard it silently.
    if (spec.kind === 'tailscale' && deviceName.trim() !== storedDeviceName.current) {
      const res = await window.opsmaxx?.vpn.setDeviceHostname(
        draft.id,
        deviceName.trim() || undefined
      )
      if (res && !res.ok) {
        toast(res.error ?? t('vpn.profileForm.deviceNameNotSaved'), 'error')
        return
      }
      storedDeviceName.current = deviceName.trim()
    }

    upsertVpnProfile({ ...draft, name, spec })
    toast(t('vpn.profileForm.saved', { name }), 'ok')
    onClose()
  }

  const setSpec = <T extends VpnProfile['spec']>(spec: T): void => setDraft((d) => ({ ...d, spec }))

  return (
    <Modal
      title={
        isNew
          ? t('vpn.profileForm.titleNew', { kind: t(KIND_SUBTITLE[draft.spec.kind]) })
          : draft.name
            ? t('vpn.profileForm.titleEdit', { name: draft.name })
            : t('vpn.profileForm.titleEditUnnamed')
      }
      subtitle={t(KIND_SUBTITLE[draft.spec.kind])}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <UnrenderedIssues
            blocking={blocking}
            shown={shown}
            nameMissing={!draft.name.trim()}
          />
          <span className="grow" />
          <button className="btn sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary sm"
            disabled={blocking.length > 0 || !draft.name.trim() || saving}
            onClick={() => void save()}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field">
          <span className="field-label">{t('vpn.profileForm.name')}</span>
          <input
            className="input"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </label>

        <label className="row" style={{ gap: 8 }}>
          <Switch checked={draft.autoStart} onChange={(v) => setDraft((d) => ({ ...d, autoStart: v }))} />
          <span className="muted" style={{ fontSize: 12 }}>
            {t('vpn.profileForm.autoStart')}
          </span>
        </label>

        <div className="divider" />

        {draft.spec.kind === 'wireguard' && (
          <WireGuardFields
            spec={draft.spec}
            issue={byPath}
            shown={shown}
            onChange={setSpec}
            pending={pendingKey}
            onPending={setPendingKey}
          />
        )}
        {draft.spec.kind === 'openvpn' && (
          <OpenVpnFields
            spec={draft.spec}
            issue={byPath}
            shown={shown}
            onChange={setSpec}
            focus={focus}
          />
        )}
        {draft.spec.kind === 'frp' && (
          <FrpFields
            spec={draft.spec}
            issue={byPath}
            shown={shown}
            onChange={setSpec}
            focus={focus}
          />
        )}
        {draft.spec.kind === 'tailscale' && (
          <TailscaleFields
            spec={draft.spec}
            issue={byPath}
            shown={shown}
            onChange={setSpec}
            deviceName={deviceName}
            onDeviceName={(v) => {
              deviceNameTouched.current = true
              setDeviceName(v)
            }}
          />
        )}

        {stripped.length > 0 && (
          // Kept reachable from the profile, not only from the import modal:
          // "why does this profile not set my DNS" is a question asked months
          // after the modal that answered it was closed.
          <details className="disclosure">
            <summary className="disclosure-head">
              <ScrollText size={13} />
              {t('vpn.profileForm.strippedSummary', { count: stripped.length })}
            </summary>
            <div className="disclosure-body">
              {stripped.map((d, i) => (
                <div key={`${d.directive}-${i}`} className="col" style={{ gap: 2 }}>
                  <code
                    className="mono"
                    style={{
                      fontSize: 12,
                      color: d.severity === 'rejected' ? 'var(--danger)' : 'var(--warn)'
                    }}
                  >
                    {d.directive}
                  </code>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {d.reason}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

      </div>
    </Modal>
  )
}

/** Blocking problems that no field displayed.
 *
 *  A disabled Save must never be the only signal. Anything a field already
 *  showed inline is left out — repeating it in the footer just makes the real
 *  orphan harder to spot. */
function UnrenderedIssues({
  blocking,
  shown,
  nameMissing
}: {
  blocking: VpnValidationIssue[]
  shown: Set<string>
  nameMissing: boolean
}): React.JSX.Element | null {
  const t = useT()
  const orphans = blocking.filter((i) => !shown.has(i.path))
  if (orphans.length === 0 && !nameMissing) return null
  return (
    <div
      className="row"
      style={{ gap: 6, alignItems: 'flex-start', color: 'var(--danger)', fontSize: 11 }}
    >
      <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {nameMissing && <span>{t('vpn.profileForm.nameMissing')}</span>}
        {orphans.map((i) => (
          <span key={i.path + i.code}>{i.message}</span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- shared bits

/** The host platform, or null until the round trip lands.
 *
 *  Several fields read differently depending on what OpsMaxx ships here, and
 *  a wrong answer during the first frame is worse than a vague one, so callers
 *  are expected to treat null as "not yet known" rather than as a platform. */
function usePlatform(): NodeJS.Platform | null {
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)
  useEffect(() => {
    let live = true
    void window.opsmaxx?.platform().then((p) => {
      if (live) setPlatform(p)
    })
    return () => {
      live = false
    }
  }, [])
  return platform
}

/** Why system mode cannot be chosen here, or null when it can.
 *
 *  Kept in one place so the wording matches what the driver actually throws —
 *  a form that offers a mode the engine refuses is worse than one that never
 *  offered it. */
function useSystemModeBlocked(): string | null {
  const t = useT()
  const platform = usePlatform()
  if (platform !== 'darwin') return null
  return t('vpn.profileForm.systemModeBlocked')
}

/** A checkbox that turns a blocking validation error into an accepted choice.
 *
 *  Deliberately a real `<input type="checkbox">` rather than the app's `.switch`
 *  span: this gates a decision with a security consequence, and the span
 *  pattern has no role, no tab stop and no key handling, so it cannot be
 *  operated or perceived without a mouse. */
function Confirm({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <label
      className="row"
      style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 12 }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0 }}
      />
      <span style={{ color: checked ? 'var(--muted)' : 'var(--warn)' }}>{label}</span>
    </label>
  )
}

type IssueMap = Record<string, VpnValidationIssue>

/** Renders whatever main said about one dotted path in the spec, against the
 *  field that path names.
 *
 *  Matching is by **prefix**, so `at="dns"` also catches `dns[0]` and
 *  `at="auth"` catches `auth.tokenRef`. Exact matching meant a single bad DNS
 *  entry produced a blocking error that no field displayed — and `at="auth"`
 *  matched nothing at all, because the validator's paths are `auth.tokenRef`
 *  and `auth.method`.
 *
 *  `shown` collects every path this rendered, so the footer can list the ones
 *  no field claimed rather than leaving a disabled Save as the only signal. */
function Issue({
  at,
  map,
  shown
}: {
  at: string
  map: IssueMap
  shown?: Set<string>
}): React.JSX.Element | null {
  const matches = matchIssues(at, map)
  for (const m of matches) shown?.add(m.path)
  if (matches.length === 0) return null
  return (
    <>
      {matches.map((i) => (
        <span
          key={i.path + i.code}
          className="field-hint"
          style={{ color: i.severity === 'error' ? 'var(--danger)' : 'var(--warn)' }}
        >
          {i.message}
        </span>
      ))}
    </>
  )
}

/** Issues at `at` itself, or nested beneath it — `dns[0]`, `auth.tokenRef`,
 *  `peers[0].allowedIps[2]`. An error sorts before a warning. */
function matchIssues(at: string, map: IssueMap): VpnValidationIssue[] {
  const out: VpnValidationIssue[] = []
  for (const [path, issue] of Object.entries(map)) {
    if (path === at || path.startsWith(`${at}[`) || path.startsWith(`${at}.`)) out.push(issue)
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}

/** A local shape check next to the field, so a mistyped key is caught here
 *  rather than as a silent no-handshake ten seconds after Start. */
function Hint({
  ok,
  when,
  text
}: {
  ok: boolean
  when: boolean
  text: string
}): React.JSX.Element | null {
  if (!when || ok) return null
  return (
    <span className="field-hint" style={{ color: 'var(--warn)' }}>
      {text}
    </span>
  )
}

// ------------------------------------------------------------------ wireguard

interface WgProps {
  spec: WireGuardSpec
  issue: IssueMap
  shown: Set<string>
  onChange: (spec: WireGuardSpec) => void
  pending: PendingKey | null
  onPending: (p: PendingKey | null) => void
}

function WireGuardFields({
  spec,
  issue,
  onChange,
  shown,
  pending,
  onPending
}: WgProps): React.JSX.Element {
  const t = useT()
  const systemModeBlocked = useSystemModeBlocked()
  const set = (patch: Partial<WireGuardSpec>): void => onChange({ ...spec, ...patch })
  const setPeer = (i: number, patch: Partial<WireGuardPeer>): void =>
    set({ peers: spec.peers.map((p, n) => (n === i ? { ...p, ...patch } : p)) })

  return (
    <>
      <div className="field">
        <span className="field-label">{t('vpn.profileForm.mode')}</span>
        <div className="row" style={{ gap: 6 }}>
          {(['userspace', 'system'] as const).map((m) => (
            <button
              key={m}
              className={clsx('btn sm', spec.mode === m && 'primary')}
              // System mode is refused outright on macOS. Leaving the button
              // live meant it could be picked and saved, and only failed at
              // Start — the choice looked supported right up to the moment it
              // was not.
              disabled={m === 'system' && systemModeBlocked !== null}
              onClick={() => set({ mode: m })}
            >
              {m === 'userspace' ? t('vpn.profileForm.modeUserspace') : t('vpn.profileForm.modeSystem')}
            </button>
          ))}
        </div>
        {systemModeBlocked !== null && (
          // Next to the control, not in a tooltip: a disabled thing that does
          // not say why is just a dead end.
          <span className="field-hint" style={{ color: 'var(--warn)' }}>
            {systemModeBlocked}
          </span>
        )}
        <span className="field-hint">
          {spec.mode === 'userspace'
            ? t('vpn.profileForm.modeUserspaceHint')
            : t('vpn.profileForm.modeSystemHint')}
        </span>
      </div>

      <InterfaceKeyField
        spec={spec}
        issue={issue}
        shown={shown}
        pending={pending}
        onPending={onPending}
      />

      <label className="field">
        <span className="field-label">{t('vpn.profileForm.addresses')}</span>
        <input
          className="input"
          placeholder="10.0.0.2/32, fd00::2/128"
          value={listStr(spec.addresses)}
          onChange={(e) => set({ addresses: parseList(e.target.value) })}
        />
        <Issue at="addresses" map={issue} shown={shown} />
        <Hint
          when={spec.addresses.length > 0}
          ok={spec.addresses.every(isCidr)}
          text={t('vpn.profileForm.addressHint')}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span className="field-label">{t('vpn.profileForm.dns')}</span>
          <input
            className="input"
            placeholder="1.1.1.1"
            value={listStr(spec.dns)}
            onChange={(e) => set({ dns: parseList(e.target.value) })}
          />
          <Issue at="dns" map={issue} shown={shown} />
        </label>
        <label className="field">
          <span className="field-label">{t('vpn.profileForm.mtu')}</span>
          <input
            className="input"
            type="number"
            placeholder="1420"
            value={spec.mtu ?? ''}
            onChange={(e) => set({ mtu: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Issue at="mtu" map={issue} shown={shown} />
        </label>
      </div>

      <div className="field">
        <div className="row" style={{ gap: 8 }}>
          <span className="field-label">{t('vpn.profileForm.peers')}</span>
          <span className="grow" />
          <button
            className="btn sm"
            onClick={() =>
              set({ peers: [...spec.peers, { publicKey: '', endpoint: '', allowedIps: ['0.0.0.0/0'] }] })
            }
          >
            <Plus size={13} /> {t('vpn.profileForm.addPeer')}
          </button>
        </div>
        {spec.peers.map((p, i) => (
          <div key={i} className="hop-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder={t('vpn.profileForm.peerKeyPlaceholder')}
                value={p.publicKey}
                onChange={(e) => setPeer(i, { publicKey: e.target.value })}
              />
              <button
                className="icon-btn sm"
                title={t('vpn.profileForm.removePeer')}
                onClick={() => set({ peers: spec.peers.filter((_, n) => n !== i) })}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <Issue at={`peers[${i}].publicKey`} map={issue} />
            <Hint
              when={!!p.publicKey}
              ok={isWireGuardKey(p.publicKey)}
              text={t('vpn.profileForm.keyShapeHint')}
            />

            <div className="input-group">
              <input
                className="input"
                placeholder="vpn.example.com:51820"
                value={p.endpoint}
                onChange={(e) => setPeer(i, { endpoint: e.target.value })}
              />
              <input
                className="input"
                type="number"
                style={{ maxWidth: 130 }}
                placeholder={t('vpn.profileForm.keepalivePlaceholder')}
                value={p.persistentKeepalive ?? ''}
                onChange={(e) =>
                  setPeer(i, {
                    persistentKeepalive: e.target.value ? Number(e.target.value) : undefined
                  })
                }
              />
            </div>
            <Issue at={`peers[${i}].endpoint`} map={issue} />
            <Hint
              when={!!p.endpoint}
              ok={parseVpnEndpoint(p.endpoint) !== null}
              text={t('vpn.profileForm.endpointHint')}
            />

            <input
              className="input"
              placeholder={t('vpn.profileForm.allowedIpsPlaceholder')}
              value={listStr(p.allowedIps)}
              onChange={(e) => setPeer(i, { allowedIps: parseList(e.target.value) })}
            />
            <Issue at={`peers[${i}].allowedIps`} map={issue} />
          </div>
        ))}
      </div>

      {spec.mode === 'userspace' && (
        <ListenerFields
          listeners={spec.listeners}
          issue={issue} shown={shown}
          onChange={(listeners) => set({ listeners })}
        />
      )}
    </>
  )
}

// ------------------------------------------------------------ interface key

/** How long to leave a key alone before asking what its public half is. Longer
 *  than the validation debounce next door because this one spawns a process. */
const PUBKEY_DEBOUNCE_MS = 300

interface KeyFieldProps {
  spec: WireGuardSpec
  issue: IssueMap
  shown: Set<string>
  /** The pair the form is holding, if any. Written by Save, not by this field.
   *
   *  There is no `onChange` here any more, and its absence is the point: this
   *  field no longer touches the spec. It reports a pair upwards and the form
   *  decides, on Save, whether a `privateKeyRef` comes into existence. */
  pending: PendingKey | null
  onPending: (p: PendingKey | null) => void
}

/**
 * The interface key: generate one, or paste one, and see the public half.
 *
 * Two things make this the shape it is.
 *
 * The private key is a secret and the profile is plain JSON, so it never lives
 * on the spec — only a `privateKeyRef` into the vault does, exactly as an
 * imported profile's does.
 *
 * This field writes nothing. It mints, it derives, it hands the pair up to the
 * form, and the form writes it on Save through the same `stageImportedSecrets`
 * road an import travels. That split exists because the old arrangement stored
 * on the button press: opening the dialog, pressing Generate and pressing
 * Cancel left a vault entry no profile referenced. Cancel now discards the key
 * along with every other unsaved edit, which is what Cancel is for.
 *
 * The public key is the whole point. A private key nobody can get the public
 * half out of is a key you cannot use: it is what the server's `[Peer]` section
 * needs, or what the provider asks you to paste into their web form. So it is
 * shown large, in monospace, with a copy button, and it updates live while a
 * key is being pasted — including for a profile that was imported, which is the
 * one case where the answer was previously "run `wg pubkey` yourself".
 *
 * What is NOT here is the public key of a key already in the vault. The
 * renderer cannot read vault secrets, and adding a route so that it could —
 * just to display a value the user can also obtain by pasting the key back in —
 * would be a much worse trade than the sentence below saying so.
 */
function InterfaceKeyField({
  spec,
  issue,
  shown,
  pending,
  onPending
}: KeyFieldProps): React.JSX.Element {
  const t = useT()
  const [privateKey, setPrivateKey] = useState(pending?.privateKey ?? '')
  const [reveal, setReveal] = useState(false)
  const [publicKey, setPublicKey] = useState(pending?.publicKey ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bridge = window.opsmaxx?.vpn as Record<string, unknown> | undefined
  const canMint = bridgeHas(bridge, 'wireguardMint')
  const canDerive = bridgeHas(bridge, 'wireguardPublicKey')
  const shaped = isWireGuardKey(privateKey)
  const inVault = !!spec.privateKeyRef?.vaultEntryId
  // A usable key on screen that the form is not yet holding. Compared against
  // the pending pair rather than against the vault, because "will be saved" is
  // now the state that matters and the vault has not been touched.
  const dirty = shaped && publicKey !== '' && publicKey !== pending?.publicKey

  // Live `wg pubkey` while the user pastes. Cheap enough to run on a settled
  // keystroke and the only way the field is worth having.
  useEffect(() => {
    if (!shaped || !canDerive) {
      setPublicKey('')
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void window.opsmaxx?.vpn.wireguardPublicKey(privateKey).then((r) => {
        if (!live) return
        setPublicKey(r?.ok && r.publicKey ? r.publicKey : '')
      })
    }, PUBKEY_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [privateKey, shaped, canDerive])

  /** Mint a fresh pair. Nothing is stored — the form writes it on Save. */
  const mint = async (): Promise<void> => {
    if (!canMint || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.opsmaxx?.vpn.wireguardMint()
      if (!res?.ok || !res.privateKey || !res.publicKey) {
        setError(res?.error ?? t('vpn.profileForm.keyNotGenerated'))
        return
      }
      setPrivateKey(res.privateKey)
      setPublicKey(res.publicKey)
      // Not revealed on arrival: a freshly generated key on screen is a key on
      // screen, and the eye is right there for the moment it is wanted.
      setReveal(false)
      onPending({ privateKey: res.privateKey, publicKey: res.publicKey })
    } finally {
      setBusy(false)
    }
  }

  /** Take the key in the box. No IPC: its public half was already derived live
   *  by the effect above, which is the only thing adopting ever needed. */
  const adopt = (): void => {
    if (!shaped || publicKey === '') return
    setError(null)
    onPending({ privateKey, publicKey })
  }

  return (
    <div className="field">
      <div className="row" style={{ gap: 8 }}>
        <span className="field-label">{t('vpn.profileForm.interfaceKey')}</span>
        <span className="grow" />
        <button className="btn sm" disabled={!canMint || busy} onClick={() => void mint()}>
          <KeyRound size={13} /> {t('vpn.profileForm.generateKeypair')}
        </button>
      </div>

      <div className="row" style={{ gap: 6 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          type={reveal ? 'text' : 'password'}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            inVault
              ? t('vpn.profileForm.replaceKeyPlaceholder')
              : t('vpn.profileForm.pasteKeyPlaceholder')
          }
          value={privateKey}
          onChange={(e) => {
            const next = e.target.value.trim()
            setError(null)
            setPrivateKey(next)
            // Emptying the box drops the held key.
            //
            // Otherwise the form goes on holding a pair the field no longer
            // shows, and Save writes a key the user has visibly deleted. This
            // is not the old behaviour — clearing the box could not unstore a
            // key that was already in the vault — but nothing is in the vault
            // yet, so the honest reading of an empty box is "not this one".
            if (next === '' && pending) onPending(null)
          }}
        />
        <button
          className="icon-btn sm"
          title={reveal ? t('vpn.profileForm.hidePrivateKey') : t('vpn.profileForm.showPrivateKey')}
          onClick={() => setReveal((v) => !v)}
        >
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
        <button
          className="icon-btn sm"
          title={t('vpn.profileForm.copyPrivateKey')}
          disabled={!privateKey}
          onClick={() => copyValue(t('vpn.profileForm.privateKeyCopied'), privateKey)}
        >
          <Copy size={14} />
        </button>
      </div>
      <Issue at="privateKeyRef" map={issue} shown={shown} />
      <Hint
        when={privateKey !== ''}
        ok={shaped}
        text={t('vpn.profileForm.keyShapeHint')}
      />

      {dirty && (
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary sm" disabled={busy} onClick={adopt}>
            {inVault ? t('vpn.profileForm.replaceStoredKey') : t('vpn.profileForm.useThisKey')}
          </button>
          <span className="field-hint">
            {inVault
              ? t('vpn.profileForm.stillUsesVaultKey')
              : t('vpn.profileForm.stillUsesNoKey')}
          </span>
        </div>
      )}

      {pending !== null && !dirty && (
        // The state that did not exist before: a real key, held, not yet
        // written. Saying so plainly is the price of deferring the write — a
        // user who generated a key and closed the window has to be able to tell
        // whether they have one.
        <span className="field-hint">
          {inVault
            ? t('vpn.profileForm.pendingReplaces')
            : t('vpn.profileForm.pendingSaves')}
        </span>
      )}

      {publicKey !== '' && (
        // Large, monospace and copyable, because this is the value that leaves
        // the machine: it goes in the server's [Peer] section, or into the
        // provider's form. A public key you cannot get out is a keypair you
        // cannot use.
        <div className="hop-card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">{t('vpn.profileForm.publicKey')}</span>
          <div className="row" style={{ gap: 6 }}>
            <code className="mono" style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>
              {publicKey}
            </code>
            <button
              className="icon-btn sm"
              title={t('vpn.profileForm.copyPublicKey')}
              onClick={() => copyValue(t('vpn.profileForm.publicKeyCopied'), publicKey)}
            >
              <Copy size={14} />
            </button>
          </div>
          <span className="field-hint">
            {t('vpn.profileForm.publicKeyHint')}
          </span>
        </div>
      )}

      {error !== null && (
        <span className="field-hint" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}

      <span className="field-hint">
        {!canMint
          ? t('vpn.profileForm.keyHintCannotMint')
          : dirty
            ? // The row above already says what to do about it; repeating
              // "stored in the vault" here would be a straight contradiction.
              t('vpn.profileForm.keyHintDirty')
            : pending !== null
              ? // Deliberately not "held in the vault", which is what this said
                // when the write happened on the button press. It is held here,
                // in an unsaved form, and Cancel throws it away.
                t('vpn.profileForm.keyHintPending')
              : inVault
                ? t('vpn.profileForm.keyHintInVault')
                : t('vpn.profileForm.keyHintNone')}
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ listeners

interface ListenerProps {
  listeners: VpnListener[]
  issue: IssueMap
  shown: Set<string>
  onChange: (l: VpnListener[]) => void
}

function ListenerFields({ listeners, issue, onChange, shown }: ListenerProps): React.JSX.Element {
  const t = useT()
  const replace = (i: number, next: VpnListener): void =>
    onChange(listeners.map((l, n) => (n === i ? next : l)))

  return (
    <div className="field">
      <div className="row" style={{ gap: 8 }}>
        <span className="field-label">{t('vpn.profileForm.localListeners')}</span>
        <span className="grow" />
        <button
          className="btn sm"
          onClick={() =>
            onChange([...listeners, { kind: 'socks5', bindHost: '127.0.0.1', bindPort: 1080 }])
          }
        >
          <Plus size={13} /> {t('vpn.profileForm.addListener')}
        </button>
      </div>
      <span className="field-hint">
        {t('vpn.profileForm.listenersHint')}
      </span>
      {listeners.map((l, i) => (
        <div key={i} className="hop-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="input-group">
            <select
              className="input"
              style={{ maxWidth: 110 }}
              value={l.kind}
              onChange={(e) => {
                const kind = e.target.value as VpnListener['kind']
                replace(
                  i,
                  kind === 'forward'
                    ? { kind, bindHost: l.bindHost, bindPort: l.bindPort, targetHost: '', targetPort: 0 }
                    : { kind, bindHost: l.bindHost, bindPort: l.bindPort }
                )
              }}
            >
              <option value="socks5">SOCKS5</option>
              <option value="http">{t('vpn.profileForm.listenerHttp')}</option>
              <option value="forward">{t('vpn.profileForm.listenerForward')}</option>
            </select>
            <input
              className="input"
              placeholder="127.0.0.1"
              value={l.bindHost}
              onChange={(e) => replace(i, { ...l, bindHost: e.target.value })}
            />
            <input
              className="input"
              type="number"
              style={{ maxWidth: 110 }}
              placeholder={t('vpn.profileForm.portPlaceholder')}
              value={l.bindPort || ''}
              onChange={(e) => replace(i, { ...l, bindPort: Number(e.target.value) })}
            />
            <button
              className="icon-btn sm"
              title={t('vpn.profileForm.removeListener')}
              onClick={() => onChange(listeners.filter((_, n) => n !== i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          {l.kind === 'forward' && (
            <div className="input-group">
              <input
                className="input"
                placeholder={t('vpn.profileForm.targetHostPlaceholder')}
                value={l.targetHost}
                onChange={(e) => replace(i, { ...l, targetHost: e.target.value })}
              />
              <input
                className="input"
                type="number"
                style={{ maxWidth: 110 }}
                placeholder={t('vpn.profileForm.targetPortPlaceholder')}
                value={l.targetPort || ''}
                onChange={(e) => replace(i, { ...l, targetPort: Number(e.target.value) })}
              />
            </div>
          )}
          <Issue at={`listeners[${i}].bindHost`} map={issue} shown={shown} />
          <Issue at={`listeners[${i}].bindPort`} map={issue} shown={shown} />
          {/* A Forward listener seeds an empty target host and port 0, so these
              two are the errors a user is most likely to be staring at — and
              they were the ones with no field to appear against. */}
          <Issue at={`listeners[${i}].targetHost`} map={issue} shown={shown} />
          <Issue at={`listeners[${i}].targetPort`} map={issue} shown={shown} />
          <BindWarning host={l.bindHost} what="listener" />
        </div>
      ))}
    </div>
  )
}

// -------------------------------------------------------------------- openvpn

interface OvpnProps {
  spec: OpenVpnSpec
  issue: IssueMap
  shown: Set<string>
  onChange: (spec: OpenVpnSpec) => void
  focus?: VpnFormFocus
}

const AUTH_LABEL: Record<OpenVpnAuthMode, MessageKey> = {
  none: 'vpn.profileForm.authNone',
  userpass: 'vpn.profileForm.authUserpass',
  'userpass-otp': 'vpn.profileForm.authUserpassOtp'
}

/**
 * Tailscale, which has almost nothing to configure — and that is the design.
 *
 * The daemon holds its own state and its own login; this profile is the app's
 * view of it. What IS worth exposing is the two things the driver reads: where
 * the CLI is, for an install the standard search does not find, and whether to
 * list the tailnet's devices. Without a form for them a profile could be
 * created and then never changed, and `showPeers` could never be turned on at
 * all — so `peersFrom` always returned an empty list.
 */
interface TailscaleProps {
  spec: TailscaleSpec
  issue: IssueMap
  shown: Set<string>
  onChange: (spec: TailscaleSpec) => void
  /** This machine's own name for the node. Not part of the spec — it is stored
   *  per device, so it is held and saved separately. */
  deviceName: string
  onDeviceName: (v: string) => void
}

function TailscaleFields({
  spec,
  issue,
  shown,
  onChange,
  deviceName,
  onDeviceName
}: TailscaleProps): React.JSX.Element {
  const t = useT()
  const set = (patch: Partial<TailscaleSpec>): void => onChange({ ...spec, ...patch })
  // The same function the driver calls, so what this says is what `ts.up` gets.
  // Two fields where one wins is exactly the place a second implementation of
  // the rule would drift and start describing a node nobody has.
  const effective = tailscaleHostname(spec, deviceName)
  const overridden = effective !== spec.hostname
  return (
    <>
      <div className="field">
        <span className="field-hint">
          {t('vpn.profileForm.tailscaleIntro')}
        </span>
      </div>

      <label className="field">
        <span className="field-label">{t('vpn.profileForm.deviceNameShared')}</span>
        <input
          className="input"
          placeholder="opsmaxx"
          value={spec.hostname ?? ''}
          onChange={(e) => set({ hostname: e.target.value || undefined })}
        />
        <Issue at="hostname" map={issue} shown={shown} />
        <span className="field-hint">
          <Trans i18nKey="vpn.profileForm.deviceNameSharedHint" components={{ code: <code /> }} />
        </span>
      </label>

      <label className="field">
        <span className="field-label">{t('vpn.profileForm.deviceNameLocal')}</span>
        <input
          className="input"
          placeholder={spec.hostname ?? 'opsmaxx'}
          value={deviceName}
          onChange={(e) => onDeviceName(e.target.value)}
        />
        <span className="field-hint">
          {t('vpn.profileForm.deviceNameLocalHint')}
        </span>
      </label>

      <div className="field">
        {/* What the node will actually be called, spelled out. Two name fields
            where one wins is a question the user should not have to answer by
            starting the tunnel and looking at the admin console. */}
        <span className="field-hint">
          {effective ? (
            <Trans
              i18nKey={overridden ? 'vpn.profileForm.appearsAsOverridden' : 'vpn.profileForm.appearsAs'}
              values={{ name: effective }}
              components={{ code: <code /> }}
            />
          ) : (
            t('vpn.profileForm.noDeviceName')
          )}
        </span>
      </div>

      <label className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={spec.showPeers === true}
          onChange={(e) => set({ showPeers: e.target.checked })}
        />
        <span className="field-hint">
          {t('vpn.profileForm.showPeersHint')}
        </span>
      </label>
    </>
  )
}

function OpenVpnFields({ spec, issue, onChange, shown, focus }: OvpnProps): React.JSX.Element {
  const t = useT()
  const set = (patch: Partial<OpenVpnSpec>): void => onChange({ ...spec, ...patch })
  const platform = usePlatform()

  return (
    <>
      <label className="field">
        <span className="field-label">{t('vpn.profileForm.authentication')}</span>
        <select
          className="input"
          value={spec.authMode}
          onChange={(e) => set({ authMode: e.target.value as OpenVpnAuthMode })}
        >
          {(Object.keys(AUTH_LABEL) as OpenVpnAuthMode[]).map((m) => (
            <option key={m} value={m}>
              {t(AUTH_LABEL[m])}
            </option>
          ))}
        </select>
        <Issue at="authMode" map={issue} shown={shown} />
        <span className="field-hint">
          {t('vpn.profileForm.openvpnCredentialsHint')}
        </span>
      </label>

      {spec.remotes && spec.remotes.length > 0 && (
        <div className="field">
          <span className="field-label">{t('vpn.profileForm.remotes')}</span>
          <div className="col" style={{ gap: 2 }}>
            {spec.remotes.map((r, i) => (
              <span key={i} className="mono" style={{ fontSize: 12 }}>
                {r.host}:{r.port} {r.proto}
              </span>
            ))}
          </div>
          {/* Read-only: they come out of the sanitised config body in the vault,
              and editing them here would desynchronise the two. */}
          <span className="field-hint">{t('vpn.profileForm.remotesHint')}</span>
        </div>
      )}

      <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Switch
          checked={!!spec.redirectGateway}
          style={{ marginTop: 1 }}
          onChange={(v) => set({ redirectGateway: v })}
        />
        <span style={{ fontSize: 12, color: spec.redirectGateway ? 'var(--warn)' : 'var(--text-muted)' }}>
          {t('vpn.profileForm.redirectGateway')}
        </span>
      </label>

      {spec.staticChallenge && (
        <div className="field">
          <span className="field-label">{t('vpn.profileForm.staticChallenge')}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {spec.staticChallenge.text}
          </span>
        </div>
      )}

      <label className="field">
        <span className="field-label">{t('vpn.profileForm.openvpnBinary')}</span>
        <input
          className="input"
          placeholder={t('vpn.profileForm.detectedAutomatically')}
          // Opened from a "could not find OpenVPN" failure, this is the field
          // that answers it — so the caret is already in it, and the browser
          // scrolls it into view for free.
          autoFocus={focus === 'binaryPath'}
          value={spec.binaryPath ?? ''}
          onChange={(e) => set({ binaryPath: e.target.value || undefined })}
        />
        <Issue at="binaryPath" map={issue} shown={shown} />
        {/* Which of these is true depends on whether we ship OpenVPN here, and
            `shared/vpnEngines.ts` is the one place that knows. Deliberately not
            phrased as "on Windows": the day another platform drops off that
            list, naming the platform here would be the thing that goes stale. */}
        <span className="field-hint">
          {userSuppliesEngine('openvpn', platform)
            ? t('vpn.profileForm.binaryHintUserSupplied')
            : platform
              ? t('vpn.profileForm.binaryHintBundled')
              : t('vpn.profileForm.binaryHintUnknown')}
        </span>
      </label>
    </>
  )
}

// ------------------------------------------------------------------------ frp

interface FrpProps {
  spec: FrpSpec
  issue: IssueMap
  shown: Set<string>
  onChange: (spec: FrpSpec) => void
  focus?: VpnFormFocus
}

function FrpFields({ spec, issue, onChange, shown, focus }: FrpProps): React.JSX.Element {
  const t = useT()
  const set = (patch: Partial<FrpSpec>): void => onChange({ ...spec, ...patch })

  // The proxy list is below the server and transport fields, so a form opened
  // from "confirm what this exposes" starts scrolled past the checkbox it was
  // opened for. Once, on mount: re-running it while the user types would drag
  // the page back every keystroke.
  const proxiesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focus === 'proxies') proxiesRef.current?.scrollIntoView({ block: 'center' })
  }, [focus])

  // Re-keys `proxies[3].localPort` to `localPort` for the row that owns it, so
  // the editor does not have to know its own index.
  const proxyIssues = (i: number): Record<string, string> => {
    const prefix = `proxies[${i}].`
    const out: Record<string, string> = {}
    for (const [path, v] of Object.entries(issue)) {
      if (path.startsWith(prefix)) out[path.slice(prefix.length)] = v.message
    }
    return out
  }

  const addProxy = (): void =>
    set({
      proxies: [
        ...spec.proxies,
        {
          name: `proxy-${spec.proxies.length + 1}`,
          type: 'tcp',
          localIp: '127.0.0.1',
          localPort: 0,
          acknowledgedExposure: false
        } satisfies FrpProxy
      ]
    })

  return (
    <>
      <div className="field-row">
        <label className="field">
          <span className="field-label">{t('vpn.profileForm.serverAddress')}</span>
          <input
            className="input"
            placeholder="frp.example.com"
            value={spec.serverAddr}
            onChange={(e) => set({ serverAddr: e.target.value })}
          />
          <Issue at="serverAddr" map={issue} shown={shown} />
        </label>
        <label className="field">
          <span className="field-label">{t('vpn.profileForm.serverPort')}</span>
          <input
            className="input"
            type="number"
            placeholder="7000"
            value={spec.serverPort || ''}
            onChange={(e) => set({ serverPort: Number(e.target.value) })}
          />
          <Issue at="serverPort" map={issue} shown={shown} />
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field-label">{t('vpn.profileForm.transport')}</span>
          <select
            className="input"
            value={spec.transport.protocol}
            onChange={(e) =>
              set({
                transport: {
                  ...spec.transport,
                  protocol: e.target.value as FrpSpec['transport']['protocol']
                }
              })
            }
          >
            {(['tcp', 'kcp', 'quic', 'websocket', 'wss'] as const).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('vpn.profileForm.corporateProxy')}</span>
          <input
            className="input"
            placeholder="http://proxy:8080"
            value={spec.transport.proxyUrl ?? ''}
            onChange={(e) =>
              set({ transport: { ...spec.transport, proxyUrl: e.target.value || undefined } })
            }
          />
          <Issue at="transport.proxyUrl" map={issue} shown={shown} />
        </label>
      </div>

      <label className="row" style={{ gap: 8 }}>
        <Switch
          checked={spec.transport.tlsEnable}
          onChange={(v) => set({ transport: { ...spec.transport, tlsEnable: v } })}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {t('vpn.profileForm.tlsEnable')}
        </span>
      </label>

      {/* Turning TLS off is a blocking error unless it is confirmed, and until
          this existed there was no control anywhere that could confirm it — the
          profile simply became unsavable, with "1 problem to fix" as the only
          explanation. The confirmation is stored on the spec, so it satisfies
          validation at start time too rather than only in this form. */}
      {!spec.transport.tlsEnable && (
        <Confirm
          checked={spec.confirmations?.allowPlaintextTransport === true}
          onChange={(v) =>
            set({ confirmations: { ...spec.confirmations, allowPlaintextTransport: v } })
          }
          label={t('vpn.profileForm.plaintextConfirm')}
        />
      )}

      <div className="field">
        <span className="field-label">{t('vpn.profileForm.authentication')}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          {spec.auth.method === 'oidc'
            ? t('vpn.profileForm.authOidc', {
                client: spec.auth.oidc?.clientId ?? t('vpn.profileForm.clientNotSet')
              })
            : spec.auth.tokenRef
              ? t('vpn.profileForm.tokenInVault')
              : t('vpn.profileForm.tokenMissing')}
        </span>
        <Issue at="auth" map={issue} shown={shown} />
      </div>

      <div className="divider" />

      <div className="field" ref={proxiesRef}>
        <div className="row" style={{ gap: 8 }}>
          <span className="field-label">{t('vpn.profileForm.proxies')}</span>
          <span className="grow" />
          <button className="btn sm" onClick={addProxy}>
            <Plus size={13} /> {t('vpn.profileForm.addProxy')}
          </button>
        </div>
        {spec.proxies.length === 0 && (
          <span className="field-hint">{t('vpn.profileForm.noProxies')}</span>
        )}
        {spec.proxies.map((p, i) => (
          <FrpProxyEditor
            key={i}
            proxy={p}
            serverAddr={spec.serverAddr}
            issues={proxyIssues(i)}
            onChange={(next) => set({ proxies: spec.proxies.map((q, n) => (n === i ? next : q)) })}
            onRemove={() => set({ proxies: spec.proxies.filter((_, n) => n !== i) })}
          />
        ))}
      </div>

      {spec.visitors.length > 0 && (
        <div className="field">
          <span className="field-label">{t('vpn.profileForm.visitors')}</span>
          {spec.visitors.map((v, i) => (
            <div key={i} className="col" style={{ gap: 4 }}>
              <span className="mono" style={{ fontSize: 12 }}>
                {t('vpn.profileForm.visitorLine', {
                  name: v.name,
                  type: v.type,
                  server: v.serverName,
                  address: `${v.bindAddr}:${v.bindPort}`
                })}
              </span>
              <BindWarning host={v.bindAddr} what="visitor" />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
