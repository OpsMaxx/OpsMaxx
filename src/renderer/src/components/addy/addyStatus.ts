import { useCallback, useEffect, useState } from 'react'
import { bridgeHas, bridgeOn } from '../../lib/bridge'
import { duration } from '../../lib/format'

/**
 * What the panel needs main to tell it, and the shape it is asked for in.
 *
 * WRITTEN FROM THE PANEL'S SIDE ON PURPOSE. The sync engine, the login and the
 * persistence are being built in parallel with this screen, and none of them
 * exists on the bridge yet (`src/preload/index.ts` carries pairing, conflicts
 * and revocation and nothing that answers "how is it going"). So this file is
 * the request: the four questions the first screenful has to answer, typed, and
 * every one of them answerable with "I do not know" rather than with a zero.
 *
 * THE RULE THE TYPES ENFORCE, and the reason `null` appears as often as it
 * does: a number that nobody measured must never render as though it had been.
 * `lastSeen: 0` is 1970, `deviceCount: 0` reads as "your account is empty", and
 * a `lastSyncAt` defaulted to `Date.now()` is a green dashboard over a dead
 * engine. Absent is a state, it has its own rendering, and it is the state this
 * build is actually in.
 */

/** One device on the account, as the relay's roster knows it. */
export interface AddyDevice {
  /** `pub_sign`, hex. Stable for the life of the device, and the key the
   *  `deviceNames` collection is keyed on. */
  id: string
  /** What to show. The `deviceNames` override where the user has set one, the
   *  birth name otherwise — resolved in main, because the renderer has no
   *  roster and must not learn to guess at one. */
  label: string
  /** The device this window is running on. Exactly one device, or none at all
   *  when main cannot tell which it is. */
  self: boolean
  /** Epoch ms the relay last saw it. `null` when it never has, or when this
   *  relay does not report per-device liveness. Never 0. */
  lastSeen: number | null
  /** Epoch ms it joined the account. `null` when unknown. */
  addedAt: number | null
  /** Revoked devices stay in the roster — the chain is immutable — so they are
   *  shown as revoked rather than dropped, which is also what makes a
   *  revocation visible from the other machines. */
  revoked?: boolean
}

/** Whether anything is actually moving, and what went wrong if not. */
export interface AddySync {
  /**
   * Is there a sync engine running in this build at all.
   *
   * `false` is the honest answer while it is being written, and it is the one
   * field that stops every other pane on this panel from lying: with no engine,
   * "last sync: never" is not a fleet that is behind, it is a feature that has
   * not started.
   */
  running: boolean
  /** A live connection to the relay, right now. */
  connected: boolean
  /** Epoch ms a sync last completed. `null` when none ever has. */
  lastSyncAt: number | null
  /** The current failure, cleared by the next success. Absent is healthy. */
  error?: { message: string; at: number; code?: string }
  /** Conflict copies waiting for a choice. The chooser that resolves them
   *  mounts at the app root (App.tsx); this is the count, so the band can say
   *  something is waiting without opening both sides of every one. */
  conflicts: number
  /** Objects carried in each of the last few sync windows, oldest first.
   *  Optional: with no history the sparkline is omitted rather than drawn
   *  flat, because a flat line is a claim that nothing synced. */
  history?: number[]
}

/** The whole answer. */
export interface AddyStatus {
  /** Is this device on an account. Everything below is about that account. */
  enrolled: boolean
  /** The relay, as `https://relay.example`. */
  relayURL?: string
  accountId?: string
  /** The roster. OMITTED — not `[]` — when main cannot read it, so the panel
   *  can tell "no devices" from "I was not told". */
  devices?: AddyDevice[]
  sync: AddySync
}

/** The two calls this panel wants on `window.opsmaxx.addy`. */
interface AddyStatusBridge {
  status?: () => Promise<AddyStatus>
  /** Pushed whenever any of the above changes, so the panel does not poll a
   *  sidecar on a timer to find out that nothing happened. */
  onStatus?: (cb: (s: AddyStatus) => void) => () => void
}

/**
 * The addy namespace, seen as the calls this panel wants rather than as the
 * calls it has.
 *
 * `as unknown as` because the bridge's real type does not declare these yet —
 * which is precisely the condition every `supported` check here exists to
 * notice. When main lands them, this cast is the line to delete.
 */
