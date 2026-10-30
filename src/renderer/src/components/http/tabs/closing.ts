import type { Id } from '../../../../../shared/apiModel'
import { useHttp } from '../../../store/http'
import { useWsSessions } from '../../../store/wsSessions'
import { toast } from '../../../store/toast'
import { useApp } from '../../../store/app'
import { keyLabel } from '../hotkeys'
import { t } from '../../../lib/i18n'

export interface ClosePlan {
  /** Saved requests with edits: one aggregate Save all / Discard / Cancel prompt covers them all. */
  dirty: Id[]
  /** Tabs holding a live WebSocket, which closing disconnects. */
  connected: Id[]
  /** What the prompt says, or null when the close needs no prompt at all. */
  prompt: string | null
}

/**
 * What closing `ids` has to ask first (§2.9). Scratch tabs never ask: their
 * draft goes onto the reopen stack. Saved tabs with edits ask once, together
 * (UX-m7). A connected WebSocket asks to disconnect (§2.12).
 */
export function planClose(ids: Id[]): ClosePlan {
  const http = useHttp.getState()
  const sessions = useWsSessions.getState().sessions
  const dirty = ids.filter((id) => http.isDirty(id))
  const connected = ids.filter((id) => ['open', 'connecting'].includes(sessions[id]?.state ?? ''))
  let prompt: string | null = null
  const name = (): string => http.requestFor(dirty[0])?.name ?? t('http.tabs.thisRequest')
  if (dirty.length === 1)
    prompt = connected.length
      ? t('http.tabs.saveChangesDisconnect', { name: name() })
      : t('http.tabs.saveChanges', { name: name() })
  else if (dirty.length > 1)
    prompt = !connected.length
      ? t('http.tabs.unsavedTabs', { count: dirty.length })
      : connected.length === 1
        ? t('http.tabs.unsavedTabsOneWs', { count: dirty.length })
        : t('http.tabs.unsavedTabsWs', { count: dirty.length, ws: connected.length })
  else if (connected.length === 1) prompt = t('http.tabs.disconnectAndClose')
  else if (connected.length > 1) prompt = t('http.tabs.disconnectManyAndClose', { count: connected.length })
  return { dirty, connected, prompt }
}

/** Closes `ids` now, focusing the successor's tab and offering the reopen. */
export function closeNow(ids: Id[]): void {
  const http = useHttp.getState()
  const scratch = ids.filter((id) => !http.tabs.find((t) => t.id === id)?.ref)
  http.closeMany(ids)
  http.setPendingClose(null)
  focusActiveTab()
  if (scratch.length) {
    const key = keyLabel('reopen-tab')
    toast(key ? t('http.tabs.closedReopen', { key }) : t('http.tabs.closed'), 'info', {
      label: t('http.tabs.reopen'),
      run: () => useHttp.getState().reopenClosed()
    })
  }
}

/** Every close goes through here: straight away when nothing is lost, else via the prompt. */
export function requestClose(ids: Id[]): void {
  if (ids.length === 0) return
  if (planClose(ids).prompt === null) closeNow(ids)
  else useHttp.getState().setPendingClose(ids)
}

/** §2.7.3: after a close, focus goes to the successor tab's button. */
export function focusActiveTab(): void {
  requestAnimationFrame(() => {
    const id = useHttp.getState().activeTab[useApp.getState().activeWorkspaceId]
    const el = id ? document.querySelector<HTMLElement>(`[data-hc-tab="${id}"]`) : null
    if (el) el.focus()
  })
}
