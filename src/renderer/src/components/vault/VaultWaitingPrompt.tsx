import { useEffect } from 'react'
import { useApp } from '../../store/app'
import { useVault } from '../../store/vault'
import { useVaultPrompt } from '../../store/vaultPrompt'

/**
 * One sentence from the surfaces that are waiting.
 *
 * > VPN “office”, 2 CI accounts, 4 monitored servers and a backup to
 * > “wasabi-nightly” are waiting on the vault.
 *
 * Each phrase already carries its own count or name, because the thing that
 * counted it is the only thing that knows whether a name or a number is the
 * honest way to say it. This only joins them.
 *
 * Empty in, empty out — which is how the caller says "nothing is waiting"
 * without a second flag.
 */
export function waitingSentence(parts: string[]): string {
  if (parts.length === 0) return ''
  const subject =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  // "VPN “office” is waiting" and "1 CI account is waiting", but "2 CI accounts
  // are waiting". One phrase naming one thing is the only singular case, and
  // whether a phrase names one thing is in its leading count when it has one —
  // so the verb comes from the text, not from how many phrases there are.
  const lead = /^(\d+) /.exec(parts[0])
  const singular = parts.length === 1 && (!lead || lead[1] === '1')
  return `${subject} ${singular ? 'is' : 'are'} waiting on the vault.`
}

/**
 * Asked once per LAUNCH, and module scope is what makes that true.
 *
 * A ref would be per mount, and React remounts this component in development
 * (StrictMode) and again on every hot reload — both of which would re-raise a
 * dialog the user has already dismissed. The whole point of the design is that
 * this is not a nag: the surfaces each carry their own unlock affordance for
 * later, so one refusal ends the question for the session.
 */
let asked = false

/** Undo that, for a test that needs a second launch. The renderer harness
 *  restores every store between tests but cannot reach a module-level flag,
 *  and a suite where only the first test can ever see this prompt would be
 *  worse than no suite. */
export function resetVaultWaitingPromptForTests(): void {
  asked = false
}

/**
 * Ask once, at launch, naming what is waiting — docs/plans/vault-ux.md §5.1.
 *
 * The measured problem is not that people are asked too often. It is that at
 * launch the vault is locked, VPN autostart, CI discovery, the fleet sampler
 * and scheduled backups all decline, and NOTHING EVER RAISES THE QUESTION.
 * They sit dead until the user clicks something unrelated, which prompts once
 * and silently repairs all of them through `resumeChecksAfterUnlock`. This is
 * the asking; the repair already exists.
 *
 * It names real things counted from real state rather than saying "some things
 * need the vault", because a count the user can check against what they know
 * they configured is what makes the prompt worth answering. A surface that
 * cannot be counted honestly is left out rather than guessed at.
 *
 * ON WAKE, NOT ASKED AGAIN — a deliberate choice, since main locks fully on
 * `powerMonitor.on('suspend')` and the same question does apply after a
 * resume. Three reasons to let the next thing that needs the vault do the
 * asking there:
 *
 *  - the lock happens as the machine goes to SLEEP, so a dialog raised then is
 *    put on a screen somebody is walking away from, and it is stale by the
 *    time they come back;
 *  - somebody who has just woken a machine is at it, and the next thing they
 *    touch already offers an unlock — which is exactly the condition that is
 *    missing at launch, where nobody touches anything for a while;
 *  - a laptop suspends several times a day, and a prompt on each of them is
 *    the nag this design explicitly is not.
 *
 * Renders nothing: the dialog is `VaultUnlockModal`, driven through the same
 * `useVaultPrompt` request every other mid-flow gate uses, so this adds a
 * reason to ask and no second way of asking.
 */
export function VaultWaitingPrompt(): null {
  // Nothing else reads vault status at launch — VaultView, Settings and
  // VaultUnlockModal each refresh on their own mount, and none of them is
  // mounted yet. Without this, `exists` stays null and the gate below never
  // resolves either way.
  const exists = useVault((s) => s.exists)
  const refresh = useVault((s) => s.refresh)
  useEffect(() => {
    if (exists === null) void refresh()
  }, [exists, refresh])

  // Not before the saved data is in. The fleet sampler is configured from the
  // renderer's server list, so asking it what is blocked before hydration gets
  // the honest answer for an empty estate — zero — and would drop the largest
  // surface out of the sentence on every launch.
  const hydrated = useApp((s) => s.hydrated)
  const damaged = useVault((s) => s.damaged)
  const stage = useVault((s) => s.stage)

  useEffect(() => {
    if (asked || !hydrated) return
    // Nothing if the vault is already unlocked, or does not exist, or cannot
    // be opened by any password: an unlock prompt over a damaged file is the
    // dead end `VaultStatus.damaged` exists to end.
    if (exists !== true || damaged || stage !== 'locked') return
    // Set before the awaits, so a re-render while they are in flight cannot
    // start a second pass and raise the dialog twice.
    asked = true
    void (async () => {
      const vault = window.opsmaxx?.vault as
        | { waiting?: () => Promise<string[]> }
        | undefined
      // `vault.waiting` ships with the `vault:waiting` handler it calls. Until
      // both are in the running preload — which under `electron-vite dev` can
      // be a whole session behind the renderer — this reads as absent and the
      // prompt simply does not appear, rather than throwing inside an effect
      // and taking the window down with it.
      const parts = [...((await vault?.waiting?.()) ?? [])]

      // The fleet's own number, from the sampler rather than from the server
      // list, because only the sampler can give it honestly: it counts the
      // whole route (a server behind a bastion whose password is in the vault
      // is blocked however readable its own credential is) and it counts the
      // targets actually being watched. Zero — sampling switched off, nothing
      // configured — leaves the surface out instead of guessing at it.
      const blocked = (await window.opsmaxx?.fleet?.status())?.vaultBlockedCount ?? 0
      if (blocked > 0) parts.push(`${blocked} monitored server${blocked === 1 ? '' : 's'}`)

      const sentence = waitingSentence(parts)
      if (!sentence) return
      // Somebody is already being asked, by a click that beat this. `request()`
      // would replace that dialog's reason with ours, which swaps the answer to
      // what they just did for an unrelated list — and their unlock repairs
      // everything here anyway.
      if (useVaultPrompt.getState().open) return
      void useVaultPrompt.getState().request(sentence)
    })()
  }, [hydrated, exists, damaged, stage])

  return null
}
