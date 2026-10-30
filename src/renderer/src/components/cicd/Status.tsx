import type { CicdOutcome, CicdStatus } from '../../../../shared/cicd'
import { clsx } from '../../lib/format'
import { t as tNow, useT } from '../../lib/i18n'
import type { MessageKey, Translate } from '../../../../shared/i18n'

/**
 * A run's status as a shape AND a word, never as a colour alone.
 *
 * `docs/design/panel-audit.md` §3: four status meanings, four roles, and the
 * unknown role is the achromatic one because an absence should read as an
 * absence rather than as a third kind of problem. CI is the feature area that
 * forced the fourth role — a provider we could not reach must render as
 * neither green nor red — so the hollow ring here is not decoration, it is the
 * distinction the module exists to keep.
 *
 * `.state-dot` supplies the shape (disc / triangle / square / ring); the word
 * beside it is what a reader who sees none of the four colours actually reads.
 */

export type StateRole = 'ok' | 'watch' | 'alarm' | 'unknown'

export function roleOf(outcome: CicdOutcome): StateRole {
  switch (outcome.status) {
    case 'success':
      // Jenkins UNSTABLE and GitHub neutral are neither pass nor fail. Folding
      // them into `success` would report a lot of builds as clean that are not.
      return outcome.warning === true ? 'watch' : 'ok'
    case 'failed':
      return 'alarm'
    case 'running':
    case 'queued':
    case 'manual':
      return 'watch'
    default:
      // canceled, skipped, unknown. None of them is a pass and none is a
      // failure, and `unknown` in particular must not borrow either colour.
      return 'unknown'
  }
}

/** Uppercase where the state needs acting on, lowercase where it does not —
 *  the same reason PosturePanel shouts EXPIRED and not "reachable". */
export function wordOf(outcome: CicdOutcome, t: Translate = tNow): string {
  if (outcome.status === 'success') return outcome.warning === true ? t('cicd.status.unstable') : t('cicd.status.ok')
  const words: Record<CicdStatus, MessageKey> = {
    queued: 'cicd.status.queued',
    running: 'cicd.status.running',
    success: 'cicd.status.ok',
    failed: 'cicd.status.failed',
    canceled: 'cicd.status.canceled',
    skipped: 'cicd.status.skipped',
    manual: 'cicd.status.needsApproval',
    unknown: 'cicd.status.unknown'
  }
  return t(words[outcome.status])
}

export function StatusWord({
  outcome,
  className
}: {
  outcome: CicdOutcome
  className?: string
}): React.JSX.Element {
  const t = useT()
  const role = roleOf(outcome)
  const word = wordOf(outcome, t)
  return (
    <span className={clsx('cicd-status', `state-${role}`, className)}>
      {/* aria-hidden: the shape is the non-colour signal for a sighted reader,
          and a screen reader gets the word right after it. */}
      <span className={`state-dot is-${role}`} aria-hidden />
      {word}
    </span>
  )
}

/**
 * The row a trigger produces before the provider has a run to name.
 *
 * Jenkins returns a queue item that may never become a build and GitHub
 * Enterprise returns 204 with no body, so there is nothing green to show and
 * nothing to number. It renders as the unknown ring, which is the true answer.
 */
export function RequestedWord({ note }: { note?: string }): React.JSX.Element {
  const t = useT()
  return (
    <span className="cicd-status state-unknown" title={note}>
      <span className="state-dot is-unknown" aria-hidden />
      {t('cicd.status.requested')}
    </span>
  )
}
