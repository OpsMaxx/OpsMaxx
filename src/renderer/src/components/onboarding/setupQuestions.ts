import type { ModuleId, ModuleState } from '../../../../shared/modules'
import type { UpdateChannel, CheckIntervalHours, UpdatePrefs } from '../../../../shared/updater'
import type { ThemeMode } from '../../store/app'
import type { MessageKey } from '../../../../shared/i18n'
import { t } from '../../lib/i18n'

/**
 * The questions a first run asks before the app is handed over.
 *
 * Twenty modules ship in this app and fifteen of them used to arrive off, with
 * nothing anywhere that asked. A new install was a terminal and an empty
 * Operations rail, and the only route to the rest was Settings › Modules — a
 * page you have to already know exists. That is the whole reason this file is
 * here: not to explain the modules, but to ask.
 *
 * Why questions rather than better defaults. Half of these turn on work against
 * machines the user does not own: running a package manager on every host, or
 * executing a command across the estate. A default cannot ask, and `an upgrade
 * is not consent` is the rule the module registry is already built around
 * (see backfillModules). A tick box the user saw and left ticked IS consent;
 * a default they never saw is not. So the modules that only read local history
 * or an already-open connection default on, and everything that reaches out
 * lives here.
 *
 * ===========================================================================
 * WHY THIS IS A WIZARD NOW, HAVING ARGUED AT LENGTH THAT IT SHOULD NOT BE
 * ===========================================================================
 *
 * It used to be one screen, on the theory that this audience closes multi-step
 * wizards and that everything visible at once is answerable in a keystroke
 * without reading. The theory met a first-time user, who did not read it. One
 * screen carrying a persona row, four questions of three lines each and four
 * preference groups is not a form that is quick to answer; it is a wall, and
 * being able to dismiss a wall with Enter is not the same as having read it.
 *
 * So it is six screens: the persona, the four questions one at a time, and a
 * review that still carries the preference groups collapsed. What the old
 * argument was actually protecting was never the single screen — it was the
 * guarantee underneath it, that somebody who commits without reading gets a
 * fuller app and nothing that writes to a server. That guarantee is untouched and
 * still pinned by tests/setupQuestions.test.ts: Enter now ADVANCES rather than
 * commits, so six of them commit exactly the defaults one of them used to, and
 * Escape still accepts what is on screen and skips the rest.
 *
 * The preferences did NOT become ten more screens. They keep the collapsed
 * <details> shape on the review step, because they already have working defaults
 * and the rule below means the right outcome for most installs is to touch none
 * of them. Progressive disclosure was the right tool for decisions most people
 * should not make, and the wrong tool for four questions everybody must.
 *
 * Why a persona at all, when the four questions already exist. The questions ask
 * what you DO with servers, which is the right question and the wrong starting
 * point: answering four of them from scratch is four decisions before the app has
 * shown you anything. A persona is one decision that fills in all four plus the
 * preferences, and every control stays editable afterwards. It is a PRESET, not
 * an identity: nothing is stored under a persona name, nothing downstream reads
 * one, and picking a different one simply re-fills the form.
 */
export interface SetupQuestion {
  id: string
  /** Asked in the second person, answerable without knowing the product. */
  questionKey: MessageKey
  /** What answering yes turns on, in the user's terms rather than module ids. */
  detailKey: MessageKey
  /** The honest cost, shown whether or not it flatters the answer. */
  costKey: MessageKey
  modules: ModuleId[]
  /**
   * The answer this question's screen opens on.
   *
   * Only ever `true` for answers whose modules read and never write. Somebody who
   * presses Enter through every screen without reading gets a fuller app than
   * they had before and nothing that touches a server they have not already
   * opened.
   */
  preselected: boolean
}

