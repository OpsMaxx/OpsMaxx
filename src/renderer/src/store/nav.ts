import { create } from 'zustand'
import { useApp } from './app'
import { isOperateModule, type ModuleId, type OperateModuleId } from '../../../shared/modules'
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

/**
 * A prefilled job step, from wherever the operator noticed they needed one.
 *
 * DELIBERATELY NOT A JUMP THAT RUNS. `openLogTail` lands on lines because
 * reading is safe; this lands on a FILLED FORM because a service action is a
 * write on somebody's server, and the confirmation it goes through is the point
 * of the composer rather than a step to be skipped by arriving with an
 * intention.
 */
/**
 * A strictly increasing jump id.
 *
 * NOT `Date.now()`, which is what this used to be on both jump kinds. Both
 * panels ignore a jump whose nonce equals the last one they honoured -- so that
 * asking twice for the same unit re-fills rather than being swallowed -- and
 * two clicks inside one millisecond produce the SAME `Date.now()`. The second
 * one then did nothing, which is exactly the case the nonce exists to handle.
 * A counter cannot collide.
 */
let jumpSeq = 0
const nextNonce = (): number => (jumpSeq += 1)

export interface JobComposerJump {
  serverId: string
  mode: 'service'
  action: 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'
  unit: string
  nonce: number
}

/**
 * Arriving on the Operations rail with an intention, from the read panel the
 * intention was formed in.
 *
 * Three writes used to live on Monitoring: revoking a key from the key table,
 * editing a crontab from the schedule list, installing a unit from the service
 * list. They have moved to Operations, and requirement four of that move is
 * that the place they left is a POINTER rather than a hole — a control that
 * simply vanished teaches a person the feature broke, and a pointer that opens
 * the wrong page teaches them the button is broken, which is worse than no
 * pointer at all.
 *
 * One union rather than a field per consumer, unlike `logTailJump` and
 * `jobComposerJump` above. Those two are consumed by one panel each and were
 * added years apart; these three arrive on the SAME rail, are cleared by the
 * same rule, and two of them land on sub-tabs of one module — so a panel has to
 * check the kind whichever way this is stored, and three near-identical fields
 * would only spread that check out.
 *
 * DELIBERATELY NOT A JUMP THAT RUNS, for exactly the reason `JobComposerJump`
 * states: `openLogTail` lands on lines because reading is safe, and every one
 * of these lands on a FILLED FORM, before its plan, before its confirmation and
 * before its approval record. The only thing a jump removes is the retyping.
 */
export type OperationsJump =
  | { kind: 'revoke-key'; fingerprint: string; nonce: number }
  | {
      kind: 'cron-edit'
      serverId: string
      /** The line as read, when an existing job is being changed; absent when
       *  adding. Carried verbatim because main identifies the job by its line
       *  and never by its position in the list. */
      line?: string
      schedule: string
      command: string
      /** The text after an unescaped `%`, which cron pipes to the command on
       *  stdin rather than running. Carried because it is NOT editable in the
       *  form and a change that dropped it would quietly rewrite what the job
       *  is fed — the one edit whose damage is invisible in the command line
       *  the operator is looking at. */
      input?: string
      nonce: number
    }
  | { kind: 'unit-install'; serverId: string; nonce: number }

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
  /** Consumed by LogTailPanel's `jump` prop; see LogTailJumpRequest. */
  logTailJump: LogTailJumpRequest | null
  /** Consumed by JobsPanel; see JobComposerJump. */
  jobComposerJump: JobComposerJump | null
  /** Consumed by whichever Operations panel the `kind` names; see
   *  OperationsJump. */
  operationsJump: OperationsJump | null
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
  logTailJump: null,
  jobComposerJump: null,
  operationsJump: null,
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
      nonce: nextNonce(),
      // Spread rather than assigned: an absent filter must stay absent, or a
      // jump with no window would clear one the operator had set by hand.
      ...(kind === 'unit' && filters.priority !== undefined ? { priority: filters.priority } : {}),
      ...(kind === 'unit' && filters.since !== undefined ? { since: filters.since } : {})
    }
  })
  useApp.getState().setActivity('monitor')
}

/**
 * Open the job composer with a service step filled in, on one server.
 *
 * Nothing runs. The operator still picks the wave, reads the plan and confirms,
 * which is exactly what they would have done had they typed it — the only thing
 * removed is the retyping of a unit name they are looking at.
 */
export function openServiceJob(
  serverId: string,
  action: JobComposerJump['action'],
  unit: string
): void {
  // `jobs` is an OPERATIONS tab, not a monitor one — it composes work that runs
  // on servers. Setting `monitorTab` here would leave the jump filled in on a
  // panel the Monitoring rail no longer renders, so the operator would land on
  // Overview with a prefilled composer they cannot see. Same routing the
  // openMonitor guard does, applied at the source rather than after the fact.
  useNav.setState({
    operationsTab: 'jobs',
    fleetRail: 'operations',
    jobComposerJump: { serverId, mode: 'service', action, unit, nonce: nextNonce() }
  })
  useApp.getState().setActivity('monitor')
}

/**
 * Open the Fleet Monitor on a particular panel.
 *
 * An `operate` module is ROUTED to Operations rather than refused, and that
 * matters more than it looks. Every pointer into this destination — the
 * status-bar chips, an alert's "show me", a round trip through
 * `openSettings('modules')` — was written when Monitoring held all seventeen
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

/**
 * Open the key-revocation panel on one fingerprint.
 *
 * Nothing is planned and nothing runs: the panel still reads the estate, still
 * shows which accounts are left out and why, and still asks. The operator who
 * pressed this was looking at the key in the Monitoring key table, which is the
 * one fact this carries over.
 */
export function openKeyRevoke(fingerprint: string): void {
  useNav.setState({
    operationsTab: 'keyRevoke',
    fleetRail: 'operations',
    operationsJump: { kind: 'revoke-key', fingerprint, nonce: nextNonce() }
  })
  useApp.getState().setActivity('monitor')
}

/**
 * Open the crontab editor with a job filled in, on one server.
 *
 * `jobs` rather than a tab of its own — the editor is a sub-tab there, for the
 * reason written on the sub-tab strip in OperationsView. Routing to the parent
 * module and letting the jump's `kind` pick the sub-tab keeps `OperationsTab` a
 * union of module ids: a nav pointer that could name a sub-tab of a module that
 * is switched off is a pointer at nothing.
 */
export function openCronEdit(draft: {
  serverId: string
  line?: string
  schedule: string
  command: string
  input?: string
}): void {
  useNav.setState({
    operationsTab: 'jobs',
    fleetRail: 'operations',
    operationsJump: { kind: 'cron-edit', ...draft, nonce: nextNonce() }
  })
  useApp.getState().setActivity('monitor')
}

/** Open the unit installer against one server. Same shape, same sub-tab rule. */
export function openUnitInstall(serverId: string): void {
  useNav.setState({
    operationsTab: 'jobs',
    fleetRail: 'operations',
    operationsJump: { kind: 'unit-install', serverId, nonce: nextNonce() }
  })
  useApp.getState().setActivity('monitor')
}

/** Open a page of Settings. */
export function openSettings(section: SettingsSection): void {
  useNav.setState({ settingsSection: section })
  useApp.getState().setActivity('settings')
}
