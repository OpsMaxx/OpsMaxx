// Editing an imported `.ovpn` without re-importing it — the roadmap's
// "edit-as-text -> re-run the sanitiser -> re-commit".
//
// THE OBVIOUS VERSION OF THIS SHIPS A PRIVATE KEY TO THE RENDERER. A stored
// `configBody` is a vault secret precisely because it carries the inline
// blocks: `<key>` is the client's private key, `<tls-crypt>` is a shared one.
// "Let them edit the text" means handing that to a window, and from there to
// the clipboard, a screenshot, a crash dump.
//
// So the text that leaves this process has every inline block REPLACED BY A
// PLACEHOLDER, and the blocks are put back here before anything is parsed or
// stored. The operator edits the directives -- `remote`, `cipher`, `verb`, the
// things anybody actually edits -- and never sees the key.
//
// FOUR THINGS THAT COULD GO WRONG WITH A PLACEHOLDER, and each is handled
// rather than assumed away:
//
//  1. A placeholder DELETED means "remove that block". Honoured, and reported,
//     because removing `<cert>` from a profile silently is the difference
//     between a profile that connects and one that does not.
//  2. A placeholder INVENTED -- somebody types the marker for a block the
//     profile never had -- must not conjure one. There is nothing to restore,
//     so it is refused rather than left in the file as literal text openvpn
//     would choke on.
//  3. A placeholder DUPLICATED would write the same key twice. Refused.
//  4. The edited text arriving with a real `<key>` block PASTED IN is the case
//     where somebody genuinely wants to replace the key. That is an IMPORT, not
//     an edit, and it is refused here with that sentence -- this path exists to
//     keep key material out of the renderer, and accepting it back would make
//     the whole redaction theatre.

import { VpnError } from './errors'

/** Every tag the parser treats as inline. Kept in step with `parsers/ovpn.ts`;
 *  a tag it knows and this does not would be shipped to the renderer whole. */
const INLINE_TAGS = [
  'ca',
  'cert',
  'key',
  'tls-auth',
  'tls-crypt',
  'tls-crypt-v2',
  'dh',
  'pkcs12',
  'crl-verify'
] as const

export type InlineTag = (typeof INLINE_TAGS)[number]

/** What replaces a block in the text the operator edits. Unmistakably not
 *  config: openvpn would reject it, so a placeholder left in a file by a bug
 *  fails loudly rather than being read as a directive. */
export function placeholderFor(tag: string): string {
  return `### SHELLPILOT-KEEP <${tag}> ###`
}

const PLACEHOLDER_RE = /^###\s*SHELLPILOT-KEEP\s*<([A-Za-z0-9_-]+)>\s*###$/

export interface RedactedConfig {
  /** Safe to send to a renderer: no key material. */
  text: string
  /** The blocks, in the order they appeared, held in this process only. */
  blocks: { tag: InlineTag; body: string }[]
}

/**
 * Swap every inline block for its placeholder.
 *
 * The whole block including its tags goes, so what comes back is one line where
 * a hundred were. A block whose closing tag never arrives is treated as running
 * to the end of the file: it is a broken profile either way, and the version
 * that leaks is the one that stops redacting at the missing tag.
 */
export function redactInlineBlocks(body: string): RedactedConfig {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  const blocks: { tag: InlineTag; body: string }[] = []
  let open: InlineTag | null = null
  let buf: string[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (open !== null) {
      if (line === `</${open}>`) {
        blocks.push({ tag: open, body: buf.join('\n') })
        out.push(placeholderFor(open))
        open = null
        buf = []
        continue
      }
      buf.push(raw)
      continue
    }
    const m = /^<([A-Za-z0-9_-]+)>$/.exec(line)
    const tag = m === null ? null : (m[1].toLowerCase() as InlineTag)
    if (tag !== null && (INLINE_TAGS as readonly string[]).includes(tag)) {
      open = tag
      continue
    }
    out.push(raw)
  }
  // Unterminated: everything after the opening tag was key material and none of
  // it may be returned.
  if (open !== null) {
    blocks.push({ tag: open, body: buf.join('\n') })
    out.push(placeholderFor(open))
  }
  return { text: out.join('\n'), blocks }
}

export type OvpnEditRefusal =
  | 'pasted-key'
  | 'unknown-placeholder'
  | 'duplicate-placeholder'

