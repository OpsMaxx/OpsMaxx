import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The controls the HTTP client offers, and what they point at.
 *
 * Reported as "no functional controls at all": no way to create a blank API
 * project, no way to add a request by hand, and two plus buttons doing the
 * same thing. The endpoints themselves were fixed separately — this is the
 * navigation around them, which was pointing people at the wrong places.
 */

/**
 * The file with its comments stripped.
 *
 * Checking the raw source flagged the comment that EXPLAINS the rename, which
 * would have taught the next person to reword the explanation rather than fix
 * the label. What matters is what renders.
 */
const src = (p: string): string =>
  readFileSync(resolve(__dirname, '..', 'src/renderer/src/components/http', p), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const MODAL = src('AddApiModal.tsx')
const VIEW = src('HttpView.tsx')
const CLIENT = src('ScalarClient.tsx')

describe('creating an API', () => {
  /**
   * "Single request" described what this used to build — one synthetic path
   * off the base URL — and stopped being true once a collection could define
   * its own endpoints. Somebody looking for a blank project read it as "this
   * is not that", which is how "you cannot create a blank API project" gets
   * reported about a screen that can.
   */
  it('offers a blank project by a name that says so', () => {
    expect(MODAL).toContain('Start empty')
    expect(MODAL).not.toContain('Single request')
  })

  it('says what each choice will do', () => {
    expect(MODAL).toMatch(/requests you add yourself/)
    expect(MODAL).toMatch(/every operation it declares/)
  })
})

describe('the two plus buttons', () => {
  /**
   * They did the same thing. The one beside the API SELECTOR — where somebody
   * is looking at one API and wants another request in it — added a whole
   * second API instead, so the missing affordance had a button pointing at
   * the wrong target.
   */
  it('no longer both add an API', () => {
    expect(VIEW).not.toMatch(/title="Add an API"/)
  })

  it('adds a request to the API on screen', () => {
    expect(VIEW).toContain('requestApiEndpointFocus(')
    expect(VIEW).toMatch(/Add a request to/)
  })

  /**
   * It IS offered for a collection that imports a description, and the
   * reasoning that hid it was wrong.
   *
   * The old argument: such a collection "takes its operations from the
   * description", so adding one cannot mean anything. That is a claim about
   * where its operations come FROM, and says nothing about what may be added
   * to it. Importing a description is the normal way to start, and the first
   * thing anyone does next is try one call the description does not have — a
   * health check, a staging route, the endpoint the spec is behind on. Every
   * comparable client allows it. Here the control was simply absent, with
   * nothing on screen to say why.
   *
   * The request is created in the document, so it lands in the operation tree
   * beside the imported ones.
   */
  it('is offered for every collection, imported or not', () => {
    const at = VIEW.indexOf('Add a request to')
    expect(at).toBeGreaterThan(-1)
    expect(VIEW.slice(Math.max(0, at - 400), at)).not.toContain('!collection.specUrl')
  })

  /**
   * It used to focus a path field in a separate endpoint editor, which wrote
   * `{method, path}` into OpsMaxx's own record. That editor is gone: the
   * document is the source of truth now, so the request is created IN it and
   * therefore appears in the operation tree rather than in a list beside one.
   */
  it('creates the request in the document and lands on it', () => {
    expect(CLIENT).toContain('apiEndpointFocus')
    expect(CLIENT).toContain('addRequest(')
    expect(CLIENT).toContain('createOperation(')
  })

  // The nonce, for the reason the terminal's find carries one: pressing twice
  // has to be two events, or the second press appears to do nothing.
  it('reacts to a second press', () => {
    const store = readFileSync(
      resolve(__dirname, '..', 'src/renderer/src/store/app.ts'),
      'utf8'
    )
    expect(store).toMatch(/apiEndpointFocus: \{ collectionId, nonce:/)
    // And the consumer has to compare it, not just read it.
    expect(CLIENT).toContain('lastFocusNonce')
  })
})
