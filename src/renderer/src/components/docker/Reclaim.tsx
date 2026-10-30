import { TriangleAlert } from 'lucide-react'
import { clsx } from '../../lib/format'
import { useT } from '../../lib/i18n'
import type { Translate } from '../../../../shared/i18n'
import {
  DOCKER_FAILURE_HELP,
  type DockerReclaimDiff,
  type DockerReclaimItem,
  type DockerReclaimPlan,
  type DockerReclaimResult
} from '../../../../shared/docker'

// The dialog that stands between a list of checkboxes and a `docker rm`.
//
// It has three faces and only ever wears one:
//
//  1. **The plan.** What is about to go, why that is worth a dialog, and the
//     caveats — which are printed in their own block, visually apart from the
//     reasons, because they are not arguments for pressing harder. They are
//     things that would otherwise be discovered afterwards.
//  2. **The refusal.** The list was re-read a moment before this would run, and
//     the host disagreed with what the operator was shown. Nothing runs; the
//     disagreement is printed. This is the face the whole feature is built
//     around, and it is deliberately not dismissible into "do it anyway" — the
//     way out is to look at the fresh list and choose again.
//  3. **The outcome.** Per item, always. "The command exited 1" says nothing
//     about which of five volumes is still there, which is the only question
//     afterwards.
//
// Split out of DockerPanel.tsx rather than added to it, and not only for
// length: `tests/dockerOps.test.ts` scans the `DiskItems` function for anything
// that accumulates per-item bytes, because summing image sizes overstates the
// disk by a multiple. Keeping the dialog out of that file keeps that guard
// reading the thing it was written to guard.

/** Kind, then a readable name. `<none>:<none>` is docker's word, kept. */
function itemRow(i: DockerReclaimItem, t: Translate): React.JSX.Element {
  return (
    <div key={`${i.kind} ${i.id}`} className="cron-row">
      <span className="chip">{i.kind}</span>
      <span className="mono cron-when" title={i.id}>
        {i.label}
      </span>
      <span className="faint cron-desc">{i.kind === 'volume' ? (i.anonymous ? t('docker.reclaim.anonymous') : t('docker.reclaim.named')) : i.id}</span>
      <span className="grow" />
      <span className="mono">{i.size}</span>
    </div>
  )
}

