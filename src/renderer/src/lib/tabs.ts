/**
 * The rules a tab strip obeys, as pure functions.
 *
 * Everything here is a plain data transformation: no React, no store, no IPC,
 * no DOM. That is deliberate and it is the whole reason this file exists. A
 * tab strip's bugs are almost never in its rendering — they are in the
 * questions it answers badly at the edges. Which tab takes over when the
 * active one closes? What happens when the tab that closed was the last in its
 * workspace? What does the third session on one host get called after the
 * second was closed?
 *
 * Answered in a component, each of those is reachable only by clicking. Here
 * they are ordinary function calls, so the edges can be enumerated in a test
 * rather than discovered by a user.
 */

/** The minimum a tab has to have for the rules below to apply to it. */
export interface TabLike {
  id: string
  workspaceId: string
  title: string
}

/**
 * The tab that takes over when `doomed` closes.
 *
 * Right first, then left, and never out of the closing tab's own workspace.
 *
 * Right-first is the browser and editor convention, and it is the one that
 * matches intent: closing a run of tabs left to right keeps landing the user
 * on the next one they meant to deal with, where left-first would walk them
 * backwards through tabs they have already finished with.
 *
 * The workspace clause is not a detail. Tabs from every workspace live in one
 * array, and only the active workspace's are on screen, so an unguarded
 * neighbour search can "activate" a tab the user cannot see — leaving the
 * visible strip with nothing selected and the panel rendering another
 * workspace's session.
 *
 * Returns null when nothing survives in that workspace, which is the empty
 * state and not an error.
 */
export function successorAfterClose<T extends TabLike>(
  tabs: readonly T[],
  doomed: ReadonlySet<string>,
  activeId: string | null
): string | null {
  // Closing something that is not active does not move the selection. Checked
  // first because it is both the common case and the one where any neighbour
  // search at all would be wrong.
  if (!activeId || !doomed.has(activeId)) return activeId

  const idx = tabs.findIndex((t) => t.id === activeId)
  if (idx === -1) return null
  const ws = tabs[idx].workspaceId
  const survives = (t: T): boolean => !doomed.has(t.id) && t.workspaceId === ws

  return (
    tabs.slice(idx + 1).find(survives)?.id ??
    // Reversed rather than searched backwards from the end: the NEAREST tab on
    // the left is the one to land on, not the leftmost one that happens to
    // survive.
    tabs.slice(0, idx).reverse().find(survives)?.id ??
    null
  )
}

/**
 * A title for a new session on a target that may already have sessions.
 *
 * Reads the titles actually in use rather than counting the matches, and those
 * are different in a way that used to produce duplicates. Counting says: three
 * sessions exist, so the next is "(4)". But close "web (2)" and the count is
 * two while "web (3)" is still on screen — so the next session is named
 * "web (3)" as well, and the strip shows two tabs with one name.
 *
 * Asking which names are TAKEN cannot do that, whatever has been closed.
 */
export function nextSessionTitle(taken: readonly string[], base: string): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  // Bounded by the number of tabs plus one: with n names taken, one of the
  // first n + 1 candidates is always free.
  for (let n = 2; n <= used.size + 2; n++) {
    const candidate = `${base} (${n})`
    if (!used.has(candidate)) return candidate
  }
  /* c8 ignore next -- unreachable: the loop covers more candidates than names */
  return `${base} (${used.size + 2})`
}

/**
 * Move a tab to a new position.
 *
 * `toIndex` is where the tab should END UP in the array it is being moved
 * within, which is the index the user dropped it on. Removing the tab before
 * inserting it is what makes that true in both directions — otherwise a
 * left-to-right drag lands one place short, because removing the source
 * shifts every later index down by one.
 *
 * Out-of-range indices clamp rather than throw. A drop past the last tab is a
 * drop on the end, which is what the user meant and what every strip does.
 */
