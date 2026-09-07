import { create } from 'zustand'
import type {
  InspectFlow,
  InspectPinnedHost,
  InspectStartOptions,
  InspectStatus
} from '../../../../shared/inspect'

// The traffic inspector's renderer state.
//
// A store rather than component state for one reason: flows arrive whether or
// not the panel is mounted. Someone who starts capture, switches to a terminal
// to run the command they are debugging, and comes back would otherwise find
// an empty list — which is the exact moment the tool has to work.
//
// The list is capped here as well as in main. Main's ring is what a newly
// opened panel is backfilled from; this one is what the window holds, and a
// window that grows without limit while a build downloads its dependencies is
// a window that stops responding.

/** Matches main's ring, so a panel that has been open all along and one that
 *  has just been opened show the same thing. */
const MAX_FLOWS = 2_000

interface InspectState {
  status: InspectStatus | null
  flows: InspectFlow[]
  selectedId: string | null
  busy: boolean
  error: string | null
  /** True once the listeners are attached, so mounting the panel twice does
   *  not subscribe twice. */
  wired: boolean

  wire: () => () => void
  refresh: () => Promise<void>
  start: (opts?: InspectStartOptions) => Promise<void>
  stop: () => Promise<void>
  clear: () => Promise<void>
  select: (id: string | null) => void
  allowPinned: (host: string) => Promise<void>
  setPassthrough: (hosts: string[]) => Promise<void>
  installTrust: (store: 'system' | 'nss') => Promise<void>
  removeTrust: (store: 'system' | 'nss') => Promise<void>
  regenerateCa: () => Promise<void>
  forgetCa: () => Promise<void>
}

function bridge(): NonNullable<Window['opsmaxx']>['inspect'] | null {
  return window.opsmaxx?.inspect ?? null
}

/** Upserts a flow in place.
 *
 *  A flow is sent twice — once when it begins and once when it ends — so the
 *  second message must replace the first rather than append. Getting this
 *  wrong shows every request twice, which is the kind of bug that makes people
 *  distrust the whole panel. */
function upsert(flows: InspectFlow[], flow: InspectFlow): InspectFlow[] {
  const i = flows.findIndex((f) => f.id === flow.id)
  if (i >= 0) {
    const next = flows.slice()
    next[i] = flow
    return next
  }
  const next = [...flows, flow]
  return next.length > MAX_FLOWS ? next.slice(next.length - MAX_FLOWS) : next
}

export const useInspect = create<InspectState>((set, get) => ({
  status: null,
  flows: [],
  selectedId: null,
  busy: false,
  error: null,
  wired: false,

  wire: () => {
    const api = bridge()
    if (!api || get().wired) return () => {}
    set({ wired: true })
    const offFlow = api.onFlow((f) => set((s) => ({ flows: upsert(s.flows, f) })))
    const offStatus = api.onStatus((status) => set({ status }))
    const offPinned = api.onPinned((p: InspectPinnedHost) =>
      set((s) => ({
        status: s.status ? { ...s.status, pinned: [...s.status.pinned, p] } : s.status
      }))
    )
    const offOpaque = api.onOpaque((o) =>
      set((s) => ({
        status: s.status ? { ...s.status, opaque: [...s.status.opaque, o] } : s.status
      }))
    )
    const offCleared = api.onCleared(() => set({ flows: [], selectedId: null }))
    return () => {
      offFlow()
      offStatus()
      offPinned()
      offOpaque()
      offCleared()
      set({ wired: false })
    }
  },

  refresh: async () => {
    const api = bridge()
    if (!api) return
    try {
      const [status, flows] = await Promise.all([api.status(), api.flows()])
      set({ status, flows, error: null })
    } catch (e) {
      set({ error: describe(e) })
    }
  },

  start: async (opts) => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: null })
    try {
      set({ status: await api.start(opts) })
    } catch (e) {
      set({ error: describe(e) })
    } finally {
      set({ busy: false })
    }
  },

  stop: async () => {
    const api = bridge()
    if (!api) return
    set({ busy: true })
    try {
      set({ status: await api.stop(), error: null })
    } catch (e) {
      set({ error: describe(e) })
    } finally {
      set({ busy: false })
    }
  },

  clear: async () => {
    await bridge()?.clear()
    set({ flows: [], selectedId: null })
  },

  select: (id) => set({ selectedId: id }),

  allowPinned: async (host) => {
    const api = bridge()
    if (!api) return
    try {
      set({ status: await api.allowPinned(host) })
    } catch (e) {
      set({ error: describe(e) })
    }
  },

  setPassthrough: async (hosts) => {
    const api = bridge()
    if (!api) return
    try {
      set({ status: await api.setPassthrough(hosts) })
    } catch (e) {
      set({ error: describe(e) })
    }
  },

  installTrust: async (store) => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: null })
    try {
      const res = await api.installTrust(store)
      // A declined prompt is a decision, not a failure. Reporting it as an
      // error would tell someone who deliberately said no that something
      // broke.
      if (!res.ok && !res.declined) set({ error: res.message ?? 'The certificate was not installed.' })
      await get().refresh()
    } catch (e) {
      set({ error: describe(e) })
    } finally {
      set({ busy: false })
    }
  },

  removeTrust: async (store) => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: null })
    try {
      const res = await api.removeTrust(store)
      if (!res.ok && !res.declined) set({ error: res.message ?? 'The certificate was not removed.' })
      await get().refresh()
    } catch (e) {
      set({ error: describe(e) })
    } finally {
      set({ busy: false })
    }
  },

  regenerateCa: async () => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: null })
    try {
      await api.regenerateCa()
      await get().refresh()
    } catch (e) {
      set({ error: describe(e) })
    } finally {
      set({ busy: false })
    }
  },

  forgetCa: async () => {
    const api = bridge()
    if (!api) return
    set({ busy: true, error: null })
    try {
      await api.forgetCa()
      await get().refresh()
    } catch (e) {
      set({ error: describe(e) })
    } finally {
      set({ busy: false })
    }
  }
}))

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Electron prefixes every rejected invoke with its own channel noise, which
  // is meaningless to the person reading it.
  return msg.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}
