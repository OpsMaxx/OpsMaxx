import { safeStorage } from 'electron'

// The OS secure store described as FACTS, with no way to read what is in it.
//
// secrets.ts holds the credentials themselves — its `exportSecrets()` returns
// every one of them in plaintext — which is why the diagnostics payload is
// forbidden from importing it at all; tests/diagnosticsImports.test.ts walks
// that closure and fails if it ever can. But the single most useful thing a bug
// report can say about a credential problem sits behind that wall: whether this
// machine can store a secret at all.
//
// So the predicate lives HERE and secrets.ts imports it from here, rather than
// this file carrying a second copy. A duplicated security-relevant predicate is
// worse than the gap it closes — two copies drift, and the one that drifts is
// the one nobody is reading at the time. There is exactly one implementation of
// "can this machine encrypt", and it is in this file.
//
// WHAT MAY LIVE IN HERE
//
// The safeStorage PREDICATES and the platform's own name for its password
// store. Not the path of the secrets file, not the ciphertext map, not
// encryptString and above all not decryptString. A field that would need any of
// those is a field that belongs on the other side of the wall, in secrets.ts,
// where the import guard can keep the payload away from it.

/**
 * Whether the OS keychain can seal a secret on this machine.
 *
 * `setSecret` refuses to persist anything at all when this is false — plaintext
 * on disk is not an option it offers — so "I set a password and it did not
 * stick" and "SSH auth keeps failing" both have this as a root cause, and until
 * now a bug report had no way to show it.
 *
 * One macOS caveat, and it is not new: the first call in a process can block on
 * a keychain permission prompt. The `secrets:available` IPC has always called
 * this same function on the same path, and it is the same prompt the user has
 * to answer before any stored credential works.
 */
export function secretsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Linux: which password store the desktop session offered — `gnome_libsecret`,
 * `kwallet6`, `basic_text` and so on. `null` on every other platform.
 *
 * A platform fact, not user data: it names an OS component the same way
 * `osRelease` names the kernel. It is also the other half of the answer
 * whenever `secretsAvailable()` is surprising, because on Linux that outcome
 * depends entirely on which store is present — `basic_text` is Electron's name
 * for "no system keyring was recognised", which is the shape of every "my
 * credentials vanish on this distro" report.
 *
 * Electron defines this on Linux only, so it is guarded on the platform and
 * then on the call itself: an older Electron, or a call made before `ready`,
 * must cost the payload one field rather than throw inside a diagnostics
 * collector someone reached for because the app was already misbehaving.
 */
export function secretsBackend(): string | null {
  if (process.platform !== 'linux') return null
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return null
  }
}
