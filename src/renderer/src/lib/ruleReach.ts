import { DISK_DANGER } from '../../../shared/hostHealth'
import type { RuleAlertKind } from '../../../shared/rules'

// Whether a rule as written can ever act.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
//
// A tester wrote this rule and reported it as a bug when nothing happened:
//
//   When Disk raised, on one server, at or above 20 → post to the webhook
//
// The disk on that host was around 60%, so by every reading of the sentence on
// screen the rule should have fired. It cannot. `at or above 20` is not a
// threshold — it is a FILTER on an alert that something else has already
// raised, and the disk alert is fixed at DISK_DANGER and raises strictly above
// it. At 60% no disk alert exists, so there is nothing for the filter to let
// through, and the rule sits at "has not acted yet" forever.
//
// The form invited the mistake precisely: it offers a metric, the word
// "raised", and a number box, which is the shape of every threshold control in
// every monitoring product. Nothing on the panel said that the number could
// not reach.
//
// So this is not decoration. The rule engine's own semantics are correct and
// stay unchanged; what was missing is that the form never said what the
// engine would do with the number.
//
// ===========================================================================
// WHAT IS AND IS NOT A PROBLEM
// ===========================================================================
//
// A `minValue` BELOW the alert's floor is not broken, and this deliberately
// does not call it an error. The rule still fires — at the floor, not at the
// number typed. That is a rule which does something other than what its author
// believes, which is worth a sentence and is not worth refusing to save.
//
// A `minValue` at or above the floor is exactly what the filter is for
// ("webhook me only when disk passes 95, not at the usual 85"), and says
// nothing.
//
// Pure, and separate from the panel, for the reason sweepBlock is: the rule is
// the feature, so it is the part that has to be right, and it should be
// testable without mounting a form.

/** How an alert kind's own threshold is decided. */
export interface AlertFloor {
  /** The value the alert engine itself raises at. */
  value: number
  /**
   * True when the engine raises STRICTLY above `value` rather than at it.
   *
   * Disk is strict — see the note in store/alerts.ts, where "at or above 85%"
   * was called out as a claim the code does not implement. Carried here so the
   * sentence this file produces cannot drift from the one the engine means.
   */
  strict: boolean
  /** Whether a person can change it, and where. */
  fixed: boolean
  /** Units for the sentence: '%' for percentages, '' for a load average. */
  unit: string
}

/** Fixed at the number every other screen colours a bar at. */
const INODE_DANGER = 85
/** Per core. */
const LOAD_DANGER = 2

/**
 * The floor for a kind, or null when the kind carries no numeric reading.
 *
 * `cpu` is the only movable one — see the note on
 * `resourceAlertThresholds` in store/app.ts, which says why disk, inodes and
 * load are deliberately fixed: an alert that fired at a different number from
 * the screen it sends you to is worse than no alert.
 */
export function alertFloor(kind: RuleAlertKind, resourceThreshold: number): AlertFloor | null {
  switch (kind) {
    case 'cpu':
      // The one movable floor here. Memory shares the same setting in the
      // alert engine but is not a rule trigger at all — RuleAlertKind is the
      // intersection of the store's kinds and the wire's, and memory is in
      // neither — so there is no `ram` case to write.
      return { value: resourceThreshold, strict: false, fixed: false, unit: '%' }
    case 'disk':
      return { value: DISK_DANGER, strict: true, fixed: true, unit: '%' }
    case 'inode':
      return { value: INODE_DANGER, strict: true, fixed: true, unit: '%' }
    case 'load':
      return { value: LOAD_DANGER, strict: false, fixed: true, unit: ' per core' }
    default:
      // Every other kind — a failed unit, an unreachable host, a job that
      // failed — is an event, not a reading. A minValue on one of those is
      // meaningless rather than merely unreachable, and the form already
      // labels the box "any reading".
      return null
  }
}

export interface RuleWarning {
  /** Which control the sentence is about, so the panel can put it there. */
  field: 'minValue' | 'action'
  text: string
}

/**
 * What to tell someone about the rule they are typing, before they save it.
 *
 * Returns every applicable warning rather than the first: a rule can both be
 * filtered below its floor AND point at a webhook that is switched off, and
 * showing one of those two would send them away to fix half the problem.
 */
export function ruleWarnings(input: {
  kind: RuleAlertKind
  /** As typed. Blank or unparseable means "any reading", which never warns. */
  minValue: string
  event: 'raised' | 'resolved'
  action: 'notify' | 'job'
  /**
   * The CPU threshold in force for the chosen server: the workspace global, or
   * this host's override. The panel resolves it with `hostThreshold` so the
   * sentence names the same number the engine will compare against.
   */
  resourceThreshold: number
  webhookEnabled: boolean
}): RuleWarning[] {
  const out: RuleWarning[] = []
  const floor = alertFloor(input.kind, input.resourceThreshold)
  const typed = Number(input.minValue.trim())

  // A blank box is "any reading" and is the common, correct case.
  //
  // Only `raised` is checked. On `resolved` the reading travels the other way
  // — a disk alert clears at 85 or below, so a filter of 20 is reachable there
  // and warning about it would be false. The asymmetry is the whole reason
  // this takes `event` at all.
  if (
    input.event === 'raised' &&
    floor !== null &&
    input.minValue.trim() !== '' &&
    Number.isFinite(typed)
  ) {
    // `strict` matters at the boundary and only there: a disk filter of exactly
    // 85 is unreachable because the alert raises above 85, while a CPU filter
    // of exactly 80 is reachable because that alert raises at 80.
    const unreachable = floor.strict ? typed <= floor.value : typed < floor.value
    if (unreachable) {
      const at = `${floor.value}${floor.unit}`
      out.push({
        field: 'minValue',
        text: floor.fixed
          ? `A ${LABEL[input.kind] ?? input.kind} alert is only raised ${floor.strict ? 'above' : 'at or above'} ${at}, and that number is fixed. This rule will not act until then — ${typed}${floor.unit} makes no difference to when it fires.`
          : `A ${LABEL[input.kind] ?? input.kind} alert is only raised at or above ${at} for this server, so this rule will not act below that. Change the alert threshold in Settings if ${typed}${floor.unit} is the line you want.`
      })
    }
  }

  if (input.action === 'notify' && !input.webhookEnabled) {
    out.push({
      field: 'action',
      // Said as a fact about delivery, not as a validation failure: the rule is
      // legitimate and saving it before configuring the endpoint is a
      // reasonable order to work in.
      text: 'Webhook delivery is switched off, so this rule will match and send nothing. Turn it on in Settings → Alerts.'
    })
  }

  return out
}

const LABEL: Partial<Record<RuleAlertKind, string>> = {
  cpu: 'CPU',
  disk: 'disk',
  inode: 'inode',
  load: 'load'
}
