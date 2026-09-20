// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { stubBridge } from './setup/renderer'
import { AiAuditLog } from '../src/renderer/src/components/ai/AiAuditLog'
import type { AuditEntry } from '../src/shared/mcp'

// The audit log's failure mode was that it had none you could see.
//
// `appendLogLine` refuses a symlink at the audit path, and a file owned by
// another uid. Both refusals are right, and `tests/auditLog.test.ts` already
// covers the main-process half: the reason is remembered and it clears when the
// cause is gone. What was missing was anyone reading it. An install in either
// state wrote zero rows from then on while `listAudit` kept returning the rows
// from before, so the view did not look broken, it looked QUIET — and for the
// one file SECURITY.md offers as the record of what an AI agent did on
// somebody's servers, quiet is the worst of the available failure modes.
//
// So these tests are about the wire, not the flag. They fail if the view stops
// asking.

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 'audit-1',
    timestamp: '2026-09-20T10:00:00.000Z',
    agentName: 'Claude Code',
    workspaceName: 'Personal',
    serverName: 'k3s-node-01',
    action: 'systemctl status cron',
    outcome: 'allowed',
    ...over
  } as AuditEntry
}

describe('the audit view, when the log has stopped accepting appends', () => {
  it('says so, instead of showing the rows from before as if they were current', async () => {
    stubBridge({
      aiMcp: {
        listAudit: async (): Promise<AuditEntry[]> => [entry()],
        auditFailure: async (): Promise<string | null> =>
          'refusing to append: /Users/x/opsmaxx-ai-audit.jsonl is a symlink'
      }
    })
    render(<AiAuditLog />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/stopped recording/i)
    // The reason itself, not just a generic banner: "appends are failing, and
    // here is why" is what a reader can act on.
    expect(alert.textContent).toMatch(/symlink/)
  })

  it('is the ONLY thing on screen that contradicts an empty list', async () => {
    // The dangerous shape. Zero rows and a refused append look identical
    // without this, and the empty state says "No AI activity recorded yet" —
    // which is a claim about the servers, not about the file, and is false.
    stubBridge({
      aiMcp: {
        listAudit: async (): Promise<AuditEntry[]> => [],
        auditFailure: async (): Promise<string | null> => 'not ours: owned by uid 0'
      }
    })
    render(<AiAuditLog />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/not a complete record/i)
    expect(screen.getByText(/No AI activity recorded yet/i)).toBeTruthy()
  })

  it('shows nothing at all when appends are working', async () => {
    stubBridge({
      aiMcp: {
        listAudit: async (): Promise<AuditEntry[]> => [entry()],
        auditFailure: async (): Promise<string | null> => null
      }
    })
    render(<AiAuditLog />)

    await waitFor(() => expect(screen.getByText(/systemctl status cron/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders against a bridge with no auditFailure at all', async () => {
    // An older preload, or a partial stub in another test file. The optional
    // call must not take the whole panel down with it — the rows are still
    // worth showing.
    stubBridge({ aiMcp: { listAudit: async (): Promise<AuditEntry[]> => [entry()] } })
    render(<AiAuditLog />)

    await waitFor(() => expect(screen.getByText(/systemctl status cron/)).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
