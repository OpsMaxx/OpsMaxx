// Masking a bearer token for display, which is a different job from redaction.
//
// `main/services/secretRedaction.ts` scrubs secrets out of text that is about
// to be LOGGED, and it replaces them wholesale because a log has no reader who
// needs to recognise the value. This module is for text that is about to be
// SHOWN to the person who owns the token, and there the first and last few
// characters are the whole point: they are how somebody tells the session they
// just created apart from the one they created last week. So the two are not
// duplicates of each other and should not be merged — one destroys the value
// and the other preserves exactly enough of it to be identified by.
//
// The page this exists for showed a full 64-character bearer token in plain
// selectable text, under the sentence "the token is in that command and is
// shown only once here", beside a button labelled "Copy again". The sentence
// was defensible — OpsMaxx stores only the hash, so this really is the only
// time it can be displayed — but "shown only once" reads as "already hidden",
// and it was sitting in the clear on a page users screenshot for their team.
// A claim the UI visibly contradicts teaches people that the security copy is
// not literally true, which is expensive for every other warning in the app.

/** Characters kept at each end. Enough to identify, far too few to use. */
export const TOKEN_VISIBLE_CHARS = 4

/**
 * How short a value has to be before masking it tells the reader nothing.
 *
 * Below this, `abcd…wxyz` would be longer than the original or would leak most
 * of it, so the whole value is replaced instead. This is a display decision,
 * not a security threshold — a short secret is not safer, it is just not
 * usefully abbreviated.
 */
const MIN_MASKABLE = TOKEN_VISIBLE_CHARS * 2 + 4

/** What a value too short to abbreviate is replaced with. */
export const TOKEN_FULLY_MASKED = '••••••••'

/** `1041…e5c0` — the identifying head and tail, and nothing in between. */
export function maskToken(token: string): string {
  const t = token.trim()
  if (!t) return ''
  if (t.length < MIN_MASKABLE) return TOKEN_FULLY_MASKED
  return `${t.slice(0, TOKEN_VISIBLE_CHARS)}…${t.slice(-TOKEN_VISIBLE_CHARS)}`
}

/**
 * Mask every bearer token inside a longer string — a CLI command, a JSON
 * snippet — leaving the rest of it readable.
 *
 * The point of showing the command at all is that the user can check what it
 * does before pasting it, so masking the entire line would defeat it. Only the
 * credential is hidden.
 *
 * Both spellings are matched because both are generated: the shell form
 * `--header "Authorization: Bearer <t>"` and the JSON form
 * `"Authorization": "Bearer <t>"`.
 */
export function maskBearerTokens(text: string): string {
  // The token runs to the first character that cannot be part of one. Anchoring
  // on the closing quote instead would drop the token on a form that has no
  // quote, and anchoring on whitespace alone would swallow a trailing `"`.
  return text.replace(/(Bearer\s+)([A-Za-z0-9._~+/-]{8,}=*)/g, (_m, prefix: string, tok: string) => {
    return `${prefix}${maskToken(tok)}`
  })
}

/** True when there is something in here worth hiding. */
export function containsBearerToken(text: string): boolean {
  return /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/.test(text)
}
