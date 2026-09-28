import type { JobSpec, JobStep } from './jobs'

// Item 34a: the first TYPED step kind.
//
// The difference from item 33's free-text composer is the whole point of item
// 34. A free-text step is a line somebody typed; a typed step is an ACTION and
// a UNIT, checked here, with the command built from them. The approval record
// then holds structured intent rather than a string, and the things that must
// never be typed by accident can be refused before anything is confirmed.
//
// WHY THE COMMAND IS STILL BUILT AS TEXT. `verifyApproval` compares the step
// text literally, so a spec whose command was substituted per server could not
// be checked against the record at all. The action and unit are validated, and
// then one command is produced for every server in the job.

export {
  SERVICE_ACTIONS,
  PROTECTED_UNITS,
  normaliseUnit,
  checkServiceStep,
  type ServiceAction,
  type ServiceStepCheck
} from './serviceAction'
import { serviceActionCommands, type ServiceAction } from './serviceAction'

export interface ServiceStepOpts {
  sudo?: boolean
  /** Skip the verification step. Off by default and worth a reason to turn on:
   *  without it the job reports that it ASKED, not that it worked. */
  skipVerify?: boolean
}

/**
 * The job spec for one service action.
 *
 * Two steps, not one, and the second is the point. `kind` stays `'command'`
 * because the ENGINE runs commands -- a JobKind of its own would be a second
 * execution path for no gain. What makes this typed is that the text was built
 * here from a checked action and a checked unit.
 */
export function serviceJobSpec(
  action: ServiceAction,
  unit: string,
  opts: ServiceStepOpts = {}
): JobSpec {
  const c = serviceActionCommands(action, unit, opts)
  const steps: JobStep[] = [{ command: c.action }]
  if (c.verify !== null) steps.push({ command: c.verify })
  return {
    kind: 'command',
    title: `${action[0].toUpperCase()}${action.slice(1)} ${c.unit}`,
    steps
  }
}
