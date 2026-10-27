import { randomUUID } from 'node:crypto'
import { AddyError, type AddySidecar } from './sidecar'
import { relayError, type RelayClient } from './relay'

/**
 * A direct connection to another device, negotiated over the relay.
 *
 * THE RELAY CARRIES THE NEGOTIATION AND NOT THE DATA. Offers, answers and ICE
 * candidates go through it, because two devices that cannot reach each other
 * yet have no other way to talk; once the data channel opens, the bytes go
 * directly and the relay sees nothing further.
 *
 * And it is the FIRST path, not the only one. A pair of networks that cannot
 * be traversed is the ordinary case -- two symmetric NATs, a corporate
 * firewall, a peer that is simply asleep -- which is why `ErrPeerUnreachable`
 * has its own code and why store-and-forward exists behind it. A caller that
 * could not tell "no direct path" from "something went wrong" would report an
 * error where it should have left a message.
 */

export interface P2PDeps {
  /** This device's own key, in hex, so a peer knows whom to answer. */
  selfDeviceHex: string
  /** The `--rtc` sidecar. Never the `--crypto` one: this negotiation touches
   *  no key, and giving it to a process that holds one would put an SDP parser
   *  in the same address space as the account key. */
  rtc: AddySidecar
  relay: RelayClient
  /** ICE servers from `/v1/turn`, already fetched by the caller. Passed rather
   *  than fetched here because asking would mean this layer holding a session
   *  token. */
  iceServers: unknown[]
  /** The key-holding sidecar. Signing and verifying happen there; this module
   *  never sees a key, and `--rtc` never sees one either. */
  crypto: AddySidecar
  /** The epoch and the verified roster head this device is on. */
  epoch: number
  rosterHead: string
  /** Every device currently on the roster, hex. A signature only means
   *  something if the key it verifies against is a member. */
  members(): string[]
}

interface SignalEnvelope {
  session: string
  kind: 'offer' | 'answer'
  sdp: string
  /**
   * The sender's device key, in hex.
   *
   * Carried in the ENVELOPE because the relay does not add it: a signal frame
   * is opaque to the server by design, which is what stops it learning which
   * devices are negotiating with which.
   *
   * IT USED TO BE A CLAIM AND IS NOW A PROOF. `signature` below covers the
   * SDP's DTLS fingerprint under this device's key, so naming somebody else
   * here produces a signature that does not verify against their roster key.
   */
  from: string
  /** Ed25519 over `protocol.Signal`, hex. */
  signature: string
  /** The signer's nonce, and the nonce of the offer an answer replies to. */
  deviceNonce: string
  peerNonce: string
  ts: number
  /** The signer's verified roster head, so each end notices immediately that
   *  the other is on a different view of the chain — which is what a forked
   *  roster looks like from the inside. */
  rosterHead: string
}

/**
 * Dials a peer.
 *
 * Resolves with a session id the caller sends and receives on, or throws
 * `peer-unreachable` -- which is the signal to fall back, not to report a
 * failure.
 */
export async function dialPeer(
  deps: P2PDeps,
  peerDeviceHex: string,
  timeoutMs = 25_000
): Promise<string> {
  const session = randomUUID()

  const offer = await deps.rtc.send<{ sdp: string }>('rtcOffer', {
    sessionId: session,
    iceServers: deps.iceServers
  })

  const sent = await signAndPublish(deps, peerDeviceHex, {
    session,
    kind: 'offer',
    sdp: offer.sdp,
    from: deps.selfDeviceHex
  })

  // The answer has to be SIGNED BY THE DEVICE WE DIALLED and has to quote our
  // own nonce, so a relay cannot answer on its behalf and cannot replay an
  // answer from an earlier session.
  const answer = await waitForSignal(
    deps,
    (e) =>
      e.session === session &&
      e.kind === 'answer' &&
      e.from === peerDeviceHex &&
      e.peerNonce === sent.deviceNonce,
    timeoutMs
  )
  if (answer && !(await verifySignal(deps, answer, sent.deviceNonce))) {
    await deps.rtc.send('rtcClose', { sessionId: session }).catch(() => undefined)
    throw new AddyError(
      'peer-unreachable',
      'the answer to this call was not signed by the device it claims to be from'
    )
  }
  if (!answer) {
    await deps.rtc.send('rtcClose', { sessionId: session }).catch(() => undefined)
    throw new AddyError(
      'peer-unreachable',
      'that device did not answer. It may be asleep, or on a network that needs a relay.'
    )
  }

  try {
    await deps.rtc.send('rtcAccept', { sessionId: session, sdp: answer.sdp })
  } catch (err) {
    // The session is cleaned up on every failure path, not only the expected
    // one. A peer connection left behind holds goroutines, a UDP socket and an
    // ICE agent in the sidecar, and the symptom is an app that is fine for an
    // hour and unusable by the evening.
    await deps.rtc.send('rtcClose', { sessionId: session }).catch(() => undefined)
    throw err
  }
  return session
}

