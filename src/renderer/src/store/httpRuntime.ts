import { create } from 'zustand'
import type { Id } from '../../../shared/apiModel'

// Send-time state that must never be saved: the production prompt waiting on
// the user, this session's "don't ask again" choices, the request each tab is
// waiting on, and file bytes chosen for a body. All memory only; a restart
// asks again and needs the file chosen again.

export interface ProductionPrompt {
  /** "DELETE", "mutation", "WebSocket connect", "WebSocket message". */
  action: string
  /** The environment or server that makes this production. */
  target: string
  /** The route's label when it is not this machine. */
  via?: string
  /** Label for the "Don't ask again this session" checkbox. */
  skipLabel: string
}

interface HttpRuntimeState {
  prompt: ProductionPrompt | null
  /** Keys of (environment or server, action) the user said not to ask about again. */
  skip: Record<string, true>
  /** The request id each tab is waiting on. A result for any other id is stale. */
  inflight: Record<Id, string>
  /** Per tab: multipart row id, or 'body' for a binary body, to the bytes chosen this session. */
  files: Record<Id, Record<string, { name: string; bytes: ArrayBuffer }>>

  /** Called by the prompt's host. */
  answer: (send: boolean, dontAskAgain: boolean) => void
  setFile: (tabId: Id, key: string, file: { name: string; bytes: ArrayBuffer } | null) => void
}

let pending: { key: string; resolve: (send: boolean) => void } | null = null

export function resetHttpRuntimeForTests(): void {
  pending = null
}

/** Shows the prompt and resolves with the user's answer. A newer prompt declines an older one. */
export function askProduction(prompt: ProductionPrompt, skipKey: string): Promise<boolean> {
  pending?.resolve(false)
  return new Promise((resolve) => {
    pending = { key: skipKey, resolve }
    useHttpRuntime.setState({ prompt })
  })
}

export const useHttpRuntime = create<HttpRuntimeState>((set) => ({
  prompt: null,
  skip: {},
  inflight: {},
  files: {},

  answer: (send, dontAskAgain) => {
    const p = pending
    pending = null
    set((s) => ({ prompt: null, skip: send && dontAskAgain && p ? { ...s.skip, [p.key]: true } : s.skip }))
    p?.resolve(send)
  },

  setFile: (tabId, key, file) =>
    set((s) => {
      const forTab = { ...(s.files[tabId] ?? {}) }
      if (file) forTab[key] = file
      else delete forTab[key]
      return { files: { ...s.files, [tabId]: forTab } }
    })
}))
