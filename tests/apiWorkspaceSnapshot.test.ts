import { describe, it, expect } from 'vitest'
import {
  MAX_SNAPSHOT_BYTES,
  fromSnapshot,
  isSnapshot,
  toSnapshot,
  type WorkspaceLike
} from '../src/shared/apiWorkspaceSnapshot'

/**
 * What the API client's workspace becomes on disk.
 *
 * This is where data loss and credential leakage would happen, and neither
 * needs a DOM to check — so both are checked here rather than by driving the
 * client.
 */

const workspace = (over: Partial<WorkspaceLike> = {}): WorkspaceLike => ({
  meta: {
    'x-scalar-environments': { staging: { color: '#fff', variables: [] } },
    'x-scalar-active-document': 'col-1'
  },
  documents: {
    'col-1': { openapi: '3.1.1', info: { title: 'One' }, paths: {} }
  },
  originalDocuments: { 'col-1': { openapi: '3.1.1', info: { title: 'One' } } },
  intermediateDocuments: { 'col-1': { openapi: '3.1.1' } },
  overrides: {},
  history: { 'col-1': { '/x': { get: [{ response: 'a megabyte of body' }] } } },
  auth: { 'col-1': { bearer: 'ghp_a_real_token_typed_by_a_person' } },
  ...over
})

describe('what is kept', () => {
  it('keeps the workspace settings', () => {
    const snap = toSnapshot(workspace(), {})
    // Environments, cookies, tabs and the active selections all live in meta,
    // and they are the whole reason the snapshot exists.
    expect(snap.meta).toMatchObject({ 'x-scalar-active-document': 'col-1' })
  })

  it('keeps one copy of each document', () => {
    const snap = toSnapshot(workspace(), {})
    expect(Object.keys(snap.documents)).toEqual(['col-1'])
  })

  it('records what each document was built from', () => {
    // Without this a restored workspace is indistinguishable from an empty
    // one, and the client rebuilds every document over the restored copy —
    // discarding exactly the edits the snapshot exists to keep.
    const snap = toSnapshot(workspace(), { 'col-1': 'source-key-v1' })
    expect(snap.sourceKeys).toEqual({ 'col-1': 'source-key-v1' })
  })
})

describe('what is dropped, and must stay dropped', () => {
  /**
   * The security-relevant assertion in this file.
   *
   * `auth` is where the client stores credentials typed into its auth
   * selector, in clear. Environment variables hold a `vault:` reference rather
   * than a value, so they are safe to keep — this map is not.
   */
  it('never writes the auth store', () => {
    const snap = toSnapshot(workspace(), {})
    expect(JSON.stringify(snap)).not.toContain('ghp_a_real_token_typed_by_a_person')
    expect((snap as unknown as Record<string, unknown>).auth).toBeUndefined()
  })

  it('never writes response history', () => {
    const snap = toSnapshot(workspace(), {})
    // Response bodies are not configuration and have no business in a backup.
    expect(JSON.stringify(snap)).not.toContain('a megabyte of body')
  })

  it('drops the two redundant copies of every document', () => {
    const snap = toSnapshot(workspace(), {})
    const raw = snap as unknown as Record<string, unknown>
    expect(raw.originalDocuments).toBeUndefined()
    expect(raw.intermediateDocuments).toBeUndefined()
  })
})

describe('the size cap', () => {
  const big = (mb: number): Record<string, unknown> => ({
    openapi: '3.1.1',
    info: { title: 'Big' },
    blob: 'x'.repeat(mb * 1024 * 1024)
  })

  it('leaves a workspace under the cap completely alone', () => {
    const snap = toSnapshot(workspace(), { 'col-1': 'k' })
    expect(snap.shed).toBeUndefined()
    expect(Object.keys(snap.documents)).toEqual(['col-1'])
  })

  it('sheds a re-fetchable document before a hand-written one', () => {
    const w = workspace({
      documents: { imported: big(3), handwritten: big(3) },
      history: {},
      auth: {}
    })
    // `imported` came from a specUrl, so its content is re-read on open and
    // dropping it costs a fetch. `handwritten` exists ONLY here.
    const snap = toSnapshot(w, { imported: 'a', handwritten: 'b' }, (slug) => slug === 'imported')

    expect(snap.shed).toContain('imported')
    expect(snap.documents.handwritten).toBeDefined()
    expect(JSON.stringify(snap).length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES)
  })

  it('sheds the source key with the document', () => {
    const w = workspace({ documents: { imported: big(6) }, history: {}, auth: {} })
    const snap = toSnapshot(w, { imported: 'a' }, () => true)

    // A slug with a key but no document would tell the client its document is
    // current and stop it being rebuilt — so a shed collection would come back
    // empty rather than re-fetched.
    expect(snap.documents.imported).toBeUndefined()
    expect(snap.sourceKeys.imported).toBeUndefined()
  })

  it('records what it shed rather than dropping it silently', () => {
    const w = workspace({ documents: { imported: big(6) }, history: {}, auth: {} })
    const snap = toSnapshot(w, { imported: 'a' }, () => true)
    // "Never saved" and "too big to save" are different problems.
    expect(snap.shed).toEqual(['imported'])
  })
})

describe('round trip', () => {
  it('gives the client back what it can use', () => {
    const snap = toSnapshot(workspace(), { 'col-1': 'k' })
    const restored = fromSnapshot(snap)

    expect(restored.documents).toEqual(snap.documents)
    expect(restored.meta).toEqual(snap.meta)
    // Empty rather than absent: the client reads these by key, and undefined
    // where it expects an object is a different bug from "nothing here yet".
    expect(restored.auth).toEqual({})
    expect(restored.history).toEqual({})
    expect(restored.originalDocuments).toEqual({})
    expect(restored.intermediateDocuments).toEqual({})
  })

  it('survives a workspace that has nothing in it yet', () => {
    const snap = toSnapshot({}, {})
    expect(() => fromSnapshot(snap)).not.toThrow()
    expect(fromSnapshot(snap).documents).toEqual({})
  })
})

describe('isSnapshot', () => {
  it('accepts what toSnapshot produces', () => {
    expect(isSnapshot(toSnapshot(workspace(), {}))).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an unversioned object', { documents: {}, sourceKeys: {} }],
    ['a future version', { version: 2, documents: {}, sourceKeys: {} }],
    ['a truncated file', { version: 1, documents: {} }]
  ])('rejects %s', (_label, value) => {
    // Anything not understood is treated as "no snapshot" and the workspace is
    // rebuilt from the collections, which always works. Coercing a shape we do
    // not understand is how a restore half-succeeds.
    expect(isSnapshot(value)).toBe(false)
  })
})
