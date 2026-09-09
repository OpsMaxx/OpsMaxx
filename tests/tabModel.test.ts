import { describe, it, expect } from 'vitest'
import {
  successorAfterClose,
  nextSessionTitle,
  moveTab,
  moveId,
  tabForNumberKey,
  rememberClosed,
  popClosed,
  REOPEN_LIMIT,
  type TabLike,
  type ClosedTab
} from '../src/renderer/src/lib/tabs'

/**
 * The rules a tab strip obeys.
 *
 * These are the questions a tab strip answers badly at the edges, and they are
 * tested here rather than clicked at, because in a component every one of them
 * is reachable only by a sequence somebody has to think to perform.
 */

const t = (id: string, workspaceId = 'w1', title = id): TabLike => ({ id, workspaceId, title })
const ids = (xs: readonly TabLike[]): string[] => xs.map((x) => x.id)

describe('which tab takes over when the active one closes', () => {
  const tabs = [t('a'), t('b'), t('c'), t('d')]

  it('takes the tab on the right', () => {
    expect(successorAfterClose(tabs, new Set(['b']), 'b')).toBe('c')
  })

  /**
   * Right-first is the browser and editor convention and it matches intent:
   * closing a run left to right keeps landing on the next tab to deal with.
   */
  it('falls back to the left only at the end of the strip', () => {
    expect(successorAfterClose(tabs, new Set(['d']), 'd')).toBe('c')
  })

  it('lands on the NEAREST surviving tab on the left, not the leftmost', () => {
    expect(successorAfterClose(tabs, new Set(['c', 'd']), 'd')).toBe('b')
  })

  it('does not move the selection when an inactive tab closes', () => {
    expect(successorAfterClose(tabs, new Set(['a']), 'c')).toBe('c')
  })

  it('returns null when the last tab in the workspace closes', () => {
    expect(successorAfterClose([t('a')], new Set(['a']), 'a')).toBeNull()
  })

  /**
   * The clause that is not a detail. Every workspace's tabs live in one array
   * and only one workspace is on screen, so an unguarded neighbour search can
   * activate a tab the user cannot see — leaving the visible strip with
   * nothing selected while the panel renders another workspace's session.
   */
  it('never crosses into another workspace', () => {
    const mixed = [t('a', 'w1'), t('x', 'w2'), t('y', 'w2'), t('b', 'w1')]
    expect(successorAfterClose(mixed, new Set(['a']), 'a')).toBe('b')
    // And when nothing in that workspace survives, null — not the neighbour
    // that happens to sit next to it in the array.
    expect(successorAfterClose(mixed, new Set(['a', 'b']), 'a')).toBeNull()
  })

  it('survives an active id that is not in the list', () => {
    expect(successorAfterClose(tabs, new Set(['zz']), 'zz')).toBeNull()
    expect(successorAfterClose(tabs, new Set(), null)).toBeNull()
  })

  it('handles every tab closing at once', () => {
    expect(successorAfterClose(tabs, new Set(['a', 'b', 'c', 'd']), 'a')).toBeNull()
  })
})

describe('naming a new session on a target that already has some', () => {
  it('uses the plain name when it is free', () => {
    expect(nextSessionTitle([], 'web')).toBe('web')
    expect(nextSessionTitle(['api'], 'web')).toBe('web')
  })

  it('numbers from two upward', () => {
    expect(nextSessionTitle(['web'], 'web')).toBe('web (2)')
    expect(nextSessionTitle(['web', 'web (2)'], 'web')).toBe('web (3)')
  })

  /**
   * THE BUG this function exists to prevent.
   *
   * Counting the matches says "three sessions, so the next is (4)". But close
   * "web (2)" and the count is two while "web (3)" is still on screen — so the
   * next session is named "web (3)" as well, and the strip shows two tabs with
   * one name. Asking which names are TAKEN cannot do that.
   */
  it('fills the gap a closed session left, without colliding', () => {
    const taken = ['web', 'web (3)'] // "web (2)" was closed
    const next = nextSessionTitle(taken, 'web')
    expect(next).toBe('web (2)')
    expect(taken).not.toContain(next)
  })

  it('never returns a name already in use, however holey the list', () => {
    const taken = ['web', 'web (2)', 'web (4)', 'web (7)']
    for (let i = 0; i < 12; i++) {
      const next = nextSessionTitle(taken, 'web')
      expect(taken).not.toContain(next)
      taken.push(next)
    }
    // And every name it produced is distinct.
    expect(new Set(taken).size).toBe(taken.length)
  })

  it('does not confuse one base name for another that starts the same way', () => {
    expect(nextSessionTitle(['web-prod'], 'web')).toBe('web')
  })
})