/**
 * Answers a peer that is dialling us.
 *
 * Returns the session id, or null when nothing was offered inside the window
 * -- which is not a failure: most of the time nobody is calling.
 */
export async function answerPeer(deps: P2PDeps, waitMs = 5000): Promise<string | null> {
  const offer = await waitForSignal(deps, (e) => e.kind === 'offer', waitMs)
  if (!offer) return null

  // BEFORE ANY OF IT REACHES PION. An unsigned offer is one the relay could
  // have written, pointing at a certificate it holds — and answering it hands
  // that relay a data channel. Dropped silently: a frame that does not verify
  // is not something to report to the user, it is noise on a public mailbox.
  //
  // `'00'.repeat(32)` because an offer answers nothing, so it quotes no nonce
  // of ours.
  if (!(await verifySignal(deps, offer, '00'.repeat(32)))) return null

  const answer = await deps.rtc.send<{ sdp: string }>('rtcAnswer', {
    sessionId: offer.session,
    sdp: offer.sdp,
    iceServers: deps.iceServers
  })
  // Answered to whoever the envelope says sent it. The relay cannot tell us --
  // a signal frame is opaque to it on purpose -- so this is the caller's claim,
  // with the bounded consequence described on the field.
  if (!offer.from) {
    // A frame from a peer that did not say who it is cannot be answered, and
    // broadcasting to every device so that one of them might take it is worse
    // than dropping it.
    await deps.rtc.send('rtcClose', { sessionId: offer.session }).catch(() => undefined)
    return null
  }
  // Signed back, quoting the offer's nonce so the dialling device can tell
  // this answer from a replayed one.
  await signAndPublish(
    deps,
    offer.from,
    { session: offer.session, kind: 'answer', sdp: answer.sdp, from: deps.selfDeviceHex },
    offer.deviceNonce
  )
  return offer.session
}

export async function closeSession(deps: P2PDeps, session: string): Promise<void> {
  await deps.rtc.send('rtcClose', { sessionId: session }).catch(() => undefined)
}

/**
 * Signs a description and publishes it.
 *
 * THE DTLS FINGERPRINT IS THE POINT, and `protocol.Signal` said so in its own
 * comment while nothing called it: without the fingerprint inside a signature,
 * a relay that carries the offer substitutes its own certificate and reads the
 * data channel. It does not need to break any crypto — it needs the
 * fingerprint to be unsigned, which it was, on every session.
 */
async function signAndPublish(
  deps: P2PDeps,
  to: string,
  base: Omit<SignalEnvelope, 'signature' | 'deviceNonce' | 'peerNonce' | 'ts' | 'rosterHead'>,
  peerNonce = '00'.repeat(32)
): Promise<SignalEnvelope> {
  const signed = await deps.crypto.send<{
    signature: string
    deviceNonce: string
    ts: number
  }>('signSignal', {
    epoch: deps.epoch,
    peerPubSign: to,
    sdp: base.sdp,
    rosterHead: deps.rosterHead,
    peerNonce
  })
  const envelope: SignalEnvelope = {
    ...base,
    signature: signed.signature,
    deviceNonce: signed.deviceNonce,
    peerNonce,
    ts: signed.ts,
    rosterHead: deps.rosterHead
  }
  await publishSignal(deps, to, envelope)
  return envelope
}

/**
 * Checks a description before anything parses it for real.
 *
 * Two questions, and both have to be yes: is the signer a device on the roster
 * this machine verified, and does the signature cover the fingerprint in the
 * SDP that is about to be used? The second is taken from the description
 * itself rather than from the envelope, so a relay that rewrites the
 * certificate has to rewrite the value the signature covers.
 */
