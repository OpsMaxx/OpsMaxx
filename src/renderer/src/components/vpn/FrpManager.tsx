import { useState } from 'react'
import { Copy, Globe, Share2 } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { useApp, useWorkspaceVpns } from '../../store/app'
import { toast } from '../../store/toast'
import type { VpnProfile } from '../../types'
import { frpPublishReadiness, publicUrl, type FrpSetupGap } from '../../../../shared/frpTunnel'
import { useVpnProfiles } from './useVpnProfiles'
import { FrpPublishDialog } from './FrpPublishDialog'
import { FrpTunnelSetup } from './FrpTunnelSetup'
import { NgrokSetup } from './NgrokSetup'
import { PublicUrlWizard } from './PublicUrlWizard'
import { isReverseProxyKind } from '../../../../shared/vpn'
import { useT } from '../../lib/i18n'

function blankFrpProfile(workspaceId: string, name: string): VpnProfile {
  return {
    id: `vpn-${crypto.randomUUID()}`,
    workspaceId,
    name,
    autoStart: false,
    // No proxies: a fresh client connects and exposes nothing, which is the
    // only safe thing an empty form can mean here.
    spec: {
      kind: 'frp',
      serverAddr: '',
      serverPort: 7000,
      auth: { method: 'token' },
      transport: { protocol: 'tcp', tlsEnable: true },
      proxies: [],
      visitors: []
    }
  }
}

/** frp reverse proxies. Same engine plumbing as `VpnManager` — see
 *  `useVpnProfiles` — but the reverse direction: a VPN brings you onto a remote
 *  network, an frp client publishes something here onto a remote one. */