describe('reordering by drag', () => {
  const tabs = [t('a'), t('b'), t('c'), t('d')]

  /**
   * Dragging right is where the naive version is off by one: removing the
   * source shifts every later index down, so inserting at the raw target index
   * lands one place short.
   */
  it('drops where the user aimed when dragging right', () => {
    expect(ids(moveTab(tabs, 'a', 2))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('drops where the user aimed when dragging left', () => {
    expect(ids(moveTab(tabs, 'd', 1))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('treats a drop past the end as a drop on the end', () => {
    expect(ids(moveTab(tabs, 'a', 99))).toEqual(['b', 'c', 'd', 'a'])
    expect(ids(moveTab(tabs, 'd', -5))).toEqual(['d', 'a', 'b', 'c'])
  })

  it('is a no-op when a tab is dropped where it already is', () => {
    expect(ids(moveTab(tabs, 'b', 1))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('leaves the list alone when the tab is unknown, and never mutates it', () => {
    const before = ids(tabs)
    expect(ids(moveTab(tabs, 'zz', 0))).toEqual(before)
    expect(ids(tabs)).toEqual(before)
  })
})

describe('number-key selection', () => {
  const tabs = [t('a'), t('b'), t('c')]

  it('selects by position for 1 to 8', () => {
    expect(tabForNumberKey(tabs, 1)?.id).toBe('a')
    expect(tabForNumberKey(tabs, 3)?.id).toBe('c')
  })

  // What every browser and both major editors do, so it is what fingers expect.
  it('sends 9 to the last tab whatever the count', () => {
    expect(tabForNumberKey(tabs, 9)?.id).toBe('c')
    expect(tabForNumberKey([t('a')], 9)?.id).toBe('a')
    expect(tabForNumberKey(Array.from({ length: 20 }, (_, i) => t(`t${i}`)), 9)?.id).toBe('t19')
  })

  it('does nothing for a position that does not exist', () => {
    expect(tabForNumberKey(tabs, 7)).toBeNull()
    expect(tabForNumberKey([], 1)).toBeNull()
    expect(tabForNumberKey(tabs, 0)).toBeNull()
  })
})

describe('reopening a closed tab', () => {
  const entry = (id: string, index = 0, ws = 'w1'): ClosedTab<TabLike> => ({
    tab: t(id, ws),
    index,
    closedAt: 0
  })

  /**
   * The property that makes the shortcut feel like an undo rather than a lucky
   * dip: closing A then B and reopening twice gives back B, then A.
   */
  it('gives tabs back newest first', () => {
    let stack = rememberClosed<TabLike>([], [entry('a')])
    stack = rememberClosed(stack, [entry('b')])
    const first = popClosed(stack)
    expect(first.entry?.tab.id).toBe('b')
    const second = popClosed(first.rest)
    expect(second.entry?.tab.id).toBe('a')
    expect(popClosed(second.rest).entry).toBeNull()
  })

  it('is bounded, dropping the oldest', () => {
    let stack: ClosedTab<TabLike>[] = []
    for (let i = 0; i < REOPEN_LIMIT + 5; i++) stack = rememberClosed(stack, [entry(`t${i}`)])
    expect(stack).toHaveLength(REOPEN_LIMIT)
    expect(stack[0].tab.id).toBe('t5')
    expect(popClosed(stack).entry?.tab.id).toBe(`t${REOPEN_LIMIT + 4}`)
  })

  it('remembers a bulk close as separate entries, reopened one at a time', () => {
    const stack = rememberClosed<TabLike>([], [entry('a'), entry('b'), entry('c')])
    expect(stack).toHaveLength(3)
    expect(popClosed(stack).entry?.tab.id).toBe('c')
  })

  /**
   * Reopening into a workspace that is locked or gone would appear to do
   * nothing while quietly consuming the undo — the worst of both.
   */
  it('skips a tab whose workspace can no longer take it', () => {
    let stack = rememberClosed<TabLike>([], [entry('keep', 0, 'w1')])
    stack = rememberClosed(stack, [entry('gone', 0, 'w2')])
    const { entry: got, rest } = popClosed(stack, (e) => e.tab.workspaceId === 'w1')
    expect(got?.tab.id).toBe('keep')
    // The unreachable entry is left in place rather than discarded: the
    // workspace may come back.
    expect(rest.map((e) => e.tab.id)).toEqual(['gone'])
  })

  it('returns null on an empty stack without throwing', () => {
    expect(popClosed<TabLike>([]).entry).toBeNull()
  })
})

describe('reordering a plain list of ids', () => {
  /**
   * Open databases are stored as ids rather than records, and their strip has
   * to reorder by exactly the same arithmetic — otherwise dragging a database
   * tab lands one place short of where a session tab does, which is a
   * difference a user feels without being able to name.
   */
  const ids = ['a', 'b', 'c', 'd']

  it('behaves identically to moveTab', () => {
    for (const to of [0, 1, 2, 3, 99, -5]) {
      const viaIds = moveId(ids, 'a', to)
      const viaTabs = moveTab(ids.map((id) => t(id)), 'a', to).map((x) => x.id)
      expect(viaIds, `to=${to}`).toEqual(viaTabs)
    }
  })

  it('leaves the list alone for an unknown id, without mutating it', () => {
    expect(moveId(ids, 'zz', 0)).toEqual(ids)
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
  })
})
