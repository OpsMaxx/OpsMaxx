import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, KeyRound, ShieldOff } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { toast } from '../../store/toast'
import { useT } from '../../lib/i18n'
import type { Translate } from '../../../../shared/i18n'
import {
  machineGrantMeaning,
  machineGrantView,
  type GrantDestination,
  type MachineGrant,
  type MachineGrantView
} from '../../../../shared/machineGrants'

/**
 * The one screen that lists what this machine may read without the master
 * password, and the one place any of it can be taken back.
 *
 * Two such grants already existed on users' machines — a scheduled backup
 * passphrase and addy's key material — and nothing enumerated either. An
 * authorisation that cannot be seen cannot be withdrawn, which is the
 * objection credProxy.ts:44 raises about durable tokens, applied to the vault.
 *
 * Every row names its consequence BEFORE its button. The failure this is
 * written against is somebody revoking a passphrase in the afternoon and
 * finding out at 03:00, so "what stops working" is not in a toast afterwards.
 */

/**
 * The bridge method this panel needs.
 *
 * Narrowed here rather than read off `OpsMaxxApi` because the preload line and
 * the `secrets:machineGrants` handler land alongside this component; once they
 * have, this is exactly what that method resolves to. `secrets.delete` is
 * already on the bridge and is what revoking calls.
 */
type GrantsBridge = { machineGrants?: () => Promise<MachineGrant[]> }

const grantsBridge = (): GrantsBridge | undefined =>
  window.opsmaxx?.secrets as unknown as GrantsBridge | undefined

function granted(t: Translate, at: string | undefined): string {
  if (!at) {
    // Said, not hidden. Every grant made before OpsMaxx recorded the date has
    // none, and a blank cell reads as "just now" to anyone skimming.
    return t('settings.machineGrants.grantedUndated')
  }
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? t('settings.machineGrants.dateUnreadable')
    : t('settings.machineGrants.grantedOn', { date: d.toLocaleDateString() })
}

export function MachineGrants(): React.JSX.Element {
  const t = useT()
  const [rows, setRows] = useState<MachineGrantView[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const list = grantsBridge()?.machineGrants
    if (typeof list !== 'function') {
      setUnavailable(true)
      return
    }
    const [grants, targets] = await Promise.all([
      list(),
      window.opsmaxx?.backup?.destinations?.() ?? Promise.resolve(null)
    ])
    const destinations: GrantDestination[] = targets?.destinations ?? []
    setRows(grants.map((g) => machineGrantView(g, destinations)))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const revoke = async (row: MachineGrantView): Promise<void> => {
    // The consequence is on screen already; the dialog repeats it, because a
    // button next to an explanation is still pressed without reading it and
    // this one is not undoable.
    const question = t('settings.machineGrants.revokeConfirm', {
      title: row.title,
      consequence: row.consequence
    })
    if (!window.confirm(question)) return
    try {
      await window.opsmaxx?.secrets?.delete(row.id)
      toast(t('settings.machineGrants.revoked'), 'ok')
    } catch (err) {
      toast(
        t('settings.machineGrants.stillGranted', {
          error: err instanceof Error ? err.message : String(err)
        }),
        'error',
        { label: t('settings.machineGrants.tryAgain'), run: () => void revoke(row) }
      )
    }
    await load()
  }

  if (unavailable) {
    return (
      <EmptyState
        compact
        title={t('settings.machineGrants.unavailableTitle')}
        message={t('settings.machineGrants.unavailableMessage')}
      />
    )
  }

  if (rows === null) return <div className="s-desc">{t('settings.machineGrants.reading')}</div>

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title={t('settings.machineGrants.emptyTitle')}
        message={t('settings.machineGrants.emptyMessage')}
      />
    )
  }

  return (
    <div>
      <div className="s-desc">{machineGrantMeaning()}</div>
      {rows.map((row) => (
        <div className="setting-row" key={row.id}>
          <div className="s-info">
            <div className="s-title">
              <KeyRound size={13} /> {row.title}
            </div>
            <div className="s-desc">{granted(t, row.grantedAt)}</div>
            {row.orphaned && (
              <div className="s-desc warn">
                <AlertTriangle size={12} /> {t('settings.machineGrants.orphaned')}
              </div>
            )}
            {row.note && <div className="s-desc warn">{row.note}</div>}
            <div className="s-desc">{row.consequence}</div>
          </div>
          <button className="btn sm danger" onClick={() => void revoke(row)}>
            <ShieldOff size={13} /> {t('settings.machineGrants.revoke')}
          </button>
        </div>
      ))}
    </div>
  )
}
