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
import type { AddyStatusSnapshot, ConflictCopy, SyncedCollection } from '../../../shared/addy'
import { forgetSyncState, syncOnce, type SyncResult } from './sync'
import { addyTarget } from './target'
import type { BackupTarget } from '../backupTargets'
import {
  applySealedClipboard,
  receiveClipboard,
  sendClipboard,
  type ClipboardDeps
} from './clipboard'
import { answerPeer, closeSession, dialPeer } from './p2p'

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
    this.account = { ...account, token }
    saveEnrolment({
      baseURL: account.baseURL,
      accountId: account.accountId,
      epoch: account.epoch,
      rootSignPub: account.rootSignPub ?? '',
      epoch1SignPub: account.epoch1SignPub ?? '',
      spki,
      insecureTLS: this.insecureTLS
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
          epochKeys: { [saved.epoch]: keys.akSeed }
        },
        log
      )
      await this.loginAndRecord()
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
    const akSeed = loadAddySecret('account', `${account.accountId}:account`)
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
    }>('verifyRoster', {
      chain: bytes,
      rootSignPub: account.rootSignPub ?? '',
      epoch1Sign: account.epoch1SignPub ?? ''
    })

    const me = await addyd.send<{ devicePub: string }>('whoami', {})
    this.roster = verified.devices
      .map((d) => d.pubSign)
      .filter((id) => id !== me.devicePub)
    const roster: AddyRoster = {
      devices: verified.devices,
      stillListed: verified.selfListed,
      head: verified.head,
      headEntry: verified.headEntry,
      headSeq: verified.headSeq,
      self: me.devicePub
    }
    this.lastRoster = roster
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
          const deps = {
            rtc,
            relay: this.relay!,
            iceServers: await this.iceServers(),
            selfDeviceHex: (await this.addyd!.send<{ devicePub: string }>('whoami')).devicePub
          }
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
        const deps = { rtc, relay: this.relay!, iceServers, selfDeviceHex: devicePub }

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
        applied: (collections) => this.appliedCb?.(collections)
      })
      this.lastSync = result
      this.carried = [...this.carried, result.carried].slice(-12)
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
    return this.syncNow()
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
        seenCounter: 0
      })
      counter = opened.counter + 1
    }
    await resolveConflict(deps, id, collection, chosen, counter)
  }

  async discardConflict(id: number): Promise<void> {
    await discardConflict(this.deps(), id)
  }
}

export const addySession = new AddySession()
