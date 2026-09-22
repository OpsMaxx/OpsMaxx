import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import {
  JOB_TEMPLATE_MAX,
  sanitiseJobTemplate,
  type JobTemplate,
  type JobTemplateList,
  type JobTemplateResult
} from '../../shared/jobCompose'
import { atomicWriteFileSync } from './atomicWrite'

// Saved job templates -- the main-process half of the follow-on to item 33.
//
// Its own file, for the reason runbooks.ts gives for its notes: this is small
// operator-authored content, so it does not belong in the history store (which
// has retention) or in the renderer's workspace blob (which is configuration).
// Temp-then-rename at 0600 through atomicWrite.ts, the shape every such file
// uses. Listed in ALL_DATA_FILES so "delete everything" takes it, and in
// NOT_SYNCED beside runbooks and rules, which are the same kind of thing.
//
// NOT in a backup bundle, deliberately, and for the reason the runbook notes
// and automation rules beside it are not either. buildBundle in backup.ts
// carries the workspace blob, secrets, vault, locks and known hosts -- what it
// takes to reach the estate -- and none of the operator-authored command files.
// Those three are one class (NOT_SYNCED marks them UNDECIDED together), and
// carrying one of them would be deciding for the class in a side door: a restore
// path for commands needs its own answer to "may a bundle someone hands you
// plant text you later paste into a shell", which is not this file's to give.
// So templates stay on this machine and do not survive a move to another one,
// and docs/features.md says so.
//
// Named job*.ts on purpose: tests/jobsNotExposed.test.ts scans this directory
// for that prefix, so the bridge cannot import this file without a test going
// red. An agent that could write a template would be choosing the text a
// person later pastes into a live shell believing they wrote it.

const TEMPLATES_FILE = 'opsmaxx-job-templates.json'
/** Where a file with a problem is moved. ONE fixed name, listed in
 *  ALL_DATA_FILES, so "delete everything" finds it; a timestamped name would be
 *  a copy of the user's commands that no wipe list knows about. */
const ASIDE_FILE = 'opsmaxx-job-templates-aside.json'

/** Versioned from the first write, as runbooks.ts's notes are. */
interface TemplatesFile {
  v: number
  templates: JobTemplate[]
}

const TEMPLATES_VERSION = 1

export interface JobTemplateDeps {
  /** Where the file lives. Defaults to userData. */
  dir?: string
  now?: () => number
}

function userPath(deps: JobTemplateDeps, name: string): string {
  return join(deps.dir ?? app.getPath('userData'), name)
}

/**
 * Everything the file holds that this version can use, and whether it is safe
 * to write back.
 *
 * Reading is forgiving and writing is not. A row this version refuses -- a
 * 121-character name, 51 steps, a field from a newer build -- is left out of
 * the list, which is harmless; writing the list back would DELETE it, which is
 * not. So any such row, an unknown `v`, or a file that will not parse sets
 * `problem`, and every write refuses while it is set.
 */
export function listJobTemplates(deps: JobTemplateDeps = {}): JobTemplateList {
  const path = userPath(deps, TEMPLATES_FILE)
  const empty = (problem: string | null): JobTemplateList => ({ templates: [], problem, path })
  if (!existsSync(path)) return empty(null)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error('[jobTemplates] file unreadable:', err)
    return empty('The saved templates file could not be read.')
  }
  const file = parsed as Partial<TemplatesFile> | null
  if (file?.v !== TEMPLATES_VERSION) {
    return empty('The saved templates file was written by a different version of OpsMaxx.')
  }
  if (!Array.isArray(file.templates)) return empty('The saved templates file holds no list.')
  // Every row narrowed again: the file survives hand edits and downgrades, and a
  // row that arrived with `targets` on it leaves without them.
  const templates = file.templates
    .map(sanitiseJobTemplate)
    .filter((t): t is JobTemplate => t !== null)
  const dropped = file.templates.length - templates.length
  return {
    templates,
    problem:
      dropped === 0
        ? null
        : `${dropped} saved template(s) are not in a shape this version accepts, so the file is not rewritten.`,
    path
  }
}

function write(deps: JobTemplateDeps, templates: JobTemplate[]): boolean {
  const body: TemplatesFile = { v: TEMPLATES_VERSION, templates }
  try {
    atomicWriteFileSync(userPath(deps, TEMPLATES_FILE), JSON.stringify(body))
    return true
  } catch (err) {
    console.error('[jobTemplates] save failed:', err)
    return false
  }
}

const NOT_WRITTEN = 'The saved templates file could not be written.'

/**
 * Create, or replace the one with the same id -- which is also how a rename
 * happens. Returns the template as stored, so the panel never shows one back
 * from memory, or the reason it was not.
 */
export function saveJobTemplate(
  deps: JobTemplateDeps,
  raw: unknown
): JobTemplateResult<{ template: JobTemplate }> {
  const clean = sanitiseJobTemplate(raw)
  if (!clean) {
    return { ok: false, reason: 'A template needs a name and at least one command.' }
  }
  const { templates, problem } = listJobTemplates(deps)
  if (problem) return { ok: false, reason: problem }
  const others = templates.filter((t) => t.id !== clean.id)
  if (others.length >= JOB_TEMPLATE_MAX) {
    return { ok: false, reason: `There are already ${JOB_TEMPLATE_MAX} saved templates.` }
  }
  const template: JobTemplate = { ...clean, updatedAt: (deps.now ?? Date.now)() }
  return write(deps, [...others, template]) ? { ok: true, template } : { ok: false, reason: NOT_WRITTEN }
}

export function removeJobTemplate(deps: JobTemplateDeps, id: unknown): JobTemplateResult {
  const { templates, problem } = listJobTemplates(deps)
  if (problem) return { ok: false, reason: problem }
  const kept = templates.filter((t) => t.id !== id)
  if (kept.length === templates.length) return { ok: false, reason: 'That template is not saved.' }
  return write(deps, kept) ? { ok: true } : { ok: false, reason: NOT_WRITTEN }
}

/**
 * Move a file with a problem to ASIDE_FILE and start a fresh one holding the
 * rows that could be read. A rename, never a delete: the rows in it are the user's and may be
 * recoverable by hand. Refuses when an earlier set-aside copy is still there,
 * because renaming over it would delete that one instead.
 */
export function setAsideJobTemplates(deps: JobTemplateDeps): JobTemplateResult<{ path: string }> {
  const { templates, problem, path } = listJobTemplates(deps)
  if (!problem) return { ok: false, reason: 'The saved templates file has nothing wrong with it.' }
  const aside = userPath(deps, ASIDE_FILE)
  if (existsSync(aside)) {
    return { ok: false, reason: `An earlier set-aside copy is still at ${aside}. Move it first.` }
  }
  try {
    renameSync(path, aside)
  } catch (err) {
    return { ok: false, reason: `It could not be moved: ${err instanceof Error ? err.message : String(err)}` }
  }
  // The whole original is in the aside copy, so the fresh file can start with
  // the rows this version COULD read rather than empty: one bad row must not
  // cost every good template. Empty when nothing parsed or the version is
  // another one's, because then nothing was read.
  if (templates.length > 0 && !write(deps, templates)) {
    return { ok: false, reason: `Moved to ${aside}, but the readable templates could not be written back.` }
  }
  return { ok: true, path: aside }
}
