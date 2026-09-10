import { describe, expect, it, beforeEach } from 'vitest'
import { useApp } from '../src/renderer/src/store/app'
import { classifyConnectionError, adviseOnError } from '../src/renderer/src/lib/connectionError'

/**
 * Dismissing a dead pane, and what a dead pane is told it did.
 *
 * Reported as "close pane button is not working": the card offered Close, the
 * click landed, and nothing happened.
 */

const reset = (): void => {
  useApp.setState({ tabs: [], panes: {}, tabSession: {}, tabCwd: {}, activeTabId: null } as never)
}

const activeTabId = (): string => useApp.getState().activeTabId as string
const panesOf = (tab: string): string[] => useApp.getState().panes[tab].panes.map((p) => p.id)

describe('closing the last pane', () => {
  beforeEach(() => {
    reset()
    useApp.setState({
      servers: [
        { id: 's1', workspaceId: 'ws-default', name: 'Box', host: 'h', port: 22, username: 'u', auth: 'key', status: 'online', tags: [], favorite: false, os: 'linux', route: [], vpnProfileId: null, demo: false }
      ]
    } as never)
  })

  it('is a no-op through closePane — which is why the button needed to not call it', () => {
    // The store refuses on purpose: closing the only pane of a tab is a TAB
    // close. A dismiss built from a render-time pane count called this anyway
    // whenever the sibling had gone since the card was drawn, and got silence.
    useApp.getState().openServer('s1')
    const tab = activeTabId()
    const [only] = panesOf(tab)

    useApp.getState().closePane(tab, only)

    expect(panesOf(tab)).toEqual([only])
    expect(useApp.getState().tabs).toHaveLength(1)
  })

  it('removes a pane while a sibling is there, and the tab once it is not', () => {
    // What the card's Close now does, decided from the store at click time
    // rather than from whatever the pane count was when it rendered.
    useApp.getState().openServer('s1')
    const tab = activeTabId()
    useApp.getState().splitPane(tab, 'v')
    const [a, b] = panesOf(tab)

    const dismiss = (paneId: string): void => {
      const now = useApp.getState().panes[tab]
      if (now && now.panes.length > 1) useApp.getState().closePane(tab, paneId)
      else useApp.getState().closeTab(tab)
    }

    dismiss(b)
    expect(panesOf(tab)).toEqual([a])
    expect(useApp.getState().tabs).toHaveLength(1)

    // The second press is now a tab close, not a refused pane close.
    dismiss(a)
    expect(useApp.getState().tabs).toHaveLength(0)
  })
})

describe('what a closed shell is told it did', () => {
  it('treats a clean exit as an exit, not as an unexplained failure', () => {
    // Typing `exit` produced "OpsMaxx could not tell what went wrong from what
    // the server said." over a session that had done exactly what it was told.
    expect(classifyConnectionError('Session closed · shell exited')).toBe('exited')
    const advice = adviseOnError('Session closed · shell exited')
    expect(advice.cause).toBe('The shell exited.')
    // Nothing to correct in a connection that worked.
    expect(advice.edit).toBe(false)
    expect(advice.retry).toBe(true)
  })

  it('still treats a non-zero exit as a failure', () => {
    // "shell exited with 1" is a shell that died, and the negative lookahead is
    // the whole difference. Classifying it as a calm exit would hide it.
    expect(classifyConnectionError('Session closed · shell exited with 1')).not.toBe('exited')
  })

  it('leaves every real failure classified as it was', () => {
    expect(classifyConnectionError('All configured authentication methods failed')).toBe('auth')
    expect(classifyConnectionError('connect ECONNREFUSED 10.0.0.4:22')).toBe('refused')
    expect(classifyConnectionError('Host key verification failed')).toBe('host-key')
    expect(classifyConnectionError('connect ETIMEDOUT')).toBe('unreachable')
  })

  it('keeps admitting it cannot explain text it does not recognise', () => {
    // The `unknown` branch exists to avoid inventing a cause. It must survive.
    expect(classifyConnectionError('flumox 42')).toBe('unknown')
  })
})
