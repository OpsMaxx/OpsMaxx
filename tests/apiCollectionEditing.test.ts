import { describe, it, expect, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'

// "I can add only one domain and I cannot edit it or add more."
//
// Reported against a running build, and all three halves were true. Adding,
// switching and deleting a saved API lived only in the left sidebar — the `+`
// in its header and the list below it — so with that sidebar collapsed the
// HTTP view could reach none of them. The one Add button in the main pane
// belongs to the empty state and disappears the moment the first collection
// exists.
//
// Editing was not hidden, it was absent: the toolbar could change viaServerId
// and insecureTls, and the name, base URL and spec were fixed at creation. A
// mistyped base URL meant deleting the API and building it again.
//
// The store could always hold many collections and always had updateApiCollection.
// Nothing in the UI called it. These are the wiring that now does.

const reset = (): void => {
  useApp.setState({ modal: null, editServerId: null, editApiCollectionId: null })
}

describe('editing a saved API', () => {
  beforeEach(reset)

  it('opens the add modal against a specific collection', () => {
    useApp.getState().openApiEditor('c-1')
    expect(useApp.getState().modal).toBe('add-api')
    expect(useApp.getState().editApiCollectionId).toBe('c-1')
  })

  it('forgets which one it was editing when the modal is opened plainly', () => {
    // Otherwise "Add an API" straight after an edit reopens the edit — the
    // exact bug editServerId is cleared in setModal to avoid.
    useApp.getState().openApiEditor('c-1')
    useApp.getState().setModal('add-api')
    expect(useApp.getState().editApiCollectionId).toBeNull()
  })

  it('forgets it on close too, so the next open starts blank', () => {
    useApp.getState().openApiEditor('c-1')
    useApp.getState().setModal(null)
    expect(useApp.getState().editApiCollectionId).toBeNull()
  })

  it('leaves the server editor alone, which shares the mechanism', () => {
    useApp.getState().openServerEditor('s-1')
    expect(useApp.getState().editServerId).toBe('s-1')
    expect(useApp.getState().editApiCollectionId).toBeNull()
  })

  it('does not leak an api id into a server edit', () => {
    useApp.getState().openApiEditor('c-1')
    useApp.getState().openServerEditor('s-1')
    // openServerEditor routes through set(), not setModal, so it has to do
    // its own clearing — it did not, and a stale api id survived into a
    // server edit. Harmless today only because the modal slot changes too.
    expect(useApp.getState().editServerId).toBe('s-1')
    expect(useApp.getState().editApiCollectionId).toBeNull()
  })
})
