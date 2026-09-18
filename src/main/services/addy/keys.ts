import { deleteSecret, getSecret, MACHINE_ONLY_SECRET_PREFIX, setSecret } from '../secrets'

/**
 * Where addy's key material is stored, and why none of it is in a backup.
 *
 * addy's whole premise is that the server holds no key. That premise survives
 * a compromised relay and dies to a bundle: a backup is the one artefact that
 * collects every credential the app holds, encrypts it under a single
 * passphrase, and is then designed to be COPIED SOMEWHERE ELSE. Putting the
 * account key in one turns "the server never sees a key" into "the server
 * never sees a key, unless the operator's bucket does".
 *
 * So every id below is built on MACHINE_ONLY_SECRET_PREFIX, which
 * `exportSecrets` already skips and `importSecrets` already refuses. Reusing
 * that prefix rather than adding a second one is deliberate: a second class
 * would be a second check in two functions and a second chance to forget one
 * of them, and the mechanism is identical either way.
 *
 * What differs from the backup-passphrase case that prefix was written for is
 * the CONSEQUENCE, and it is the better half of the trade. A machine that
 * restores a bundle does not get the backup passphrase back and nothing can
 * give it back; it does not get these back either, but each one has a real
 * route home:
 *
 *  - `root` comes back from the twelve-word mnemonic, which is what a mnemonic
 *    is for. It authorises epoch changes and nothing else, so it is also the
 *    one a device should not be holding day to day.
 *  - `account` comes back from pairing, which re-delivers the current AK_n
 *    over a channel the roster authenticates.
 *  - `device` deliberately does NOT come back, and must not. A restored
 *    machine is a different device: it gets its own key, its own roster entry
 *    and its own line in the device list. A bundle that carried the old one
 *    would clone an identity, and two machines answering to one roster entry
 *    is exactly the state revocation cannot express -- revoking it would cut
 *    off the innocent one too.
 *
 * `tests/machineOnlySecrets.test.ts` pins all of this against the real
 * `exportSecrets`, per kind, rather than trusting the prefix by inspection.
 */
export const ADDY_SECRET_KINDS = ['root', 'account', 'device'] as const
export type AddySecretKind = (typeof ADDY_SECRET_KINDS)[number]

/**
 * The id one addy secret is stored under.
 *
 * `scope` is the account id for `root` and `device`, and `<account id>:<epoch>`
 * for `account` -- an epoch's AK_n is a different secret from its successor's
 * and both may be held at once during a transition, so the epoch is part of
 * the identity rather than something that overwrites it.
 */
export function addySecretId(kind: AddySecretKind, scope: string): string {
  return `${MACHINE_ONLY_SECRET_PREFIX}addy-${kind}:${scope}`
}

export const addyAccountSecretId = (accountId: string, epoch: number): string =>
  addySecretId('account', `${accountId}:${epoch}`)

/** Stored sealed by the OS keychain, like every other credential here. Returns
 *  false when the keychain is unavailable, and the caller must treat that as a
 *  refusal to proceed rather than storing the key some other way. */
export function storeAddySecret(kind: AddySecretKind, scope: string, value: string): boolean {
  return setSecret(addySecretId(kind, scope), value)
}

export function loadAddySecret(kind: AddySecretKind, scope: string): string | null {
  return getSecret(addySecretId(kind, scope))
}

export function forgetAddySecret(kind: AddySecretKind, scope: string): void {
  deleteSecret(addySecretId(kind, scope))
}
