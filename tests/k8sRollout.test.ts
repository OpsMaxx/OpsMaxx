import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  describeRevision,
  joinRollout,
  parseReplicaSetRevisions,
  parseRolloutHistory
} from '../src/shared/k8sRollout'

// Item 39's rollout history. The fixtures are one deployment on k3s v1.31.5
// taken through three revisions, with a change-cause set only at the second.

const DIR = fileURLToPath(new URL('./fixtures/k8s/rollout', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const joined = (): ReturnType<typeof joinRollout> =>
  joinRollout(parseRolloutHistory(read('history.txt')), parseReplicaSetRevisions(read('replicasets.txt')))

describe('reading what kubectl printed', () => {
  it('skips the name line and the header, and takes the three revisions', () => {
    const h = parseRolloutHistory(read('history.txt'))
    expect(h.map((r) => r.revision)).toEqual([1, 2, 3])
  })

  it('reads <none> as no change-cause rather than as the text "<none>"', () => {
    expect(parseRolloutHistory(read('history.txt'))[0].changeCause).toBe('')
  })

  it('takes the image from the ReplicaSet, which is the per-revision fact', () => {
    const rs = parseReplicaSetRevisions(read('replicasets.txt'))
    expect(rs.find((r) => r.revision === 3)!.images).toEqual(['busybox:1.36.1'])
  })
})

describe('the change-cause belongs to whichever rollout last set it', () => {
  // THE finding, measured. `kubernetes.io/change-cause` is an annotation on
  // the deployment, copied onto every new ReplicaSet until somebody changes
  // it. Revisions 2 and 3 both say "bump to 1.37" and revision 3 is
  // busybox:1.36.1 — a different image wearing revision 2's label.
  it('is identical on two revisions that are different images', () => {
    const r = joined()
    const two = r.find((x) => x.revision === 2)!
    const three = r.find((x) => x.revision === 3)!
    expect(two.changeCause).toBe(three.changeCause)
    expect(two.images).toEqual(['busybox:1.37'])
    expect(three.images).toEqual(['busybox:1.36.1'])
  })

  it('marks the later one as wearing a label it probably inherited', () => {
    const three = joined().find((x) => x.revision === 3)!
    expect(three.causeRepeated).toBe(true)
    // Not the earlier one: revision 2 is where the label was actually set.
    expect(joined().find((x) => x.revision === 2)!.causeRepeated).toBe(false)
  })

  it('says so on screen, because rolling back to the wrong one is the cost', () => {
    // An operator asking for "the one before the 1.37 bump" would otherwise
    // land somewhere else entirely.
    const three = describeRevision(joined().find((x) => x.revision === 3)!)
    expect(three).toContain('busybox:1.36.1')
    expect(three).toContain('left over')
  })

  it('does not caveat a revision whose label is its own', () => {
    const two = describeRevision(joined().find((x) => x.revision === 2)!)
    expect(two).toContain('busybox:1.37')
    expect(two).not.toContain('left over')
  })

  it('leads with the image, never the label', () => {
    // The image is a fact about this revision; the label may not be.
    for (const r of joined()) expect(describeRevision(r).startsWith('busybox:')).toBe(true)
  })
})

describe('revisions with no ReplicaSet left', () => {
  it('says the image was not read rather than showing nothing', () => {
    // Old ReplicaSets are garbage-collected past revisionHistoryLimit, so a
    // revision in the history with no ReplicaSet is normal.
    const r = joinRollout([{ revision: 9, changeCause: '' }], [])
    expect(describeRevision(r[0])).toBe('image not read')
  })

  it('puts the newest revision first', () => {
    expect(joined().map((r) => r.revision)).toEqual([3, 2, 1])
  })
})
