import { createHash } from 'node:crypto'

/**
 * What makes two clipboard entries "the same thing".
 *
 * Ported from SyncClipboard's hash specification, WITH ITS TWO DEFECTS FIXED.
 * Both are the kind that only show up across platforms, which is exactly where
 * a clipboard lives:
 *
 *  1. FILENAMES ARE NFC-NORMALISED BEFORE HASHING. macOS hands back
 *     decomposed Unicode (NFD) and Linux and Windows hand back composed (NFC),
 *     so the same file copied on a Mac and received on Linux hashes
 *     differently -- and an echo-suppression scheme built on that hash then
 *     fails to suppress, which is a loop.
 *  2. SIZE IS IN BYTES, and truncation happens on a code-point boundary.
 *     Hashing a prefix cut at an arbitrary byte can split a multi-byte
 *     character, and the two halves of one character are not the same content
 *     as either.
 */

/** How much of a large payload is hashed.
 *
 *  A clipboard entry can be a screenshot. Hashing all of it on every read is
 *  work done on the UI thread for a comparison that a prefix plus the length
 *  already decides -- two different images that share their first 64 KiB AND
 *  their exact byte length are not a case worth paying for. */
export const HASH_PREFIX_BYTES = 64 * 1024

export interface ClipboardIdentity {
  /** `text` or `files`. Not a MIME type: the question is which code path
   *  handles it, and the platforms disagree about MIME types for the same
   *  content. */
  kind: 'text' | 'files'
  /** Hex SHA-256 over the canonical form below. */
  hash: string
  /** Total size in BYTES, not characters. */
  size: number
}

/**
 * Truncates to at most `limit` bytes without splitting a character.
 *
 * Exported because it is the half that is easy to get wrong and worth testing
 * on its own.
 */
export function truncateOnCodePoint(text: string, limit: number): Buffer {
  const full = Buffer.from(text, 'utf8')
  if (full.length <= limit) return full

  // Walk back from the limit until the byte is not a UTF-8 continuation byte
  // (10xxxxxx). At most three steps, because no encoded character is longer
  // than four bytes.
  let end = limit
  while (end > 0 && (full[end] & 0b1100_0000) === 0b1000_0000) end--
  return full.subarray(0, end)
}

/** The identity of a text entry. */
export function identifyText(text: string): ClipboardIdentity {
  const full = Buffer.from(text, 'utf8')
  const prefix = truncateOnCodePoint(text, HASH_PREFIX_BYTES)
  const hash = createHash('sha256')
    // The length goes in FIRST and separately. Without it, a prefix hash makes
    // every document sharing an opening paragraph the same clipboard entry.
    .update(`text:${full.length}:`)
    .update(prefix)
    .digest('hex')
  return { kind: 'text', hash, size: full.length }
}

/**
 * The identity of a file list.
 *
 * Names only, normalised and sorted. NOT contents: a clipboard file entry is a
 * reference, the file may be gigabytes, and hashing it on every clipboard read
 * would make copying a video freeze the app. Two different files with the same
 * name and size in the same order are a collision this accepts -- the cost of
 * being wrong is one redundant transfer, and the cost of being right is
 * reading every byte of everything anybody copies.
 */
export function identifyFiles(paths: readonly string[]): ClipboardIdentity {
  const canonical = paths
    // NFC, because macOS gives NFD and everything else gives NFC. Without
    // this the same file hashes differently on either side of a transfer.
    .map((p) => p.normalize('NFC'))
    // Sorted, because the platforms do not agree on the order of a
    // multi-selection and the user did not choose one.
    .sort()

  const hash = createHash('sha256')
  hash.update(`files:${canonical.length}:`)
  for (const name of canonical) {
    const bytes = Buffer.from(name, 'utf8')
    // Length-prefixed, so ["ab", "c"] and ["a", "bc"] cannot hash alike.
    hash.update(`${bytes.length}:`)
    hash.update(bytes)
  }
  return { kind: 'files', hash: hash.digest('hex'), size: canonical.length }
}

/**
 * Echo suppression.
 *
 * NOT a comparison against the last hash seen, which is the obvious design and
 * the one that breaks: a user who copies the same text twice on purpose gets
 * the second copy swallowed, and a user whose two devices each apply the
 * other's paste gets a loop that a hash comparison cannot tell from legitimate
 * repetition.
 *
 * Instead: ARM a flag immediately before writing to the clipboard, and
 * disarm it on the next read that matches. A read that matches while armed is
 * our own write coming back; a read that matches while disarmed is the user
 * copying the same thing again, which is a real event and should be sent.
 */
export class EchoSuppressor {
  private armed: { hash: string; at: number } | null = null

  constructor(
    /** How long an armed write stays armed. The platform's clipboard change
     *  notification is not instant and is not ordered, so this cannot be zero;
     *  it also must not be long, or a genuine re-copy inside the window is
     *  swallowed. */
    private readonly windowMs = 2000,
    private readonly now: () => number = Date.now
  ) {}

  /** Call immediately BEFORE writing to the clipboard. */
  arm(hash: string): void {
    this.armed = { hash, at: this.now() }
  }

  /** Whether this read should be ignored. Consumes the arming. */
  shouldIgnore(hash: string): boolean {
    const held = this.armed
    if (!held) return false
    if (this.now() - held.at > this.windowMs) {
      this.armed = null
      return false
    }
    if (held.hash !== hash) return false
    this.armed = null
    return true
  }
}
