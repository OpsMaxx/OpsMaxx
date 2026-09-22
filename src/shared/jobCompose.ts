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
  /** How to undo it. Written down at the same time as the job, because that is
   *  the only moment anybody knows -- item 44. Never run automatically. */
  rollback: string
}

export const EMPTY_JOB_DRAFT: JobDraft = {
  title: '',
  steps: '',
  waveSize: 0,
  gate: false,
  rebootLast: false,
  rollback: ''
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

  const rollback = parseJobSteps(draft.rollback)
  if (rollback.length > JOB_MAX_STEPS) {
    return { ok: false, reason: `The rollback has more than ${JOB_MAX_STEPS} steps, which is more than the dialog can show you.` }
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
  const rollback = parseJobSteps(draft.rollback).map((command) => ({ command }))
  return {
    kind: 'command',
    title: draft.title.trim(),
    steps,
    ...(draft.gate ? { gate: 'health' as const } : {}),
    // Absent rather than empty: `rollback: []` on the spec would read as "an
    // undo was written and it does nothing", and the panel would offer a
    // button for it.
    ...(rollback.length > 0 ? { rollback } : {})
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

// ---------------------------------------------------------------------------
// Saved templates -- the follow-on item 33 left open
// ---------------------------------------------------------------------------
//
// A template is the STEPS of a job and nothing that decides where or whether
// they run. broadcast.ts's rule 1 is the reason: "no saved target set that
// could drift as the workspace changes". A template that remembered its servers
// would be exactly that set, and one that remembered its approval would be a
// confirmation answered once and replayed against whatever the workspace had
// become. So a template holds the text, the reboot flag and the rollback, and
// loading one fills the composer and stops: servers are picked fresh, and
// `planJob` mints the confirmation over the job as it now stands.
//
// Wave size and the health gate are deliberately not saved either. Both only
// mean something against a target count, and the gate check refuses a wave
// size that is not smaller than it.
//
// Human-only, like the rest of this file. Nothing in the MCP bridge can list,
// read or write one (tests/jobTemplates.test.ts). An agent that could save a
// template would be choosing the text an operator later runs in a terminal
// believing they wrote it.

export interface JobTemplate {
  id: string
  name: string
  /** The composer's steps text as typed, `#` notes included. Parsed with
   *  `parseJobSteps` whenever it is used, exactly as a typed draft is. */
  steps: string
  rollback: string
  rebootLast: boolean
  updatedAt: number
  /** Refused by type as well as by `sanitiseJobTemplate`. `never` rather than
   *  absent so that a spread of a job, a draft-plus-targets or a request
   *  object into a template fails to compile instead of carrying them along. */
  targets?: never
  approval?: never
}

/** More than this and it is a snippet library, which this is not. */
export const JOB_TEMPLATE_MAX = 200
/** A generous 50 steps' worth. Not a technical limit. */
const JOB_TEMPLATE_TEXT_MAX = 20_000

// C0 except newline and tab, DEL, C1 and the bidi overrides. A template's text
// is pasted into a live shell, so an escape sequence in it is not cosmetic:
// ESC [ 2 0 1 ~ ends bracketed paste and turns the rest of the text into
// keystrokes. The panel never produces one; a hand-edited or restored file can.
// eslint-disable-next-line no-control-regex -- matching them is the point
const UNSAFE_TEMPLATE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

function cleanTemplateText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw.replace(/\r\n?/g, '\n').replace(UNSAFE_TEMPLATE, '')
  return clean.length > JOB_TEMPLATE_TEXT_MAX ? null : clean
}

/**
 * A template as it may be stored, or `null`.
 *
 * Builds a NEW object from the fields a template has, so anything else on the
 * input -- `targets`, `approval`, `cohort`, a whole JobRunRequest -- is dropped
 * rather than trusted because it rode along. Called by main on every save and
 * on every read of the file, which survives hand edits and restored backups.
 */
export function sanitiseJobTemplate(raw: unknown): JobTemplate | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(r.id)) return null
  const name = cleanTemplateText(r.name)?.replace(/\s+/g, ' ').trim() ?? ''
  if (name === '' || name.length > 120) return null
  const steps = cleanTemplateText(r.steps)
  const rollback = cleanTemplateText(r.rollback ?? '')
  if (steps === null || rollback === null) return null
  const count = parseJobSteps(steps).length
  if (count === 0 || count > JOB_MAX_STEPS || parseJobSteps(rollback).length > JOB_MAX_STEPS) {
    return null
  }
  return {
    id: r.id,
    name,
    steps,
    rollback,
    rebootLast: r.rebootLast === true,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0
  }
}

/** The composer's draft as a template. The draft has no targets to leave out,
 *  and wave size and gate are left out on purpose -- see above. */
export function templateFromDraft(draft: JobDraft, id: string, name: string): JobTemplate | null {
  return sanitiseJobTemplate({
    id,
    name,
    steps: draft.steps,
    rollback: draft.rollback,
    rebootLast: draft.rebootLast
  })
}

/** A template loaded into the composer. Wave size and gate keep whatever the
 *  operator already set, because they belong to the servers being picked now. */
export function draftFromTemplate(t: JobTemplate, current: JobDraft): JobDraft {
  return {
    ...current,
    title: t.name,
    steps: t.steps,
    rollback: t.rollback,
    rebootLast: t.rebootLast
  }
}

/**
 * What "run in this terminal" pastes: the steps, one per line, `#` notes
 * dropped exactly as a job drops them. No trailing newline, so it behaves as
 * any other multi-line paste does, and the reboot flag and rollback do not
 * travel -- a terminal has no reboot-and-wait and no undo button.
 */
export function templateTerminalText(t: JobTemplate): string {
  return parseJobSteps(t.steps).join('\n')
}

/**
 * The preload's `jobTemplates` namespace. Three calls: rename is a `save` with
 * the same id. `list` answers `null` when the file exists and cannot be read,
 * which is not the same as "you have saved none", and `save` refuses rather
 * than overwrite a file it could not read.
 */
export interface JobTemplatesBridge {
  list(): Promise<JobTemplate[] | null>
  save(template: JobTemplate): Promise<JobTemplate | null>
  remove(id: string): Promise<boolean>
}
