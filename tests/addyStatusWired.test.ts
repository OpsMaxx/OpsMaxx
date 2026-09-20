import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The Sync & devices panel can actually be told something.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 *
 * The panel was written BEFORE anything could answer it. That was deliberate
 * and it is documented in `addyStatus.ts`: the screen typed the four questions
 * it needed answered and rendered "not reported" for every one of them, so it
 * was honest while the engine behind it was built. The whole design depends on
 * one thing — that when main lands the answer, the panel notices.
 *
 * It notices through `addyStatusSupported()`, which asks the bridge whether it
 * has a `status` call. So the failure this file exists against is precise and
 * it is silent: `session.status()` implemented, typechecking, unit-tested, and
 * no IPC handler or no preload method — in which case `supported` stays false
 * for ever and the panel goes on saying "sync is not running on this build"
 * over a build where it is.
 *
 * That exact failure has happened five times in this codebase (VPN profile
 * import, WireGuard discovery, coexistence advisories, addy's `attach` and
 * addy's login) and three times in CI/CD alone, which is why
 * `cicdBridgeWired.test.ts` exists. This is the same check for the same shape
 * of hole. It walks source text on purpose: that a name appears is weak proof
 * the call is right, and strong proof it is not missing.
 */

const ROOT = resolve(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const MAIN = read('src/main/index.ts')
const PRELOAD = read('src/preload/index.ts')
const SESSION = read('src/main/services/addy/session.ts')
const STATUS = read('src/renderer/src/components/addy/addyStatus.ts')

describe('the status the panel asks for is reachable from the panel', () => {
  it('main answers the channel the preload invokes', () => {
    // Anchored on the channel name and the call, never on the layout: a
    // handler wrapped onto two lines is the same wiring, and a test that
    // breaks on a reformat is one people learn to edit rather than read.
    expect(MAIN).toMatch(/ipcMain\.handle\(\s*'addy:status'/)
    expect(MAIN).toMatch(/addySession\.status\(\)/)
    expect(PRELOAD).toMatch(/ipcRenderer\.invoke\('addy:status'\)/)
  })

  it('exposes both halves, because the panel subscribes only when it has both', () => {
    // `useAddyStatus` returns early unless `supported`, and `supported` reads
    // `status`. A build with the push and not the read subscribes to nothing;
    // one with the read and not the push shows a number that never changes
    // again — including "1 device" for the whole session after a pairing that
    // just added a second.
    expect(PRELOAD).toMatch(/\bstatus:\s*\(\)/)
    expect(PRELOAD).toMatch(/\bonStatus:\s*\(/)
    expect(PRELOAD).toMatch(/ipcRenderer\.on\('addy:status'/)
    expect(PRELOAD).toMatch(/removeListener\('addy:status'/)
  })

  it('main pushes on change rather than waiting to be asked', () => {
    expect(MAIN).toMatch(/addySession\.watch\(/)
    expect(MAIN).toMatch(/webContents\.send\('addy:status'/)
    // And something actually calls the notifier. A `watch` nobody announces to
    // is a subscription that never fires, which looks exactly like a working
    // one until a device is added.
    expect(SESSION).toMatch(/this\.announce\(\)/)
  })

  it('the panel reads the bridge without a cast around it', () => {
    // The cast was the marker for "main has not landed this yet", and
    // `addyStatus.ts` says in its own words that it is the line to delete when
    // main does. Leaving it would mean a rename on either side compiles
    // cleanly and reports nothing — the failure mode this whole file is about.
    expect(STATUS).not.toMatch(/as unknown as AddyStatusBridge/)
  })

  it('the shape is declared once, in the shared contract', () => {
    // Two copies of it would let main's answer drift from the panel's question
    // with neither side failing to compile.
    expect(read('src/shared/addy.ts')).toMatch(/export interface AddyStatusSnapshot/)
    expect(STATUS).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/addy'/)
  })
})

/**
 * The clipboard, which was entirely dead.
 *
 * `updateClipboardShortcuts` was written, correct, and called from NOWHERE —
 * so the two global shortcuts were never registered and the only way to send a
 * clipboard was a key combination nothing listened for. The handlers, the
 * sealing, the mailbox, the echo suppression and the p2p fallback all worked;
 * the feature did not exist.
 *
 * That is the sixth time this exact hole has appeared in this codebase. It is
 * not a typo class and it is not caught by a typechecker: a function nobody
 * calls compiles perfectly and its unit tests pass.
 */
describe('the clipboard shortcuts are actually registered', () => {
  it('something asks for them', () => {
    // The bug, precisely: the only mention of this function in the entire
    // repository was its own declaration.
    const mentions = MAIN.match(/updateClipboardShortcuts\(/g) ?? []
    expect(
      mentions.length,
      'updateClipboardShortcuts is declared and never called — the shortcuts are never registered'
    ).toBeGreaterThan(1)
  })

  it('is driven by a setting the user can see, not by a default', () => {
    // A global shortcut is taken from every application on the machine, and
    // Cmd/Ctrl+Shift+C is DevTools in every browser. Holding it for somebody
    // who never asked is worse than not shipping the feature.
    expect(MAIN).toMatch(/ipcMain\.handle\(\s*'addy:setClipboardShortcuts'/)
    expect(PRELOAD).toMatch(/invoke\('addy:setClipboardShortcuts'/)
    const PERSIST = read('src/renderer/src/store/persist.ts')
    expect(PERSIST).toMatch(/setClipboardShortcuts/)
    // At startup AND on change: main keeps no copy across restarts, so a
    // startup push is what stops the setting being silently off every launch.
    expect((PERSIST.match(/setClipboardShortcuts/g) ?? []).length).toBeGreaterThan(1)
  })

  it('is released when this device is not on an account', () => {
    // A shortcut whose handler can only answer "this device is not attached"
    // teaches the user the feature is broken.
    expect(MAIN).toMatch(/addySession\.attached/)
    expect(MAIN).toMatch(/refreshClipboardShortcuts/)
  })

  it('offers the switch on the panel, where the feature lives', () => {
    // A setting nobody can find cannot be how you find the feature — the same
    // argument the addy module's own registry entry makes about its nav entry.
    const PANEL = read('src/renderer/src/components/addy/AddyPanel.tsx')
    expect(PANEL).toMatch(/addyClipboardShortcuts/)
  })
})

/**
 * The backup destination that could not be created.
 *
 * `addyTarget` was written, carried its four preconditions, had its own test
 * file — and there was no `kind: 'addy'` destination to open and no case in
 * `openTarget`. The only reference to it in the whole repository outside its
 * own file was that test. So "back up to your relay" did not exist in the
 * product, and the test suite was green over it.
 *
 * Same shape as the clipboard above, found the same way: by asking which
 * exported functions nothing outside their own file and their own test calls.
 */
describe('the relay is a backup destination you can actually choose', () => {
  it('is a kind the shared contract knows about', () => {
    const BACKUP = read('src/shared/backup.ts')
    expect(BACKUP).toMatch(/BACKUP_DESTINATION_KINDS = \[[^\]]*'addy'/)
    expect(BACKUP).toMatch(/interface AddyBackupDestination/)
  })

  it('has a case in the driver table, and a factory that supplies it', () => {
    const TARGETS = read('src/main/services/backupTargets.ts')
    expect(TARGETS).toMatch(/case 'addy'/)
    // Registered rather than imported, so the driver table does not depend on
    // a feature most installs never turn on — and so there is no cycle with
    // services/addy/target.ts, which imports this file.
    expect(TARGETS).toMatch(/export function registerAddyTarget/)
    expect(MAIN).toMatch(/registerAddyTarget\(/)
    expect(SESSION).toMatch(/backupTarget\(/)
  })

  it('says what it is rather than failing at the first scheduled run', () => {
    // A destination that accepts configuration and then fails every run is one
    // somebody discovers when they need a restore.
    const TARGETS = read('src/main/services/backupTargets.ts')
    expect(TARGETS).toMatch(/not on an addy account/)
  })

  it('can be created from the panel', () => {
    // The kind list drives the buttons, so a kind with no `blank()` case would
    // offer a button that builds a malformed destination.
    const PANEL = read('src/renderer/src/components/settings/BackupDestinations.tsx')
    expect(PANEL).toMatch(/kind === 'addy'/)
  })
})

/**
 * The direct path was unreachable in both directions.
 *
 * `dialPeer` was wired and `answerPeer` was called from nowhere. A WebRTC
 * connection needs an answerer, so with nobody answering, `tryDirect` could
 * never succeed on any network — every clipboard silently took the mailbox
 * and the fallback made that invisible. The feature was not "rarely
 * available"; it did not work at all.
 *
 * The fallback is what made this survivable and what made it undetectable,
 * which is the general lesson: a graceful degradation with no way to tell it
 * apart from the good path will hide a dead feature indefinitely.
 */
describe('the direct path has both halves', () => {
  it('something answers a dial, not just dials', () => {
    expect(SESSION).toMatch(/answerPeer\(/)
    expect(SESSION).toMatch(/dialPeer\(/)
  })

  it('a directly delivered payload has somewhere to go', () => {
    // `receiveClipboard` reads the mailbox. A payload that arrived over a
    // DataChannel would otherwise be opened into a variable nobody reads.
    const CLIP = read('src/main/services/addy/clipboard.ts')
    expect(CLIP).toMatch(/export async function applySealedClipboard/)
    expect(SESSION).toMatch(/applySealedClipboard\(/)
  })

  it('listens only while the feature is switched on', () => {
    // It is a long poll held open for the life of the session. Holding a
    // connection for a feature nobody turned on buys nothing.
    expect(MAIN).toMatch(/startAnswering\(\)/)
    expect(MAIN).toMatch(/stopAnswering\(\)/)
  })

  it('stops when the session detaches', () => {
    expect(SESSION).toMatch(/this\.stopAnswering\(\)/)
  })
})

/**
 * A revocation had a victim and no actor.
 *
 * `services/addy/revoke.ts` implements what a revoked device does to ITSELF:
 * reads the roster, finds itself absent, closes its sessions, wipes every data
 * file and shows a blocking screen. It is careful, it is tested, and nothing
 * anywhere authored the roster entry that triggers it — so a user could see
 * the devices on their account and had no way to remove one, which for a lost
 * laptop is the single call they most need.
 */
describe('a device can be taken off the account', () => {
  it('the sidecar authors the entry', () => {
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    expect(CRYPTO).toMatch(/func handleRevokeDevice/)
    expect(CRYPTO).toMatch(/protocol\.OpRevoke/)
    const MAINGO = readFileSync(join(ROOT, 'sidecar/addyd/main.go'), 'utf8')
    expect(MAINGO).toMatch(/"revokeDevice":/)
  })

  it('and every layer above it is connected', () => {
    expect(SESSION).toMatch(/async revokeDevice\(/)
    expect(MAIN).toMatch(/ipcMain\.handle\('addy:revokeDevice'/)
    expect(PRELOAD).toMatch(/invoke\('addy:revokeDevice'/)
    const PANEL = read('src/renderer/src/components/addy/AddyPanel.tsx')
    expect(PANEL).toMatch(/revokeDevice\(/)
  })

  it('refuses to let a device revoke itself', () => {
    // That is a wipe of the machine the user is sitting at, one press away, on
    // a list where one row is "this device". Refused in the sidecar, so no
    // caller can reach it by skipping a UI guard — and the panel does not
    // offer the button on that row either.
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    expect(CRYPTO).toMatch(/cannot revoke itself/)
    const PANEL = read('src/renderer/src/components/addy/AddyPanel.tsx')
    expect(PANEL).toMatch(/!d\.self && d\.revoked !== true/)
  })
})

/**
 * Recovery: the path nobody takes until everything has gone wrong.
 *
 * There is no second chance to discover it does not work — by the time anyone
 * needs it, every device is already gone. So it is wired before anyone needs
 * it, and the wiring is checked here for the same reason the rest of this file
 * exists: a `recoverFromPhrase` nobody can reach is exactly as useful as not
 * having written it.
 */
describe('an account can be recovered from the phrase', () => {
  it('the sidecar has both halves and can forget the root key', () => {
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    for (const h of ['handleRecoverIdentity', 'handleRecoverOpen', 'handleRecoverForget']) {
      expect(CRYPTO, `${h} is missing`).toMatch(new RegExp(`func ${h}`))
    }
    const MAINGO = readFileSync(join(ROOT, 'sidecar/addyd/main.go'), 'utf8')
    expect(MAINGO).toMatch(/"recoverIdentity":/)
    expect(MAINGO).toMatch(/"recoverOpen":/)
  })

  it('writes a ROOT-signed entry, not an epoch-signed one', () => {
    // The distinction a verifier uses to tell a recovery from an ordinary
    // pairing, and what `mnemonicAdded` surfaces to somebody reviewing their
    // devices. An AK-signed entry would be indistinguishable from one written
    // by any device that already held the epoch key — including a revoked one.
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    expect(CRYPTO).toMatch(/Signer:\s+protocol\.SignerRK/)
  })

  it('verifies the roster against the escrow rather than the relay', () => {
    // The escrow carries the head entry as the account committed it, so the
    // chain is checked against a pin the relay never saw. A recovering device
    // has nothing else to compare against, which is exactly when serving it a
    // truncated roster would be most worth trying.
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    expect(CRYPTO).toMatch(/protocol\.Pin\{Seq: head\.Seq, Hash: headHash\}/)
  })

  it('and every layer above it is connected', () => {
    expect(SESSION).toMatch(/async recoverFromPhrase\(/)
    expect(MAIN).toMatch(/ipcMain\.handle\(\s*'addy:recover'/)
    expect(PRELOAD).toMatch(/invoke\('addy:recover'/)
    const SETUP = read('src/renderer/src/components/addy/AddySetup.tsx')
    expect(SETUP).toMatch(/addy\.recover\(/)
    expect(SETUP).toMatch(/I have a recovery phrase/)
  })

  it('drops the root key whether it worked or not', () => {
    // RK opens the escrow and authorises an epoch change: it is the whole
    // estate, and a process still holding it after recovery has no use for it.
    expect(SESSION).toMatch(/recoverForget/)
  })

  it('ends on a device review rather than on a success message', () => {
    // Anyone who read the card can do what was just done. The moment a person
    // is most able to notice a device they do not recognise is the moment they
    // have just been handed the list.
    const SETUP = read('src/renderer/src/components/addy/AddySetup.tsx')
    expect(SETUP).toMatch(/Check the device list/)
  })
})

/**
 * Re-keying: the other half of removing a device.
 *
 * Taking a machine off the roster stops it receiving anything new. It does NOT
 * take back the epoch key that machine is already holding, so a laptop that
 * was stolen rather than retired can still read everything it captured. The
 * re-key is what changes that, and without it the revocation UI would be
 * promising something it does not do.
 */
describe('the account key can be changed', () => {
  it('the sidecar prepares both kinds and keeps them apart', () => {
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    expect(CRYPTO).toMatch(/func handleRotateEpoch/)
    // A revocation rotation must NOT publish a chained handoff: it is sealed
    // under the old key, which is exactly what the removed device holds.
    expect(CRYPTO).toMatch(/if kind == protocol\.Hygiene \{/)
    // And it must not be signed by that key either.
    expect(CRYPTO).toMatch(/must not authorise the escape from itself/)
  })

  it('writes in the order the protocol requires', () => {
    // Collections re-sealed first, escrow second, handoffs third, the
    // transition LAST. Any other order leaves a window in which a device
    // reading the chain finds an epoch whose objects do not exist yet — and
    // the transition being last is what makes a crash leave the account
    // usable at the old epoch rather than at neither.
    const rotate = SESSION.slice(SESSION.indexOf('async rotateEpoch('))
    const body = rotate.slice(0, rotate.indexOf('\n  /**', 10))
    const reseal = body.indexOf('for (const name of SYNCED_COLLECTIONS)')
    const escrow = body.indexOf("putObject('escrow'")
    const handoff = body.indexOf('handoff:')
    const transition = body.indexOf('appendRoster(')
    expect(reseal, 'collections are not re-sealed').toBeGreaterThan(-1)
    expect(escrow, 'the escrow is not re-sealed').toBeGreaterThan(reseal)
    expect(handoff, 'no handoffs are published').toBeGreaterThan(escrow)
    expect(transition, 'the transition is not appended last').toBeGreaterThan(handoff)
  })

  it('re-seals the escrow, or recovery silently stops working', () => {
    // The card would go on opening an epoch the account has moved off: a
    // recovery that appears to succeed and hands back a key that reads
    // nothing current.
    expect(SESSION).toMatch(/prepared\.escrow/)
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    expect(CRYPTO).toMatch(/needEpoch/)
  })

  it('and every layer above it is connected', () => {
    expect(MAIN).toMatch(/ipcMain\.handle\('addy:rotate'/)
    expect(PRELOAD).toMatch(/invoke\('addy:rotate'/)
    const PANEL = read('src/renderer/src/components/addy/AddyPanel.tsx')
    expect(PANEL).toMatch(/addy\.rotate\('revocation'/)
  })
})

/**
 * A rotation that nobody else can follow locks the account.
 *
 * The rotating machine re-seals every collection under the new epoch and
 * publishes a handoff per surviving device. A device that never reads its
 * handoff holds only the old key, and from that moment every object it fetches
 * fails to open — an AEAD error on every collection at once, on a machine that
 * did nothing wrong. So the re-key shipped an hour ago was, on its own, a way
 * to lock every other device out of the account.
 */
describe('other devices follow a rotation', () => {
  it('the sidecar can adopt an epoch it did not mint', () => {
    const CRYPTO = readFileSync(join(ROOT, 'sidecar/addyd/crypto.go'), 'utf8')
    expect(CRYPTO).toMatch(/func handleAdoptEpoch/)
    // Refused for a revocation by the READER as well as the writer: a relay
    // that kept the chained handoff from a hygiene rotation and served it
    // against a later revocation would hand a revoked device exactly what the
    // revocation took away.
    expect(CRYPTO).toMatch(/ReadChainedHandoff/)
  })

  it('the session notices and walks forward', () => {
    expect(SESSION).toMatch(/private async followRotation\(/)
    // From refreshRoster, because the roster is where a rotation announces
    // itself — the transition entry moves the chain's epoch.
    expect(SESSION).toMatch(/followRotation\(chainEpoch\)/)
  })

  it('stores the adopted key, or the device is locked out on its next launch', () => {
    expect(SESSION).toMatch(/account:\$\{next\}/)
    // And the resume path loads every epoch this device holds, not just the
    // newest: objects re-sealed under n+1 land before the transition does, so
    // a device that has just caught up still needs n.
    expect(SESSION).toMatch(/for \(let n = 2; n <= saved\.epoch; n\+\+\)/)
  })

  it('the rotating device keeps the key it rotated to', () => {
    // Stored BEFORE any of the writes. A crash after the first PUT and before
    // this would leave the relay carrying objects this device cannot read —
    // the one failure worse than not rotating at all.
    const rotate = SESSION.slice(SESSION.indexOf('async rotateEpoch('))
    const store = rotate.indexOf('account:${prepared.epoch}')
    const firstWrite = rotate.indexOf('for (const name of SYNCED_COLLECTIONS)')
    expect(store).toBeGreaterThan(-1)
    expect(store).toBeLessThan(firstWrite)
  })

  it('pairs a new device into the CURRENT epoch, not epoch 1', () => {
    // The unsuffixed keychain name still holds the original key after a
    // rotation. Handing that to a joining device would pair it into an epoch
    // the account has moved off: it would see the roster and be unable to read
    // a single object.
    expect(SESSION).toMatch(/account\.epoch > 1/)
  })
})

/**
 * Files, and the pointer/payload split.
 *
 * `ADDY_MODULE_IDS` named `addyTransfer` and nothing implemented it, so the
 * clipboard's own refusal — "Files and images are sent as transfers" — pointed
 * at a feature that did not exist.
 */
describe('a file can be sent to another device', () => {
  it('puts the bytes in the object store and a pointer in the mailbox', () => {
    const T = read('src/main/services/addy/transfer.ts')
    expect(T).toMatch(/putObject\(/)
    expect(T).toMatch(/'\/v1\/mail'/)
    // And in that order. A notice that arrives before the object exists is a
    // recipient fetching a 404 and reporting a failure for a transfer that is
    // about to work.
    expect(T.indexOf('putObject(')).toBeLessThan(T.indexOf("'/v1/mail'"))
  })

  it('checks the digest before writing anything to disk', () => {
    // The AEAD proves nobody without the key altered the bytes. The digest
    // proves they are all of them.
    const T = read('src/main/services/addy/transfer.ts')
    const check = T.indexOf('arrived incomplete')
    const write = T.indexOf('writeFileSync(')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(write)
  })

  it('does not let a sender choose where its file lands', () => {
    // BOTH halves of the path, and this assertion used to check only one.
    //
    // The filename was sanitised and the transfer ID was not — and the ID is
    // what builds the directory, under `mkdirSync(..., {recursive: true})`.
    // An id of `../../../../.ssh` with a name of `authorized_keys` wrote an
    // SSH key into the user's home directory at mode 0600, which is the mode
    // sshd requires. The notice comes from another machine; holding the epoch
    // key is not a reason to trust it, it is the reason to check it.
    const T = read('src/main/services/addy/transfer.ts')
    expect(T).toMatch(/basename\(notice\.name\)/)
    expect(T).toMatch(/TRANSFER_ID\.test\(notice\.id\)/)
    expect(T).toMatch(/join\(dir, basename\(notice\.id\)\)/)
    // And the id is never used unchecked for the relay object either.
    expect(T).not.toMatch(/join\(dir, notice\.id\)/)
  })

  it('sweeps quarantine rather than keeping everything for ever', () => {
    const T = read('src/main/services/addy/transfer.ts')
    expect(T).toMatch(/export function sweepQuarantine/)
    expect(SESSION).toMatch(/sweepQuarantine\(\)/)
  })

  it('and every layer above it is connected', () => {
    expect(SESSION).toMatch(/async sendFile\(/)
    expect(MAIN).toMatch(/ipcMain\.handle\('addy:sendFile'/)
    expect(PRELOAD).toMatch(/invoke\('addy:sendFile'/)
    const PANEL = read('src/renderer/src/components/addy/AddyPanel.tsx')
    expect(PANEL).toMatch(/addy\.sendFile\(/)
  })

  it('is deleted by "delete everything", and never synced', () => {
    // Whole file contents, written by a machine other than this one.
    expect(read('src/main/services/backup.ts')).toMatch(/'addy-transfers'/)
    expect(read('src/shared/addy.ts')).toMatch(/addyTransfers:/)
  })
})

/**
 * A request signature has to be over what the far end checks.
 *
 * The relay verifies against Go's `r.URL.Path`, which is percent-DECODED. The
 * client signed the ESCAPED path, so any object name containing a character
 * `encodeURIComponent` escapes was signed one way and verified another. With
 * only `servers` and `escrow` in play nothing escaped and it never showed; the
 * first name with a colon in it produced a 401 that reads exactly like a bad
 * token, on a request whose token was fine.
 */
describe('object names that need escaping still authenticate', () => {
  it('signs the decoded path while sending the escaped one', () => {
    const RELAY = read('src/main/services/addy/relay.ts')
    expect(RELAY).toMatch(/decodeURIComponent\(raw\)/)
    // The URL itself stays escaped, or a name with a slash in it would
    // address a different route entirely.
    expect(RELAY).toMatch(/encodeURIComponent\(name\)/)
  })
})