export function FrpManager(): React.JSX.Element {
  const t = useT()
  const profiles = useWorkspaceVpns().filter((p) => isReverseProxyKind(p.spec.kind))
  const { row, dialogs, importProfile, editProfile } = useVpnProfiles()

  // The one-click flow. `port` is a string rather than a number so an empty box
  // is empty rather than 0, and so "3000abc" is rejected instead of silently
  // becoming 3000.
  const [port, setPort] = useState('')
  const [gaps, setGaps] = useState<FrpSetupGap[] | null>(null)
  const [publishing, setPublishing] = useState<{ port: number } | null>(null)
  const [settingUp, setSettingUp] = useState(false)
  // ngrok is configured rather than imported, so it needs its own way in —
  // there is no file to drop. See NgrokSetup.
  const [addingNgrok, setAddingNgrok] = useState(false)
  // Which provider, asked before anything is published. The button used to mean
  // frp and only frp, so an install whose ngrok profile was the configured one
  // got frp's readiness gaps -- an answer about a tunnel server it had
  // deliberately not set up.
  const [choosing, setChoosing] = useState<{ port: number } | null>(null)

  const readiness = frpPublishReadiness(profiles)
  const wanted = /^\d+$/.test(port.trim()) ? Number(port.trim()) : 0
  const portOk = wanted > 0 && wanted < 65536

  const newClient = (): void => editProfile(blankFrpProfile(useApp.getState().activeId(), t('vpn.frp.manager.newClientName')))

  /**
   * The click.
   *
   * It produces a URL or it produces an explanation, and there is no third
   * outcome — `frpPublishReadiness` has no state that yields half of one. The
   * explanation is deliberately not the setup dialog opening by itself: being
   * dropped into a five-field form is a worse answer to "why did nothing
   * happen" than a sentence saying what is missing, with the form one click
   * further on.
   */
  const publish = (): void => {
    if (!portOk) {
      toast(t('vpn.frp.manager.portRequired'), 'error')
      return
    }
    setGaps(null)
    setChoosing({ port: wanted })
  }

  // Everything already published through the tunnel host, with the address it
  // is at. The point of the feature is the URL, so it has to be gettable again
  // afterwards without opening the proxy editor and reassembling it by hand.
  const published =
    readiness.ready && readiness.target.spec.proxies.length > 0
      ? readiness.target.spec.proxies
          .filter((p) => p.subdomain)
          .map((p) => ({
            name: p.name,
            local: `${p.localIp}:${p.localPort}`,
            url: publicUrl(readiness.target.host, p.subdomain as string)
          }))
      : []

  const copy = (url: string): void => {
    window.opsmaxx?.clipboard.write(url)
    toast(t('vpn.frp.manager.addressCopied'), 'ok')
  }

  return (
    <div className="content">
      <div className="content-header">
        <div>
          <h1>{t('vpn.frp.manager.title')}</h1>
          <div className="sub">{t('vpn.frp.manager.subtitle')}</div>
        </div>
        <div className="spacer" />
        {/* Demoted, both of them. This screen used to stack four things that
            all looked like the way in — "Import frpc config", "New frp client",
            "Get a public URL", and a filled "New frp client" in the middle of
            the empty state. Three of the four are named in frp's own
            vocabulary and none of those three is what a person came here to
            do. One primary survives, below. */}
        <button className="btn quiet size-28" onClick={() => importProfile('frp')}>
          {t('vpn.frp.manager.importConfig')}
        </button>
        <button className="btn quiet size-28" onClick={newClient}>
          {t('vpn.frp.manager.newClient')}
        </button>
        <button className="btn quiet size-28" onClick={() => setAddingNgrok(true)}>
          {t('vpn.frp.manager.addNgrok')}
        </button>
      </div>

      <div className="hop-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 13 }}>{t('vpn.frp.manager.publishLocalhost')}</span>
          <input
            className="input"
            style={{ width: 92 }}
            placeholder="3000"
            aria-label={t('vpn.frp.manager.localPortLabel')}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') publish()
            }}
          />
          <button className="btn primary size-32" onClick={publish}>
            <Globe size={14} /> {t('vpn.frp.manager.getPublicUrl')}
          </button>
          <span className="grow" />
        </div>

        {/* What is missing, rather than a URL that would not have worked. */}
        {gaps && (
          <div className="col" style={{ gap: 6 }}>
            {gaps.map((g) => (
              <span key={g.code} style={{ fontSize: 12, color: 'var(--warn)' }}>
                {g.message}
              </span>
            ))}
            <div className="row">
              <button className="btn secondary size-28" onClick={() => setSettingUp(true)}>
                {t('vpn.frp.manager.setUpServer')}
              </button>
            </div>
          </div>
        )}

        {published.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            {published.map((p) => (
              <div key={p.name} className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12 }}>{p.url}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  → {p.local}
                </span>
                <span className="grow" />
                <button
                  className="icon-btn sm"
                  title={t('vpn.frp.manager.copyUrl', { url: p.url })}
                  aria-label={t('vpn.frp.manager.copyUrl', { url: p.url })}
                  onClick={() => copy(p.url)}
                >
                  <Copy size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          icon={<Share2 size={26} />}
          title={t('vpn.frp.manager.emptyTitle')}
          message={t('vpn.frp.manager.emptyMessage')}
          action={
            <button className="btn secondary size-32" onClick={newClient}>
              <Share2 size={15} /> {t('vpn.frp.manager.newClient')}
            </button>
          }
        />
      ) : (
        <div className="col" style={{ gap: 8, paddingBottom: 16 }}>
          {profiles.map(row)}
        </div>
      )}

      {addingNgrok && (
        <NgrokSetup onClose={() => setAddingNgrok(false)} onDone={() => setAddingNgrok(false)} />
      )}

      {settingUp && (
        <FrpTunnelSetup
          workspaceId={useApp.getState().activeId()}
          // Promote the profile the user already has rather than adding a
          // second one beside it: two frp clients dialling the same server is
          // a confusing thing to end a setup with.
          existing={profiles.length === 1 ? profiles[0] : null}
          onClose={() => setSettingUp(false)}
          onDone={() => {
            setSettingUp(false)
            setGaps(null)
            // Carry straight on into the publish the user originally asked
            // for. The setup was an interruption, not the task.
            if (portOk) setPublishing({ port: wanted })
          }}
        />
      )}

      {choosing && (
        <PublicUrlWizard
          localPort={choosing.port}
          frpReady={readiness.ready}
          frpGap={readiness.ready ? null : (readiness.gaps[0]?.message ?? null)}
          onPickFrp={() => {
            setChoosing(null)
            setPublishing({ port: choosing.port })
          }}
          onSetUpFrp={() => {
            setChoosing(null)
            setGaps(readiness.ready ? null : readiness.gaps)
            setSettingUp(true)
          }}
          onAddNgrok={() => {
            setChoosing(null)
            setAddingNgrok(true)
          }}
          onClose={() => setChoosing(null)}
        />
      )}

      {publishing && readiness.ready && (
        <FrpPublishDialog
          target={readiness.target}
          localPort={publishing.port}
          onClose={() => setPublishing(null)}
        />
      )}

      {dialogs}
    </div>
  )
}
