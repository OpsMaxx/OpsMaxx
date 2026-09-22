import { create } from 'zustand'
import { useApp } from './app'
import type { DatabaseConn } from '../types'

// Which database connection the add/edit dialog is working on.
//
// A connection that fails because a port or a username is wrong is not a
// problem the user can fix from an error message — before this, the only way
// to change a saved database was to delete it and type it all again. The
// dialog needs to know what it is editing before it mounts, hence a store
// rather than a prop.

interface DbEditorState {
  editId: string | null
}

export const useDbEditor = create<DbEditorState>(() => ({ editId: null }))

/** Opens the dialog on a blank profile. */
export function openDatabaseCreator(): void {
  useDbEditor.setState({ editId: null })
  useApp.getState().setModal('add-database')
}

/** Opens the dialog on an existing profile, so a connection that is wrong can
 *  be corrected where it is wrong. */
export function openDatabaseEditor(id: string): void {
  useDbEditor.setState({ editId: id })
  useApp.getState().setModal('add-database')
}

/** Writes changed fields back. `replaceAll` is the store's own bulk setter and
 *  replaces the `databases` reference, which is what persist.ts watches, so an
 *  edit is saved exactly like an add or a delete.
 *
 *  The revision bump is what makes the edit reach the connection rather than
 *  only the record. Main caches one client per database id, and an id does not
 *  change when a host does -- so correcting a wrong port and re-running the
 *  query used to go on answering from the old one. Bumped on the act of
 *  saving, not on a field diff, so a password-only correction invalidates too:
 *  the secret lives in the vault or the keychain and changes nothing here.
 *
 *  `dbClose` on top is not what makes it correct -- the new revision already
 *  makes the cache miss -- it is what frees the old client now instead of
 *  leaving it open against a database the user just repointed. */
export function saveDatabaseEdit(id: string, patch: Partial<DatabaseConn>): void {
  const state = useApp.getState()
  if (typeof window !== 'undefined') void window.opsmaxx?.db?.close?.(id)
  state.replaceAll({
    databases: state.databases.map((d) =>
      d.id === id ? { ...d, ...patch, rev: (d.rev ?? 0) + 1 } : d
    )
  })
}
