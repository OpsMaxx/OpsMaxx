import { describe, it, expect } from 'vitest'

import {
  APPROVAL_SURFACES,
  isCommandApproval,
  type ApprovalSurface,
  type CommandApproval
} from '../src/shared/broadcast'

// ONE VOCABULARY, in two places that have to agree: the TYPE says which
// surfaces exist, and APPROVAL_SURFACES is the RUNTIME list isCommandApproval
// validates against. A member added to one and not the other is not a type
// error -- it is an approval the verifier rejects at run time, on a build that
// compiled -- which is how `JobApprovalEntry.surface` came to be its own
// narrower copy that did not know about `k8s-exec`.

// Adding a member to ApprovalSurface makes THIS fail to compile, which is the
// point: the compiler asks for the test to be updated, and the test then asks
// for the runtime list.
const EVERY: Record<ApprovalSurface, true> = {
  broadcast: true,
  job: true,
  'k8s-exec': true,
  access: true,
  k8s: true,
  'db-statement': true
}

function approval(surface: ApprovalSurface): CommandApproval {
  return {
    v: 1,
    surface,
    commands: ['systemctl restart nginx'],
    targets: [{ serverId: 's1', serverName: 'edge-01' }],
    risk: 'elevated',
    confirmation: { kind: 'confirm' },
    phrase: null,
    confirmedAt: 1_700_000_000_000
  }
}

describe('the approval surfaces the log can describe', () => {
  it('lists at run time exactly the surfaces the type declares', () => {
    expect([...APPROVAL_SURFACES].sort()).toEqual(Object.keys(EVERY).sort())
  })

  it('accepts an approval from every one of them', () => {
    for (const s of APPROVAL_SURFACES) {
      expect(isCommandApproval(approval(s)), s).toBe(true)
    }
  })

  it('still refuses a surface nobody declared', () => {
    expect(isCommandApproval({ ...approval('job'), surface: 'sftp' })).toBe(false)
  })
})