export const SETUP_QUESTIONS: SetupQuestion[] = [
  {
    id: 'containers',
    questionKey: 'onboarding.questions.containers.question',
    detailKey: 'onboarding.questions.containers.detail',
    costKey: 'onboarding.questions.containers.cost',
    modules: ['docker', 'kubernetes'],
    preselected: true
  },
  {
    id: 'fleet',
    questionKey: 'onboarding.questions.fleet.question',
    detailKey: 'onboarding.questions.fleet.detail',
    costKey: 'onboarding.questions.fleet.cost',
    modules: ['inventory', 'drift', 'changeLog', 'posture'],
    preselected: false
  },
  {
    id: 'operate',
    questionKey: 'onboarding.questions.operate.question',
    detailKey: 'onboarding.questions.operate.detail',
    costKey: 'onboarding.questions.operate.cost',
    modules: ['broadcast', 'patch', 'jobs'],
    preselected: false
  },
  {
    id: 'cicd',
    questionKey: 'onboarding.questions.cicd.question',
    detailKey: 'onboarding.questions.cicd.detail',
    // Two costs, because there are two and hiding either would flatter the
    // answer: the traffic leaves the machine, and the token is long-lived.
    costKey: 'onboarding.questions.cicd.cost',
    // `cicd` only. `cicdTrigger` is a module this card deliberately cannot
    // reach, for the reason `keyRevoke` cannot: "do you use CI" is a question
    // about what you have, and starting builds on infrastructure OpsMaxx does
    // not administer is a decision about what you do. One tick should not
    // answer both.
    modules: ['cicd'],
    preselected: false
  }
]

/**
 * Fold the answers into the module state.
 *
 * A false answer turns its modules OFF rather than leaving them alone: the
 * card shows what each answer controls, so somebody who answers no to containers
 * has said something about Docker, and honouring only the yeses would make the
 * card a one-way switch that quietly disagrees with what it displayed.
 *
 * Modules not named by any question are untouched. That is deliberate and it
 * is the safe direction — `rules` (the only unattended execution path),
 * `keyRevoke` and `access` are reachable from Settings and from nowhere else,
 * which is the protection they were given on purpose.
 */
export function applySetupAnswers(base: ModuleState, answers: Record<string, boolean>): ModuleState {
  const next: ModuleState = { ...base }
  for (const q of SETUP_QUESTIONS) {
    const on = answers[q.id] === true
    for (const id of q.modules) next[id] = on
  }
  return next
}

/** What the card starts with, before the user touches anything. */
export function defaultSetupAnswers(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const q of SETUP_QUESTIONS) out[q.id] = q.preselected
  return out
}

// ---------------------------------------------------------------------------
// PREFERENCES — the half of the first run that is not a module
// ---------------------------------------------------------------------------
//
// Modules decide what the app CONTAINS. These decide how it BEHAVES, and a few
// of them shape the experience more than any single module does: whether it
// polls the estate in the background, whether it tells you when a server is
// struggling, when it takes an update, what it looks like. All of them were
// reachable only from Settings, which is a page you have to already know exists
// — the same argument that put the module questions on this card.
//
// ===========================================================================
// THE ONE RULE THAT MATTERS HERE: WRITE ONLY WHAT WAS TOUCHED
// ===========================================================================
//
// `AppSettings` is persisted WHOLESALE and merged saved-over-default
// (store/app.ts: `{ ...DEFAULT_SETTINGS, ...data.settings }`). So any value this
// card writes explicitly is written into that install's data file for good, and
// permanently outranks a later change to the default. A card that helpfully
// wrote all eight of these on every first run would freeze all eight, for every
// user, forever — and the trap is invisible, because it looks like it worked.
//
// Hence `PrefAnswers` holds `undefined` for "not touched" rather than a value,
// and `setupPatch()` returns a patch containing only the keys somebody moved.
// Pressing Enter without opening a group writes NOTHING, and the defaults stay
// defaults that a later release can still change.
//
// The three stores are also why a patch is the shape. These fields do not live
// together: theme is top-level renderer state, four are `AppSettings`, and the
// update preferences are owned by MAIN in its own file, because the launch check
// happens before a window exists. One card, three destinations, so nothing here
// may assume it can be handed over in a single object.

