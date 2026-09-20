import { AddyError, openAddyd, type AddySidecar } from './sidecar'
import { storeAddySecret, loadAddySecret } from './keys'
import { loadEnrolment, saveEnrolment } from './enrolment'
import {
  beginPairing,
  forgetPairing,
  joinPairing,
  publish,
  receive,
  type PairingConfirmation
} from './pairing'
import { RelayClient } from './relay'
import {
  discardConflict,
  listConflicts,
  resolveConflict,
  type ConflictDeps
} from './conflicts'
import {
  SYNCED_COLLECTIONS,
  type AddyStatusSnapshot,
  type ConflictCopy,
  type SyncedCollection
} from '../../../shared/addy'
import { app } from 'electron'
import { counterFloor, forgetSyncState, syncOnce, type SyncResult } from './sync'
import { SOURCES } from './collections'
import { runRevocationWipe } from './revoke'
import { deleteAllData } from '../backup'
import { addyTarget } from './target'
import type { BackupTarget } from '../backupTargets'
import {
  collectFiles,
  sendFile,
  sweepQuarantine,
  type ArrivedFile,
  type TransferDeps
} from './transfer'
import {
  applySealedClipboard,
  receiveClipboard,
  sendClipboard,
  type ClipboardDeps
} from './clipboard'
import { answerPeer, closeSession, dialPeer, type P2PDeps } from './p2p'

/**
 * The live connection to an addy account: one sidecar, one relay client.
 *
 * NOTHING HERE IS CONFIGURED YET, and every entry point says so rather than
 * failing obscurely. Pairing is what fills this in, and until it does, the
 * honest answer to "what conflicts are waiting" is "none, because this device
 * is not attached to an account" -- not an exception the renderer has to
 * recognise, and not an empty list that looks like everything is fine.
 */

/** A verified roster, as the panel needs it. */
export interface AddyRoster {
  devices: {
    pubSign: string
    pubEnc: string
    epoch: number
    mnemonicAdded: boolean
    /** The pseudonym, opened in the sidecar. Absent when this device does not
     *  hold the profile key of the epoch that device was added in — the
     *  ordinary state for one that joined after a rotation, not an error. */
    label?: string
  }[]
  /** Whether THIS device is still listed. False is the revocation signal. */
  stillListed: boolean
  /** H(last entry), hex: the pin two devices can compare, and the one a
   *  printed recovery card carries. */
  head?: string
  /** That entry's own bytes, base64. What anything CHAINING a new entry needs,
   *  because the next entry's `prev_hash` is its hash — and what a handoff
   *  seals so a joining device can verify the chain it fetches rather than
   *  trusting the relay's copy. Not interchangeable with `head`. */
  headEntry?: string
  headSeq?: number
  /** This device's own `pub_sign`, so a caller can mark which row is itself. */
  self?: string
  problem?: string
}

/** What a resume at launch found. */
export interface AddyResumeResult {
  resumed: boolean
  accountId?: string
  baseURL?: string
  /** Set when this machine IS enrolled and something stopped it coming back —
   *  an unreadable keychain, an unreachable relay. Distinct from "not set
   *  up", which is what `resumed: false` with no problem means. */
  problem?: string
}

export interface AddyAccount {
  baseURL: string
  token: string
  accountId: string
  epoch: number
  /** The root and epoch-1 signing public halves, which a roster is verified
   *  against. Carried on the account because they must come from this client
   *  and never from the relay. */
  rootSignPub?: string
  epoch1SignPub?: string
}

class AddySession {
  private addyd: AddySidecar | null = null
  private relay: RelayClient | null = null
  private account: AddyAccount | null = null
  /** Accept a self-signed relay certificate. Development instances only, and
   *  carried on the enrolment so a resume does not silently become strict. */
  private insecureTLS = false

  /** The last roster this device VERIFIED, kept so `status()` can answer
   *  without a network round trip on every render.
   *
   *  `null` means "never read", and that is not the same as an empty account:
   *  the panel renders the two differently on purpose, so this must never be
   *  initialised to `[]`. */
  private lastRoster: AddyRoster | null = null
  private watchers = new Set<(s: AddyStatusSnapshot) => void>()
  /** Told which collections changed on disk, so the renderer can reload them
   *  before writing its own stale copy back over the top. */
  private appliedCb: ((collections: SyncedCollection[]) => void) | null = null

  /** The last pass, or null when none has run in this process. */
  private lastSync: SyncResult | null = null
  /** Objects carried per pass, oldest first. Bounded, because it is a
   *  sparkline and not a log. */
  private carried: number[] = []
  /** True only while a pass is actually in flight — the panel's "syncing now",
   *  and the guard that stops two passes racing each other into conflict
   *  copies neither user caused. */
  private syncing = false
  private syncTimer: NodeJS.Timeout | null = null

  /** True once a device is attached to an account and the sidecar is up. */
  get attached(): boolean {
    return this.account !== null && this.addyd !== null && this.addyd.alive()
  }

  /** Starts the sidecar and hands it the key material.
   *
   *  The KEYS are passed in rather than read here, because reading them means
   *  touching the keychain and this module has no business doing that -- the
   *  addy key store is one builder and one place, and a second reader is a
   *  second thing to forget to exclude from a backup. */
  async attach(
    account: AddyAccount,
    keys: { deviceSignSeed: string; deviceEncKey: string; epochKeys: Record<number, string> },
    log?: (line: string) => void
  ): Promise<void> {
    await this.detach()
    const addyd = await openAddyd('--crypto', log)
    await addyd.send('load', {
      accountId: account.accountId,
      deviceSignSeed: keys.deviceSignSeed,
      deviceEncKey: keys.deviceEncKey,
      epochKeys: keys.epochKeys
    })
    this.addyd = addyd
    this.relay = new RelayClient(
      { baseURL: account.baseURL, token: account.token, insecureTLS: this.insecureTLS },
      addyd
    )
    this.account = account
  }

  /** Stops the sidecar and forgets everything. Called when the vault locks and
   *  at quit: nothing addyd holds is on disk, so stopping it IS the
   *  remediation rather than a step towards one. */
  async detach(): Promise<void> {
    // First, and before the sidecar goes: a pass that starts against a closed
    // sidecar fails every collection, and the failure would be recorded as the
    // account's state rather than as a shutdown.
    this.stopSync()
    this.stopAnswering()
    await this.cancelPairing()
    const rtc = this.rtc
    this.rtc = null
    await rtc?.close()
    const held = this.addyd
    this.addyd = null
    this.relay = null
    this.account = null
    await held?.close()
  }

