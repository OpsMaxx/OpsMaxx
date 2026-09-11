/**
 * Subsequence matching for the command palette.
 *
 * The palette filtered with `String.includes`, which means you have to type the
 * beginning of a word you would already have to know -- "shortcuts" finds
 * Keyboard Shortcuts and "kbs" finds nothing, and neither does "keysh". That is
 * the opposite of what a palette is for: it exists so you can reach something
 * you only half remember the name of.
 *
 * Deliberately small. No index, no ranking model, no dependency -- the haystack
 * is a few hundred short strings rebuilt on each keystroke, and anything
 * cleverer would be more code to maintain than the problem is worth.
 */

/**
 * How well `query` matches `text`, or 0 for no match.
 *
 * Every character of the query must appear in `text`, in order. What separates
 * a good match from a technical one is WHERE those characters landed: a run of
 * adjacent letters and a hit at the start of a word both beat a set of letters
 * scattered through the middle, which is what makes "kbs" rank Keyboard
 * Shortcuts above a row that merely contains a k, a b and an s.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = text.toLowerCase()

  // An exact substring is always the best answer, and scored above any
  // subsequence so that typing a name in full puts that name first.
  const direct = t.indexOf(q)
  if (direct >= 0) {
    // Earlier is better, at a word boundary better still, and shorter wins the
    // tie -- without that last term "SSH" and "SSH agent forwarding" score
    // identically for the query "ssh" and the order between them is whatever
    // the array happened to be in.
    const boundary = direct === 0 || /[\s\-_./]/.test(t[direct - 1])
    return 10_000 - direct * 5 + (boundary ? 200 : 0) - t.length
  }

  let score = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    let found = -1
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i
        break
      }
    }
    if (found < 0) return 0
    const boundary = found === 0 || /[\s\-_./]/.test(t[found - 1])
    run = found === ti ? run + 1 : 0
    score += 1 + run * 3 + (boundary ? 8 : 0)
    ti = found + 1
  }
  // Shorter haystacks win ties: "SSH" should beat "SSH agent forwarding" for
  // the query "ssh".
  return Math.max(1, score * 10 - t.length)
}