export function moveTab<T extends TabLike>(
  tabs: readonly T[],
  fromId: string,
  toIndex: number
): T[] {
  return moveBy(tabs, (t) => t.id === fromId, toIndex)
}

/**
 * The same rule, for a list that is just ids.
 *
 * Open databases are stored as an id array rather than as records, and their
 * strip has to reorder by exactly the same arithmetic — otherwise dragging a
 * database tab lands one place short of where a session tab does, which is
 * the kind of difference a user feels without being able to name.
 */
export function moveId(ids: readonly string[], id: string, toIndex: number): string[] {
  return moveBy(ids, (x) => x === id, toIndex)
}

/**
 * Remove, then insert. One implementation, because the off-by-one lives here.
 *
 * `toIndex` is where the item should END UP in the list it is moving within,
 * which is the index the user dropped on. Removing before inserting is what
 * makes that true in both directions: insert at the raw target after removing
 * a source that sat earlier, and a left-to-right drag lands one place short
 * because every later index has shifted down by one.
 *
 * Out-of-range clamps rather than throws. A drop past the last item is a drop
 * on the end, which is what the user meant and what every strip does.
 */
function moveBy<T>(items: readonly T[], match: (item: T) => boolean, toIndex: number): T[] {
  const from = items.findIndex(match)
  if (from === -1) return [...items]
  const out = [...items]
  const [moved] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(toIndex, out.length)), 0, moved)
  return out
}

/**
 * The tab a number key selects, among the tabs actually on screen.
 *
 * 1-8 are positional and 9 is the LAST tab, however many there are. That is
 * not an arbitrary choice: it is what every browser and both major editors do,
 * so it is what a user's fingers already expect, and "9 = the end" is useful
 * precisely when there are more tabs than number keys.
 *
 * Returns null when the position does not exist, so a stray Cmd+7 does nothing
 * rather than clamping to a tab the user did not aim at.
 */
export function tabForNumberKey<T extends TabLike>(visible: readonly T[], n: number): T | null {
  if (visible.length === 0) return null
  if (n === 9) return visible[visible.length - 1]
  if (n < 1 || n > 8) return null
  return visible[n - 1] ?? null
}

/**
 * One entry in the reopen stack — enough to rebuild a closed tab.
 *
 * The tab's own record plus where it was, so reopening puts it back in its
 * place rather than at the end. `index` is a hint: tabs may have closed or
 * moved since, so the caller clamps.
 */
export interface ClosedTab<T extends TabLike> {
  tab: T
  index: number
  closedAt: number
}

/** How many closures are remembered. Deep enough to undo a mistaken run of
 *  closes, shallow enough that it is never a memory question. */
export const REOPEN_LIMIT = 10

/**
 * Remember closed tabs, newest last.
 *
 * Order matters: reopening pops the most recent, so closing A then B then
 * reopening twice gives back B then A. That is the property that makes the
 * shortcut feel like an undo rather than a lucky dip.
 */
export function rememberClosed<T extends TabLike>(
  stack: readonly ClosedTab<T>[],
  entries: readonly ClosedTab<T>[]
): ClosedTab<T>[] {
  const out = [...stack, ...entries]
  return out.length > REOPEN_LIMIT ? out.slice(out.length - REOPEN_LIMIT) : out
}

/**
 * Take the most recently closed tab back off the stack.
 *
 * Returns the entry and the remaining stack, so the caller never mutates.
 * Skips entries whose tab belongs to a workspace that is no longer available:
 * reopening into a workspace the user cannot see would appear to do nothing
 * while quietly consuming the undo.
 */
export function popClosed<T extends TabLike>(
  stack: readonly ClosedTab<T>[],
  canReopen: (entry: ClosedTab<T>) => boolean = () => true
): { entry: ClosedTab<T> | null; rest: ClosedTab<T>[] } {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (canReopen(stack[i])) {
      return { entry: stack[i], rest: [...stack.slice(0, i), ...stack.slice(i + 1)] }
    }
  }
  return { entry: null, rest: [...stack] }
}