  /**
   * Mints an account and registers it on a relay.
   *
   * THE ONLY TIME THE RECOVERY PHRASE EXISTS. The sidecar returns it once and
   * has no call that returns it again, so this hands it straight to the caller
   * and keeps no copy -- not in a field, not in a log, not in the keychain.
   * A phrase the app can produce on request is a phrase that leaks the day
   * something can ask.
   *
   * The secrets go to the keychain under the machine-only prefix, so they
   * cannot ride in a backup: the root key comes back from the phrase and the
   * account key from pairing, and the device key deliberately does not come
   * back at all.
   */
  async createAccount(
    baseURL: string,
    invite: string,
    label: string
  ): Promise<{ accountId: string; mnemonic: string }> {
    const relay = baseURL.replace(/\/+$/, '')
    if (!relay.startsWith('https://')) {
      // Refused rather than upgraded. A relay reached over plain HTTP is one
      // whose TLS nothing checked, and silently rewriting what somebody typed
      // is how they end up trusting an address they did not choose.
      throw new AddyError('config-invalid', 'a relay address must be https://')
    }

    await this.detach()
    const addyd = await openAddyd('--crypto')
    this.addyd = addyd

    const minted = await addyd.send<{
      accountId: string
      mnemonic: string
      rootSignPub: string
      epoch1SignPub: string
      secrets: { deviceSignSeed: string; deviceEncKey: string; akSeed: string }
      genesis: string
      escrow: string
      epoch: number
    }>('createAccount', { label })

    // REGISTERED BEFORE ANYTHING IS STORED. A machine that saved keys for an
    // account the relay rejected would look attached and be able to do
    // nothing, and the user would have a recovery phrase for an account that
    // does not exist.
    const resp = await fetch(`${relay}/v1/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: minted.accountId,
        root_sign_pub: minted.rootSignPub,
        genesis: minted.genesis,
        escrow: minted.escrow,
        invite
      })
    }).catch((err: unknown) => {
      throw new AddyError(
        'relay-unreachable',
        `could not reach ${relay}: ${err instanceof Error ? err.message : String(err)}`
      )
    })

    if (!resp.ok) {
      const detail = await resp.text().catch(() => resp.statusText)
      await this.detach()
      throw new AddyError(
        resp.status === 403 ? 'pairing-refused' : 'config-invalid',
        resp.status === 403
          ? 'that invite has been used, has expired, or is not one this relay issued'
          : `the relay refused the account (${resp.status}): ${detail.slice(0, 200)}`
      )
    }

    // Now it is real, so the keys are worth keeping.
    for (const [kind, value] of [
      ['device', minted.secrets.deviceSignSeed],
      ['device-enc', minted.secrets.deviceEncKey],
      ['account', minted.secrets.akSeed]
    ] as const) {
      if (!storeAddySecret(kind === 'account' ? 'account' : 'device', `${minted.accountId}:${kind}`, value)) {
        throw new AddyError(
          'config-invalid',
          'this machine has no usable keychain, so the account keys cannot be stored. Nothing was kept.'
        )
      }
    }

    this.account = {
      baseURL: relay,
      token: '',
      accountId: minted.accountId,
      epoch: minted.epoch,
      rootSignPub: minted.rootSignPub,
      epoch1SignPub: minted.epoch1SignPub
    }
    this.relay = new RelayClient({ baseURL: relay, token: '', insecureTLS: this.insecureTLS }, addyd)

    // LOG IN, which is the step that used to be missing entirely.
    //
    // Every authorised call carries `Bearer ${token}` and the token was left
    // as the empty string here, so the account existed on the relay and this
    // device could not do one authorised thing with it. Registering is not
    // logging in: the first says who the account is, the second proves this
    // device is on it.
    //
    // Not fatal if it fails. The account IS registered and the keys ARE
    // stored by this point, so throwing would leave the user holding a
    // recovery phrase for an account the app then claims not to have. The
    // enrolment is recorded either way and the next resume tries again.
    await this.loginAndRecord().catch(() => undefined)

    return { accountId: minted.accountId, mnemonic: minted.mnemonic }
  }

  /**
   * Trade the device key for a token, and write the enrolment down.
   *
   * THE ENROLMENT HAD NO HOME. `this.account` is a field on a class instance,
   * so creating an account and restarting the app lost it completely: the keys
   * stayed in the keychain, nothing remembered which relay they belonged to,
   * and the app came back looking as though Addy had never been set up.
   *
   * What is written is an ADDRESS, not a secret: the relay, the account id,
   * the epoch and the TLS pin. The keys stay in the keychain under the
   * machine-only prefix where `createAccount` put them. The token is
   * deliberately NOT written — it expires, and a stale one on disk is a thing
   * to invalidate rather than a thing to use.
   */
  private async loginAndRecord(): Promise<void> {
    const account = this.account
    const relay = this.relay
    if (!account || !relay) return
    const { token, spki } = await relay.login()

    /**
     * AND THE PIN IS COMPARED, which is what it was recorded for.
     *
     * `LoginResult.spki` is documented as "kept so a later reconnect can
     * notice it changed". Nothing compared it. Every hit on `spki` in this
     * codebase was a computation or a WRITE — so a login simply overwrote the
     * stored pin with whatever the server presented that morning, and a
     * changed key was adopted in silence. A pin that is only ever written is
     * not a pin, it is a note.
     *
     * Refused rather than warned. The login signature is bound to this value,
     * so a different one means either the operator replaced the relay's
     * certificate or somebody is between this device and it, and a client
     * cannot tell those apart. The remedy for the first is the same either
     * way: forget the enrolment and join again deliberately.
     */
    const known = loadEnrolment()
    if (known?.spki && known.spki !== spki) {
      throw new AddyError(
        'relay-unreachable',
        `the relay at ${account.baseURL} is presenting a different TLS key than the one this device recorded when it joined. Either its certificate was replaced, or something is between you and it. Nothing was sent.`
      )
    }

    this.account = { ...account, token }
    saveEnrolment({
      baseURL: account.baseURL,
      accountId: account.accountId,
      epoch: account.epoch,
      rootSignPub: account.rootSignPub ?? '',
      epoch1SignPub: account.epoch1SignPub ?? '',
      spki,
      insecureTLS: this.insecureTLS,
      ...(known?.pinSeq !== undefined ? { pinSeq: known.pinSeq, pinHead: known.pinHead } : {})
    })
    // A token is exactly what the engine was waiting for. Started here rather
    // than at each call site, because every path that ends with this device
    // authenticated — launch, minting, joining — should end with it syncing,
    // and three call sites is three chances to forget one.
    this.startSync()
  }

  /**
   * Come back to an account this machine already joined.
   *
   * Called once at launch. Without it the only attached session in the
   * product's history was the one inside the process that created the
   * account — `attach()` had ZERO callers, so `attached` was false on every
   * subsequent run and every clipboard call answered "this device is not
   * attached to an addy account yet".
   *
   * Silent when there is nothing to resume, which is every machine that has
   * never set Addy up. A keychain that refuses is not silent: the enrolment
   * is recorded and the keys are not, and the difference between "not set up"
   * and "set up and unreadable" is one a person has to be told.
   */
  async resume(log?: (line: string) => void): Promise<AddyResumeResult> {
    const saved = loadEnrolment()
    if (!saved) return { resumed: false }

    const keys = {
      deviceSignSeed: loadAddySecret('device', `${saved.accountId}:device`),
      deviceEncKey: loadAddySecret('device', `${saved.accountId}:device-enc`),
      akSeed: loadAddySecret('account', `${saved.accountId}:account`)
    }
    /**
     * EVERY EPOCH THIS DEVICE HOLDS, not just the current one.
     *
     * Epoch 1 lives under the unsuffixed name — it was written before there
     * was any other kind — and each rotation this device followed added its
     * own. Loading only the newest would lose the ability to read anything
     * that has not been re-sealed yet, which is a real window: the rotating
     * device writes the new objects before the transition entry, but nothing
     * makes the two atomic.
     *
     * A gap in the middle is not fatal here, because the objects that matter
     * are the current epoch's — it is reported by what fails to open rather
     * than by refusing to start, which would take a working device offline
     * over a key it may never need.
     */
    const epochKeys: Record<number, string> = {}
    if (keys.akSeed) epochKeys[1] = keys.akSeed
    for (let n = 2; n <= saved.epoch; n++) {
      const seed = loadAddySecret('account', `${saved.accountId}:account:${n}`)
      if (seed) epochKeys[n] = seed
    }
    if (!keys.deviceSignSeed || !keys.deviceEncKey || !keys.akSeed) {
      return {
        resumed: false,
        problem:
          'this machine is enrolled on a relay but its keys cannot be read from the keychain.'
      }
    }

    this.insecureTLS = saved.insecureTLS === true
    try {
      await this.attach(
        {
          baseURL: saved.baseURL,
          token: '',
          accountId: saved.accountId,
          epoch: saved.epoch,
          rootSignPub: saved.rootSignPub,
          epoch1SignPub: saved.epoch1SignPub
        },
        {
          deviceSignSeed: keys.deviceSignSeed,
          deviceEncKey: keys.deviceEncKey,
          epochKeys
        },
        log
      )
      await this.loginAndRecord()
      /**
       * AND READ THE ROSTER, WHICH NOTHING DID.
       *
       * `refreshRoster` was called from pairing, rotation, revocation and
       * recovery — every path except the one every launch takes. So a device
       * that had been removed from the account resumed, logged in, started
       * syncing and never once asked whether it was still a member. The wipe
       * it was supposed to trigger could not fire because the question was
       * never put.
       *
       * Not fatal if it fails: a laptop on a train is still attached and the
       * panel should say which relay it belongs to. The next sync pass asks
       * again.
       */
      await this.refreshRoster().catch(() => undefined)
      return { resumed: true, accountId: saved.accountId, baseURL: saved.baseURL }
    } catch (err) {
      // Attached-but-not-logged-in is a real and useful state: the sidecar is
      // up and the keys are loaded, so the panel can say which relay this
      // machine belongs to even while that relay is unreachable.
      return {
        resumed: this.attached,
        accountId: saved.accountId,
        baseURL: saved.baseURL,
        problem: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /**
   * A pairing, driven from here.
   *
   * ONE AT A TIME, deliberately. Two concurrent pairings on one device means
   * two codes on screen and a user who can compare the wrong emoji against the
   * wrong device -- which is the single failure the emoji exist to prevent.
   */
  private pairing: { id: string; abort: AbortController } | null = null

  async beginPairing(baseURL: string): Promise<{ code: string; pairingId: string }> {
    await this.cancelPairing()
    const addyd = this.addyd ?? (await openAddyd('--crypto'))
    this.addyd ??= addyd

    const abort = new AbortController()
    const { handle, confirmed } = await beginPairing({ addyd, baseURL }, abort.signal)
    this.pairing = { id: handle.pairingId, abort }

    // The confirmation resolves later, when the other device answers. Held
    // rather than awaited so the caller can show the code NOW -- the user has
    // to read it out loud while this is still waiting.
    this.pendingConfirmation = confirmed
    return handle
  }

  private pendingConfirmation: Promise<PairingConfirmation> | null = null

  /** Resolves when the other device has confirmed, with the emoji to compare. */
  async awaitPairing(): Promise<PairingConfirmation> {
    if (!this.pendingConfirmation) {
      throw new AddyError('config-invalid', 'no pairing is in progress')
    }
    return this.pendingConfirmation
  }

  async joinPairing(baseURL: string, code: string, pairingId: string): Promise<PairingConfirmation> {
    await this.cancelPairing()
    const addyd = this.addyd ?? (await openAddyd('--crypto'))
    this.addyd ??= addyd
    const abort = new AbortController()
    this.pairing = { id: pairingId, abort }
    this.joinContext = { baseURL, pairingId, abort }
    return joinPairing({ addyd, baseURL }, code, pairingId, abort.signal)
  }

  private joinContext: { baseURL: string; pairingId: string; abort: AbortController } | null = null

  /**
   * THE INITIATOR'S HALF OF "THEY MATCH", and it did not exist.
   *
   * Pressing that button called `cancelPairing()` and toasted "Device added".
   * Nothing was added: no account key crossed, no roster entry was written,
   * and the account went on containing exactly one device. The emoji matched
   * and the app said something untrue about the user's data.
   *
   * Three things have to happen, in this order, and the order is the point:
   *
   *  1. Seal the account key to the peer, BOUND TO THE SPAKE2 SECRET. That
   *     binding is what stops the relay — which carries every frame —
   *     substituting a handoff of its own; it never learns the secret.
   *  2. Write the roster entry that says the device is on the account, signed
   *     with the epoch key and chained to the head THIS device verified.
   *  3. Only then forget the pairing.
   *
   * If the roster append fails the handoff has already gone, which is the
   * safe direction: the joiner holds a key to an account that does not list
   * it, so it can read nothing and is refused everywhere until the entry
   * lands. The reverse — listed but keyless — would be a device the account
   * vouches for that cannot prove anything.
   */
  async completePairing(confirmation: PairingConfirmation): Promise<{ devices: number }> {
    const addyd = this.addyd
    const relay = this.relay
    const account = this.account
    const pairing = this.pairing
    if (!addyd || !relay || !account || !pairing) {
      throw new AddyError('config-invalid', 'no pairing is in progress on an attached account')
    }
    const peerPubEnc = confirmation.peer.pubEnc
    const peerPubSign = confirmation.self?.pubSign ?? confirmation.peer.pubSign
    if (!peerPubEnc) {
      throw new AddyError('pairing-refused', 'the other device sent no encryption key')
    }

    // The head THIS device verified, never the relay's word for it.
    const before = await this.refreshRoster()
    // THE CURRENT EPOCH'S KEY, not epoch 1's. After a rotation the unsuffixed
    // name still holds the original, and handing that to a joining device
    // would pair it into an epoch the account has moved off — it would see
    // the roster and be unable to read a single object.
    const akSeed =
      account.epoch > 1
        ? loadAddySecret('account', `${account.accountId}:account:${account.epoch}`)
        : loadAddySecret('account', `${account.accountId}:account`)
    if (!akSeed) {
      throw new AddyError('config-invalid', 'this device cannot read its own account key')
    }

    // The counter is chosen HERE and travels beside the blob, because the
    // joiner has to pass it back to open one: it is bound into the sealed
    // handoff, so a relay that alters it in the frame produces a refusal
    // rather than a device joined to something it did not agree to. Same for
    // the epoch and the account id — all three are authenticated inside, and
    // none of them can be derived by a device that has never seen the account.
    const counter = (before.headSeq ?? 0) + 1
    const sealed = await addyd.send<{ handoff: string }>('pairHandoff', {
      pairingId: pairing.id,
      epoch: account.epoch,
      akSeed,
      headEntry: before.headEntry ?? '',
      peerPubEnc,
      counter
    })
    await publish({ addyd, baseURL: relay.baseURL }, pairing.id, 'initiator', {
      handoff: sealed.handoff,
      epoch: account.epoch,
      counter,
      accountId: account.accountId
    })

    const entry = await addyd.send<{ seq: number; entry: string }>('addDevice', {
      headEntry: before.headEntry ?? '',
      headSeq: before.headSeq ?? 0,
      epoch: account.epoch,
      pubSign: peerPubSign,
      pubEnc: peerPubEnc,
      // The pseudonym the joining device chose for itself, sealed into the
      // entry so only devices holding this epoch's profile key can read it.
      label: confirmation.self?.label ?? 'a paired device'
    })
    await relay.appendRoster(entry.seq, entry.entry)

    await this.cancelPairing()
    const after = await this.refreshRoster()
    // Push now rather than at the next tick. The device that just joined logs
    // in and syncs within seconds, and if this account's collections have
    // never been uploaded it finds an empty relay and adopts nothing — so the
    // promise the pairing screen just made would take up to five minutes to
    // come true for no reason.
    void this.syncNow().catch(() => undefined)
    return { devices: after.devices.length }
  }

  /**
   * THE JOINER'S HALF, equally absent.
   *
   * `joinPairing` compared emoji and stopped. It never stored a key, never
   * set an account, never attached — so a device that had just proved it knew
   * the code went back to knowing nothing at all.
   *
   * The secrets are written to the keychain BEFORE the enrolment is recorded,
   * for the reason `createAccount` gives in reverse: a note pointing at an
   * account whose keys were never stored is a device that looks enrolled and
   * can do nothing.
   */
  async finishJoin(): Promise<{ accountId: string }> {
    const addyd = this.addyd
    const ctx = this.joinContext
    if (!addyd || !ctx) throw new AddyError('config-invalid', 'no join is in progress')

    const sealed = await receive<{ handoff: string; counter: number; epoch: number; accountId: string }>(
      { addyd, baseURL: ctx.baseURL },
      ctx.pairingId,
      'joiner',
      ctx.abort.signal
    )
    const accepted = await addyd.send<{
      accountId: string
      epoch: number
      rootSignPub: string
      epoch1SignPub: string
      headEntry: string
      devicePubSign: string
      devicePubEnc: string
      secrets: { deviceSignSeed: string; deviceEncKey: string; akSeed: string }
    }>('pairAccept', {
      pairingId: ctx.pairingId,
      handoff: sealed.handoff,
      epoch: sealed.epoch,
      counter: sealed.counter,
      // From the handoff frame, and required: the account id is bound inside
      // the sealed blob and it cannot be opened without it.
      accountId: sealed.accountId
    })

    for (const [kind, scope, value] of [
      ['device', 'device', accepted.secrets.deviceSignSeed],
      ['device', 'device-enc', accepted.secrets.deviceEncKey],
      ['account', 'account', accepted.secrets.akSeed]
    ] as const) {
      if (!storeAddySecret(kind, `${accepted.accountId}:${scope}`, value)) {
        throw new AddyError(
          'config-invalid',
          'this machine has no usable keychain, so the account keys cannot be stored. Nothing was kept.'
        )
      }
    }

    this.account = {
      baseURL: ctx.baseURL,
      token: '',
      accountId: accepted.accountId,
      epoch: accepted.epoch,
      rootSignPub: accepted.rootSignPub,
      epoch1SignPub: accepted.epoch1SignPub
    }
    this.relay = new RelayClient(
      { baseURL: ctx.baseURL, token: '', insecureTLS: this.insecureTLS },
      addyd
    )
    await this.loginAndRecord()
    await this.refreshRoster().catch(() => undefined)
    this.joinContext = null
    return { accountId: accepted.accountId }
  }

  /** Ends whatever is in progress and forgets the shared secret.
   *
   *  Called when the user says the emoji do not match, when they close the
   *  panel, and before starting a second pairing. A session left behind is one
   *  an attacker can still send frames to. */
  async cancelPairing(): Promise<void> {
    const held = this.pairing
    this.pairing = null
    this.pendingConfirmation = null
    if (!held) return
    held.abort.abort()
    if (this.addyd) await forgetPairing({ addyd: this.addyd, baseURL: '' }, held.id)
  }

  /**
   * Send the clipboard to every other device, or take what was sent here.
   *
   * Both refuse honestly when this device is not attached, because the
   * keystroke that reaches them is a global shortcut the user can press at any
   * time -- including before they have set addy up at all.
   */
  async sendClipboard(): Promise<{ sent: number; skipped?: string }> {
    if (!this.attached) {
      return { sent: 0, skipped: 'This device is not attached to an addy account yet.' }
    }
    return sendClipboard(this.clipboardDeps())
  }

  async receiveClipboard(): Promise<{ applied: boolean; from?: string; reason?: string }> {
    if (!this.attached) {
      return { applied: false, reason: 'This device is not attached to an addy account yet.' }
    }
    return receiveClipboard(this.clipboardDeps())
  }

  /** Every other device on the roster. Empty until a roster has been verified,
   *  which is the honest answer: sending to a device list nobody checked is
   *  sending to whatever the relay said. */
  private roster: string[] = []

  setRoster(devices: string[]): void {
    this.roster = devices
  }

  /**
   * Read the roster, verify it, and remember who else is on the account.
   *
   * `setRoster` had ZERO callers, so `this.roster` was permanently empty and
   * `sendClipboard` iterated nothing — the clipboard reported success having
   * sent to no one. This is the call that fills it.
   *
   * Verification happens in the SIDECAR, under the account keys, and what
   * comes back is the LIVE set: the verifier applies revocations as it walks
   * the chain, so a revoked device is absent rather than flagged. That makes
   * "am I still on this roster" a stronger question than any field could be,
   * because there is nothing a forged entry could set to claim otherwise.
   *
   * This device is excluded from the peer list. Sending a clipboard to
   * yourself is not continuity, and the echo suppression downstream should
   * never have to think about it.
   */
  async refreshRoster(): Promise<AddyRoster> {
    const relay = this.relay
    const addyd = this.addyd
    const account = this.account
    if (!relay || !addyd || !account) {
      return { devices: [], stillListed: false, problem: 'not attached' }
    }
    const saved = loadEnrolment()
    const pin =
      saved?.pinSeq !== undefined && saved.pinHead
        ? { seq: saved.pinSeq, head: saved.pinHead }
        : null

    const bytes = await relay.roster()
    // `selfListed`, not `stillListed`: the sidecar's name for it. Getting this
    // wrong reads as `undefined`, which is falsy — and a falsy answer here is
    // "this device has been revoked", which is the one conclusion that must
    // never be reached by a typo.
    const verified = await addyd.send<{
      devices: {
        pubSign: string
        pubEnc: string
        epoch: number
        mnemonicAdded: boolean
        label?: string
      }[]
      selfListed: boolean
      head: string
      headEntry: string
      headSeq: number
      /** The epoch the chain ENDS in. A rotation moves it, which is how a
       *  device that was not consulted finds out one happened. */
      epoch: number
    }>('verifyRoster', {
      chain: bytes,
      rootSignPub: account.rootSignPub ?? '',
      epoch1Sign: account.epoch1SignPub ?? '',
      // THE PIN, which nothing supplied. `VerifyChain` raises "rewound" and
      // "forked" only when it is given one, so without this a relay could
      // withhold the newest entries and every device verified the shorter
      // chain without complaint — including a chain missing the entry that
      // revoked a device, which puts that device back in everyone's peer list.
      ...(pin ? { havePin: true, pinnedSeq: pin.seq, pinnedHead: pin.head } : {})
    })

    // A ROTATION ANNOUNCES ITSELF HERE. The chain's epoch moved and this
    // device has not; everything it reads from now on is sealed under a key it
    // does not hold unless it follows. Walked one step at a time, because each
    // handoff is bound to the key of the epoch before it.
    let chainEpoch = verified.epoch
    while (chainEpoch > (this.account?.epoch ?? 0)) {
      if (!(await this.followRotation(chainEpoch).catch(() => false))) break
    }
    chainEpoch = verified.epoch

    const me = await addyd.send<{ devicePub: string }>('whoami', {})
    this.roster = verified.devices.map((d) => d.pubSign).filter((id) => id !== me.devicePub)

    /**
     * THE REVOCATION SIGNAL, ACTED ON.
     *
     * `revoke.ts` implements the wipe, tests it over 180 lines, and had ZERO
     * production callers — while this very field, the one it waits on, was
     * computed here and read nowhere. So a stolen laptop was removed from the
     * roster, told nothing, and went on syncing: full vault, known hosts,
     * servers and env still on disk, still current.
     *
     * Checked here because this is the only place that verifies a chain, and
     * `selfListed` is a cryptographic answer rather than a flag — the verifier
     * applies revocations as it walks, so there is no field a forged entry
     * could set to claim otherwise.
     *
     * NOT awaited: the wipe closes live sessions first and that can take a
     * moment, and nothing good comes of holding a roster read open for it.
     * The tombstone is written before the first file goes, so a crash midway
     * still leaves the device blocked on its next launch.
     */
    if (!verified.selfListed && this.account) {
      this.beginRevocationWipe(me.devicePub)
    }

    const roster: AddyRoster = {
      devices: verified.devices,
      stillListed: verified.selfListed,
      head: verified.head,
      headEntry: verified.headEntry,
      headSeq: verified.headSeq,
      self: me.devicePub
    }
    this.lastRoster = roster

    /**
     * MOVE THE PIN FORWARD, and only forward.
     *
     * Recorded after a verification that passed, so the entry pinned is one
     * this device checked rather than one it was handed. Never moved back: a
     * shorter chain has already been refused by the verifier above, and
     * writing a lower sequence here would undo the refusal for every launch
     * afterwards.
     */
    if (saved && verified.headSeq > (saved.pinSeq ?? -1)) {
      saveEnrolment({ ...saved, pinSeq: verified.headSeq, pinHead: verified.head })
    }

    this.announce()
    return roster
  }

  /**
   * The `--rtc` sidecar, started lazily.
   *
   * A SECOND PROCESS, and never the same one: `--crypto` holds the account key
   * and does not link a WebRTC stack, `--rtc` parses SDP, STUN, DTLS and SRTP
   * off the open internet and never sees a key. Lazily, because most sessions
   * never send a clipboard and a WebRTC stack is not free to start.
   */
  private rtc: AddySidecar | null = null

  private async ensureRtc(): Promise<AddySidecar | null> {
    if (this.rtc?.alive()) return this.rtc
    try {
      this.rtc = await openAddyd('--rtc')
      return this.rtc
    } catch {
      // No `--rtc` is a degraded mode, not a failure: everything falls back to
      // the mailbox, which works.
      this.rtc = null
      return null
    }
  }

  /**
   * ICE servers, as the relay describes them. Asked per attempt.
   *
   * A device behind a symmetric NAT needs relay credentials to have any
   * chance; one on the same LAN does not need them and pays nothing for
   * asking. No credentials is a degraded mode rather than a failure — host and
   * server-reflexive candidates only — so this never throws.
   */
  /**
   * What the signalling layer needs, in one place.
   *
   * `crypto` is here because a signal is SIGNED now, and only `--crypto` holds
   * a device key — the `--rtc` process still never sees one. `members` is here
   * because a signature means nothing unless the key it verifies against is on
   * the roster this device checked: an attacker who can publish a frame can
   * also sign one with a key of their own.
   */
  private p2pDeps(rtc: AddySidecar, iceServers: unknown[], selfDeviceHex: string): P2PDeps {
    return {
      rtc,
      relay: this.relay!,
      iceServers,
      selfDeviceHex,
      crypto: this.addyd!,
      epoch: this.account!.epoch,
      rosterHead: this.lastRoster?.head ?? '',
      members: () => this.roster
    }
  }

  private async iceServers(): Promise<unknown[]> {
    try {
      const resp = await this.relay!.request('GET', '/v1/turn')
      if (!resp.ok) return []
      const turn = (await resp.json()) as {
        mode: string
        url?: string
        credential?: { username: string; password: string; url: string }
      }
      if (turn.mode === 'embedded' && turn.credential) {
        return [
          {
            urls: [turn.credential.url],
            username: turn.credential.username,
            credential: turn.credential.password
          }
        ]
      }
      if (turn.mode === 'external' && turn.url) return [{ urls: [turn.url] }]
      return []
    } catch {
      return []
    }
  }

  /** Running while this device is listening for direct dials. */
  private answering = false
  private answerStop: AbortController | null = null

  /**
   * LISTEN FOR A DIRECT DIAL, which nothing did.
   *
   * `answerPeer` was written and called from nowhere, so no device ever
   * answered an offer — which means `tryDirect` could never succeed in either
   * direction and every clipboard, on every network, silently took the
   * mailbox. The direct path was not "rarely available"; it was unreachable,
   * and the fallback hid that completely.
   *
   * It runs only while the clipboard shortcuts are held, and that is the
   * decision rather than a simplification: this is a long poll against the
   * relay held open for the life of the session, and holding a connection
   * open for a feature the user has not switched on is a cost with no benefit
   * attached to it.
   */
  async startAnswering(): Promise<void> {
    if (this.answering || !this.attached) return
    const rtc = await this.ensureRtc()
    if (!rtc) return
    this.answering = true
    const stop = new AbortController()
    this.answerStop = stop

    void (async () => {
      while (!stop.signal.aborted && this.attached) {
        try {
          const deps = this.p2pDeps(
            rtc,
            await this.iceServers(),
            (await this.addyd!.send<{ devicePub: string }>('whoami')).devicePub
          )
          const session = await answerPeer(deps)
          if (!session) continue
          try {
            // One message per connection, matching what the dialling side
            // sends: it closes as soon as the payload is away.
            const got = await rtc.send<{ payload: string | null }>('rtcReceive', {
              sessionId: session,
              waitMs: 10_000
            })
            if (got.payload) await applySealedClipboard(this.clipboardDeps(), got.payload)
          } finally {
            await closeSession(deps, session)
          }
        } catch {
          // A failed answer is the ordinary case — two symmetric NATs, a peer
          // that gave up, a relay blip. Waiting before the next attempt is
          // what stops a broken relay becoming a hot loop.
          await new Promise((r) => setTimeout(r, 2_000))
        }
      }
      this.answering = false
    })()
  }

  stopAnswering(): void {
    this.answerStop?.abort()
    this.answerStop = null
  }

  private clipboardDeps(): ClipboardDeps {
    const base = this.deps()
    return {
      ...base,
      peers: () => this.roster,
      tryDirect: async (peerHex, sealed) => {
        const rtc = await this.ensureRtc()
        if (!rtc || !this.account || !this.addyd) return false

        // What the relay says about relaying, asked once per attempt. One
        // implementation, shared with the answering side — two copies of "how
        // do I reach a relay" is two places to get it differently.
        const iceServers = await this.iceServers()

        const { devicePub } = await this.addyd.send<{ devicePub: string }>('whoami')
        const deps = this.p2pDeps(rtc, iceServers, devicePub)

        let dialled: string | null = null
        try {
          dialled = await dialPeer(deps, peerHex)
          await rtc.send('rtcSend', { sessionId: dialled, payload: sealed })
          return true
        } catch {
          return false
        } finally {
          // Closed on every path, including success: a clipboard send is one
          // message and holding the connection open afterwards would hold
          // goroutines, a UDP socket and an ICE agent in the sidecar for a
          // conversation that is over.
          if (dialled) await closeSession(deps, dialled)
        }
      }
    }
  }

  private deps(): ConflictDeps {
    if (!this.addyd || !this.relay || !this.account) {
      throw new AddyError('not-paired', 'this device is not attached to an addy account')
    }
    return { addyd: this.addyd, relay: this.relay, epoch: () => this.account!.epoch }
  }

  /**
   * What the Sync & devices panel renders, and nothing it has to guess at.
   *
   * THE RULE THIS OBEYS is the one `addyStatus.ts` was written around: a
   * number nobody measured must not render as though it had been. So the
   * roster is OMITTED rather than sent as `[]` until this device has actually
   * verified one, `lastSeen` and `addedAt` are `null` because the relay
   * reports neither, and `sync.running` is `false` while there is no engine to
   * run -- which is what stops "last sync: never" reading as a fleet that has
   * fallen behind rather than a feature that has not started.
   *
   * Cheap on purpose: it reads what is already in memory plus the enrolment
   * note on disk. The renderer calls it on mount in every window, including
   * for people who have never opened addy.
   */
  async status(): Promise<AddyStatusSnapshot> {
    const enrolment = this.account ? null : loadEnrolment()
    const relayURL = this.account?.baseURL ?? enrolment?.baseURL
    const accountId = this.account?.accountId ?? enrolment?.accountId
    const roster = this.lastRoster

    return {
      // A device is enrolled once it has an account, whether or not the
      // sidecar is up and whether or not the relay is reachable. Anything
      // narrower would report a laptop with no network as never having set
      // addy up, and offer it the "create an account" flow it must not take.
      enrolled: !!accountId,
      ...(relayURL ? { relayURL } : {}),
      ...(accountId ? { accountId } : {}),
      ...(roster
        ? {
            devices: roster.devices.map((d) => ({
              id: d.pubSign,
              // The pseudonym from the roster, opened in the sidecar under the
              // epoch's profile key. When this device does not hold that epoch
              // the sidecar sends none, and the first bytes of the key are at
              // least true -- unlike a made-up "Device 2".
              label: d.label ?? `device ${d.pubSign.slice(0, 8)}`,
              self: d.pubSign === roster.self,
              // Neither is reported by the relay. `null`, so the panel says
              // "not reported" instead of drawing 1970 or "just now".
              lastSeen: null,
              addedAt: null
            }))
          }
        : {}),
      sync: {
        // The timer is running, which is what "there is an engine" means. Not
        // `this.syncing` — that is true for the second or two a pass takes,
        // and a flag the panel reads every other figure through must not blink
        // off between passes.
        running: this.syncTimer !== null,
        // A token means this device authenticated to the relay, which is the
        // strongest connection claim that can be made without a round trip.
        connected: !!this.relay?.token,
        // Null until a pass has actually completed in this process. NOT
        // `Date.now()`, and not the time the app started.
        lastSyncAt: this.lastSync?.at ?? null,
        ...(this.lastSync?.error
          ? {
              error: {
                message: `${this.lastSync.error.collection}: ${this.lastSync.error.message}`,
                at: this.lastSync.at,
                ...(this.lastSync.error.code ? { code: this.lastSync.error.code } : {})
              }
            }
          : {}),
        conflicts: (await this.conflicts()).length,
        // Omitted rather than sent flat: a flat line is a claim that nothing
        // synced, and before the first pass nothing is known either way.
        ...(this.carried.length > 0 ? { history: this.carried } : {})
      }
    }
  }

  // -------------------------------------------------------------------------
  // The engine
  // -------------------------------------------------------------------------

  /**
   * How often a pass runs on its own.
   *
   * Five minutes, and it is a floor rather than a target: a pass over sixteen
   * collections that have not changed is sixteen conditional GETs, which is
   * cheap but not free, and nothing in this product is worth a relay round
   * trip every thirty seconds. The cases that need to be prompt — a device
   * just paired, the app just started, the user pressed Sync — all call
   * `syncNow()` directly rather than waiting for this.
   */
  private static readonly SYNC_EVERY_MS = 5 * 60_000

  /** Told which collections changed on disk. Registered once, by main. */
  onApplied(cb: (collections: SyncedCollection[]) => void): void {
    this.appliedCb = cb
  }

  /**
   * One pass, now.
   *
   * Refuses to start a second while one is running rather than queueing it:
   * two passes over the same account race each other into conflict copies that
   * neither device's user caused, and the second pass would have nothing new
   * to say anyway.
   */
  async syncNow(): Promise<SyncResult | null> {
    if (this.syncing) return null
    if (!this.attached || !this.relay?.token) return null
    this.syncing = true
    this.announce()
    try {
      const result = await syncOnce({
        addyd: this.addyd!,
        relay: this.relay,
        epoch: () => this.account!.epoch,
        applied: (collections) => this.appliedCb?.(collections),
        accountId: () => this.account!.accountId
      })
      this.lastSync = result
      this.carried = [...this.carried, result.carried].slice(-12)
      // Files ride the same pass. They are not collections and never go
      // through the engine above — a transfer is a one-off with a recipient,
      // not a document two devices both own — but "has anything arrived for
      // me" is the same question at the same moment, and giving it its own
      // timer would be a second schedule to reason about.
      await this.collectFiles().catch(() => undefined)
      sweepQuarantine()
      // AND THE ROSTER, every pass. A machine that is left running for a week
      // would otherwise never ask again after launch — and "the laptop is
      // open on a desk somewhere" is the case removing a device is for.
      await this.refreshRoster().catch(() => undefined)
      return result
    } finally {
      this.syncing = false
      this.announce()
    }
  }

  /**
   * Start the timer, and take one pass immediately.
   *
   * The immediate pass is the point. A device that has been off for a week
   * should not show a week-old estate for five minutes because a timer has to
   * tick first — and it is the moment a newly paired device gets everything,
   * which is the whole promise the pairing screen just made.
   */
  startSync(): void {
    if (this.syncTimer) return
    this.syncTimer = setInterval(() => {
      void this.syncNow().catch(() => undefined)
    }, AddySession.SYNC_EVERY_MS)
    // Unref'd: a sync timer must never be the reason the process stays alive
    // through a quit.
    this.syncTimer.unref?.()
    void this.syncNow().catch(() => undefined)
  }

  stopSync(): void {
    if (!this.syncTimer) return
    clearInterval(this.syncTimer)
    this.syncTimer = null
  }

  /**
   * Forget every agreement and take everything again from the relay.
   *
   * The escape hatch the design asks for, and it is not a destructive one:
   * with no state, every collection where the two copies differ becomes a
   * conflict the user is shown, rather than a silent overwrite in either
   * direction. That is why it is safe to offer at all.
   */
  async resyncEverything(): Promise<SyncResult | null> {
    forgetSyncState()
    // WAIT FOR ANY PASS ALREADY RUNNING, rather than returning null.
    //
    // `syncNow` refuses to start a second pass, so clicking this while one was
    // in flight cleared the file, had the running pass decline to write over
    // it, and then ran nothing — the escape hatch the whole design leans on
    // was a no-op, and the panel had a `null` to render. The user's second
    // click, a second after their first, hit it every time.
    for (let waited = 0; this.syncing && waited < 30_000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250))
    }
    return this.syncNow()
  }

  /** True while a wipe is running, so a second roster read does not start
   *  another one on top of it. */
  private wiping = false
  private revokedCb: ((t: unknown) => void) | null = null

  /** Told when this device has been removed and wiped, so the window can put
   *  the blocking screen up without waiting for a relaunch. */
  onRevoked(cb: (t: unknown) => void): void {
    this.revokedCb = cb
  }

  /**
   * This device has been removed from the account. Take it apart.
   *
   * Everything OpsMaxx stores here goes: the vault, the credentials, the
   * known hosts, the server list. The tombstone is written FIRST and survives
   * the wipe, which is what makes the blocking screen appear on the next
   * launch even if the machine is pulled mid-delete.
   *
   * What this is NOT is a remote kill switch, and `revoke.ts` says so at
   * length: it needs this device to reach the relay and read the chain. A
   * machine kept offline never hears. That is exactly why removing a device
   * and changing the account key are two separate operations.
   */
  private beginRevocationWipe(deviceId: string): void {
    if (this.wiping) return
    const account = this.account
    if (!account) return
    this.wiping = true

    void runRevocationWipe(
      { accountId: account.accountId, deviceId, at: new Date().toISOString() },
      {
        closeSessions: async () => {
          // Before a single file goes. Deleting the vault out from under a
          // live SSH session does not stop the session — it makes it carry on
          // against files that are gone.
          this.stopSync()
          this.stopAnswering()
          await this.detach().catch(() => undefined)
        },
        wipe: () => deleteAllData()
      }
    )
      .then(
        (tombstone) => {
          this.revokedCb?.(tombstone)
          this.announce()
        },
        () => undefined
      )
      .finally(() => {
        this.wiping = false
      })
  }

  /** Pushed to the renderer whenever any of the above changes, so the panel
   *  does not poll a sidecar on a timer to learn that nothing happened. */
  watch(cb: (s: AddyStatusSnapshot) => void): () => void {
    this.watchers.add(cb)
    return () => this.watchers.delete(cb)
  }

  private announce(): void {
    if (this.watchers.size === 0) return
    void this.status().then(
      (s) => {
        for (const cb of this.watchers) cb(s)
      },
      // A status read that fails must not take down whatever just succeeded.
      // The panel keeps the last good answer and its own Refresh still works.
      () => undefined
    )
  }

  /**
   * Follow a rotation somebody else performed.
   *
   * WITHOUT THIS A RE-KEY LOCKS EVERY OTHER DEVICE OUT. The rotating machine
   * re-seals every collection under the new epoch and publishes a handoff per
   * surviving device; a device that never reads its handoff holds only the old
   * key, and from that moment every object it fetches is sealed under one it
   * does not have. The symptom is an AEAD failure on every collection at once,
   * on a machine that did nothing wrong — and the user's reasonable conclusion
   * is that sync is broken.
   *
   * Called from `refreshRoster`, because the roster is where a rotation
   * announces itself: the transition entry moves the chain's epoch, and this
   * device notices it has fallen behind at the same moment it learns anything
   * else about the account.
   *
   * Returns false when there is nothing to do, or when the handoff is not
   * there yet — which is an ordinary race rather than a failure: the rotating
   * device writes the handoffs before the transition, but the relay is
   * eventually consistent and a read can land between them.
   */
  private async followRotation(toEpoch: number): Promise<boolean> {
    const addyd = this.addyd
    const relay = this.relay
    const account = this.account
    if (!addyd || !relay || !account || toEpoch <= account.epoch) return false

    // ONE STEP AT A TIME. The handoff for epoch n+1 is bound to the key for
    // epoch n, so a device two behind has to walk, and a device that missed
    // one entirely cannot — it is told so rather than handed something that
    // looks like a key.
    const next = account.epoch + 1

    // THE WHOLE CHAIN, ONCE. It used to fetch a single transition entry in a
    // second, independent request and hand that to the sidecar unverified —
    // so the flag saying "this was a revocation", which is what refuses a
    // chained handoff, was the relay's word rather than the account's. The
    // sidecar now verifies the chain and reads the transition out of it.
    const chain = await relay.roster()

    const self = await addyd.send<{ fingerprint: string }>('fingerprintSelf')
    // Mine first, the chained one second. A revocation publishes only the
    // first, and the sidecar refuses the second for one anyway — so the order
    // is about what is likeliest to be there, not about what is allowed.
    const mine = await relay.getObject(`handoff:${self.fingerprint}`, next)
    const chained = mine ? null : await relay.getObject('handoff', next)
    const object = mine ?? chained
    if (!object) return false

    const adopted = await addyd.send<{
      epoch: number
      epochSignPub: string
      secrets: { akSeed: string }
    }>('adoptEpoch', {
      epoch: next,
      counter: 1,
      handoff: object.body.toString('base64'),
      chain,
      // Pinned at enrolment, never from a relay response. The genesis entry is
      // signed by this key, so without it no chain verifies at all.
      epoch1Sign: account.epoch1SignPub ?? '',
      chained: !mine
    })

    // STORED BEFORE THE ACCOUNT MOVES. A device that adopted an epoch and
    // forgot it on quit is locked out on its next launch for exactly the
    // reason this whole method exists, and the keychain is the only thing
    // here with durable storage.
    if (!storeAddySecret('account', `${account.accountId}:account:${next}`, adopted.secrets.akSeed)) {
      throw new AddyError(
        'config-invalid',
        'this machine has no usable keychain, so the new account key cannot be stored.'
      )
    }

    this.account = { ...account, epoch: adopted.epoch }
    saveEnrolment({
      baseURL: account.baseURL,
      accountId: account.accountId,
      epoch: adopted.epoch,
      rootSignPub: account.rootSignPub ?? '',
      epoch1SignPub: account.epoch1SignPub ?? '',
      spki: loadEnrolment()?.spki ?? '',
      insecureTLS: this.insecureTLS
    })
    // Every pinned ETag and counter was against the old epoch's objects. The
    // next pass reconciles from scratch, which is what should happen.
    forgetSyncState()
    return true
  }

  /**
   * Move the account to a new epoch key.
   *
   * TWO KINDS, AND THEY ARE NOT DEGREES OF THE SAME THING.
   *
   *  - `hygiene` is routine. The current epoch key signs it, and it publishes
   *    a chained handoff so a device that was asleep catches up through the
   *    chain without re-pairing.
   *  - `revocation` is a response to compromise, and it needs the recovery
   *    phrase. The compromised epoch key must not authorise the escape from
   *    itself — a device about to be removed is holding it — so the root key
   *    signs, nothing chains, and the new key is sealed individually to each
   *    surviving device.
   *
   * THE ORDER OF THE WRITES IS NORMATIVE and it is owned here, because only
   * this side can talk to the relay: re-seal every collection under n+1 first,
   * write the escrow, publish the handoffs, append the transition entry, and
   * only then let the old objects go. Any other order leaves a window in which
   * a device reading the chain finds an epoch whose objects do not exist yet.
   *
   * A crash between any two steps leaves the account usable at epoch n, which
   * is the only acceptable failure mode — and is why the transition entry is
   * last. Until it is appended, nothing has moved.
   */
  async rotateEpoch(
    kind: 'hygiene' | 'revocation',
    mnemonic?: string
  ): Promise<{ epoch: number; resealed: number }> {
    const addyd = this.addyd
    const relay = this.relay
    const account = this.account
    if (!addyd || !relay || !account) {
      throw new AddyError('not-paired', 'this device is not attached to an addy account')
    }

    const chain = await relay.roster()
    const prepared = await addyd.send<{
      epoch: number
      epochSignPub: string
      handoffs: Record<string, string>
      chained?: string
      escrow?: string
      secrets: { akSeed: string }
      seq: number
      entry: string
    }>('rotateEpoch', {
      kind,
      chain,
      rootSignPub: account.rootSignPub ?? '',
      epoch1Sign: account.epoch1SignPub ?? '',
      ...(mnemonic ? { mnemonic } : {})
    })

    // 0. THE KEY ITSELF, BEFORE ANY OF THE WRITES.
    //
    // The keychain is the only durable store on this machine, and everything
    // below re-seals the account's data under a key the sidecar is holding in
    // memory. A crash after the first PUT and before this would leave the
    // relay carrying objects this device cannot read on its next launch —
    // the one failure mode worse than not rotating at all.
    if (
      !storeAddySecret(
        'account',
        `${account.accountId}:account:${prepared.epoch}`,
        prepared.secrets.akSeed
      )
    ) {
      throw new AddyError(
        'config-invalid',
        'this machine has no usable keychain, so the new account key cannot be stored. Nothing was rotated.'
      )
    }

    // 1. EVERY COLLECTION, UNDER THE NEW EPOCH, BEFORE ANYTHING ELSE.
    //
    // Read under the old key and written under the new one, object by object.
    // A collection missed here is one that becomes unreadable the moment the
    // transition lands, which is the permanent data loss this ordering exists
    // to prevent — so a failure stops the whole rotation rather than carrying
    // on with a partial one.
    let resealed = 0
    for (const name of SYNCED_COLLECTIONS) {
      const existing = await relay.getObject(name, account.epoch)
      if (!existing) continue
      const opened = await addyd.send<{ payload: string; counter: number }>('open', {
        collection: name,
        epoch: account.epoch,
        sealed: existing.body.toString('base64'),
        knownSchema: 1,
        // THE FLOOR, at the worst possible moment to be without one. This is
        // a re-key — what a person does AFTER a compromise — and every object
        // opened here is re-sealed under the new epoch and becomes what the
        // whole account reads. Opened at 0, a relay-served stale copy is
        // promoted to canonical account-wide, and the rotation's own
        // `forgetSyncState()` then zeroes every peer's floor so none of them
        // can refuse it either.
        seenCounter: counterFloor(name)
      })
      const sealed = await addyd.send<{ sealed: string }>('seal', {
        collection: name,
        epoch: prepared.epoch,
        schema: 1,
        writerVersion: `opsmaxx/${app.getVersion?.() ?? '0'}`,
        counter: opened.counter,
        payload: opened.payload
      })
      await relay.putObject(
        name,
        prepared.epoch,
        opened.counter,
        Buffer.from(sealed.sealed, 'base64')
      )
      resealed++
    }

    // 2. The escrow, so the recovery phrase still opens the CURRENT key. A
    //    re-key that skipped this would leave the card opening an epoch the
    //    account had moved off, which is a recovery that appears to work and
    //    hands back nothing usable.
    if (prepared.escrow) {
      await relay.putObject('escrow', prepared.epoch, 1, Buffer.from(prepared.escrow, 'base64'))
    }

    // 3. The handoffs: one per surviving device, plus the chained one for a
    //    hygiene rotation. Named by the recipient's key fingerprint, so a
    //    device fetches only its own.
    for (const [fingerprint, sealed] of Object.entries(prepared.handoffs)) {
      await relay.putObject(
        `handoff:${fingerprint}`,
        prepared.epoch,
        1,
        Buffer.from(sealed, 'base64')
      )
    }
    if (prepared.chained) {
      await relay.putObject('handoff', prepared.epoch, 1, Buffer.from(prepared.chained, 'base64'))
    }

    // 4. And only now the transition. Everything the new epoch needs is
    //    already there, so the first device to read this entry finds an epoch
    //    that works.
    await relay.appendRoster(prepared.seq, prepared.entry)

    this.account = {
      ...account,
      epoch: prepared.epoch,
      ...(prepared.epoch === 1 ? { epoch1SignPub: prepared.epochSignPub } : {})
    }
    await this.refreshRoster()
    // The sync state pins per-collection ETags and counters against the old
    // epoch's objects, none of which apply now. Forgetting it makes the next
    // pass reconcile from scratch, which is exactly what should happen.
    forgetSyncState()
    void this.syncNow().catch(() => undefined)

    return { epoch: prepared.epoch, resealed }
  }

  /**
   * Get back in with nothing but the twelve words.
   *
   * THE PATH NOBODY TAKES UNTIL EVERYTHING HAS GONE WRONG. Every device lost,
   * stolen or dead; the only thing left is the card the user wrote the phrase
   * on. There is no second chance to find out it does not work, which is why
   * both halves of it are tested in the sidecar against a real account.
   *
   * TWO SIDECAR CALLS, and the split is forced rather than chosen: the escrow
   * lives on the relay under the account's own name and reading it needs a
   * session, so this device must know the account id and hold a signing key
   * BEFORE it can fetch the thing that tells it everything else.
   *
   * The device keys are MINTED, not recovered. The phrase never carried them,
   * because a device key that could be re-derived from something printed on a
   * card would make the card enough to impersonate a machine. So this is a NEW
   * device that the root key vouches for, and the entry it writes is
   * root-signed — which is what a person reviewing their devices later sees as
   * "added with the recovery phrase".
   */
  async recoverFromPhrase(
    baseURL: string,
    mnemonic: string,
    label: string,
    insecureTLS = false
  ): Promise<{ accountId: string; devices: number }> {
    const relay = baseURL.replace(/\/+$/, '')
    if (!relay.startsWith('https://')) {
      throw new AddyError('config-invalid', 'a relay address must be https://')
    }

    await this.detach()
    this.insecureTLS = insecureTLS
    const addyd = await openAddyd('--crypto')
    this.addyd = addyd

    try {
      const identity = await addyd.send<{
        accountId: string
        rootSignPub: string
        devicePub: string
        secrets: { deviceSignSeed: string; deviceEncKey: string }
      }>('recoverIdentity', { mnemonic, label })

      // Stored before the network, unlike `createAccount` which stores after
      // it — and the asymmetry is the point. There, a failure means an account
      // that does not exist and keys worth discarding. Here the account
      // already exists and these keys are the only ones this machine will ever
      // have for it: a relay that goes down between the login and the roster
      // append must not cost the user their one recovery attempt.
      for (const [scope, value] of [
        ['device', identity.secrets.deviceSignSeed],
        ['device-enc', identity.secrets.deviceEncKey]
      ] as const) {
        if (!storeAddySecret('device', `${identity.accountId}:${scope}`, value)) {
          throw new AddyError(
            'config-invalid',
            'this machine has no usable keychain, so the recovered keys cannot be stored. Nothing was kept.'
          )
        }
      }

      this.account = {
        baseURL: relay,
        token: '',
        accountId: identity.accountId,
        epoch: 1,
        rootSignPub: identity.rootSignPub
      }
      this.relay = new RelayClient({ baseURL: relay, token: '', insecureTLS }, addyd)
      const { token } = await this.relay.login()
      this.account = { ...this.account, token }

      // The escrow, then the chain. Both are fetched before either is trusted:
      // the escrow carries the head entry as the ACCOUNT committed it, so the
      // chain is verified against a pin the relay never saw — which is what
      // catches a relay serving a truncated roster to a device that has
      // nothing else to compare against, at the moment that is most worth
      // trying.
      const escrowObj = await this.relay.getObject('escrow', 1)
      if (!escrowObj) {
        throw new AddyError(
          'not-paired',
          'this relay has no escrow for that account, so there is nothing to recover from here. Check the relay address.'
        )
      }
      const chain = await this.relay.roster()

      type Opened = {
        accountId: string
        epoch: number
        rootSignPub: string
        epoch1SignPub: string
        devices: number
        /** Present INSTEAD of the rest when the chain is ahead of the escrow
         *  that was opened: this one reads history and nothing current. */
        needEpoch?: number
        seq: number
        entry: string
        secrets: { akSeed: string }
      }

      /**
       * EPOCH 1 FIRST, WHATEVER THE ACCOUNT'S EPOCH IS.
       *
       * The genesis entry is signed by AK_1, so epoch 1's escrow is the only
       * thing that makes the chain checkable at all — and an account that has
       * rotated keeps its CURRENT key in a later escrow. So recovery opens
       * both: the first to verify, the second to be usable.
       *
       * This loop did not exist. `recoverOpen` reported `needEpoch` and the
       * caller destructured `secrets.akSeed` off a response that does not
       * carry one, so recovering any account that had ever been re-keyed
       * threw — on the one path a person takes when everything else is
       * already gone.
       */
      let opened = await addyd.send<Opened>('recoverOpen', {
        escrow: escrowObj.body.toString('base64'),
        epoch: 1,
        chain
      })

      if (opened.needEpoch !== undefined) {
        const current = await this.relay.getObject('escrow', opened.needEpoch)
        if (!current) {
          // The chain says the account rotated and the relay has no escrow
          // for the epoch it rotated to. Refused rather than falling back to
          // epoch 1's key, which is the key every revoked device still holds:
          // a recovery that quietly lands on it would re-seal the estate
          // under exactly what the re-key was performed to retire.
          throw new AddyError(
            'roster-invalid',
            `this account is on epoch ${opened.needEpoch} and the relay has no escrow for it. Recovering onto the older key would undo the re-key, so this stops here.`
          )
        }
        opened = await addyd.send<Opened>('recoverOpen', {
          escrow: current.body.toString('base64'),
          epoch: opened.needEpoch,
          chain
        })
        if (opened.needEpoch !== undefined) {
          throw new AddyError('roster-invalid', 'the relay will not serve this account\'s current escrow')
        }
      }

      /**
       * AND CHECK NOBODY IS ROLLING US BACK.
       *
       * The chain is pinned against the escrow's own head — but the relay
       * chose which escrow to serve, so it can pick the one whose head
       * matches its truncation point. Serve epoch 1's escrow and a chain cut
       * back to the genesis entry, and everything verifies: a prefix of a
       * valid chain is a valid chain. The user, typing their own recovery
       * phrase, lands on the epoch key that every revoked device and every
       * retired epoch still holds, and proceeds to re-seal the estate under
       * it.
       *
       * An escrow one epoch past the chain's end is proof that happened: the
       * account only writes one when it rotates. The relay must now hide that
       * too — and hiding it breaks recovery visibly for anyone who really did
       * re-key, rather than silently downgrading someone who did.
       *
       * This is a bound, not a cure. A device recovering from nothing has no
       * prior state to compare against, which is why the design's printable
       * card carries the roster head and the device count: the person is the
       * last check, and §6 of the review screen is where they make it.
       */
      const ahead = await this.relay.getObject('escrow', opened.epoch + 1).catch(() => null)
      if (ahead) {
        throw new AddyError(
          'roster-rewound',
          `this relay served a roster ending at epoch ${opened.epoch} while holding an escrow for epoch ${opened.epoch + 1}. That is a rolled-back account, not a recovery, and nothing was changed.`
        )
      }

      // UNDER ITS OWN EPOCH. The unsuffixed name is epoch 1's by convention —
      // it was written before any other kind existed — so a recovery onto a
      // rotated account that stored its key there would come back after a
      // restart with the current key filed as epoch 1's, and seal nothing
      // anyone could read.
      const keyName =
        opened.epoch > 1
          ? `${opened.accountId}:account:${opened.epoch}`
          : `${opened.accountId}:account`
      if (!storeAddySecret('account', keyName, opened.secrets.akSeed)) {
        throw new AddyError(
          'config-invalid',
          'this machine has no usable keychain, so the account key cannot be stored. Nothing was kept.'
        )
      }

      await this.relay.appendRoster(opened.seq, opened.entry)

      this.account = {
        ...this.account,
        epoch: opened.epoch,
        rootSignPub: opened.rootSignPub,
        epoch1SignPub: opened.epoch1SignPub
      }
      // Re-logs in and writes the enrolment, so this survives a restart like
      // any other attachment — and starts the engine, which is what actually
      // brings the estate back onto this machine.
      await this.loginAndRecord()
      const after = await this.refreshRoster()
      return { accountId: opened.accountId, devices: after.devices.length }
    } finally {
      // RK is the whole estate. It is dropped whether this worked or not,
      // because a process holding it after it has no further use for it is
      // the one thing a recovery must not leave behind.
      await addyd.send('recoverForget').catch(() => undefined)
    }
  }

  /**
   * Remove another device from the account.
   *
   * THE ACTOR SIDE, which did not exist. `services/addy/revoke.ts` implements
   * what a revoked device does to itself — reads the roster, finds itself
   * absent, wipes and shows a blocking screen — and nothing anywhere authored
   * the entry that makes that happen. A user could see the devices on their
   * account and had no way to remove one, which for a lost laptop is the
   * single call they most need.
   *
   * SOFT, and the distinction is not a detail. This removes the device from
   * the roster: every other device stops sealing to it, the relay stops
   * accepting it once it re-reads the chain, and it wipes itself on next
   * launch. It does NOT take back the epoch key, so a machine that is stolen
   * rather than merely retired also needs a re-key — which is a separate call
   * with a different signer, because a rotation the revoked device could
   * follow would be worse than no rotation at all.
   *
   * Both halves come from the roster THIS device verified, never from the
   * relay: the encryption key is part of the entry and a revoke naming a
   * substituted one is refused, because otherwise "revoke" would be a way to
   * rewrite a live device's encryption key.
   */
  async revokeDevice(pubSign: string): Promise<{ devices: number }> {
    const addyd = this.addyd
    const relay = this.relay
    const account = this.account
    if (!addyd || !relay || !account) {
      throw new AddyError('not-paired', 'this device is not attached to an addy account')
    }

    const before = await this.refreshRoster()
    const target = before.devices.find((d) => d.pubSign === pubSign)
    if (!target) {
      // Already gone, or never there. Reported rather than written: appending
      // a revoke for a device the chain does not list produces an entry every
      // verifier refuses, and the account would be stuck on a head nobody
      // accepts.
      throw new AddyError('config-invalid', 'that device is not on this account')
    }

    const entry = await addyd.send<{ seq: number; entry: string }>('revokeDevice', {
      headEntry: before.headEntry ?? '',
      headSeq: before.headSeq ?? 0,
      epoch: account.epoch,
      pubSign: target.pubSign,
      pubEnc: target.pubEnc
    })
    await relay.appendRoster(entry.seq, entry.entry)

    const after = await this.refreshRoster()
    return { devices: after.devices.length }
  }

  /**
   * A backup destination that writes to this account's relay.
   *
   * Built per call rather than held, because the epoch can change between two
   * backups and a target holding a stale one would seal the second bundle
   * under a key the account has moved off. `addyTarget` reads it through the
   * `epoch()` function for the same reason.
   *
   * Returns null when this device is not attached — which is a state, not a
   * failure: the destination dialog says so and points at the Sync & devices
   * page, rather than reporting a relay error for a relay nobody chose.
   */
  backupTarget(passphraseLength: number): BackupTarget | null {
    if (!this.attached || !this.relay) return null
    return addyTarget({
      addyd: this.addyd!,
      relay: this.relay,
      epoch: () => this.account!.epoch,
      passphraseLength: () => passphraseLength
    })
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  /** Sends one file to one device on this account. */
  async sendFile(path: string, toDevice: string): Promise<{ id: string; name: string; size: number }> {
    return sendFile(this.transferDeps(), path, toDevice)
  }

  /** Collects whatever has been sent to this device, into quarantine. */
  async collectFiles(): Promise<ArrivedFile[]> {
    if (!this.attached || !this.relay?.token) return []
    const arrived = await collectFiles(this.transferDeps())
    if (arrived.length > 0) this.announce()
    return arrived
  }

  private transferDeps(): TransferDeps {
    const base = this.deps()
    return { ...base, peers: () => this.roster }
  }

  /** Empty rather than throwing when unattached.
   *
   *  The renderer calls this on mount, on every window, before the user has
   *  been anywhere near addy. An exception there would be an error dialog for
   *  a feature nobody has turned on. */
  async conflicts(): Promise<ConflictCopy[]> {
    if (!this.attached) return []
    return listConflicts(this.deps())
  }

  async resolveConflict(id: number, collection: string, chosen: unknown): Promise<void> {
    // The counter comes from the winning object's own, plus one. Deriving it
    // here rather than taking it from the renderer keeps the anti-rollback
    // control out of reach of anything a page could influence.
    const deps = this.deps()
    const stored = await deps.relay.getObject(collection, deps.epoch())
    let counter = 1
    if (stored) {
      const opened = await deps.addyd.send<{ counter: number }>('open', {
        collection,
        epoch: deps.epoch(),
        sealed: stored.body.toString('base64'),
        knownSchema: 1,
        // The comment above says deriving the counter here "keeps the
        // anti-rollback control out of reach of anything a page could
        // influence". Opened at 0 it did the opposite: it moved that control
        // from the renderer to the RELAY. Serve an archived copy and the
        // resolution is written at a number every peer refuses as a rollback,
        // so the user's decision silently never propagates.
        seenCounter: counterFloor(collection)
      })
      counter = opened.counter + 1
    }
    await resolveConflict(deps, id, collection, chosen, counter, stored?.etag ?? '')

    /**
     * AND PUT IT ON THIS MACHINE, which nothing did.
     *
     * The resolution went to the relay and stopped there: no local write, no
     * state entry, no renderer notification. So the merged list the user had
     * just built by hand did not appear on the screen they built it on — for
     * up to five minutes, and only if nothing made `localChanged` true in the
     * meantime. The obvious next move is to edit it by hand, which makes
     * `localChanged` true and turns the next pass into a fresh conflict
     * against their own merge.
     */
    const source = SOURCES[collection as SyncedCollection]
    if (source) {
      source.write(Buffer.from(JSON.stringify(chosen), 'utf8'))
      if (source.inRendererStore) this.appliedCb?.([collection as SyncedCollection])
    }
    // The next pass reconciles the counters and the ETag from scratch rather
    // than from a record written here, which would be a second place the
    // bookkeeping is done and a second place to get it wrong.
    forgetSyncState()
    void this.syncNow().catch(() => undefined)
  }

  async discardConflict(id: number): Promise<void> {
    await discardConflict(this.deps(), id)
  }
}

export const addySession = new AddySession()
