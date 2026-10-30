import { useEffect, useState } from 'react'
import { Modal } from '../common/Modal'
import type { CliPairingRequest } from '../../../../shared/mcp'
import { bridgeOn } from '../../lib/bridge'
import { StartsInMode } from './ModePicker'
import { useT } from '../../lib/i18n'

// Mounted once at the app root, like ApprovalWatcher: the `opsmaxx
// claude|codex|run` CLI launcher can pair from any tab the user happens to
// be on. The code shown here is never sent back over the wire to whichever
// local process asked for it — only display it and let the user type it into
// their own terminal proves they can see both.
export function CliPairingBanner(): React.JSX.Element | null {
  const [request, setRequest] = useState<CliPairingRequest | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const t = useT()

  useEffect(() => {
    const off = bridgeOn('aiMcp.onPairingEvent', window.opsmaxx?.aiMcp?.onPairingEvent, (e) => {
      if (e.type === 'created') setRequest(e.request)
      else setRequest((r) => (r && r.id === e.request.id ? null : r))
    })
    return () => off?.()
  }, [])

  useEffect(() => {
    if (!request) return
    const tick = (): void =>
      setSecondsLeft(Math.max(0, Math.round((new Date(request.expiresAt).getTime() - Date.now()) / 1000)))
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [request])

  if (!request) return null

  const cancel = async (): Promise<void> => {
    await window.opsmaxx?.aiMcp.cancelPairing(request.id)
    setRequest(null)
  }

  return (
    <Modal title={t('ai.cliPairing.title')} onClose={cancel}>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.cliPairing.agent')}</div>
          <div className="s-desc">{request.agentName}</div>
          <StartsInMode />
        </div>
      </div>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('ai.cliPairing.typeCode')}</div>
          <div className="s-title mono" style={{ fontSize: 28, letterSpacing: 6, marginTop: 6 }}>
            {request.code}
          </div>
          <div className="s-desc" style={{ marginTop: 6 }}>
            {t('ai.cliPairing.expires', { seconds: secondsLeft })}
          </div>
        </div>
      </div>
      <div className="setting-row" style={{ marginTop: 12 }}>
        <button className="btn danger outline" onClick={cancel}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  )
}
