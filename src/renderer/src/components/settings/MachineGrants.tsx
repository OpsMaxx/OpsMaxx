import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, KeyRound, ShieldOff } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import { toast } from '../../store/toast'
import {
  MACHINE_GRANT_MEANING,
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

function granted(at: string | undefined): string {
  if (!at) {
    // Said, not hidden. Every grant made before OpsMaxx recorded the date has
    // none, and a blank cell reads as "just now" to anyone skimming.
    return 'Granted before OpsMaxx recorded grant dates'
  }
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? 'Grant date unreadable' : `Granted ${d.toLocaleDateString()}`
}

export function MachineGrants(): React.JSX.Element {
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
    if (!window.confirm(`Revoke this grant?\n\n${row.title}\n\n${row.consequence}`)) return
    try {
      await window.opsmaxx?.secrets?.delete(row.id)
      toast('Revoked. This machine can no longer read that secret on its own.', 'ok')
    } catch (err) {
      toast(
        `It is still granted: ${err instanceof Error ? err.message : String(err)}`,
        'error',
        { label: 'Try again', run: () => void revoke(row) }
      )
    }
    await load()
  }

  if (unavailable) {
    return (
      <EmptyState
        compact
        title="Grants cannot be listed right now"
        message="The preload bridge on this build has no way to read them. Restart the app; if it persists, this version cannot show them and nothing can be revoked from here."
      />
    )
  }

  if (rows === null) return <div className="s-desc">Reading this machine’s keychain…</div>

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title="Nothing runs without your master password"
        message="No secret on this machine is readable without it. Scheduled backups and addy will ask you to unlock after a restart."
      />
    )
  }

  return (
    <div>
      <div className="s-desc">{MACHINE_GRANT_MEANING}</div>
      {rows.map((row) => (
        <div className="setting-row" key={row.id}>
          <div className="s-info">
            <div className="s-title">
              <KeyRound size={13} /> {row.title}
            </div>
            <div className="s-desc">{granted(row.grantedAt)}</div>
            {row.orphaned && (
              <div className="s-desc warn">
                <AlertTriangle size={12} /> Orphaned — this authorises something that no longer
                exists.
              </div>
            )}
            {row.note && <div className="s-desc warn">{row.note}</div>}
            <div className="s-desc">{row.consequence}</div>
          </div>
          <button className="btn sm danger" onClick={() => void revoke(row)}>
            <ShieldOff size={13} /> Revoke
          </button>
        </div>
      ))}
    </div>
  )
}
