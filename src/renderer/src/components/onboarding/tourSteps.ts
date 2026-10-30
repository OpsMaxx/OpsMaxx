import type { ActivityView } from '../../types'
import type { MessageKey } from '../../../../shared/i18n'
import { moduleEnabled, type ModuleId, type ModuleState } from '../../../../shared/modules'

export interface TourStep {
  id: string
  titleKey: MessageKey
  bodyKey: MessageKey
  // Which view to switch to while this step shows, so the feature is on screen
  // behind the card rather than merely described.
  view?: ActivityView
  // A concrete thing to try, where there is one worth naming.
  actionKey?: MessageKey
}

// ---------------------------------------------------------------------------
// TWO STEPS ON FIRST RUN, AND SIX DEFERRED — NOT SIX DELETED
// ---------------------------------------------------------------------------
//
// The tour used to be eight panels shown back to back before the user had done
// anything. Reading it in order, the problem is obvious:
//
//   1  a definition of the product
//   2  ~75 words on workspaces, multi-client isolation and shared vault
//      entries, for somebody with zero servers
//   3  add a server or import your SSH config   ← the only actionable step,
//                                                 and the only one they need
//   4  create your vault: a live, focused "Master password (min 12
//      characters)" field, 60 seconds into a first launch
//   5-7 monitoring, tunnels, AI
//   8  that is the tour
//
// It spent its highest-attention slots on org-scale concepts a solo first-run
// user has no model for, and reached the actual first action third, by which
// time tour fatigue has set in.
//
// Step 4 was the serious one. It is the single most irreversible commitment in
// the product — "it is never stored anywhere, so if you lose it the contents
// cannot be recovered" — and it was being asked for before the user had
// connected to anything or had any reason to care. A password chosen in that
// state is chosen carelessly, and it cannot be recovered.
//
// Steps 5 and 6 were also staged over screens that contradicted their own copy:
// "live CPU, memory, disk" narrated over the Fleet keys tab, which shows a
// disabled-feature notice; "tunnels and databases" over an empty frp panel, for
// a technology the Add Server dialog says "is never a transport".
//
// So: two steps up front, and the other six become FEATURE_TIPS, shown once
// each when the user first opens the view they describe. Nothing is deleted —
// every sentence survives, it just arrives when the reader has a reason to want
// it, and on the screen it is actually about, which is what fixes the staging
// mismatch as a side effect.
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'connections',
    titleKey: 'onboarding.tour.connections.title',
    bodyKey: 'onboarding.tour.connections.body',
    view: 'connections',
    actionKey: 'onboarding.tour.connections.action'
  },
  {
    id: 'done',
    titleKey: 'onboarding.tour.done.title',
    bodyKey: 'onboarding.tour.done.body',
    actionKey: 'onboarding.tour.done.action'
  }
]

/**
 * A step that used to be in the tour, shown once when its view is first opened.
 *
 * `view` is the trigger, not merely a backdrop: the tip fires because the user
 * went somewhere, which means they have a reason to read it. That is the whole
 * difference between this and a panel four of eight.
 */
export interface FeatureTip extends TourStep {
  view: ActivityView
  /**
   * The module this tip is about, where it is about one.
   *
   * A tip for a module the user switched off is a tip about a screen they cannot
   * reach, and showing it is worse than saying nothing: the walkthrough spends its
   * credibility describing a feature that is not there, which teaches the reader
   * that the rest of it may not be there either.
   *
   * Absent means the tip is about the app rather than about a module -- workspaces,
   * the vault, the AI bridge -- and is always eligible.
   */
  module?: ModuleId
  /**
   * Which Monitoring tab this tip belongs to, for the tips whose `view` is
   * `monitor`.
   *
   * Monitoring, Operations and the four promoted modules all share one
   * ActivityView, so `view` alone cannot tell them apart -- the same problem
   * FeatureTipCard already solved for `fleetRail`. A tip with a `tab` fires only
   * when that tab is the one on screen; one without fires on the Monitoring rail
   * generally.
   */
  tab?: ModuleId
}

