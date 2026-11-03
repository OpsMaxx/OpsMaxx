import { useEffect, useRef } from 'react'
import { useVault } from '../store/vault'

/**
 * Keep asking the OS while biometrics are switched on but unavailable, and say
 * when they come back.
 *
 * "Unavailable" is usually not a fact about the machine but about this moment.
 * After a sleep the terminal reconnects on `resume`, which macOS fires at the
 * lock screen -- before anyone has unlocked it -- and the reconnect opens the
 * vault prompt there. Touch ID is refused to apps while the screen is locked
 * (and while the lid is shut on an external display), so the one check the
 * prompt made said "unavailable" and nothing ever asked again. The user
 * unlocked the screen into a password field and an error about a fingerprint
 * they had enrolled; closing the dialog and reconnecting "fixed" it only
 * because a fresh dialog checks afresh.
 *
 * `onBack` is the gate's chance to re-arm its one automatic prompt: the system
 * could not ask before, so the user has not refused anything yet.
 */
export function useBioRecheck(active: boolean, onBack: () => void): void {
  const blocked = useVault((s) => s.bioEnabled && !s.bioAvailable)
  const wasBlocked = useRef(false)
  const back = useRef(onBack)
  back.current = onBack

  useEffect(() => {
    if (!active) {
      wasBlocked.current = false
      return
    }
    if (!blocked) {
      if (wasBlocked.current) {
        wasBlocked.current = false
        back.current()
      }
      return
    }
    wasBlocked.current = true
    // ponytail: polls every 2s while a gate is up and blocked; canPromptTouchID
    // is a local LAContext call, so this costs nothing worth an event channel.
    const recheck = (): void => void useVault.getState().refreshBiometrics()
    const id = window.setInterval(recheck, 2000)
    window.addEventListener('focus', recheck)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', recheck)
    }
  }, [active, blocked])
}
