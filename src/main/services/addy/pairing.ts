import { AddyError, type AddySidecar } from './sidecar'

/**
 * Driving a pairing from main.
 *
 * Three parties: this device's sidecar, which holds the keys and runs SPAKE2;
 * the relay, which carries opaque frames between two mailboxes and learns
 * nothing; and the user, who compares seven emoji with somebody in the room or
 * on the phone.
 *
 * THIS MODULE HOLDS NO KEY AND MAKES NO DECISION. It moves frames and reports
 * what the sidecar said. The two things that matter -- that the emoji appear
 * only after a key confirmation verifies, and that three wrong codes end the
 * session -- are both enforced in the sidecar, where a bug here cannot reach
 * them.
 */

/** The unauthenticated rendezvous is a poll, so this is how long to keep
 *  asking before giving up on the other device. Long: the person on the far
 *  end is typing a six-word code, and a pairing that timed out while they were
 *  still reading it is one they blame on the product. */
const RENDEZVOUS_TIMEOUT_MS = 180_000

export interface PairingHandle {
  /** Shown on this screen and read to the other person. Never sent anywhere. */
  code: string
  pairingId: string
}

export interface PairingConfirmation {
  /** Seven emoji, identical on both devices. */
  sas: string[]
  /** The same list as words, so a phone call works as well as a photograph. */
  sasWords: string
  peer: { pubSign: string; pubEnc?: string }
  /** The joining device's own public halves, present only on the joiner, for
   *  the initiator to write into the roster entry that adds it. */
  self?: { pubSign: string; pubEnc: string }
}

export interface PairingDeps {
  addyd: AddySidecar
  /** `https://relay.example`. The rendezvous is UNAUTHENTICATED -- a joining
   *  device has no account yet, which is the whole point -- so this takes a
   *  bare URL rather than a signed client. */
  baseURL: string
}

/** Posts a frame into the peer's mailbox. */
async function publish(deps: PairingDeps, id: string, role: string, frame: unknown): Promise<void> {
  const resp = await fetch(`${deps.baseURL}/v1/pair/${id}?as=${role}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ frame: Buffer.from(JSON.stringify(frame), 'utf8').toString('base64') })
  })
  if (!resp.ok) {
    throw new AddyError('relay-unreachable', `the relay would not carry the frame (${resp.status})`)
  }
}

/**
 * Waits for a frame in this role's mailbox.
 *
 * The relay answers 204 when nothing arrived within its own poll window, so
 * this loops. An implementation that treated 204 as an error would give up the
 * first time the other person took more than twenty seconds to type.
 */
async function receive<T>(deps: PairingDeps, id: string, role: string, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + RENDEZVOUS_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw new AddyError('pairing-expired', 'the pairing was cancelled')
    const resp = await fetch(`${deps.baseURL}/v1/pair/${id}?as=${role}`, { signal }).catch(() => null)
    if (!resp) throw new AddyError('relay-unreachable', 'the relay stopped answering')
    if (resp.status === 204) continue
    if (!resp.ok) {
      throw new AddyError('relay-unreachable', `the relay refused the rendezvous (${resp.status})`)
    }
    const { frame } = (await resp.json()) as { frame: string }
    return JSON.parse(Buffer.from(frame, 'base64').toString('utf8')) as T
  }
  throw new AddyError('pairing-expired', 'the other device did not answer in time')
}

/**
 * The device SHOWING the code.
 *
 * Returns as soon as there is a code to display, and the rest happens in the
 * promise it also returns. That split matters: the user has to be able to read
 * the code out loud while this is still waiting for the other end, and an API
 * that only resolved once pairing completed would have nothing to show them.
 */
export function beginPairing(
  deps: PairingDeps,
  signal: AbortSignal
): Promise<{ handle: PairingHandle; confirmed: Promise<PairingConfirmation> }> {
  return deps.addyd
    .send<{ code: string; pairingId: string; startFrame: unknown }>('pairBegin')
    .then((begun) => {
      const handle: PairingHandle = { code: begun.code, pairingId: begun.pairingId }

      const confirmed = (async (): Promise<PairingConfirmation> => {
        await publish(deps, begun.pairingId, 'initiator', begun.startFrame)

        const reply = await receive<{
          msgB: string
          confirmB: string
          pubSign: string
          pubEnc: string
        }>(deps, begun.pairingId, 'initiator', signal)

        // The sidecar verifies the confirmation MAC and only then derives the
        // emoji. If it throws here, the other end did not prove it knows the
        // code -- and the emoji are never computed at all.
        const replied = await deps.addyd.send<PairingConfirmation & { confirmFrame: unknown }>(
          'pairReply',
          { pairingId: begun.pairingId, ...reply }
        )
        await publish(deps, begun.pairingId, 'initiator', replied.confirmFrame)

        return { sas: replied.sas, sasWords: replied.sasWords, peer: replied.peer }
      })()

      return { handle, confirmed }
    })
}

/**
 * The device TYPING the code.
 *
 * It needs the pairing id as well, and that is not an oversight in the
 * protocol -- it is a property of it. The id is inside the start frame, and
 * the frame sits in a mailbox addressed BY the id, so a joiner cannot fetch it
 * without already knowing it. The two therefore travel together: the initiator
 * shows both, by QR or as one string, and the panel splits them.
 *
 * The consequence is worth naming, because it is a feature: a code on its own
 * is useless later. Two devices have to be pairing AT THE SAME TIME, so a code
 * overheard this morning cannot be redeemed this afternoon.
 */
export async function joinPairing(
  deps: PairingDeps,
  code: string,
  pairingId: string,
  signal: AbortSignal
): Promise<PairingConfirmation> {
  const start = await receive<{ pairingId: string; msgA: string; pubSign: string }>(
    deps,
    pairingId,
    'joiner',
    signal
  )
  const joined = await deps.addyd.send<{ replyFrame: unknown }>('pairJoin', {
    code,
    pairingId,
    msgA: start.msgA,
    pubSign: start.pubSign
  })
  await publish(deps, pairingId, 'joiner', joined.replyFrame)

  const confirm = await receive<{ confirmA: string }>(deps, pairingId, 'joiner', signal)
  return deps.addyd.send<PairingConfirmation>('pairConfirm', { pairingId, confirmA: confirm.confirmA })
}

/** Ends a session, forgetting the shared secret. Called when the user says the
 *  emoji do not match, and on every ordinary completion. */
export async function forgetPairing(deps: PairingDeps, pairingId: string): Promise<void> {
  await deps.addyd.send('pairForget', { pairingId }).catch(() => undefined)
}
