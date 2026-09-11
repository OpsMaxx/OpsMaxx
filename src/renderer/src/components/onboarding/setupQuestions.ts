import type { ModuleId, ModuleState } from '../../../../shared/modules'

/**
 * The questions a first run asks before the app is handed over.
 *
 * Twenty modules ship in this app and fifteen of them used to arrive off, with
 * nothing anywhere that asked. A new install was a terminal and an empty
 * Operations rail, and the only route to the rest was Settings › Modules — a
 * page you have to already know exists. That is the whole reason this file is
 * here: not to explain the modules, but to ask.
 *
 * Why questions rather than better defaults. Half of these turn on work against
 * machines the user does not own: running a package manager on every host, or
 * executing a command across the estate. A default cannot ask, and `an upgrade
 * is not consent` is the rule the module registry is already built around
 * (see backfillModules). A tick box the user saw and left ticked IS consent;
 * a default they never saw is not. So the modules that only read local history
 * or an already-open connection default on, and everything that reaches out
 * lives here.
 *
 * Why one screen and not a wizard. This audience closes multi-step wizards.
 * Three groups, all visible, Enter to accept — the whole thing is answerable
 * without reading it, and readable by anyone who wants to.
 */
export interface SetupQuestion {
  id: string
  /** Asked in the second person, answerable without knowing the product. */
  question: string
  /** What ticking it turns on, in the user's terms rather than module ids. */
  detail: string
  /** The honest cost, shown whether or not it flatters the answer. */
  cost: string
  modules: ModuleId[]
  /**
   * Ticked when the card opens.
   *
   * Only for answers whose modules read and never write. Somebody who presses
   * Enter without reading gets a fuller app than they had before and nothing
   * that touches a server they have not already opened.
   */
  preselected: boolean
}

export const SETUP_QUESTIONS: SetupQuestion[] = [
  {
    id: 'containers',
    question: 'Do you work with containers?',
    detail: 'Docker and Kubernetes panels on every server — containers, pods, logs, and a shell inside a running container.',
    cost: 'Reads only, and nothing runs until you open the panel.',
    modules: ['docker', 'kubernetes'],
    preselected: true
  },
  {
    id: 'fleet',
    question: 'Do you look after a fleet, or a couple of machines?',
    detail:
      'Inventory, configuration drift, a change log and a security posture table across every server in the workspace.',
    cost: 'These read every host on a schedule, including running its package manager once an hour.',
    modules: ['inventory', 'drift', 'changeLog', 'posture'],
    preselected: false
  },
  {
    id: 'operate',
    question: 'Do you change servers from here, or only watch them?',
    detail: 'Run a command across many servers at once, plan and apply package updates, and leave long jobs running.',
    cost: 'This is the half of the app that writes to your servers.',
    modules: ['broadcast', 'patch', 'jobs'],
    preselected: false
  }
]

/**
 * Fold the answers into the module state.
 *
 * A false answer turns its modules OFF rather than leaving them alone: the
 * card shows what each answer controls, so somebody who unticks containers has
 * said something about Docker, and honouring only the ticks would make the
 * card a one-way switch that quietly disagrees with what it displayed.
 *
 * Modules not named by any question are untouched. That is deliberate and it
 * is the safe direction — `rules` (the only unattended execution path),
 * `keyRevoke` and `access` are reachable from Settings and from nowhere else,
 * which is the protection they were given on purpose.
 */
export function applySetupAnswers(base: ModuleState, answers: Record<string, boolean>): ModuleState {
  const next: ModuleState = { ...base }
  for (const q of SETUP_QUESTIONS) {
    const on = answers[q.id] === true
    for (const id of q.modules) next[id] = on
  }
  return next
}

/** What the card starts with, before the user touches anything. */
export function defaultSetupAnswers(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const q of SETUP_QUESTIONS) out[q.id] = q.preselected
  return out
}
