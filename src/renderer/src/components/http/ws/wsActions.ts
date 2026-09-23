import type { HttpTabState, Id, WsRequest } from '../../../../../shared/apiModel'
import { openSocket, sendWsMessage } from '../../../lib/httpSend'
import { useApi } from '../../../store/api'
import { useHttp } from '../../../store/http'
import { EMPTY_COMPOSER, useWsSessions, type WsConnState } from '../../../store/wsSessions'
import { prettyJson } from './frames'

// What the WebSocket tab does, outside any component, so the http-send hotkey
// and the palette reach the same code as the buttons.

/** A socket exists or is being made: the upgrade's inputs are frozen. */
export const isLive = (state: WsConnState | undefined): boolean =>
  state === 'connecting' || state === 'open' || state === 'closing'

export function wsRequestOf(tab: HttpTabState | undefined): WsRequest | null {
  if (!tab) return null
  const req =
    tab.draft ?? (tab.ref?.requestId ? useApi.getState().findRequest(tab.ref.collectionId, tab.ref.requestId) : null)
  return req?.kind === 'ws' ? req : null
}

/**
 * ⌘↵ on a WebSocket tab. Connected, it sends the composer's message and never
 * disconnects: disconnecting is a click or a palette command, not a key the
 * user was pressing to talk (UX-M11). Not connected, it connects.
 */
export async function submitWs(tabId: Id): Promise<void> {
  const ws = useWsSessions.getState()
  const state = ws.sessions[tabId]?.state
  if (state === 'open') {
    const composer = ws.composers[tabId] ?? EMPTY_COMPOSER
    if (composer.text === '') return
    await sendWsMessage(tabId, composer.text)
    if (composer.clearOnSend) useWsSessions.getState().setComposer(tabId, { text: '' })
    return
  }
  if (!isLive(state)) await openSocket(tabId)
}

export function updateWs(tabId: Id, patch: Partial<WsRequest>): void {
  const tab = useHttp.getState().tabs.find((t) => t.id === tabId)
  const req = wsRequestOf(tab)
  if (req) useHttp.getState().updateDraft(tabId, { ...req, ...patch })
}

/** ⌥⌘B: pretty-prints a JSON composer message. A non-JSON message is left alone. */
export function beautifyWs(tabId: Id): void {
  const ws = useWsSessions.getState()
  const text = (ws.composers[tabId] ?? EMPTY_COMPOSER).text
  const pretty = prettyJson(text)
  if (pretty !== null) ws.setComposer(tabId, { text: pretty, format: 'json' })
}
