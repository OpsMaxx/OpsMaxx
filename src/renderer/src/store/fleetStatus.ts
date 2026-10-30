import { create } from 'zustand'
import type { FleetSamplerStatus } from '../../../shared/fleet'
import type { MessageKey } from '../../../shared/i18n'
import { t } from '../lib/i18n'

// The sampler's real state, app-wide.
//
// This exists because background checking could stop and nothing would say so
// anywhere a person was looking. The vault auto-locks, the sampler pauses,
// every alert the app can raise stops being raised — and the only surface that
// mentioned it was one line in Settings → Monitoring, a pane an operator has no
// reason to open on a normal day. Found by running it: the switch was on, the
// sampler had been paused for an unknown length of time, and a failed unit sat
// undelivered the whole while.
//
// That is the exact failure the monitor exists to prevent, reintroduced at the
// point where it costs the most: silence from a monitoring tool is indis-
// tinguishable from good news.

interface FleetStatusState {
  status: FleetSamplerStatus | null
  setStatus: (s: FleetSamplerStatus | null) => void
}

export const useFleetStatus = create<FleetStatusState>((set) => ({
  status: null,
  setStatus: (status) => set({ status })
}))

export type SamplerWarningKind = 'vault-locked' | 'vault-partial' | 'no-targets' | 'stalled'

export interface SamplerWarning {
  kind: SamplerWarningKind
  /** Status-bar chip label. Short enough not to crowd the bar. */
  label: string
  /** Tooltip. Says what has stopped, not just what the state is called. */
  detail: string
}

const WARNINGS: Record<SamplerWarningKind, { label: MessageKey; detail: MessageKey }> = {
  'vault-locked': {
    label: 'store.fleetStatus.warning.vaultLocked.label',
    detail: 'store.fleetStatus.warning.vaultLocked.detail'
  },
  // The partial case, which used to be reported as the total one. A vault with
  // one credential in it made the chip say every check had stopped, when in
  // fact one server had. Saying "paused" about an estate that is still being
  // watched is the same class of wrong as silence about one that is not.
  'vault-partial': {
    label: 'store.fleetStatus.warning.vaultPartial.label',
    detail: 'store.fleetStatus.warning.vaultPartial.detail'
  },
  'no-targets': {
    label: 'store.fleetStatus.warning.noTargets.label',
    detail: 'store.fleetStatus.warning.noTargets.detail'
  },
  stalled: {
    label: 'store.fleetStatus.warning.stalled.label',
    detail: 'store.fleetStatus.warning.stalled.detail'
  }
}

const warning = (kind: SamplerWarningKind): SamplerWarning => ({
  kind,
  label: t(WARNINGS[kind].label),
  detail: t(WARNINGS[kind].detail)
})

/**
 * Whether the status bar should be warning, and about what.
 *
 * Pure so the rule can be tested without a DOM — and the rule is the whole
 * feature, so it is the part that has to be right.
 *
 * Two silences are deliberate. Background checking switched OFF is a choice,
 * not a fault, and warning about it would train people to ignore the chip.
 * Unknown status is also silent: `status` is null until the first poll returns,
 * and a chip that flashes a warning on every launch is worse than no chip.
 */
export function samplerWarning(
  status: FleetSamplerStatus | null,
  enabled: boolean
): SamplerWarning | null {
  if (!enabled || !status) return null
  if (status.idleReason === 'disabled') return null
  if (status.idleReason === 'vault-locked') return warning('vault-locked')
  // Deliberately NOT gated on `!status.running`: a sweep that is running and
  // skipping four hosts is precisely the case this exists for.
  if (status.vaultBlockedCount > 0) return warning('vault-partial')
  if (status.idleReason === 'no-targets') return warning('no-targets')
  // Enabled, targets present, vault open, and still not looping.
  if (!status.running) return warning('stalled')
  return null
}