/** A choice on a preference group. `undefined` means the user never touched it. */
export interface PrefAnswers {
  // Look & feel
  theme?: ThemeMode
  compactDensity?: boolean
  // Watching the estate
  fleetSamplingEnabled?: boolean
  fleetSamplingIntervalMs?: number
  // Alerts
  resourceAlertsEnabled?: boolean
  resourceAlertThreshold?: number
  // Updates — these go to main, not into AppSettings.
  updateChannel?: UpdateChannel
  updateAutoCheck?: boolean
  updateCheckIntervalHours?: CheckIntervalHours
  updateAutoDownload?: boolean
}

/**
 * The `AppSettings` keys this card may write.
 *
 * Named as a type rather than left as `Record<string, unknown>` so that putting
 * an update preference in the wrong bag is a compile error. That mistake is
 * otherwise invisible: `AppSettings` has no `channel` key, main never hears about
 * it, and the card appears to have worked while the preference does nothing.
 */
export type SettingsPatch = Partial<{
  compactDensity: boolean
  fleetSamplingEnabled: boolean
  fleetSamplingIntervalMs: number
  resourceAlertsEnabled: boolean
  resourceAlertThreshold: number
}>

/** One option on a preference control. */
export interface PrefOption<T> {
  value: T
  labelKey: MessageKey
  /** The cost or consequence, where there is one worth stating. */
  detailKey?: MessageKey
  /**
   * How this option reads in the COLLAPSED group header, where it has no label
   * beside it to make sense of.
   *
   * A yes/no control labelled "Check automatically" summarises as "Yes", and a
   * header reading "Stable only · Yes · Every 6 hours · Yes" tells the reader
   * nothing about what was answered yes to -- the question is the part that did
   * not fit. So an option may carry its own self-contained wording, and an empty
   * string means "leave me out of the summary entirely", which is the right answer
   * for a default that is already implied by its neighbour.
   */
  shortKey?: MessageKey | ''
}

/**
 * A preference the card can ask about.
 *
 * `key` is the `PrefAnswers` field; the group knows how to route it. Deliberately
 * NOT a path into a store — the three destinations are resolved once, in
 * `setupPatch`, rather than encoded into fourteen strings here.
 */
export interface PrefControl {
  key: keyof PrefAnswers
  labelKey: MessageKey
  /** What it does, in the user's terms. */
  detailKey: MessageKey
  /** Shown as radio buttons when there are two or three, a dropdown beyond. */
  options: PrefOption<string | number | boolean>[]
  /** The value the app behaves as today, so the card can show it as current. */
  fallback: string | number | boolean
  /** Only offered when this other key is not switched off. */
  requires?: { key: keyof PrefAnswers; is: string | number | boolean }
}

export interface PrefGroup {
  id: string
  labelKey: MessageKey
  /** One line, shown under the group title when it is open. */
  detailKey: MessageKey
  controls: PrefControl[]
}

