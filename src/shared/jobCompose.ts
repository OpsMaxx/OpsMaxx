import type { JobSpec, JobStep } from './jobs'

// Turning what an operator typed into a job spec.
//
// The finding this closes is item 33's: the job engine shipped in full -- waves,
// health gate, reboot-and-verify, detached execution, approval record -- and no
// renderer composed a job. `jobs.run` had exactly one caller, PatchPanel, so
// "restart nginx on twelve servers", "install a package everywhere" and "push
// this config" were all the same missing thing wearing different clothes.
//
// WHY THE PARSING IS HERE AND NOT IN THE PANEL. The step text ends up inside
// the approval record, which main re-derives and compares literally. A panel
// that trimmed a line differently from the thing that later re-reads it would
// produce a job that refuses itself, with a message about a disagreement
// nobody can see. One parser, called by the panel and by its tests.

/** Steps past this and the dialog stops being readable, which is the point of
 *  the dialog. Not a technical limit. */
export const JOB_MAX_STEPS = 50
/** Servers past this in one wave and "who is this about to touch" stops being a
 *  question the operator can answer by looking. */
export const JOB_MAX_WAVE = 100

export interface JobDraft {
  title: string
  /** One command per line. Blank lines and `#` comments are dropped. */
  steps: string
  /** Servers per wave. 0 means "all at once", which is what `planWaves` means
   *  by a size of 0 and is spelled out rather than left as a magic number. */
  waveSize: number
  /** Hold each wave until every server in it reports healthy AFTER the wave
   *  finished. A property of the spec, so it is part of the approval. */
  gate: boolean
  /** The LAST step restarts the machine. Declared rather than sniffed, because
   *  a declared reboot gets the reboot-and-wait treatment and a sniffed one
   *  gets `unreachable`. */
  rebootLast: boolean
}

export const EMPTY_JOB_DRAFT: JobDraft = {
  title: '',
  steps: '',
  waveSize: 0,
  gate: false,
  rebootLast: false
}

/**
 * The commands, in order, as they will appear in the approval record.
 *
 * `#` comments are dropped rather than sent. A commented line in a textarea is
 * a note to the person typing, and shipping it as a step would run it -- `#` is
 * a comment to `sh`, so it would "work", and the approval record would then
 * carry a line the operator meant as prose.
 */
export function parseJobSteps(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

export type JobDraftCheck = { ok: true } | { ok: false; reason: string }

/**
 * Whether this draft can be turned into a job, and if not, why in a sentence.
 *
 * Says what is wrong rather than disabling a button silently: a Run button that
 * is grey for a reason nobody states is a bug report.
 */
export function checkJobDraft(draft: JobDraft, targetCount: number): JobDraftCheck {
  const title = draft.title.trim()
  if (title === '') return { ok: false, reason: 'Give the job a title. It is what the list shows later.' }
  if (title.length > 120) return { ok: false, reason: 'The title is too long to read in a list. Keep it under 120 characters.' }

  const steps = parseJobSteps(draft.steps)
  if (steps.length === 0) return { ok: false, reason: 'Add at least one command. Blank lines and # comments do not count.' }
  if (steps.length > JOB_MAX_STEPS) {
    return { ok: false, reason: `${steps.length} steps is more than the ${JOB_MAX_STEPS} this dialog can show you at once, and a confirmation nobody can read is not one.` }
  }

  if (targetCount === 0) return { ok: false, reason: 'Pick at least one server.' }

  if (!Number.isInteger(draft.waveSize) || draft.waveSize < 0) {
    return { ok: false, reason: 'The wave size must be a whole number, or 0 for all servers at once.' }
  }
  if (draft.waveSize > JOB_MAX_WAVE) {
    return { ok: false, reason: `A wave of ${draft.waveSize} servers is more than this will run at once. Use ${JOB_MAX_WAVE} or fewer.` }
  }

  // A gate with one wave gates nothing, and an operator who ticked it believes
  // otherwise. Said out loud rather than quietly ignored.
  if (draft.gate && (draft.waveSize === 0 || draft.waveSize >= targetCount)) {
    return {
      ok: false,
      reason: 'The health gate holds each wave until the previous one is healthy, so it needs more than one wave. Set a wave size smaller than the number of servers, or untick the gate.'
    }
  }

  return { ok: true }
}

/**
 * The spec, which is what the approval record is minted over.
 *
 * `kind: 'command'` because that is what this is. A typed kind -- service,
 * package, file, user -- is item 34, and each of those builds its step text in
 * main so the record holds structured intent rather than a line somebody typed.
 * This one holds the line somebody typed, and says so.
 */
export function composeJobSpec(draft: JobDraft): JobSpec {
  const commands = parseJobSteps(draft.steps)
  const steps: JobStep[] = commands.map((command, i) => {
    const last = i === commands.length - 1
    return draft.rebootLast && last ? { command, reboot: true } : { command }
  })
  return {
    kind: 'command',
    title: draft.title.trim(),
    steps,
    ...(draft.gate ? { gate: 'health' as const } : {})
  }
}

/**
 * Wave labels for a target list, as `cohort` values.
 *
 * `planJob` sizes the confirmation on the LARGEST cohort rather than the total,
 * which is the whole reason waves exist: twelve servers three at a time is a
 * blast radius of three. Getting this wrong in the panel would ask for a weaker
 * confirmation than the run deserves, so the cohort is assigned here next to
 * the check that reads it.
 */
export function assignWaves<T>(targets: T[], waveSize: number): (T & { cohort: string })[] {
  const n = waveSize > 0 ? Math.floor(waveSize) : targets.length
  return targets.map((t, i) => ({ ...t, cohort: `Wave ${Math.floor(i / Math.max(n, 1)) + 1}` }))
}
