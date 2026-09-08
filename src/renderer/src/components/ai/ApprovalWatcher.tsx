import { useEffect } from 'react'
import { nextUndeferred, startApprovalQueue, useApprovalQueue } from '../../store/approvalQueue'
import { ApprovalDialog } from './ApprovalDialog'

// Mounted once at the app root so an approval request surfaces no matter
// which tab the user is on — an AI agent waiting on a sudo command should not
// require the user to already be looking at AI & MCP > Approvals.
//
// The queue itself moved to store/approvalQueue.ts. This component is now only
// the mount point: it starts the one subscription and renders whichever request
// is at the front and has not been deferred. The status-bar chip reads the same
// store, which is what makes a deferred request findable again instead of
// invisible until it times out.
export function ApprovalWatcher(): React.JSX.Element | null {
  const pending = useApprovalQueue((s) => s.pending)
  const deferred = useApprovalQueue((s) => s.deferred)

  useEffect(() => startApprovalQueue(), [])

  const current = nextUndeferred(pending, deferred)
  if (!current) return null

  return <ApprovalDialog request={current} waiting={pending.length} />
}
