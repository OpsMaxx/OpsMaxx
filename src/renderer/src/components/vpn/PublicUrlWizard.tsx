import { useEffect, useState } from 'react'
import { Check, Copy, Globe, Loader2, Share2 } from 'lucide-react'
import { Modal } from '../common/Modal'
import { useApp } from '../../store/app'
import { toast } from '../../store/toast'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { isVpnRunning } from '../../../../shared/vpn'
import type { NgrokSpec, VpnProfile } from '../../../../shared/vpn'
import { headline } from './useVpnProfiles'
import { Switch } from '../common/Switch'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

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
  const t = useT()
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
      const existing = ngrokProfile.spec.tunnels.find((tn) => tn.localPort === localPort)
      const name = existing?.name ?? `port-${localPort}`
      const tunnels = existing
        ? ngrokProfile.spec.tunnels.map((tn) =>
            tn.localPort === localPort ? { ...tn, acknowledgedExposure: true } : tn
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
      const result = await withVaultUnlock(t('vpn.publicUrl.unlockReason', { local }), () =>
        running
          ? window.opsmaxx!.vpn.reload(ngrokProfile.id)
          : window.opsmaxx!.vpn.start(ngrokProfile.id)
      )
      if (result && result.ok === false) {
        // The endpoint stays on the profile: it is valid and confirmed, and
        // what failed is the engine. The row's Start button is the shortest way
        // to try again, and it now shows the reason.
        toast(headline(result.error ?? t('vpn.publicUrl.ngrokFailed')), 'error')
        setBusy(false)
        onClose()
        return
      }
      // The URL arrives on the status bus; the effect above closes this out.
      // It is not read from `result` because a profile that was already running
      // returns from `reload` without one.
    } catch (e) {
      toast(headline(e instanceof Error ? e.message : t('vpn.publicUrl.ngrokFailed')), 'error')
      setBusy(false)
    }
  }

  const copy = (): void => {
    if (!url) return
    window.opsmaxx?.clipboard.write(url)
    toast(t('vpn.publicUrl.copied'), 'ok')
  }

  // ---------------------------------------------------------------- the URL
  if (url) {
    return (
      <Modal
        title={t('vpn.publicUrl.doneTitle')}
        subtitle={local}
        onClose={onClose}
        cancelLabel={t('common.done')}
        confirm={{ label: t('vpn.publicUrl.copyUrl'), onClick: copy }}
      >
        <div className="col" style={{ gap: 10 }}>
          <div className="hop-card row" style={{ gap: 8, alignItems: 'center' }}>
            <Check size={15} style={{ color: 'var(--ok)', flex: 'none' }} />
            <span className="mono selectable" style={{ wordBreak: 'break-all' }}>
              {url}
            </span>
            <span className="grow" />
            <button className="icon-btn sm" title={t('vpn.publicUrl.copyTitle', { url })} onClick={copy}>
              <Copy size={14} />
            </button>
          </div>
          <p className="s-desc">
            {t('vpn.publicUrl.doneReach', { local })}
          </p>
          <p className="s-desc">
            {t('vpn.publicUrl.doneEphemeral')}
          </p>
        </div>
      </Modal>
    )
  }

  // ------------------------------------------------------- waiting on ngrok
  if (busy) {
    return (
      <Modal title={t('vpn.publicUrl.publishingTitle')} subtitle={local} onClose={onClose} cancelLabel={null}>
        <div className="row" style={{ gap: 10, alignItems: 'center', padding: '8px 0' }}>
          <Loader2 size={18} className="spin" />
          <span>{t('vpn.publicUrl.asking', { local })}</span>
        </div>
      </Modal>
    )
  }

  // ------------------------------------------------- ngrok exposure consent
  if (provider === 'ngrok' && ngrokProfile) {
    return (
      <Modal
        title={t('vpn.publicUrl.ngrokTitle')}
        subtitle={ngrokProfile.name}
        onClose={onClose}
        confirm={{
          label: t('vpn.publicUrl.getUrl'),
          disabled: !acknowledged,
          onClick: () => void publishNgrok()
        }}
      >
        <div className="col" style={{ gap: 14 }}>
          {/* The port written out in full, not "this port". 3000 and 3306 are
              one keystroke apart and one of them is a database. */}
          <div className="hop-card col" style={{ gap: 6 }}>
            <span style={{ fontSize: 'var(--fs-body)' }}>
              <Trans
                i18nKey="vpn.publicUrl.ngrokReach"
                values={{ local }}
                components={{ b: <b className="mono" /> }}
              />
            </span>
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
              {t('vpn.publicUrl.ngrokAudience')}
            </span>
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
              {t('vpn.publicUrl.ngrokRoute')}
            </span>
          </div>

          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Switch
              checked={acknowledged}
              label={t('vpn.publicUrl.ngrokSwitch', { local })}
              style={{ marginTop: 1 }}
              onChange={setAcknowledged}
            />
            <span
              style={{
                fontSize: 'var(--fs-sm)',
                color: acknowledged ? 'var(--text-muted)' : 'var(--warn)'
              }}
            >
              {t('vpn.publicUrl.ngrokAck', { local })}
            </span>
          </label>
        </div>
      </Modal>
    )
  }

  // ------------------------------------------------------- the choice itself
  return (
    <Modal title={t('vpn.publicUrl.chooseTitle')} subtitle={local} onClose={onClose}>
      <div className="col" style={{ gap: 10 }}>
        <p className="s-desc" style={{ marginTop: 0 }}>
          {t('vpn.publicUrl.chooseIntro', { local })}
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
              {t('vpn.publicUrl.ngrokDetail')}
            </span>
            <span className="setup-q-cost">
              {ngrokProfile
                ? t('vpn.publicUrl.ngrokReady')
                : t('vpn.publicUrl.ngrokNeeds')}
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
            <span className="setup-q-title">{t('vpn.publicUrl.frpTitle')}</span>
            <span className="setup-q-detail">
              {t('vpn.publicUrl.frpDetail')}
            </span>
            <span className="setup-q-cost">
              {frpReady ? t('vpn.publicUrl.frpReady') : (frpGap ?? t('vpn.publicUrl.frpNeeds'))}
            </span>
          </span>
        </button>
      </div>
    </Modal>
  )
}
