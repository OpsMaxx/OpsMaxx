import { AddyError, openAddyd, type AddySidecar } from './sidecar'
import {
  beginPairing,
  forgetPairing,
  joinPairing,
  type PairingConfirmation
} from './pairing'
import { RelayClient } from './relay'
import {
  discardConflict,
  listConflicts,
  resolveConflict,
  type ConflictDeps
} from './conflicts'
import type { ConflictCopy } from '../../../shared/addy'
import { receiveClipboard, sendClipboard, type ClipboardDeps } from './clipboard'
import { closeSession, dialPeer } from './p2p'

/**
 * The live connection to an addy account: one sidecar, one relay client.
 *
 * NOTHING HERE IS CONFIGURED YET, and every entry point says so rather than
 * failing obscurely. Pairing is what fills this in, and until it does, the
 * honest answer to "what conflicts are waiting" is "none, because this device
 * is not attached to an account" -- not an exception the renderer has to
 * recognise, and not an empty list that looks like everything is fine.
 */

export interface AddyAccount {
  baseURL: string
  token: string
  accountId: string
  epoch: number
}

class AddySession {
  private addyd: AddySidecar | null = null
  private relay: RelayClient | null = null
  private account: AddyAccount | null = null

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
    this.relay = new RelayClient({ baseURL: account.baseURL, token: account.token }, addyd)
    this.account = account
  }

  /** Stops the sidecar and forgets everything. Called when the vault locks and
   *  at quit: nothing addyd holds is on disk, so stopping it IS the
   *  remediation rather than a step towards one. */
  async detach(): Promise<void> {
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
    return joinPairing({ addyd, baseURL }, code, pairingId, abort.signal)
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

  private clipboardDeps(): ClipboardDeps {
    const base = this.deps()
    return {
      ...base,
      peers: () => this.roster,
      tryDirect: async (peerHex, sealed) => {
        const rtc = await this.ensureRtc()
        if (!rtc || !this.account || !this.addyd) return false

        // What the relay says about relaying, asked once per attempt. A device
        // behind a symmetric NAT needs TURN credentials to have any chance;
        // one on the same LAN does not need them and pays nothing for asking.
        let iceServers: unknown[] = []
        try {
          const resp = await this.relay!.request('GET', '/v1/turn')
          if (resp.ok) {
            const turn = (await resp.json()) as {
              mode: string
              url?: string
              credential?: { username: string; password: string; url: string }
            }
            if (turn.mode === 'embedded' && turn.credential) {
              iceServers = [
                {
                  urls: [turn.credential.url],
                  username: turn.credential.username,
                  credential: turn.credential.password
                }
              ]
            } else if (turn.mode === 'external' && turn.url) {
              iceServers = [{ urls: [turn.url] }]
            }
          }
        } catch {
          // No relay credentials means host and server-reflexive candidates
          // only, which is enough on a shared network and not enough behind
          // two symmetric NATs. Worth trying rather than refusing.
        }

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