export const PREF_GROUPS: PrefGroup[] = [
  {
    id: 'updates',
    labelKey: 'onboarding.prefs.updates.label',
    detailKey: 'onboarding.prefs.updates.detail',
    controls: [
      {
        key: 'updateChannel',
        labelKey: 'onboarding.prefs.updateChannel.label',
        detailKey: 'onboarding.prefs.updateChannel.detail',
        fallback: 'stable',
        options: [
          { value: 'stable', labelKey: 'onboarding.prefs.updateChannel.stable', shortKey: 'onboarding.prefs.updateChannel.stableShort' },
          { value: 'beta', labelKey: 'onboarding.prefs.updateChannel.beta', detailKey: 'onboarding.prefs.updateChannel.betaDetail', shortKey: 'onboarding.prefs.updateChannel.betaShort' }
        ]
      },
      {
        key: 'updateAutoCheck',
        labelKey: 'onboarding.prefs.updateAutoCheck.label',
        detailKey: 'onboarding.prefs.updateAutoCheck.detail',
        fallback: true,
        options: [
          // Omitted when on: the interval line beside it already says checking
          // happens, and "Yes" beside "every 6 hours" is a word with no subject.
          { value: true, labelKey: 'common.yes', shortKey: '' },
          { value: false, labelKey: 'onboarding.prefs.updateAutoCheck.no', shortKey: 'onboarding.prefs.updateAutoCheck.noShort' }
        ]
      },
      {
        key: 'updateCheckIntervalHours',
        labelKey: 'onboarding.prefs.updateCheckIntervalHours.label',
        detailKey: 'onboarding.prefs.updateCheckIntervalHours.detail',
        fallback: 6,
        requires: { key: 'updateAutoCheck', is: true },
        options: [
          { value: 0, labelKey: 'onboarding.prefs.updateCheckIntervalHours.launch', shortKey: 'onboarding.prefs.updateCheckIntervalHours.launchShort' },
          { value: 6, labelKey: 'onboarding.prefs.updateCheckIntervalHours.sixHours', shortKey: 'onboarding.prefs.updateCheckIntervalHours.sixHoursShort' },
          { value: 24, labelKey: 'onboarding.prefs.updateCheckIntervalHours.daily', shortKey: 'onboarding.prefs.updateCheckIntervalHours.dailyShort' }
        ]
      },
      {
        key: 'updateAutoDownload',
        labelKey: 'onboarding.prefs.updateAutoDownload.label',
        detailKey: 'onboarding.prefs.updateAutoDownload.detail',
        fallback: true,
        requires: { key: 'updateAutoCheck', is: true },
        options: [
          { value: true, labelKey: 'common.yes', shortKey: 'onboarding.prefs.updateAutoDownload.yesShort' },
          { value: false, labelKey: 'onboarding.prefs.updateAutoDownload.ask', shortKey: 'onboarding.prefs.updateAutoDownload.askShort' }
        ]
      }
    ]
  },
  {
    id: 'fleet',
    labelKey: 'onboarding.prefs.fleet.label',
    detailKey: 'onboarding.prefs.fleet.detail',
    controls: [
      {
        key: 'fleetSamplingEnabled',
        labelKey: 'onboarding.prefs.fleetSamplingEnabled.label',
        // The honest cost, stated the way the module questions state theirs.
        detailKey: 'onboarding.prefs.fleetSamplingEnabled.detail',
        fallback: false,
        options: [
          { value: false, labelKey: 'onboarding.prefs.fleetSamplingEnabled.whileLooking', shortKey: 'onboarding.prefs.fleetSamplingEnabled.whileLookingShort' },
          { value: true, labelKey: 'onboarding.prefs.fleetSamplingEnabled.background', shortKey: 'onboarding.prefs.fleetSamplingEnabled.backgroundShort' }
        ]
      },
      {
        key: 'fleetSamplingIntervalMs',
        labelKey: 'onboarding.prefs.fleetSamplingIntervalMs.label',
        detailKey: 'onboarding.prefs.fleetSamplingIntervalMs.detail',
        fallback: 120000,
        requires: { key: 'fleetSamplingEnabled', is: true },
        options: [
          { value: 60000, labelKey: 'onboarding.prefs.fleetSamplingIntervalMs.oneMinute', shortKey: 'onboarding.prefs.fleetSamplingIntervalMs.oneMinuteShort' },
          { value: 120000, labelKey: 'onboarding.prefs.fleetSamplingIntervalMs.twoMinutes', shortKey: 'onboarding.prefs.fleetSamplingIntervalMs.twoMinutesShort' },
          { value: 300000, labelKey: 'onboarding.prefs.fleetSamplingIntervalMs.fiveMinutes', shortKey: 'onboarding.prefs.fleetSamplingIntervalMs.fiveMinutesShort' },
          { value: 900000, labelKey: 'onboarding.prefs.fleetSamplingIntervalMs.fifteenMinutes', shortKey: 'onboarding.prefs.fleetSamplingIntervalMs.fifteenMinutesShort' }
        ]
      }
    ]
  },
  {
    id: 'alerts',
    labelKey: 'onboarding.prefs.alerts.label',
    detailKey: 'onboarding.prefs.alerts.detail',
    controls: [
      {
        key: 'resourceAlertsEnabled',
        labelKey: 'onboarding.prefs.resourceAlertsEnabled.label',
        detailKey: 'onboarding.prefs.resourceAlertsEnabled.detail',
        fallback: true,
        options: [
          // Omitted when on: the threshold beside it carries the meaning.
          { value: true, labelKey: 'common.yes', shortKey: '' },
          { value: false, labelKey: 'onboarding.prefs.resourceAlertsEnabled.off', shortKey: 'onboarding.prefs.resourceAlertsEnabled.offShort' }
        ]
      },
      {
        key: 'resourceAlertThreshold',
        labelKey: 'onboarding.prefs.resourceAlertThreshold.label',
        detailKey: 'onboarding.prefs.resourceAlertThreshold.detail',
        fallback: 80,
        requires: { key: 'resourceAlertsEnabled', is: true },
        options: [
          { value: 70, labelKey: 'onboarding.prefs.resourceAlertThreshold.early', shortKey: 'onboarding.prefs.resourceAlertThreshold.earlyShort' },
          { value: 80, labelKey: 'onboarding.prefs.resourceAlertThreshold.normal', shortKey: 'onboarding.prefs.resourceAlertThreshold.normalShort' },
          { value: 90, labelKey: 'onboarding.prefs.resourceAlertThreshold.serious', shortKey: 'onboarding.prefs.resourceAlertThreshold.seriousShort' }
        ]
      }
    ]
  },
  {
    id: 'look',
    labelKey: 'onboarding.prefs.look.label',
    detailKey: 'onboarding.prefs.look.detail',
    controls: [
      {
        key: 'theme',
        labelKey: 'onboarding.prefs.theme.label',
        detailKey: 'onboarding.prefs.theme.detail',
        fallback: 'opsmaxx',
        options: [
          { value: 'opsmaxx', labelKey: 'onboarding.prefs.theme.opsmaxx' },
          { value: 'opsmaxx-light', labelKey: 'onboarding.prefs.theme.opsmaxxLight' },
          { value: 'dark', labelKey: 'onboarding.prefs.theme.dark' },
          { value: 'light', labelKey: 'onboarding.prefs.theme.light' },
          { value: 'system', labelKey: 'onboarding.prefs.theme.system' }
        ]
      },
      {
        key: 'compactDensity',
        labelKey: 'onboarding.prefs.compactDensity.label',
        detailKey: 'onboarding.prefs.compactDensity.detail',
        fallback: false,
        options: [
          { value: false, labelKey: 'onboarding.prefs.compactDensity.comfortable' },
          { value: true, labelKey: 'onboarding.prefs.compactDensity.compact' }
        ]
      }
    ]
  }
]