export const OVPN_EDIT_REFUSAL_HELP: Record<OvpnEditRefusal, string> = {
  'pasted-key':
    'This edit contains an inline block. Replacing a certificate or a key is an import, not an edit — this screen never shows key material, and taking it back here would make that pointless. Import the new .ovpn instead.',
  'unknown-placeholder':
    'This edit names a block the profile does not have. There is nothing to put back, and leaving the marker in the file would give openvpn a line it cannot read.',
  'duplicate-placeholder':
    'This edit names the same block twice, which would write the same certificate or key into the profile twice.'
}

export type OvpnEditResult =
  | {
      ok: true
      /** The body to sanitise and store. Key material restored. */
      body: string
      /** Blocks the operator removed by deleting their placeholder. */
      removed: InlineTag[]
    }
  | { ok: false; reason: OvpnEditRefusal; detail: string }

/**
 * Put the blocks back.
 *
 * The result is what `parseOvpn` is then run over -- this does not sanitise
 * anything itself, and deliberately so: there is exactly one sanitiser and a
 * second opinion here would be a second set of rules to keep in step.
 */
export function restoreInlineBlocks(edited: string, blocks: RedactedConfig['blocks']): OvpnEditResult {
  const byTag = new Map(blocks.map((b) => [b.tag, b.body]))
  const seen = new Set<string>()
  const out: string[] = []

  for (const raw of edited.split(/\r?\n/)) {
    const line = raw.trim()
    const m = PLACEHOLDER_RE.exec(line)
    if (m === null) {
      // A real inline tag in the edited text is somebody pasting a key back in.
      const opened = /^<([A-Za-z0-9_-]+)>$/.exec(line)
      const tag = opened === null ? null : opened[1].toLowerCase()
      if (tag !== null && (INLINE_TAGS as readonly string[]).includes(tag)) {
        return {
          ok: false,
          reason: 'pasted-key',
          detail: OVPN_EDIT_REFUSAL_HELP['pasted-key']
        }
      }
      out.push(raw)
      continue
    }
    const tag = m[1].toLowerCase()
    const body = byTag.get(tag as InlineTag)
    if (body === undefined) {
      return {
        ok: false,
        reason: 'unknown-placeholder',
        detail: OVPN_EDIT_REFUSAL_HELP['unknown-placeholder']
      }
    }
    if (seen.has(tag)) {
      return {
        ok: false,
        reason: 'duplicate-placeholder',
        detail: OVPN_EDIT_REFUSAL_HELP['duplicate-placeholder']
      }
    }
    seen.add(tag)
    out.push(`<${tag}>`, body, `</${tag}>`)
  }

  return {
    ok: true,
    body: out.join('\n'),
    // Reported, never silent. Removing `<cert>` is the difference between a
    // profile that connects and one that does not.
    removed: blocks.map((b) => b.tag).filter((t) => !seen.has(t))
  }
}

export interface OvpnEditChange {
  /** Directive lines the edit added, in order. */
  added: string[]
  /** Directive lines it removed. */
  removed: string[]
  /** Inline blocks it dropped. */
  blocksRemoved: InlineTag[]
}

/**
 * What changed, for the confirmation.
 *
 * Line-level and deliberately dumb: a real diff would be nicer to read and this
 * is the thing shown before a profile that carries a private key is rewritten,
 * so "these lines are gone, these are new" is the claim that is easy to check
 * against the text beside it.
 */
export function ovpnEditChange(
  before: string,
  after: string,
  blocksRemoved: InlineTag[] = []
): OvpnEditChange {
  const clean = (s: string): string[] =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith(';'))
  const a = clean(before)
  const b = clean(after)
  const countIn = (list: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const l of list) m.set(l, (m.get(l) ?? 0) + 1)
    return m
  }
  const ca = countIn(a)
  const cb = countIn(b)
  const added: string[] = []
  const removed: string[] = []
  for (const l of b) if ((cb.get(l) ?? 0) > (ca.get(l) ?? 0)) added.push(l)
  for (const l of a) if ((ca.get(l) ?? 0) > (cb.get(l) ?? 0)) removed.push(l)
  return {
    added: [...new Set(added)],
    removed: [...new Set(removed)],
    blocksRemoved
  }
}

/** Thrown rather than returned when a caller hands this a body it has no
 *  business editing. Matches the parser's own habit. */
export function assertEditable(body: string): void {
  if (body.trim() === '') {
    throw new VpnError('config-rejected', 'There is no configuration stored for this profile to edit.')
  }
}
