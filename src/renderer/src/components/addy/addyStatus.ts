import { useCallback, useEffect, useState } from 'react'
import type {
  AddyStatusDevice,
  AddyStatusSnapshot,
  AddyStatusSync
} from '../../../../shared/addy'
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

/**
 * THE SHAPES, now owned by the shared contract.
 *
 * These four interfaces were written HERE first, as a request: main could not
 * answer any of them, so the panel typed the questions it needed answered and
 * rendered "not reported" for each until something did. Main answers them now,
 * and a second copy of the shape would let the answer drift from the question
 * without either side failing to compile — so the definitions moved to
 * `shared/addy.ts` and these names stay as aliases, because the panel and its
 * tests read better with them.
 *
 * The rule the shapes carry is unchanged and is the reason they are worth
 * pinning: `devices` is OMITTED rather than `[]` until a roster has been
 * verified, `lastSeen` is `null` rather than 0, and `sync.running` says
 * whether there is an engine at all.
 */
export type AddyDevice = AddyStatusDevice
export type AddySync = AddyStatusSync
export type AddyStatus = AddyStatusSnapshot

/**
 * The addy namespace on the bridge.
 *
 * This used to be `as unknown as` over a hand-written interface, because the
 * bridge genuinely did not declare these calls — which is the condition every
 * `supported` check below exists to notice. Main declares them now, so the
 * cast is gone and a rename on either side is a compile error rather than a
 * panel that quietly reports nothing.
 *
 * The `supported` check STAYS. A running app can have a preload older than the
 * renderer — that is the ordinary state of a dev server that was not
 * restarted, and of a window that outlived an update — and the honest
 * rendering of it is "this build cannot answer", not a crash. */
function statusBridge(): typeof window.opsmaxx.addy | undefined {
  return window.opsmaxx?.addy
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
          // Reached only when main reported `enrolled: false`, which is
          // authoritative and works offline — it reads a note on disk. The
          // build knows perfectly well; it said no. Blaming the build sent
          // people looking for an update.
          detail: `This device is not on an account. The address of the relay it last used, ${relay}, is remembered here.`,
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
            // The ordinary cause is that the roster has not arrived yet: it is
            // read from the relay and held in memory, so an enrolled device
            // that launched offline is exactly here. Telling that person the
            // feature is half-built is the single most misleading string on
            // this screen, and it is the state a sysadmin lands in most often.
            detail: `Waiting for the device list${relay ? ` from ${relay}` : ''}. It arrives the next time this device reaches the relay.`,
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
    : sync.error !== undefined
      ? {
          // BEFORE THE TICK, and this branch did not exist.
          //
          // `lastSyncAt` is set when a pass STARTS, so a pass that failed
          // still leaves a non-null timestamp — and the last step rendered
          // "Everything this device knows about has been carried", with a
          // green tick, directly above a band saying the last sync failed and
          // why. Two contradictory statements on one screen, and the
          // reassuring one had the tick.
          key: 'current',
          title: 'Both devices agree',
          detail:
            'The last pass failed, so some changes have not been carried. The reason is below.',
          state: 'now'
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
        : others === 0
          ? {
              // "BOTH DEVICES AGREE — DONE" WITH ONE DEVICE IS A FALSE CLAIM.
              // There is no second device to agree with, so the thing the step
              // names has not happened; what has happened is that this device
              // reached the relay. Rendering it green made the checklist say
              // the setup was finished while the step above it was still the
              // one asking for a second device — a list where the later item
              // is complete and the earlier one is not.
              key: 'current',
              title: 'Both devices agree',
              detail:
                'Only this device is on the account, so there is nothing to agree with yet. Everything it knows about has been carried to the relay and is waiting there.',
              state: 'todo'
            }
          : { key: 'current', title: 'Both devices agree', detail: 'Everything this device knows about has been carried.', state: 'done' }

  return [account, device, pair, syncStep, current]
}
