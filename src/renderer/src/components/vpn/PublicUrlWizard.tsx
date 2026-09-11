import { useEffect, useState } from 'react'
import { Check, Copy, Globe, Loader2, Share2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { clsx } from '../../lib/format'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { isVpnRunning } from '../../../../shared/vpn'
import type { NgrokSpec, VpnProfile } from '../../../../shared/vpn'
import { headline } from './useVpnProfiles'

/**
 * "Get a public URL", asked as the question it actually is.
 *
 * The button used to mean frp and only frp, so an install whose ngrok profile
 * was the thing set up got the frp readiness gaps instead -- an answer about a
 * tunnel server it had deliberately not configured. Both providers do the same
 * job from the user's side, and which one is right depends on what they already
 * have, so the button asks instead of assuming.
 *
 * It ends on the URL. That is the whole point of the feature and it was the one
 * thing the flow did not produce: ngrok assigns a fresh hostname on every run
 * without a reserved domain, so if the wizard does not hand it over there is
 * nowhere else to read it from.
 *
 * frp is delegated to `FrpPublishDialog`, which already does this properly --
 * it spells out both ends of the exposure and owns the acknowledgement gate.
 * Only the ngrok half is new.
 */

type Provider = 'ngrok' | 'frp'

interface PublicUrlWizardProps {
  localPort: number
  /** Ready to publish through frp: the caller has a configured tunnel server. */
  frpReady: boolean
  /** What frp is missing, in the caller's words, when it is not ready. */
  frpGap: string | null
  onPickFrp: () => void
  onSetUpFrp: () => void
  onAddNgrok: () => void
  onClose: () => void
}

export function PublicUrlWizard({
  localPort,
  frpReady,
  frpGap,
  onPickFrp,
  onSetUpFrp,
  onAddNgrok,
  onClose
}: PublicUrlWizardProps): React.JSX.Element {
  const profiles = useApp((s) => s.vpns)
  const statuses = useApp((s) => s.vpnStatuses)
  const upsertVpnProfile = useApp((s) => s.upsertVpnProfile)

  // An ngrok profile that could actually publish: it has an authtoken. One
  // without is a profile the engine will refuse, so offering it here would be
  // offering a route that ends in an error.
  const ngrokProfile = profiles.find(
    (p): p is VpnProfile & { spec: NgrokSpec } =>
      p.spec.kind === 'ngrok' && !!p.spec.authtokenRef
  )

  const [provider, setProvider] = useState<Provider | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState<string | null>(null)

  const local = `127.0.0.1:${localPort}`

  /**
   * The URL, once the engine has one.
   *
   * Read from the status bus rather than from the start call's own reply,
   * because a profile that was already running never makes that call -- and
   * because the bus is what the rest of the app reads, so anything that works
   * here works on the row too.
   */
  const liveUrl = (id: string): string | null => {
    const st = statuses[id]
    if (!st || !isVpnRunning(st.state)) return null
    return st.stats?.endpoints?.[0]?.publicUrl ?? null
  }

  useEffect(() => {
    if (!busy || !ngrokProfile) return
    const found = liveUrl(ngrokProfile.id)
    if (found) {
      setUrl(found)
      setBusy(false)
    }
  })

  const publishNgrok = async (): Promise<void> => {
    if (!ngrokProfile || !acknowledged || busy) return
    setBusy(true)
    try {
      // One endpoint per port. Re-publishing a port already on the profile
      // reuses its entry rather than adding a second endpoint for the same
      // thing -- some ngrok plans allow only one endpoint per session, and two
      // for one port would spend that allowance on a duplicate.
      const existing = ngrokProfile.spec.tunnels.find((t) => t.localPort === localPort)
      const name = existing?.name ?? `port-${localPort}`
      const tunnels = existing
        ? ngrokProfile.spec.tunnels.map((t) =>
            t.localPort === localPort ? { ...t, acknowledgedExposure: true } : t
          )
        : [
            ...ngrokProfile.spec.tunnels,
            {
              name,
              proto: 'http' as const,
              localPort,
              // The gate the engine enforces, ticked by the switch below rather
              // than by this code deciding on the user's behalf.
              acknowledgedExposure: true
            }
          ]
      const spec: NgrokSpec = { ...ngrokProfile.spec, tunnels }
      upsertVpnProfile({ ...ngrokProfile, spec })

      const st = statuses[ngrokProfile.id]
      const running = st ? isVpnRunning(st.state) : false
      const result = await withVaultUnlock(`Publishing ${local}`, () =>
        running
          ? window.opsmaxx!.vpn.reload(ngrokProfile.id)
          : window.opsmaxx!.vpn.start(ngrokProfile.id)
      )
      if (result && result.ok === false) {
        // The endpoint stays on the profile: it is valid and confirmed, and
        // what failed is the engine. The row's Start button is the shortest way
        // to try again, and it now shows the reason.
        toast(headline(result.error ?? 'ngrok would not start.'), 'error')
        setBusy(false)
        onClose()
        return
      }
      // The URL arrives on the status bus; the effect above closes this out.
      // It is not read from `result` because a profile that was already running
      // returns from `reload` without one.
    } catch (e) {
      toast(headline(e instanceof Error ? e.message : 'ngrok would not start.'), 'error')
      setBusy(false)
    }
  }

  const copy = (): void => {
    if (!url) return
    window.opsmaxx?.clipboard.write(url)
    toast('Public URL copied', 'ok')
  }

  // ---------------------------------------------------------------- the URL
  if (url) {
    return (
      <Modal
        title="Your service is public"
        subtitle={local}
        onClose={onClose}
        cancelLabel="Done"
        confirm={{ label: 'Copy URL', onClick: copy }}
      >
        <div className="col" style={{ gap: 10 }}>
          <div className="hop-card row" style={{ gap: 8, alignItems: 'center' }}>
            <Check size={15} style={{ color: 'var(--ok)', flex: 'none' }} />
            <span className="mono selectable" style={{ wordBreak: 'break-all' }}>
              {url}
            </span>
            <span className="grow" />
            <button className="icon-btn sm" title={`Copy ${url}`} onClick={copy}>
              <Copy size={14} />
            </button>
          </div>
          <p className="s-desc">
            Anyone with this address reaches {local} on this machine, for as long as the profile
            is running. Stopping it takes the address away.
          </p>
          <p className="s-desc">
            ngrok assigns a new address each run unless the account has a reserved domain, so this
            one will not survive a restart.
          </p>
        </div>
      </Modal>
    )
  }

  // ------------------------------------------------------- waiting on ngrok
  if (busy) {
    return (
      <Modal title="Publishing…" subtitle={local} onClose={onClose} cancelLabel={null}>
        <div className="row" style={{ gap: 10, alignItems: 'center', padding: '8px 0' }}>
          <Loader2 size={18} className="spin" />
          <span>Asking ngrok for an address for {local}.</span>
        </div>
      </Modal>
    )
  }

  // ------------------------------------------------- ngrok exposure consent
  if (provider === 'ngrok' && ngrokProfile) {
    return (
      <Modal
        title="Publish through ngrok"
        subtitle={ngrokProfile.name}
        onClose={onClose}
        confirm={{
          label: 'Get the URL',
          disabled: !acknowledged,
          onClick: () => void publishNgrok()
        }}
      >
        <div className="col" style={{ gap: 14 }}>
          {/* The port written out in full, not "this port". 3000 and 3306 are
              one keystroke apart and one of them is a database. */}
          <div className="hop-card col" style={{ gap: 6 }}>
            <span style={{ fontSize: 'var(--fs-body)' }}>
              This makes <b className="mono">{local}</b> reachable from the public internet.
            </span>
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
              Anyone who has the address can reach it. There is no password in front of it unless
              your own service has one.
            </span>
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
              Traffic crosses ngrok's servers to get here.
            </span>
          </div>

          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span
              className={clsx('switch', acknowledged && 'on')}
              style={{ marginTop: 1 }}
              role="switch"
              tabIndex={0}
              aria-checked={acknowledged}
              aria-label={`Make ${local} reachable from the public internet`}
              onClick={() => setAcknowledged(!acknowledged)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  setAcknowledged(!acknowledged)
                }
              }}
            />
            <span
              style={{
                fontSize: 'var(--fs-sm)',
                color: acknowledged ? 'var(--text-muted)' : 'var(--warn)'
              }}
            >
              I want {local} reachable from the public internet.
            </span>
          </label>
        </div>
      </Modal>
    )
  }

  // ------------------------------------------------------- the choice itself
  return (
    <Modal title="Get a public URL" subtitle={local} onClose={onClose}>
      <div className="col" style={{ gap: 10 }}>
        <p className="s-desc" style={{ marginTop: 0 }}>
          Both of these put {local} on the internet. Which one is right depends on what you
          already have.
        </p>

        <button
          type="button"
          className="setup-q"
          onClick={() => (ngrokProfile ? setProvider('ngrok') : onAddNgrok())}
        >
          <span className="setup-tick on" aria-hidden="true">
            <Globe size={13} />
          </span>
          <span className="setup-q-body">
            <span className="setup-q-title">ngrok</span>
            <span className="setup-q-detail">
              ngrok gives you the address and runs the server. Nothing to host.
            </span>
            <span className="setup-q-cost">
              {ngrokProfile
                ? 'Ready — an authtoken is in the vault.'
                : 'Needs a free ngrok account authtoken. Set one up now.'}
            </span>
          </span>
        </button>

        <button
          type="button"
          className="setup-q"
          onClick={() => (frpReady ? onPickFrp() : onSetUpFrp())}
        >
          <span className="setup-tick on" aria-hidden="true">
            <Share2 size={13} />
          </span>
          <span className="setup-q-body">
            <span className="setup-q-title">Your own frp server</span>
            <span className="setup-q-detail">
              The address is on a domain you control, and the traffic crosses only your server.
            </span>
            <span className="setup-q-cost">
              {frpReady ? 'Ready — a tunnel server is configured.' : (frpGap ?? 'Needs a server you control.')}
            </span>
          </span>
        </button>
      </div>
    </Modal>
  )
}
