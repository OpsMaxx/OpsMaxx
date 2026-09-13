import { useCallback, useEffect, useRef, useState } from 'react'
import { classifyConnectionError, faultAdvice } from '../lib/connectionError'

// Carrying a terminal across a reboot.
//
// Typing `reboot` used to end like this: "[session closed]", then one manual
// Reconnect, then "Connection lost before handshake" over a card saying OpsMaxx
// could not tell what went wrong. Every word of that is true and none of it is
// useful — the user knows what went wrong, they rebooted the box. The app knew
// enough to wait thirty seconds and try again, and did not.
//
// WHY THIS IS NOT ARMED BY SPOTTING `reboot`.
//
// Because the app deliberately cannot see it. Shell integration injects OSC 133
// and stops there: `shared/shellIntegration.ts` says in as many words that
// `633;E`, the command line itself, is left out because "a snippet that reports
// command text is a keylogger with a friendly name" — and it is not injected
// into remote sessions at all, so an SSH tab emits no marks unless the far
// host's own dotfiles do. Detecting the command would therefore mean reading
// keystrokes or scraping the scrollback, which is building precisely the
// recording this codebase refuses to build, for a signal that aliases, scripts,
// sudo wrappers and a reboot ordered from another session all defeat anyway.
//
// So recovery arms on the ENDING, not on the command — and the ending is a
// better discriminator than it looks, for the reason in `shouldAutoRecover`.

/**
 * How long to wait before each attempt, then 30s for the rest of the budget.
 *
 * The first two are short because the cheapest thing this can recover is not a
 * reboot at all — a flapping link, a Wi-Fi handover, a container that restarted
 * in two seconds — and making that case wait half a minute would be its own
 * annoyance. After that it backs off to 30s, which is the number that matters:
 * once the machine IS back, it is the longest the user waits to find out.
 * Tighter would spend the budget knocking on a door nobody is behind yet —
 * sshd is one of the last things to come up.
 */
export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

/**
 * How long to keep trying in total, measured from the drop.
 *
 * A reboot is 30–90 seconds; a slow one — fsck, a cloud instance waiting on its
 * hypervisor, a kernel upgrade regenerating an initramfs — is a few minutes.
 * Five covers those and stops well short of pretending a decommissioned host is
 * coming back. When it runs out the card says so and the Reconnect button is
 * still there, so the budget is a limit on unattended retrying, not on trying.
 */
export const RECOVERY_BUDGET_MS = 5 * 60_000

/** The wait before attempt `n` (1-based), holding at the last step. */
export function recoveryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]
}

/**
 * Is this ending one that a server coming back would fix?
 *
 * TWO RULES, AND THE FIRST ONE IS THE SAFETY PROPERTY.
 *
 * 1. Never an authentication failure. `ssh.ts` has already paid for that
 *    lesson: a background sweep answered a keyboard-interactive challenge with
 *    `finish([])` every interval, tripped MaxAuthTries and fail2ban, and locked
 *    the user out of their own interactive sessions. `faultAdvice().retry` is
 *    where this codebase already records which faults a retry cannot fix —
 *    auth, a changed host key, a missing key file, a key needing a passphrase,
 *    an OS refusal — so this asks that rather than keeping a second list that
 *    could drift away from the buttons the card offers.
 *
 * 2. Never a shell that ran and finished. `exit`, and `shell exited with 3`,
 *    are the far side doing what it was told; a machine going away does not
 *    hand back an exit code. Without this a container whose image has no shell
 *    (`shell exited with 127`) would be dialled once a minute for five minutes.
 *
 * What is left — a bare "Session closed", "Connection lost before handshake",
 * ECONNREFUSED, a timeout, a SIGHUP — is the network-shaped half, and that is
 * what gets retried.
 *
 * Note where this is asked from: the CLOSE of a session, or the failure of an
 * attempt that followed one. A session that closed had already authenticated,
 * which is why an ordinary reboot cannot be mistaken for a credential problem
 * no matter how vague its close reason is. And if the first attempt after it
 * comes back as `auth`, rule 1 stops the run there — so a recovering session
 * costs a host at most the single failed authentication a user pressing
 * Reconnect once would have cost it.
 */
export function shouldAutoRecover(reason: string | null | undefined): boolean {
  if (!reason) return false
  if (/shell exited/i.test(reason)) return false
  return faultAdvice(classifyConnectionError(reason)).retry
}

/**
 * Forget the pooled connection to a server, so the next dial is a real one.
 *
 * The pool is a ControlMaster: without this the reconnect after a drop is
 * handed the very socket the drop happened on. A server that closed cleanly
 * self-evicts through ssh2's own `close` event, but one that was reset or
 * powered off does not — its entry sits there looking usable for as long as TCP
 * takes to notice, which is exactly the reboot case.
 *
 * Eviction, not `poolClose`: closing would cut every other pane and the metrics
 * sampler riding the same connection. See `poolEvictServer` in main.
 */
export async function evictPooledConnection(serverId: string | undefined): Promise<void> {
  if (!serverId) return
  try {
    await window.opsmaxx?.ssh?.poolEvict?.(serverId)
  } catch {
    /* A pool we could not reach is not a reason to skip the attempt. */
  }
}