export const FEATURE_TIPS: FeatureTip[] = [
  {
    id: 'tip-workspaces',
    view: 'connections',
    titleKey: 'onboarding.tips.workspaces.title',
    bodyKey: 'onboarding.tips.workspaces.body',
    actionKey: 'onboarding.tips.workspaces.action'
  },
  {
    // Fires when the user opens the vault, which is the moment they are already
    // thinking about a credential — not 60 seconds into a first launch.
    id: 'tip-vault',
    view: 'vault',
    titleKey: 'onboarding.tips.vault.title',
    bodyKey: 'onboarding.tips.vault.body'
  },
  {
    id: 'tip-monitor',
    view: 'monitor',
    titleKey: 'onboarding.tips.monitor.title',
    bodyKey: 'onboarding.tips.monitor.body'
  },
  {
    id: 'tip-tunnels',
    view: 'tunnels',
    titleKey: 'onboarding.tips.tunnels.title',
    bodyKey: 'onboarding.tips.tunnels.body'
  },
  {
    id: 'tip-databases',
    view: 'databases',
    titleKey: 'onboarding.tips.databases.title',
    bodyKey: 'onboarding.tips.databases.body'
  },
  {
    id: 'tip-ai',
    view: 'ai',
    titleKey: 'onboarding.tips.ai.title',
    bodyKey: 'onboarding.tips.ai.body'
  },

  // The promoted modules, which had no tips at all.
  //
  // They were tabs in a strip nobody was introduced to; now they are icons in the
  // rail, which is more discoverable and no more self-explanatory. Each of these
  // carries a `module`, so it is never shown to somebody who switched the module
  // off, and a `tab`, so it fires on its own destination rather than anywhere on
  // the shared Monitoring ActivityView.
  {
    id: 'tip-docker',
    view: 'monitor',
    module: 'docker',
    tab: 'docker',
    titleKey: 'onboarding.tips.docker.title',
    bodyKey: 'onboarding.tips.docker.body'
  },
  {
    id: 'tip-kubernetes',
    view: 'monitor',
    module: 'kubernetes',
    tab: 'kubernetes',
    titleKey: 'onboarding.tips.kubernetes.title',
    bodyKey: 'onboarding.tips.kubernetes.body'
  },
  {
    id: 'tip-cicd',
    view: 'monitor',
    module: 'cicd',
    tab: 'cicd',
    titleKey: 'onboarding.tips.cicd.title',
    bodyKey: 'onboarding.tips.cicd.body'
  },
  {
    id: 'tip-processes',
    view: 'monitor',
    module: 'processes',
    tab: 'processes',
    titleKey: 'onboarding.tips.processes.title',
    bodyKey: 'onboarding.tips.processes.body'
  }
]

/**
 * The tips a given module state can actually justify showing.
 *
 * Filtered here rather than in the arrays above, and that is deliberate: `TOUR_STEPS`,
 * `FEATURE_TIPS` and `FULL_WALKTHROUGH` are the COMPLETE lists and stay that way
 * — tests/onboardingTour.test.ts pins `FULL_WALKTHROUGH` to exactly their union, on
 * the argument that a replay from Settings is somebody asking for the whole thing.
 * Adaptation is a question about one install at one moment, so it belongs at the
 * point of use.
 */
export function tipsFor(modules: ModuleState | undefined): FeatureTip[] {
  return FEATURE_TIPS.filter((t) => !t.module || moduleEnabled(modules, t.module))
}

/**
 * The walkthrough, adapted to what this install actually has.
 *
 * Used by the replay from Settings. Somebody who asks for the walkthrough wants
 * all of it, which is why `FULL_WALKTHROUGH` exists — but "all of it" cannot
 * honestly include four panels about modules they have switched off. The first and
 * last steps are never about a module, so the shape is preserved: it still opens on
 * adding a server and still ends on the command palette.
 */
export function walkthroughFor(modules: ModuleState | undefined): TourStep[] {
  return [TOUR_STEPS[0], ...tipsFor(modules), TOUR_STEPS[1]]
}

/**
 * Everything, in the order it used to be shown.
 *
 * Settings offers to replay the walkthrough, and somebody who asks for it
 * explicitly is asking for the whole thing — deferring six of eight to a
 * trigger they have already passed would give them two panels and nothing else.
 */
export const FULL_WALKTHROUGH: TourStep[] = [TOUR_STEPS[0], ...FEATURE_TIPS, TOUR_STEPS[1]]
