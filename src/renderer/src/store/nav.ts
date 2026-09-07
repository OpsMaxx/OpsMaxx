import { create } from 'zustand'
import { useApp } from './app'
import { isOperateModule, type ModuleId, type OperateModuleId } from '../../../shared/modules'

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
 *  fixed; the rest are whichever optional modules are enabled.
 *
 *  Deliberately still the WHOLE `ModuleId` union rather than the read half.
 *  Every existing caller passes a tab it worked out from a module id, and
 *  narrowing this type would turn `openMonitor('patch')` from something
 *  `openMonitor` can route into a compile error at each of those call sites —
 *  pushing the routing decision back out to the callers, which is the thing
 *  this file exists to stop. `openMonitor` sorts it out instead. */
export type MonitorTab = 'overview' | 'alerts' | ModuleId

/** Which panel of Operations is showing. Only `operate` modules live here, and
 *  the union is narrow on purpose: there is no such thing as an Operations tab
 *  for a read-only module, so it must not be possible to name one. */
export type OperationsTab = OperateModuleId

/**
 * Which of the two fleet destinations the main area is showing.
 *
 * Monitoring and Operations are separate destinations with separate icons in
 * the activity bar, but they are ONE mounted component tree — see FleetMonitor,
 * which hosts both. That is not an implementation shortcut, it is the
 * requirement: LogTailPanel stops its remote command on unmount and
 * BroadcastPanel holds a live run, so a split that unmounted one side would
 * kill a tail every time somebody went to look at a patch plan. Switching rail
 * hides a subtree; it never tears one down.
 */
export type FleetRail = 'monitor' | 'operations'

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
  /** The Operations tab, held here for the same reason as `monitorTab`. */
  operationsTab: OperationsTab
  /** Which of the two fleet destinations is showing. See FleetRail. */
  fleetRail: FleetRail
  setAiSection: (s: AiSection) => void
  setSettingsSection: (s: SettingsSection) => void
  setMonitorTab: (t: MonitorTab) => void
  setOperationsTab: (t: OperationsTab) => void
  clearAiGroup: () => void
}

export const useNav = create<NavState>((set) => ({
  aiSection: 'overview',
  aiGroupId: null,
  settingsSection: 'appearance',
  monitorTab: 'overview',
  // Broadcast rather than patch, because it is the cheaper thing to land on:
  // an empty command box does nothing until it is filled in, where the patch
  // planner starts computing a plan against the estate the moment it is shown.
  operationsTab: 'broadcast',
  fleetRail: 'monitor',
  setAiSection: (s) => set({ aiSection: s, aiGroupId: null }),
  setSettingsSection: (s) => set({ settingsSection: s }),
  setMonitorTab: (t) => set({ monitorTab: t }),
  setOperationsTab: (t) => set({ operationsTab: t }),
  clearAiGroup: () => set({ aiGroupId: null })
}))

/** Open a page of AI & MCP, optionally on a particular access group. */
export function openAi(section: AiSection, groupId?: string | null): void {
  useNav.setState({ aiSection: section, aiGroupId: groupId ?? null })
  useApp.getState().setActivity('ai')
}

/**
 * Open the Fleet Monitor on a particular panel.
 *
 * An `operate` module is ROUTED to Operations rather than refused, and that
 * matters more than it looks. Every pointer into this destination — the
 * status-bar chips, an alert's "show me", a round trip through
 * `openSettings('modules')` — was written when Monitoring held all fifteen
 * modules. Splitting the destination underneath them would have turned each of
 * those into a click that opens Monitoring and shows Overview, which is the
 * failure this whole file was written against: a pointer that opens the wrong
 * place is worse than no pointer, because it teaches the user the button is
 * broken rather than that the feature is elsewhere.
 *
 * So the split is invisible to callers. `openMonitor('patch')` lands on the
 * patch planner; it simply lands on it in Operations.
 */
export function openMonitor(tab: MonitorTab): void {
  if (tab !== 'overview' && tab !== 'alerts' && isOperateModule(tab)) {
    openOperations(tab)
    return
  }
  useNav.setState({ monitorTab: tab, fleetRail: 'monitor' })
  useApp.getState().setActivity('monitor')
}

/** Open Operations on a particular panel. */
export function openOperations(tab: OperationsTab): void {
  useNav.setState({ operationsTab: tab, fleetRail: 'operations' })
  useApp.getState().setActivity('monitor')
}

/** Open a page of Settings. */
export function openSettings(section: SettingsSection): void {
  useNav.setState({ settingsSection: section })
  useApp.getState().setActivity('settings')
}
