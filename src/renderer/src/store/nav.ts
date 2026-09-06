import { create } from 'zustand'
import { useApp } from './app'
import type { ModuleId } from '../../../shared/modules'
import type { LogPriority } from '../../../shared/logtail'

// Which page of AI & MCP, and which page of Settings, is open. Both used to be
// local `useState` inside their panel, which meant nothing outside the panel
// could point at anything inside it — so a message about an access group, the
// bridge or an update could only *name* the place and leave the user to find
// it. Holding the section here is what lets a button do the walking.

export type AiSection = 'overview' | 'agents' | 'groups' | 'sessions' | 'approvals' | 'audit' | 'security'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'connections'
  | 'ssh'
  | 'security'
  | 'sftp'
  | 'monitoring'
  | 'modules'
  | 'editor'
  | 'shortcuts'
  | 'backup'
  | 'notifications'
  | 'advanced'

/** Which panel of the Fleet Monitor is showing. `overview` and `alerts` are
 *  fixed; the rest are whichever optional modules are enabled. */
export type MonitorTab = 'overview' | 'alerts' | ModuleId

/**
 * A jump into the log tail asked for from elsewhere in the monitor -- item 43.
 *
 * `LogTailPanel` has taken a `jump` prop since it shipped, and its own comment
 * names the caller this is for: "the failed-unit list is the one that matters".
 * Nothing ever passed it. This is the other half.
 *
 * Held in nav rather than lifted into FleetMonitor's state for the reason
 * `monitorTab` is: the failed-unit list is several components down, and
 * threading a setter through them to reach a sibling is how that prop came to
 * be unused in the first place.
 *
 * `nonce` rather than a value comparison, because tailing the same unit on the
 * same server twice in a row is a thing people do -- LogTailJump's own note.
 */
export interface LogTailJumpRequest {
  kind: 'unit' | 'file' | 'container'
  target: string
  serverId: string
  nonce: number
  /** journald filters, carried through a jump so an alert can land on the
   *  window that explains it rather than on the whole unit's history. Unit
   *  jumps only; the panel ignores them for files and containers, which is the
   *  same rule `validateLogSource` enforces. */
  priority?: LogPriority
  since?: string
}

interface NavState {
  aiSection: AiSection
  /** An access group the Access Groups page should open on, set by whoever
   *  sent the user there. Cleared as soon as it has been honoured, so coming
   *  back later does not silently re-select a group the user has moved on from. */
  aiGroupId: string | null
  settingsSection: SettingsSection
  /**
   * Held here rather than in FleetMonitor's own useState, for exactly the
   * reason at the top of this file: the status-bar alert chip is a pointer at
   * the inbox, and a pointer that can only open the page and not the tab is a
   * chip that says "it is in here somewhere". The panels still stay mounted —
   * this moves which one is visible, not whether it exists.
   */
  monitorTab: MonitorTab
  /** Consumed by LogTailPanel's `jump` prop; see LogTailJumpRequest. */
  logTailJump: LogTailJumpRequest | null
  setAiSection: (s: AiSection) => void
  setSettingsSection: (s: SettingsSection) => void
  setMonitorTab: (t: MonitorTab) => void
  clearAiGroup: () => void
}

export const useNav = create<NavState>((set) => ({
  aiSection: 'overview',
  aiGroupId: null,
  settingsSection: 'appearance',
  monitorTab: 'overview',
  logTailJump: null,
  setAiSection: (s) => set({ aiSection: s, aiGroupId: null }),
  setSettingsSection: (s) => set({ settingsSection: s }),
  setMonitorTab: (t) => set({ monitorTab: t }),
  clearAiGroup: () => set({ aiGroupId: null })
}))

/** Open a page of AI & MCP, optionally on a particular access group. */
export function openAi(section: AiSection, groupId?: string | null): void {
  useNav.setState({ aiSection: section, aiGroupId: groupId ?? null })
  useApp.getState().setActivity('ai')
}

/**
 * Open the log tail on one unit on one server, and start it.
 *
 * It lands on LINES rather than on a filled-in form, which is LogTailPanel's
 * own decision about what a jump means: somebody who clicked a failed unit
 * asked to see its log, not to be shown a form about it.
 */
export function openLogTail(
  serverId: string,
  target: string,
  kind: LogTailJumpRequest['kind'] = 'unit',
  filters: { priority?: LogPriority; since?: string } = {}
): void {
  useNav.setState({
    monitorTab: 'logTail',
    logTailJump: {
      kind,
      target,
      serverId,
      nonce: Date.now(),
      // Spread rather than assigned: an absent filter must stay absent, or a
      // jump with no window would clear one the operator had set by hand.
      ...(kind === 'unit' && filters.priority !== undefined ? { priority: filters.priority } : {}),
      ...(kind === 'unit' && filters.since !== undefined ? { since: filters.since } : {})
    }
  })
  useApp.getState().setActivity('monitor')
}

/** Open the Fleet Monitor on a particular panel. */
export function openMonitor(tab: MonitorTab): void {
  useNav.setState({ monitorTab: tab })
  useApp.getState().setActivity('monitor')
}

/** Open a page of Settings. */
export function openSettings(section: SettingsSection): void {
  useNav.setState({ settingsSection: section })
  useApp.getState().setActivity('settings')
}