export function ReclaimDialog({
  plan,
  diff,
  checking,
  running,
  phrase,
  onPhrase,
  onConfirm,
  onCancel
}: {
  plan: DockerReclaimPlan
  /** Set once the fresh read has come back and disagreed. Until then, null. */
  diff: DockerReclaimDiff | null
  checking: boolean
  running: boolean
  phrase: string
  onPhrase: (v: string) => void
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const typedPhrase = plan.confirmation.kind === 'type-to-confirm' ? plan.confirmation.phrase : null
  const canConfirm = typedPhrase === null || phrase.trim() === typedPhrase

  if (diff !== null) {
    return (
      <div className="bc-confirm">
        <div className="s-title">{t('docker.reclaim.diffTitle')}</div>
        <div className="s-desc danger">
          <TriangleAlert size={12} /> {t('docker.reclaim.diffBody')}
        </div>
        {diff.ineligible.length > 0 && (
          <>
            <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
              <span className="grow">{t('docker.reclaim.ineligible')}</span>
            </div>
            {diff.ineligible.map((c) => (
              <div key={`${c.item.kind} ${c.item.id}`} className="cron-row">
                <span className="chip warn">{c.item.kind}</span>
                <span className="mono cron-when">{c.item.label}</span>
                <span className="faint cron-desc">{c.detail}</span>
              </div>
            ))}
          </>
        )}
        {diff.gone.length > 0 && (
          <>
            <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
              <span className="grow">{t('docker.reclaim.gone')}</span>
            </div>
            {diff.gone.map((i) => (
              <div key={`${i.kind} ${i.id}`} className="cron-row">
                <span className="chip">{i.kind}</span>
                <span className="mono cron-when">{i.label}</span>
                <span className="faint cron-desc">{t('docker.reclaim.goneDetail')}</span>
              </div>
            ))}
          </>
        )}
        {diff.changed.length > 0 && (
          <>
            <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
              <span className="grow">{t('docker.reclaim.changed')}</span>
            </div>
            {diff.changed.map((c) => (
              <div key={`${c.item.kind} ${c.item.id}`} className="cron-row">
                <span className="chip warn">{c.item.kind}</span>
                <span className="mono cron-when">{c.item.label}</span>
                <span className="faint cron-desc">{c.detail}</span>
              </div>
            ))}
          </>
        )}
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
          {t('docker.reclaim.itemiseAgain')}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={onCancel}>
            {t('common.close')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bc-confirm">
      <div className="s-title">
        {plan.items.length === 1
          ? t('docker.reclaim.removeOne')
          : t('docker.reclaim.removeMany', { count: plan.items.length })}
      </div>
      {plan.items.map((i) => itemRow(i, t))}
      {plan.reasons.length > 0 && (
        <div className="s-desc danger" style={{ marginTop: 6 }}>
          <TriangleAlert size={12} /> {plan.reasons.join('; ')}.
        </div>
      )}
      {/* Apart from the reasons, and labelled as something else, because they
          are not arguments for pressing harder — they are the things that get
          discovered afterwards otherwise. */}
      {plan.caveats.length > 0 && (
        <div className="s-desc" style={{ marginTop: 4 }}>
          <div className="faint" style={{ fontSize: 11 }}>
            {t('docker.reclaim.caveats')}
          </div>
          {plan.caveats.map((c) => (
            <div key={c} className="faint" style={{ fontSize: 11 }}>
              · {c}
            </div>
          ))}
        </div>
      )}
      {typedPhrase !== null && (
        <div className="input-group" style={{ marginTop: 6 }}>
          <input
            className="input"
            placeholder={t('docker.common.typeToContinue', { phrase: typedPhrase })}
            value={phrase}
            onChange={(e) => onPhrase(e.target.value)}
            autoFocus
          />
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button className="btn primary" disabled={!canConfirm || checking || running} onClick={onConfirm}>
          {checking ? t('docker.reclaim.rereading') : running ? t('docker.reclaim.removing') : t('common.remove')}
        </button>
        <button className="btn ghost" disabled={running} onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <span className="faint" style={{ fontSize: 11 }}>
          {t('docker.reclaim.readFirst')}
        </span>
      </div>
    </div>
  )
}

/**
 * What happened, per object.
 *
 * A failed removal is not a failed read: docker refusing to delete a volume
 * that turned out to be in use is this feature working, and it is reported as
 * one row rather than as a broken panel.
 */
export function ReclaimOutcome({ result }: { result: DockerReclaimResult }): React.JSX.Element {
  const t = useT()
  if (!result.ok) {
    return (
      <div className="s-desc danger">
        <TriangleAlert size={12} /> {DOCKER_FAILURE_HELP[result.reason]}
        <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
          {result.detail}
        </div>
        {result.reason === 'permission-denied' && (
          <div className="faint" style={{ marginTop: 6 }}>
            {t('docker.reclaim.permissionDenied')}
          </div>
        )}
      </div>
    )
  }
  const gone = result.outcomes.filter((o) => o.ok)
  const stayed = result.outcomes.filter((o) => !o.ok)
  return (
    <div className={clsx('s-desc', stayed.length > 0 && 'danger')}>
      <div>
        {result.usedSudo
          ? t('docker.reclaim.removedAsRoot', { gone: gone.length, total: result.outcomes.length })
          : t('docker.reclaim.removed', { gone: gone.length, total: result.outcomes.length })}
      </div>
      {stayed.map((o) => (
        <div key={`${o.item.kind} ${o.item.id}`} className="mono danger" style={{ fontSize: 11 }}>
          {o.item.label}: {o.error}
        </div>
      ))}
      {result.unattributed.map((line, i) => (
        <div key={i} className="mono faint" style={{ fontSize: 11 }}>
          {line}
        </div>
      ))}
      {/* No byte figure here, and its absence is the same decision the itemised
          view makes: per-item sizes do not add up, because image layers are
          shared. The honest number comes from re-reading `docker system df`. */}
      {gone.length > 0 && (
        <div className="faint" style={{ fontSize: 11 }}>
          {t('docker.reclaim.rereadTotals')}
        </div>
      )}
    </div>
  )
}