async function verifySignal(deps: P2PDeps, envelope: SignalEnvelope, selfNonce: string): Promise<boolean> {
  if (!envelope.from || !deps.members().includes(envelope.from)) return false
  if (envelope.peerNonce !== selfNonce) return false
  try {
    await deps.crypto.send('verifySignal', {
      epoch: deps.epoch,
      // The recipient, as the signer named it: us. And separately, whose
      // signature to check it against — which must be a roster member, asserted
      // above.
      peerPubSign: deps.selfDeviceHex,
      signerPubSign: envelope.from,
      sdp: envelope.sdp,
      rosterHead: envelope.rosterHead,
      deviceNonce: envelope.deviceNonce,
      peerNonce: envelope.peerNonce,
      ts: envelope.ts,
      signature: envelope.signature
    })
    return true
  } catch {
    return false
  }
}

async function publishSignal(deps: P2PDeps, to: string, envelope: SignalEnvelope): Promise<void> {
  // POST. This was a GET with a body, which Node's fetch refuses before it
  // leaves the machine — and the throw was swallowed by the caller's fallback,
  // so no direct connection was ever attempted and every clipboard quietly
  // went through the mailbox.
  const resp = await deps.relay.request('POST', `/v1/signal?to=${encodeURIComponent(to)}`, {
    frame: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
  })
  if (!resp.ok) throw await relayError(resp, 'the relay would not carry a signal')
}

/**
 * Waits for a frame this device cares about.
 *
 * ONE READER PER RELAY CLIENT, and every waiter is fed from it.
 *
 * The relay's mailbox is per-device, not per-session, and it hands each frame
 * to whichever poll is waiting first. Each caller used to run its own poll and
 * drop whatever did not match — so with the answering loop running (it runs
 * whenever the clipboard shortcuts are on, which is exactly when a clipboard
 * gets sent), the answer to this device's own offer usually landed in the
 * answering loop's poll, failed its "is this an offer?" test, and was thrown
 * away. The dial then timed out and the send fell back to the mailbox.
 *
 * Now the first waiter starts one poll loop, frames go to the first waiter
 * whose predicate matches, and the loop stops once nobody is waiting. A frame
 * nobody wants is still dropped — re-queuing it would need a queue this layer
 * does not have, and a stale frame would confuse the next negotiation.
 */
interface SignalWaiter {
  matches(e: SignalEnvelope): boolean
  settle(e: SignalEnvelope | null, err?: unknown): void
}
const signalWaiters = new WeakMap<RelayClient, Set<SignalWaiter>>()

function waitForSignal(
  deps: P2PDeps,
  matches: (e: SignalEnvelope) => boolean,
  timeoutMs: number
): Promise<SignalEnvelope | null> {
  let waiters = signalWaiters.get(deps.relay)
  const startReader = waiters === undefined
  if (!waiters) {
    waiters = new Set()
    signalWaiters.set(deps.relay, waiters)
  }
  const set = waiters
  return new Promise((resolve, reject) => {
    const waiter: SignalWaiter = {
      matches,
      settle: (e, err) => {
        clearTimeout(timer)
        set.delete(waiter)
        if (err !== undefined) reject(err)
        else resolve(e)
      }
    }
    const timer = setTimeout(() => waiter.settle(null), timeoutMs)
    set.add(waiter)
    if (startReader) void readSignals(deps.relay, set)
  })
}

async function readSignals(relay: RelayClient, waiters: Set<SignalWaiter>): Promise<void> {
  try {
    while (waiters.size > 0) {
      const resp = await relay.request('GET', '/v1/signal')
      if (resp.status === 204) continue
      if (!resp.ok) throw await relayError(resp, 'the relay refused signalling')
      const { frame } = (await resp.json()) as { frame?: string }
      if (!frame) continue
      let envelope: SignalEnvelope
      try {
        envelope = JSON.parse(Buffer.from(frame, 'base64').toString('utf8')) as SignalEnvelope
      } catch {
        // A frame that does not parse is one this build does not understand --
        // a newer peer, most likely. Ignored rather than fatal: refusing to
        // negotiate because somebody sent something unfamiliar would make every
        // upgrade a network partition.
        continue
      }
      for (const w of waiters) {
        if (w.matches(envelope)) {
          w.settle(envelope)
          break
        }
      }
    }
  } catch (err) {
    for (const w of [...waiters]) w.settle(null, err)
  } finally {
    signalWaiters.delete(relay)
  }
}