/** Whether a control is offered, given the answers so far. */
export function prefAvailable(c: PrefControl, answers: PrefAnswers): boolean {
  if (!c.requires) return true
  const current = answers[c.requires.key] ?? valueOf(c.requires.key, answers)
  return current === c.requires.is
}

/** The value a control is showing: the answer if touched, else its fallback. */
function valueOf(key: keyof PrefAnswers, answers: PrefAnswers): string | number | boolean {
  if (answers[key] !== undefined) return answers[key] as string | number | boolean
  for (const g of PREF_GROUPS) {
    const c = g.controls.find((x) => x.key === key)
    if (c) return c.fallback
  }
  return false
}

export function prefValue(
  c: PrefControl,
  answers: PrefAnswers
): string | number | boolean {
  return answers[c.key] !== undefined ? (answers[c.key] as string | number | boolean) : c.fallback
}

/** What a collapsed group shows in its header: the values, in order, joined. */
export function prefSummary(g: PrefGroup, answers: PrefAnswers): string {
  const parts: string[] = []
  for (const c of g.controls) {
    if (!prefAvailable(c, answers)) continue
    const v = prefValue(c, answers)
    const opt = c.options.find((o) => o.value === v)
    if (!opt) continue
    // `shortKey` where the option carries one -- including an empty one, which
    // means "omit me". Only fall back to the label when nothing was said.
    const key = opt.shortKey !== undefined ? opt.shortKey : opt.labelKey
    if (key) parts.push(t(key))
  }
  return parts.join(' · ')
}