// ---------------------------------------------------------------------------
// Why a read-only panel is empty.
//
// Six panels — posture, access, inventory, drift, patches, search — each said
// the same paragraph when they had nothing: "OpsMaxx reads this about once
// an hour... Press Check now, and make sure background checking is on in
// Settings." Three sentences of maybe, and a button.
//
// Found by running it against a real estate. The vault had auto-locked, so the
// sweep was breaking out of its target loop on the first host and collecting
// nothing. Check now called sampleNow, which called sweep, which broke on the
// same line — the button spun, succeeded, and the panel repeated the
// instruction to press it. The status bar two inches below said "Checks
// paused" and knew exactly why; the panels never asked.
//
// So the question a panel has to answer is not "am I empty" — it already knows
// that — but "what is stopping the sweep, and what does this person press". The
// sampler has published `idleReason` all along. This turns it into the answer.
// ---------------------------------------------------------------------------

export type SweepBlockKind =
  | 'vault-locked'
  | 'vault-partial'
  | 'checks-off'
  | 'no-targets'
  | 'stalled'
  | 'not-yet'

export interface SweepBlock {
  kind: SweepBlockKind
  /** What is stopping the sweep. One sentence, no hedging. */
  reason: string
  /** The single thing that fixes it. */
  fix: string
  /** Which control the panel should offer. Exactly one. */
  action: 'unlock-vault' | 'open-settings' | 'check-now'
}

/**
 * What to tell someone looking at a panel that has collected nothing.
 *
 * Pure, for the reason samplerWarning above is pure: the rule IS the feature,
 * so it is the part that has to be right, and it should be testable without
 * mounting six panels.
 *
 * `not-yet` is the only benign answer — the sweep is healthy and simply has
 * not reached this host. Every other kind is a thing that will not fix itself,
 * and naming it is the whole point.
 */
export function sweepBlock(status: FleetSamplerStatus | null, enabled: boolean): SweepBlock {
  if (!enabled) {
    return {
      kind: 'checks-off',
      reason: t('store.fleetStatus.sweep.checksOff.reason'),
      fix: t('store.fleetStatus.sweep.checksOff.fix'),
      action: 'open-settings'
    }
  }
  // Null until the first poll returns. Not a fault, and claiming one on every
  // launch would be the same lie in the other direction.
  if (!status) {
    return {
      kind: 'not-yet',
      reason: t('store.fleetStatus.sweep.notYet.reason'),
      fix: t('store.fleetStatus.sweep.notYet.fix'),
      action: 'check-now'
    }
  }
  if (status.idleReason === 'vault-locked') {
    return {
      kind: 'vault-locked',
      reason: t('store.fleetStatus.sweep.vaultLocked.reason'),
      // Said plainly because the alternative wastes the press: Check now calls
      // the same sweep that is breaking on the lock.
      fix: t('store.fleetStatus.sweep.vaultLocked.fix'),
      action: 'unlock-vault'
    }
  }
  if (status.idleReason === 'disabled') {
    return {
      kind: 'checks-off',
      reason: t('store.fleetStatus.sweep.checksOff.reason'),
      fix: t('store.fleetStatus.sweep.checksOff.fix'),
      action: 'open-settings'
    }
  }
  if (status.idleReason === 'no-targets') {
    return {
      kind: 'no-targets',
      reason: t('store.fleetStatus.sweep.noTargets.reason'),
      fix: t('store.fleetStatus.sweep.noTargets.fix'),
      action: 'open-settings'
    }
  }
  if (!status.running) {
    return {
      kind: 'stalled',
      reason: t('store.fleetStatus.sweep.stalled.reason'),
      fix: t('store.fleetStatus.sweep.stalled.fix'),
      action: 'open-settings'
    }
  }
  if (status.vaultBlockedCount > 0) {
    /**
     * Ceiling, stated: this does not know whether THIS panel's hosts are among
     * the blocked ones. `sweepBlock` is pure and takes no server ids, and
     * threading them through six panels to sharpen one sentence is not worth
     * it. So it says "some", which is true, rather than "nothing has been
     * collected for these hosts yet", which in this state is a guess that
     * sends the reader to press a button that will not help.
     */
    return {
      kind: 'vault-partial',
      reason: t('store.fleetStatus.sweep.vaultPartial.reason'),
      fix: t('store.fleetStatus.sweep.vaultPartial.fix'),
      action: 'unlock-vault'
    }
  }
  return {
    kind: 'not-yet',
    reason: t('store.fleetStatus.sweep.notYet.reason'),
    fix: t('store.fleetStatus.sweep.notYet.fix'),
    action: 'check-now'
  }
}
