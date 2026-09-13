import { useEffect, useState } from 'react'

/**
 * Whether any rule is still armed, regardless of the Rules module switch.
 *
 * WHY THIS EXISTS. The module toggle hides panels; it does not stop the rule
 * engine, which sweeps in main and has never read `settings.modules` — see the
 * note on the `rules` entry in shared/modules.ts. Switching Rules off therefore
 * used to hide the ONLY screen that lists what is armed and the only control
 * that disarms it, while the rules carried on running jobs on the estate. A
 * switch may hide a feature; it may not hide the controls for something that is
 * still acting on your servers.
 *
 * So Monitoring asks this, and keeps the tab when the answer is yes.
 *
 * Deliberately a one-shot read rather than a subscription. The question is only
 * asked to decide whether a tab exists, the answer changes only when somebody
 * arms or disarms a rule — which they do FROM that tab, which re-renders itself
 * — and a poll here would put an IPC call on a timer for a panel most installs
 * do not have switched on. `nonce` is how a caller asks again.
 *
 * Fails CLOSED in the useful direction: a bridge that is missing or throwing
 * answers `false`, so a build without the channel does not grow a tab it cannot
 * populate. That is safe precisely because it only ever ADDS a tab the module
 * switch would otherwise have removed — the switch itself still works.
 */
export function useArmedRules(nonce = 0): boolean {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    let live = true
    const run = async (): Promise<void> => {
      try {
        const rules = (window.opsmaxx as unknown as {
          rules?: { list?: () => Promise<{ enabled?: boolean }[]> }
        } | undefined)?.rules
        if (typeof rules?.list !== 'function') return
        const list = await rules.list()
        if (live) setArmed(Array.isArray(list) && list.some((r) => r?.enabled === true))
      } catch {
        // A build without the channel, or a read that failed. Either way this is
        // not worth a toast: the module switch still does what it says, and the
        // only thing lost is the override that keeps the tab visible.
      }
    }
    void run()
    return () => {
      live = false
    }
  }, [nonce])

  return armed
}