/**
 * The three patches this card has to apply, containing ONLY what was touched.
 *
 * Split by destination rather than returned as one object, because the three
 * destinations are genuinely three: `settings` goes through `setSettings`, `theme`
 * is top-level store state with its own setter, and `update` has to cross the
 * bridge into main. A single blob would force the caller to take it apart again,
 * and the one thing that must not be lost on the way is the emptiness — see the
 * rule at the top of this section.
 */
export function setupPatch(answers: PrefAnswers): {
  settings: SettingsPatch
  theme: ThemeMode | null
  update: Partial<UpdatePrefs>
} {
  const settings: SettingsPatch = {}
  const update: Partial<UpdatePrefs> = {}

  if (answers.compactDensity !== undefined) settings.compactDensity = answers.compactDensity
  if (answers.fleetSamplingEnabled !== undefined) {
    settings.fleetSamplingEnabled = answers.fleetSamplingEnabled
  }
  if (answers.fleetSamplingIntervalMs !== undefined) {
    settings.fleetSamplingIntervalMs = answers.fleetSamplingIntervalMs
  }
  if (answers.resourceAlertsEnabled !== undefined) {
    settings.resourceAlertsEnabled = answers.resourceAlertsEnabled
  }
  if (answers.resourceAlertThreshold !== undefined) {
    settings.resourceAlertThreshold = answers.resourceAlertThreshold
  }

  if (answers.updateChannel !== undefined) update.channel = answers.updateChannel
  if (answers.updateAutoCheck !== undefined) update.autoCheck = answers.updateAutoCheck
  if (answers.updateCheckIntervalHours !== undefined) {
    update.checkIntervalHours = answers.updateCheckIntervalHours
  }
  if (answers.updateAutoDownload !== undefined) update.autoDownload = answers.updateAutoDownload

  return { settings, theme: answers.theme ?? null, update }
}

// ---------------------------------------------------------------------------
// PERSONAS — one decision that fills in all the others
// ---------------------------------------------------------------------------
//
// A persona is a PRESET over the answers above. It is emphatically not an
// identity: nothing is stored under a persona name, no code anywhere branches on
// one, and picking a different one just re-fills the form. That is the whole
// design, and it is what keeps this from leaking into the rest of the app — the
// module registry stays the only thing that decides what the app contains, and
// `ModuleState` stays the only thing that records it.
//
// Why it earns its place on a card that was already answerable in one keystroke:
// the four questions ask what you DO with servers, which is the right question
// asked from a standing start. "Do you look after a fleet, or a couple of
// machines" is four words of jargon away from "am I the person this row is for".
// A job title is the one thing a new user knows for certain about themselves, so
// it is the cheapest possible first answer, and it sets seven or eight others.
//
// THE CONSTRAINT, which is not negotiable and is pinned by
// tests/setupQuestions.test.ts: a persona may set the four question answers and
// the preferences, and NOTHING ELSE. It reaches modules only through
// `SETUP_QUESTIONS`, so it inherits that list's protections for free — `rules`,
// `keyRevoke`, `access` and `cicdTrigger` are unreachable from this card by
// construction rather than by a rule somebody has to remember, because no
// question names them. A persona with its own `modules` array would have thrown
// that away, which is exactly why it does not have one.
//
// The preference presets are deliberately timid. Only `fleetSampling` is set by
// any persona, because it is the one preference whose right answer genuinely
// follows from the job — an SRE wants the estate watched while they are not
// looking, and someone with two machines does not. Theme, density, alert
// threshold and every update preference are left UNTOUCHED by every persona, for
// the reason at the top of the preferences section: a value written here is
// frozen for that install forever, and nothing about a job title implies a
// colour scheme.

