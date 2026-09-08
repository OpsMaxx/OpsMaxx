// Whether a backup would contain anything.
//
// The status bar, the activity-bar badge and the Backup panel all shout
// "Backup out of date" in red, and on a brand new install with zero servers
// they shouted it immediately. The cause is upstream of all three: the staleness
// check watches `state.workspaces`, and the app creates a default workspace for
// itself on first run — so the very first thing a user saw, before they had
// created anything, was a red failure about data that did not exist.
//
// That is expensive out of all proportion to the bug. It is the first coloured
// signal in the product, and it teaches the reader that the status bar cries
// wolf — the same bar that later carries the alert count and, now, the
// pending-approval chip. A warning nobody can act on is training.
//
// So: a workspace the app made for itself is not user data. Everything else is.
// The test is deliberately about CONTENT rather than about "is this the first
// run", because a user who deletes their last server is back in the same state
// and the answer should be the same both times.

export interface BackupContentState {
  workspaces: readonly unknown[]
  folders: readonly unknown[]
  servers: readonly unknown[]
  databases: readonly unknown[]
  tunnels: readonly unknown[]
  vpns: readonly unknown[]
}

export function hasBackupContent(s: BackupContentState): boolean {
  if (
    s.servers.length > 0 ||
    s.databases.length > 0 ||
    s.tunnels.length > 0 ||
    s.vpns.length > 0 ||
    s.folders.length > 0
  ) {
    return true
  }
  // A SECOND workspace is a decision somebody made; the first one was made for
  // them. Renaming the default is also a decision, but this module cannot see
  // names without knowing what the default is called, and guessing at that is
  // how a rename in a later version silently stops counting. An empty second
  // workspace is the cheapest honest signal, and anything with actual content
  // in it is already caught above.
  return s.workspaces.length > 1
}