function statusBridge(): AddyStatusBridge | undefined {
  return window.opsmaxx?.addy as unknown as AddyStatusBridge | undefined
}

/** Whether this build can answer the question at all. */
export function addyStatusSupported(): boolean {
  return bridgeHas(statusBridge() as unknown as Record<string, unknown> | undefined, 'status')
}

export interface AddyStatusRead {
  /** `null` until the first answer arrives, and for the whole life of a build
   *  that cannot answer. */
  status: AddyStatus | null
  /** False when the bridge has no `status` call. The panel renders its "not on
   *  this build" form off this, rather than off an empty status. */
  supported: boolean
  /** The read itself failed — a different thing from a sync error, and shown
   *  as such. */
  error: string | null
  refresh: () => void
}

/**
 * Read the status, and keep reading it.
 *
 * Subscribes only when the bridge has both halves. `bridgeOn` warns once about
 * a missing method and tells the reader to restart the dev server, which is the
 * right advice for a preload that is merely stale and the wrong advice for a
 * method nobody has written yet.
 */
export function useAddyStatus(): AddyStatusRead {
  const [status, setStatus] = useState<AddyStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const supported = addyStatusSupported()

  const refresh = useCallback(() => {
    const call = statusBridge()?.status
    if (!call) return
    void call().then(
      (s) => {
        setStatus(s)
        setError(null)
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
  }, [])

  useEffect(() => {
    if (!supported) return
    refresh()
    return bridgeOn<[AddyStatus]>('addy.onStatus', statusBridge()?.onStatus, (s) => setStatus(s))
  }, [supported, refresh])

  return { status, supported, error, refresh }
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

/**
 * Where a person is between "never heard of this" and "two machines agree".
 *
 * A pure function, and separately exported, for two reasons. It is the only
 * part of this screen with any reasoning in it, so it is the part worth testing
 * without a DOM; and every branch of it is a sentence about what is true, which
 * is easier to keep honest when the sentences sit together rather than one per
 * JSX block.
 */
export type AddyStepState =
  /** Behind you. */
  | 'done'
  /** Where you are, and the only step that offers an action. */
  | 'now'
  /** Ahead of you, and reachable. */
  | 'todo'
  /** Nobody can say. Either this build does not report it, or the engine that
   *  would is not running. NEVER rendered as a tick or a cross. */
  | 'unknown'

export interface AddyStep {
  key: 'account' | 'device' | 'pair' | 'sync' | 'current'
  title: string
  /** What is true right now, in a sentence. Never a promise about what will
   *  happen. */
  detail: string
  state: AddyStepState
}

/**
 * How long ago, in the unit a person would say it in.
 *
 * `duration()` is the app's own helper and it stops at hours, which is right
 * for a metric read four minutes ago and wrong for this panel: a device that
 * paired last spring comes back as "3672h 0m". Below a day it DEFERS to
 * `duration`, so a device seen this morning and a server sampled this morning
 * are described the same way on both screens.
 */
export function ago(atMs: number): string {
  const days = Math.floor((Date.now() - atMs) / 86_400_000)
  if (days < 1) return duration(atMs)
  if (days < 30) return `${days}d`
  const months = Math.round(days / 30)
  return months < 12 ? `${months}mo` : `${Math.round(days / 365)}y`
}

/** The host part of a relay URL, for a subtitle. The whole URL is too long for
 *  a KPI tile and the scheme is not the part anybody reads. */
export function relayHost(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    // A half-typed relay is still worth showing back to the person who typed
    // it; it is just not a URL yet.
    return url
  }
}

/**
 * The five steps, and where the reader is on them.
 *
 * `relaySetting` is `settings.addyRelayURL` — the relay this device last
 * created an account on. It is the ONLY durable trace of enrolment the renderer
 * can see without main, and it says less than it looks like it says: it records
 * that an account was minted from this machine, not that the enrolment is still
 * in place. Step one says exactly that much and no more.
 */
export function addyJourney(
  status: AddyStatus | null,
  supported: boolean,
  relaySetting: string | undefined
): AddyStep[] {
  const relay = relayHost(status?.relayURL ?? relaySetting)
  const enrolled = status?.enrolled === true
  const devices = status?.devices
  const others = devices?.filter((d) => !d.self && d.revoked !== true).length
  const self = devices?.find((d) => d.self)
  const sync = status?.sync

  const account: AddyStep = enrolled
    ? {
        key: 'account',
        title: 'An account on a relay',
        detail: relay ? `This device is on the account at ${relay}.` : 'This device is on an account.',
        state: 'done'
      }
    : relay
      ? {
          key: 'account',
          title: 'An account on a relay',
          detail: `An account was created from this device on ${relay}. This build cannot tell whether that enrolment is still in place — the relay address is remembered here, the enrolment is not.`,
          state: supported ? 'now' : 'unknown'
        }
      : {
          key: 'account',
          title: 'An account on a relay',
          detail:
            'Name the relay you run and create an account on it. The twelve-word recovery phrase is shown once, during this step, and nothing on this machine keeps a copy.',
          state: 'now'
        }

  const device: AddyStep = !supported
    ? {
        key: 'device',
        title: 'This device joins it',
        detail: 'This build does not report which devices are enrolled.',
        state: 'unknown'
      }
    : enrolled
      ? {
          key: 'device',
          title: 'This device joins it',
          detail: self ? `Enrolled as ${self.label}.` : 'This device is enrolled.',
          state: 'done'
        }
      : { key: 'device', title: 'This device joins it', detail: 'Happens when the account is created, or when this device is paired with one that already has an account.', state: 'todo' }

  const pair: AddyStep = !supported
    ? {
        key: 'pair',
        title: 'A second device pairs with it',
        detail: 'This build does not report the device list.',
        state: 'unknown'
      }
    : !enrolled
      ? {
          key: 'pair',
          title: 'A second device pairs with it',
          detail: 'Both machines have to be open at the same time; one shows a code and both compare the same emoji.',
          state: 'todo'
        }
      : others === undefined
        ? {
            key: 'pair',
            title: 'A second device pairs with it',
            detail: 'The account exists, but this build does not report who else is on it.',
            state: 'unknown'
          }
        : others > 0
          ? {
              key: 'pair',
              title: 'A second device pairs with it',
              detail: `${others} other ${others === 1 ? 'device is' : 'devices are'} on this account.`,
              state: 'done'
            }
          : {
              key: 'pair',
              title: 'A second device pairs with it',
              detail:
                'Nothing syncs to one device. Open OpsMaxx on the other machine, start pairing here, and compare the emoji on both.',
              state: 'now'
            }

  const syncStep: AddyStep = !supported
    ? {
        key: 'sync',
        title: 'Sync runs',
        detail: 'Nothing is carrying data between devices yet: this build does not run the engine that would.',
        state: 'unknown'
      }
    : sync?.running !== true
      ? {
          key: 'sync',
          title: 'Sync runs',
          detail: 'The sync engine is not running. Pairing and the account are unaffected; nothing is moving between devices.',
          state: 'unknown'
        }
      : sync.connected
        ? { key: 'sync', title: 'Sync runs', detail: 'Connected to the relay.', state: 'done' }
        : {
            key: 'sync',
            title: 'Sync runs',
            detail: sync.error
              ? `Running, but not connected: ${sync.error.message}`
              : 'Running, and not connected to the relay right now.',
            state: 'now'
          }

  const current: AddyStep = !supported || sync?.running !== true
    ? {
        key: 'current',
        title: 'Both devices agree',
        detail: 'Nothing can be said about this until sync runs.',
        state: 'unknown'
      }
    : sync.conflicts > 0
      ? {
          key: 'current',
          title: 'Both devices agree',
          detail: `${sync.conflicts} ${sync.conflicts === 1 ? 'change was' : 'changes were'} made in two places at once and need a choice.`,
          state: 'now'
        }
      : sync.lastSyncAt === null
        ? {
            key: 'current',
            title: 'Both devices agree',
            detail: 'Nothing has synced yet.',
            state: 'todo'
          }
        : { key: 'current', title: 'Both devices agree', detail: 'Everything this device knows about has been carried.', state: 'done' }

  return [account, device, pair, syncStep, current]
}
