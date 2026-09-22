/**
 * A server's tags as the editor stores them.
 *
 * Search matches them case-sensitively against a lowercased query
 * (ConnectionTree's `match`), so a tag typed as "Prod" could never be found by
 * typing "prod" — or by typing anything, because the query is lowercased
 * first. Lowercasing here is what makes a tag searchable at all. Trimmed and
 * deduplicated for the same reason: " prod" and "prod" would otherwise be two
 * chips that look identical. The caps keep a row in a 28px tree from turning
 * into a paragraph.
 */
export const MAX_TAGS = 8
export const MAX_TAG_LENGTH = 24

export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const t of raw) {
    const tag = t.trim().toLowerCase().slice(0, MAX_TAG_LENGTH).trim()
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length === MAX_TAGS) break
  }
  return out
}

/** The editor's comma-separated text, as tags. */
export function parseTags(text: string): string[] {
  return normalizeTags(text.split(','))
}