export interface RecoveryState {
  /** A run is under way: an attempt is scheduled or in flight. */
  active: boolean
  /** Which attempt, 1-based. */
  attempt: number
  /** Seconds until the next attempt; 0 while one is in flight. */
  nextInSec: number
  /** The budget ran out without getting back in. */
  exhausted: boolean
}

const IDLE: RecoveryState = { active: false, attempt: 0, nextInSec: 0, exhausted: false }

/**
 * Reconnect on a backoff after an eligible drop, until it works or the budget
 * is spent.
 *
 * `dead` is why the session ended, or null while it is alive; `online` is the
 * session reaching `ready`, which is the only unambiguous success signal — a
 * failed attempt is `dead` going from null back to a string, and without a
 * separate success edge the two are indistinguishable.
 *
 * `dial` must be the RAW reconnect. The wrapper a user's Reconnect button goes
 * through cancels this run first, and handing that one back to the loop would
 * make every scheduled attempt cancel itself.
 */
export function useSessionRecovery(
  dead: string | null,
  online: boolean,
  dial: () => void,
  serverId?: string
): { recovery: RecoveryState; cancelRecovery: () => void } {
  const [recovery, setRecovery] = useState<RecoveryState>(IDLE)
  // The run itself is mutable bookkeeping rather than state: it changes inside
  // timer callbacks that must see the current value, not the one captured when
  // the effect that armed them ran.
  const run = useRef<{ deadline: number; attempt: number; awaiting: boolean } | null>(null)
  // Set by a cancel, a manual Reconnect and an exhausted budget alike. It is
  // what stops a new run arming behind the user's back after they have taken
  // over; only a session actually coming up clears it.
  const stopped = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null)
  // Read through refs so the scheduled attempt uses the current transport
  // without every reschedule depending on the identity of a callback.
  const dialRef = useRef(dial)
  dialRef.current = dial
  const serverRef = useRef(serverId)
  serverRef.current = serverId

  const clearTimers = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    if (ticker.current) clearInterval(ticker.current)
    timer.current = null
    ticker.current = null
  }, [])

  const cancelRecovery = useCallback(() => {
    clearTimers()
    run.current = null
    stopped.current = true
    setRecovery(IDLE)
  }, [clearTimers])

  // Nothing outlives the pane.
  useEffect(() => clearTimers, [clearTimers])

  // A session that came up is the end of the run, and the only thing that lets
  // a later drop arm a new one.
  useEffect(() => {
    if (!online) return
    clearTimers()
    run.current = null
    stopped.current = false
    setRecovery(IDLE)
  }, [online, clearTimers])

  useEffect(() => {
    if (!dead) return
    const current = run.current

    // `awaiting` distinguishes the two ways `dead` can become a string: an
    // attempt this loop made coming back failed, or a session ended on its own.
    if (current?.awaiting) {
      current.awaiting = false
      if (!shouldAutoRecover(dead)) {
        // An attempt that failed for a reason retrying cannot fix — the host
        // came back with a different key, or the credential is gone. Stop and
        // let the ordinary card say so.
        clearTimers()
        run.current = null
        stopped.current = true
        setRecovery(IDLE)
        return
      }
    } else {
      if (stopped.current) return
      // A countdown is already running. One session can set `dead` twice — a
      // status error and the connect promise rejecting describe the same
      // failure — and treating the second as a fresh ending would restart the
      // schedule and push the deadline out with it.
      if (timer.current) return
      if (!shouldAutoRecover(dead)) return
      run.current = { deadline: Date.now() + RECOVERY_BUDGET_MS, attempt: 0, awaiting: false }
    }

    const active = run.current
    if (!active) return
    const attempt = active.attempt + 1
    const delay = recoveryDelay(attempt)
    if (Date.now() + delay > active.deadline) {
      clearTimers()
      run.current = null
      stopped.current = true
      setRecovery({ active: false, attempt: active.attempt, nextInSec: 0, exhausted: true })
      return
    }

    active.attempt = attempt
    setRecovery({ active: true, attempt, nextInSec: Math.ceil(delay / 1000), exhausted: false })
    clearTimers()
    ticker.current = setInterval(() => {
      setRecovery((s) => (s.nextInSec > 0 ? { ...s, nextInSec: s.nextInSec - 1 } : s))
    }, 1_000)
    timer.current = setTimeout(() => {
      clearTimers()
      const live = run.current
      if (!live) return
      live.awaiting = true
      setRecovery((s) => ({ ...s, nextInSec: 0 }))
      // Evict first, then dial. The order is the point: a reconnect handed the
      // socket the reboot killed fails in a way that looks like the server is
      // still down.
      void evictPooledConnection(serverRef.current).finally(() => {
        if (run.current?.awaiting) dialRef.current()
      })
    }, delay)
    // `dead` is the whole trigger; everything else is read through a ref
    // precisely so a re-render cannot restart a scheduled attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dead])

  return { recovery, cancelRecovery }
}
