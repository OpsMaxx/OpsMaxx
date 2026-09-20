import { describe, it, expect } from 'vitest'
import { mergeCollections, baseOf, asRecords } from '../src/main/services/addy/merge'

// Sync's unit was the whole collection, so a delete on one device and an
// unrelated add on another was a conflict a person had to resolve rather than
// a merge. sync.ts names the case: "these differ in one entry and I want both".
//
// The merge refuses to decide anything genuinely ambiguous — that still goes to
// the conflict copy and the chooser. What it removes is being asked about edits
// that do not overlap.

const buf = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), 'utf8')
const parse = (b: Buffer): Array<Record<string, unknown>> => JSON.parse(b.toString('utf8'))
const ids = (b: Buffer): string[] => parse(b).map((r) => r.id as string)

const A = { id: 'a', name: 'web-01' }
const B = { id: 'b', name: 'db-01' }
const C = { id: 'c', name: 'cache-01' }

describe('the case this exists for', () => {
  it('keeps an add from one device and a delete from another', () => {
    const base = baseOf(buf([A, B]))!
    const local = buf([A, B, C]) // this device added C
    const remote = buf([A]) // the other device deleted B
    const m = mergeCollections(base, local, remote)!
    expect(ids(m.merged)).toEqual(['a', 'c'])
    expect(m).toMatchObject({ added: 1, removed: 1 })
  })

  it('keeps an edit from one device and an edit to a different record on the other', () => {
    const base = baseOf(buf([A, B]))!
    const local = buf([{ ...A, name: 'web-01-renamed' }, B])
    const remote = buf([A, { ...B, name: 'db-01-renamed' }])
    const m = mergeCollections(base, local, remote)!
    expect(parse(m.merged)).toEqual([{ id: 'a', name: 'web-01-renamed' }, { id: 'b', name: 'db-01-renamed' }])
    expect(m.updated).toBe(2)
  })

  it('does not resurrect a deleted record just because the other side still has it', () => {
    // The reason per-item merging needs an ancestor at all. Without one,
    // "absent here, present there" is indistinguishable from an add.
    const base = baseOf(buf([A, B]))!
    expect(ids(mergeCollections(base, buf([A]), buf([A, B]))!.merged)).toEqual(['a'])
  })

  it('adds a record that is new on both sides only once', () => {
    const base = baseOf(buf([A]))!
    const m = mergeCollections(base, buf([A, C]), buf([A, C]))!
    expect(ids(m.merged)).toEqual(['a', 'c'])
  })
})

describe('what it refuses to decide', () => {
  it('the same record edited differently on both sides', () => {
    const base = baseOf(buf([A]))!
    expect(
      mergeCollections(base, buf([{ ...A, name: 'mine' }]), buf([{ ...A, name: 'theirs' }]))
    ).toBeNull()
  })

  it('edited here, deleted there', () => {
    const base = baseOf(buf([A, B]))!
    expect(mergeCollections(base, buf([A, { ...B, name: 'still using this' }]), buf([A]))).toBeNull()
  })

  it('deleted here, edited there', () => {
    const base = baseOf(buf([A, B]))!
    expect(mergeCollections(base, buf([A]), buf([A, { ...B, name: 'still using this' }]))).toBeNull()
  })

  it('a collection with no base, because there is no ancestor to reason from', () => {
    expect(mergeCollections(undefined, buf([A]), buf([B]))).toBeNull()
  })

  it('a payload that is not a list of identified records', () => {
    // apiWorkspace is an object, and nothing guarantees every collection stays
    // a list. Those keep the existing whole-collection behaviour.
    const base = baseOf(buf([A]))!
    expect(mergeCollections(base, buf({ settings: 1 }), buf([A]))).toBeNull()
    expect(mergeCollections(base, buf([A]), buf({ settings: 1 }))).toBeNull()
    expect(asRecords(buf([{ noId: true }]))).toBeNull()
    expect(asRecords(Buffer.from('not json', 'utf8'))).toBeNull()
  })

  it('a payload with duplicate ids, rather than silently dropping one', () => {
    expect(asRecords(buf([A, A]))).toBeNull()
  })
})

describe('the same edit made twice', () => {
  it('is not a conflict', () => {
    // Both devices renamed it identically — the same intent, reached twice.
    // Refusing here would send a person to a chooser offering two copies that
    // say the same thing.
    const base = baseOf(buf([A]))!
    const same = buf([{ ...A, name: 'agreed' }])
    expect(parse(mergeCollections(base, same, same)!.merged)).toEqual([{ id: 'a', name: 'agreed' }])
  })

  it('is not a conflict when the two sides serialise keys differently', () => {
    // Two builds writing the same record with different key order must not
    // read as an edit on both sides. That would be a conflict nobody made.
    const base = baseOf(buf([{ id: 'a', x: 1, y: 2 }]))!
    const local = buf([{ id: 'a', x: 1, y: 2 }])
    const remote = Buffer.from('[{"y":2,"id":"a","x":1}]', 'utf8')
    const m = mergeCollections(base, local, remote)
    expect(m).not.toBeNull()
    expect(m!.updated).toBe(0)
  })
})

describe('ordering', () => {
  it('keeps this device\'s order and appends what only the other side has', () => {
    const base = baseOf(buf([A, B]))!
    const m = mergeCollections(base, buf([B, A]), buf([A, B, C]))!
    expect(ids(m.merged)).toEqual(['b', 'a', 'c'])
  })
})
