import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { JOB_TEMPLATE_MAX, sanitiseJobTemplate, type JobTemplate } from '../../shared/jobCompose'
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
// Named job*.ts on purpose: tests/jobsNotExposed.test.ts scans this directory
// for that prefix, so the bridge cannot import this file without a test going
// red. An agent that could write a template would be choosing the text a
// person later pastes into a live shell believing they wrote it.

const TEMPLATES_FILE = 'opsmaxx-job-templates.json'

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

function templatesPath(deps: JobTemplateDeps): string {
  return join(deps.dir ?? app.getPath('userData'), TEMPLATES_FILE)
}

/** Every stored template, or `null` when the file exists and cannot be read.
 *  An unreadable file is not an empty one, and the panel says which. */
export function listJobTemplates(deps: JobTemplateDeps = {}): JobTemplate[] | null {
  const path = templatesPath(deps)
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error('[jobTemplates] file unreadable:', err)
    return null
  }
  const rows = (parsed as Partial<TemplatesFile> | null)?.templates
  if (!Array.isArray(rows)) return null
  // Every row narrowed again: the file survives hand edits and restores, and a
  // row that arrived with `targets` on it leaves without them.
  return rows.map(sanitiseJobTemplate).filter((t): t is JobTemplate => t !== null)
}

function write(deps: JobTemplateDeps, templates: JobTemplate[]): boolean {
  const body: TemplatesFile = { v: TEMPLATES_VERSION, templates }
  try {
    atomicWriteFileSync(templatesPath(deps), JSON.stringify(body))
    return true
  } catch (err) {
    console.error('[jobTemplates] save failed:', err)
    return false
  }
}

/**
 * Create, or replace the one with the same id -- which is also how a rename
 * happens. Returns the template as stored, or `null` when it was refused or did
 * not land, so the panel never shows back a template from memory.
 */
export function saveJobTemplate(deps: JobTemplateDeps, raw: unknown): JobTemplate | null {
  const clean = sanitiseJobTemplate(raw)
  if (!clean) return null
  // Refuse rather than overwrite a file that exists and would not parse: the
  // templates in it are still on disk, and one save would replace all of them.
  const existing = listJobTemplates(deps)
  if (existing === null) return null
  const others = existing.filter((t) => t.id !== clean.id)
  if (others.length >= JOB_TEMPLATE_MAX) return null
  const stored: JobTemplate = { ...clean, updatedAt: (deps.now ?? Date.now)() }
  return write(deps, [...others, stored]) ? stored : null
}

export function removeJobTemplate(deps: JobTemplateDeps, id: unknown): boolean {
  const existing = listJobTemplates(deps)
  if (existing === null || typeof id !== 'string') return false
  const kept = existing.filter((t) => t.id !== id)
  return kept.length !== existing.length && write(deps, kept)
}