export interface Persona {
  id: string
  labelKey: MessageKey
  /** One line, in the second person, recognisable without knowing the product. */
  detailKey: MessageKey
  /** Answers to SETUP_QUESTIONS. Ids not named here are left false. */
  answers: Record<string, boolean>
  /** Preference answers. Kept minimal on purpose — see above. */
  prefs: PrefAnswers
}

export const PERSONAS: Persona[] = [
  {
    id: 'devops',
    labelKey: 'onboarding.personas.devops.label',
    detailKey: 'onboarding.personas.devops.detail',
    answers: { containers: true, cicd: true, operate: true, fleet: false },
    prefs: {}
  },
  {
    id: 'cloud',
    labelKey: 'onboarding.personas.cloud.label',
    detailKey: 'onboarding.personas.cloud.detail',
    answers: { containers: true, cicd: true, fleet: true, operate: false },
    prefs: { fleetSamplingEnabled: true }
  },
  {
    id: 'infra',
    labelKey: 'onboarding.personas.infra.label',
    detailKey: 'onboarding.personas.infra.detail',
    answers: { fleet: true, operate: true, containers: false, cicd: false },
    prefs: { fleetSamplingEnabled: true }
  },
  {
    id: 'sre',
    labelKey: 'onboarding.personas.sre.label',
    detailKey: 'onboarding.personas.sre.detail',
    answers: { containers: true, fleet: true, cicd: false, operate: false },
    prefs: { fleetSamplingEnabled: true }
  }
]

/**
 * NOTHING is preselected, and this is a safety decision rather than a UI one.
 *
 * The card's central guarantee — pinned by tests/setupQuestions.test.ts under
 * "pressing Enter without reading" — is that somebody who commits without reading
 * gets a FULLER app and nothing that writes to a server. `defaultSetupAnswers()`
 * upholds it by preselecting only the containers question, whose modules read.
 *
 * Preselecting a persona would have broken it outright. The DevOps preset answers
 * the `operate` question `true`, which turns on `broadcast`, `patch` and `jobs` —
 * running commands across the estate, installing packages, rebooting hosts. Had
 * the card opened with that persona chosen, pressing Enter on a first launch would
 * have enabled all three without anybody reading a word, which is precisely the
 * outcome `defaultEnabled: false` on every operate module exists to prevent. "A
 * tick box the user saw and left ticked IS consent; a default they never saw is
 * not" — and a persona nobody chose is the second thing.
 *
 * So the row opens with none selected. PICKING one is a deliberate act, and a
 * persona may then enable operate modules on exactly the same footing as ticking
 * the question by hand.
 */
export const DEFAULT_PERSONA_ID: string | null = null

/**
 * The question answers a persona implies.
 *
 * Every question id is present in the result, so switching persona turns things
 * OFF as well as on — the card shows what each answer controls, and a preset that
 * only ever added would leave a user who changed their mind with the union of two
 * personas rather than the one they picked.
 */
export function personaAnswers(p: Persona): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const q of SETUP_QUESTIONS) out[q.id] = p.answers[q.id] === true
  return out
}
