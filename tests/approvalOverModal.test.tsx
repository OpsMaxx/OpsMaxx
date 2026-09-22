// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { Modal } from '../src/renderer/src/components/common/Modal'
import { ContextMenu } from '../src/renderer/src/components/connections/ContextMenu'
import { Toasts } from '../src/renderer/src/components/common/Toasts'
import { ApprovalWatcher } from '../src/renderer/src/components/ai/ApprovalWatcher'
import { toast } from '../src/renderer/src/store/toast'
import type { ApprovalRequest } from '../src/shared/mcp'

// An approval paints above every Modal (`--z-approval`), but it is not part of
// the Modal stack, so the Modal underneath still believed it was on top. A
// mousedown on Deny was "outside" it and closed it, and so did an Escape. The
// SFTP overwrite dialog closes by cancelling, so answering an AI approval
// cancelled an upload batch. Toasts sit above Modals the same way.

const approval: ApprovalRequest = {
  id: 'appr-1',
  sessionId: 'sess-1',
  agentName: 'Claude Code',
  workspaceId: 'ws-1',
  workspaceName: 'Personal',
  serverId: 'srv-1',
  serverName: 'web-1',
  capability: 'sudo',
  action: 'sudo systemctl restart cron',
  risk: 'high',
  createdAt: new Date().toISOString(),
  status: 'pending'
}

function withApproval(): ReturnType<typeof vi.fn> {
  const respondApproval = vi.fn(async () => true)
  stubBridge({
    aiMcp: {
      listApprovals: async () => [approval],
      getConfig: async () => ({ approvalTimeoutSeconds: 120 }),
      listSessions: async () => [],
      listAudit: async () => [],
      respondApproval,
      onApprovalEvent: () => () => undefined
    }
  })
  return respondApproval
}

describe('an approval over an open dialog', () => {
  it('answering it does not close the dialog underneath', async () => {
    const respond = withApproval()
    const onClose = vi.fn()
    render(
      <>
        <Modal title="Replace 3 files?" onClose={onClose}>
          <span>body</span>
        </Modal>
        <ApprovalWatcher />
      </>
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    expect(respond).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an Escape while it is up does not close the dialog underneath', async () => {
    withApproval()
    const onClose = vi.fn()
    render(
      <>
        <Modal title="Replace 3 files?" onClose={onClose}>
          <span>body</span>
        </Modal>
        <ApprovalWatcher />
      </>
    )
    await screen.findByRole('button', { name: 'Deny' })

    await userEvent.keyboard('{Escape}')

    expect(onClose).not.toHaveBeenCalled()
    // The approval itself is still there to be answered.
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
  })

  it('nor does a context menu close under it', async () => {
    withApproval()
    const onClose = vi.fn()
    render(
      <>
        <ContextMenu x={0} y={0} entries={[{ label: 'Rename', onClick: () => undefined }]} onClose={onClose} />
        <ApprovalWatcher />
      </>
    )

    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Deny' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the same, without an approval', () => {
  it('clicking a toast does not close the dialog underneath', async () => {
    stubBridge({})
    const onClose = vi.fn()
    render(
      <>
        <Modal title="Replace 3 files?" onClose={onClose}>
          <span>body</span>
        </Modal>
        <Toasts />
      </>
    )
    toast('Upload finished', 'ok')

    fireEvent.mouseDown(await screen.findByText('Upload finished'))

    expect(onClose).not.toHaveBeenCalled()
  })

  // The guard must not become "never close": with nothing above it, outside
  // clicks and Escape still dismiss.
  it('still closes on an outside click and on Escape', () => {
    stubBridge({})
    const onClose = vi.fn()
    render(
      <Modal title="Replace 3 files?" onClose={onClose}>
        <span>body</span>
      </Modal>
    )

    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
