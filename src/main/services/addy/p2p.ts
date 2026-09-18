import { randomUUID } from 'node:crypto'
import { AddyError, type AddySidecar } from './sidecar'
import type { RelayClient } from './relay'

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
   * devices are negotiating with which. The cost is that the answerer has to
   * be told whom to answer, and the teller is the caller.
   *
   * It is therefore claimable: a device on this account could put another
   * device's key here and misdirect an answer. The consequence is bounded and
   * worth stating -- everyone who can publish a frame is already a device on
   * the user's own account, and the data channel carries nothing but payloads
   * sealed to a specific device, which a misdirected peer cannot open. It
   * wastes a negotiation; it does not leak one.
   */
  from: string
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

  await publishSignal(deps, peerDeviceHex, {
    session,
    kind: 'offer',
    sdp: offer.sdp,
    from: deps.selfDeviceHex
  })

  const answer = await waitForSignal(deps, (e) => e.session === session && e.kind === 'answer', timeoutMs)
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
  await publishSignal(deps, offer.from, {
    session: offer.session,
    kind: 'answer',
    sdp: answer.sdp,
    from: deps.selfDeviceHex
  })
  return offer.session
}

export async function closeSession(deps: P2PDeps, session: string): Promise<void> {
  await deps.rtc.send('rtcClose', { sessionId: session }).catch(() => undefined)
}

async function publishSignal(deps: P2PDeps, to: string, envelope: SignalEnvelope): Promise<void> {
  const resp = await deps.relay.request('GET', `/v1/signal?to=${encodeURIComponent(to)}`, {
    frame: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
  })
  if (!resp.ok && resp.status !== 204) {
    throw new AddyError('relay-unreachable', `the relay would not carry a signal (${resp.status})`)
  }
}

/**
 * Waits for a frame this device cares about.
 *
 * The relay's mailbox is per-device and not per-session, so a frame for
 * another negotiation can arrive while this one is waiting. Frames that do not
 * match are DROPPED rather than re-queued: re-queuing would need a queue this
 * layer does not have, and the sender retries -- whereas a frame held for a
 * negotiation that has already given up is a frame that confuses the next one.
 */
async function waitForSignal(
  deps: P2PDeps,
  matches: (e: SignalEnvelope) => boolean,
  timeoutMs: number
): Promise<SignalEnvelope | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const resp = await deps.relay.request('GET', '/v1/signal')
    if (resp.status === 204) continue
    if (!resp.ok) {
      throw new AddyError('relay-unreachable', `the relay refused signalling (${resp.status})`)
    }
    const { frame } = (await resp.json()) as { frame?: string }
    if (!frame) continue
    try {
      const envelope = JSON.parse(Buffer.from(frame, 'base64').toString('utf8')) as SignalEnvelope
      if (matches(envelope)) return envelope
    } catch {
      // A frame that does not parse is one this build does not understand --
      // a newer peer, most likely. Ignored rather than fatal: refusing to
      // negotiate because somebody sent something unfamiliar would make every
      // upgrade a network partition.
    }
  }
  return null
}
