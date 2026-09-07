import { useMemo } from 'react'
import { Wrench } from 'lucide-react'
import { clsx } from '../../lib/format'
import {
  moduleEnabled,
  modulesOnSurface,
  type ModuleDef,
  type ModuleState,
  type OperateModuleId
} from '../../../../shared/modules'
import { openSettings, useNav } from '../../store/nav'
import { BroadcastPanel } from '../monitor/BroadcastPanel'
import { PatchPanel } from '../monitor/PatchPanel'
import type { Server } from '../../types'

// Operations — the half of the fleet destination that CHANGES servers.
//
// The split this component exists for is written up on `ModuleSurface` in
// src/shared/modules.ts. The short version: Monitoring had fifteen module tabs
// and put a teal primary button in the same top-right slot on every one of
// them. On thirteen it meant "read that again". On two it meant "install 70
// packages and reboot" and "run this shell command on every selected host".
// Nothing was mislabelled — the labels were fine — but a slot a person clicks
// without reading thirteen times a day is a slot they will click without
// reading the fourteenth time too. The fix is not a redder button. It is that
// the two live somewhere else, with a different icon, a different header and a
// different shape, so arriving here is itself the signal.
//
// Three things this page does differently from Monitoring, all deliberate:
//
//  1. A standing banner rather than a title. Monitoring's `.content-header` is
//     an `h1` and a stat line. This is a statement about what the whole rail
//     does, and it does not scroll away.
//  2. Tabs that carry their consequence. There are two of them, so there is
//     room to say what each one will do to a host. Monitoring's strip cannot
//     afford that at thirteen tabs; this one can afford it at two, and the
//     asymmetry is the point rather than an inconsistency.
//  3. Execute controls at the FOOT of the card (`.op-actionbar`), never
//     top-right. See the comments at those two sites in BroadcastPanel and
//     PatchPanel.
//
// It renders the SAME panel components Monitoring used to mount. Duplicating
// them would have meant two BroadcastPanels drifting apart, and the panels were
// never the problem — where they were mounted was.

/** What each operate tab will do, said in the tab itself. */
const CONSEQUENCE: Record<OperateModuleId, string> = {
  broadcast: 'Runs a shell command on every server you select.',
  patch: 'Installs packages in waves, and restarts hosts that ask for it.'
}

export function OperationsView({
  servers,
  modules,
  hidden
}: {
  servers: Server[]
  modules: ModuleState | undefined
  /**
   * Hidden rather than unmounted, and this prop is the whole reason the rail
   * lives inside FleetMonitor. BroadcastPanel holds a live run in component
   * state and its Stop button is the only way to cancel one; unmounting this
   * subtree to go and look at a log tail would strand a fan-out mid-flight.
   */
  hidden: boolean
}): React.JSX.Element {
  const tab = useNav((s) => s.operationsTab)
  const setTab = useNav((s) => s.setOperationsTab)

  const enabled = useMemo<ModuleDef[]>(
    () => modulesOnSurface('operate').filter((m) => moduleEnabled(modules, m.id)),
    [modules]
  )
  const off = useMemo<ModuleDef[]>(
    () => modulesOnSurface('operate').filter((m) => !moduleEnabled(modules, m.id)),
    [modules]
  )

  // A module switched off while its tab is open would otherwise leave the rail
  // blank with no way back — the same guard FleetMonitor applies to its own.
  const activeTab = enabled.some((m) => m.id === tab) ? tab : (enabled[0]?.id ?? null)
  const show = (id: OperateModuleId): React.CSSProperties | undefined =>
    activeTab === id ? undefined : { display: 'none' }

  return (
    <div className="content ops-content" style={hidden ? { display: 'none' } : undefined}>
      {/* Sticky for the same reason Monitoring's strip is: one screen into a
          patch plan or a fan-out result table, nothing else on screen says
          which rail you are on, and this rail is the one where that matters. */}
      <div className="ops-sticky">
        <div className="ops-banner">
          <Wrench size={16} />
          <div>
            <div className="ops-banner-title">Operations</div>
            <div className="ops-banner-sub">
              Everything here changes servers. Nothing here is a refresh.
            </div>
          </div>
        </div>

        {enabled.length > 0 && (
          <div className="ops-rail">
            {enabled.map((m) => {
              const id = m.id as OperateModuleId
              return (
                <button
                  key={m.id}
                  className={clsx('ops-rail-btn', activeTab === m.id && 'active')}
                  onClick={() => setTab(id)}
                >
                  <span className="ops-rail-label">{m.label}</span>
                  <span className="ops-rail-consequence">{CONSEQUENCE[id]}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {enabled.length === 0 && (
        // Not an apology for an empty page — a description of what the rail is
        // for. Both operate modules ship OFF (`backfillModules`: an upgrade is
        // not consent), so for most installs this IS the Operations page, and
        // it has to be able to explain itself without a trip to Settings.
        <div className="ops-empty">
          <div className="s-title">Nothing here can change a server yet.</div>
          {off.map((m) => (
            <div key={m.id} className="s-desc" style={{ marginTop: 8 }}>
              <b>{m.label}</b> — {m.detail}
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <button className="btn sm primary" onClick={() => openSettings('modules')}>
              Choose modules
            </button>
          </div>
        </div>
      )}

      {/* Mounted whenever the module is on, hidden when another tab is showing.
          Never conditional on `activeTab` — see the `hidden` prop above. */}
      {moduleEnabled(modules, 'broadcast') && (
        <div className="ops-card" style={show('broadcast')}>
          <BroadcastPanel servers={servers} />
        </div>
      )}
      {moduleEnabled(modules, 'patch') && (
        <div className="ops-card" style={show('patch')}>
          <PatchPanel servers={servers} />
        </div>
      )}

      {/* One operate module on and the other off: say so here rather than
          leaving the person to guess that patching lives behind a setting. The
          list is empty when both are on, so this costs nothing then. */}
      {enabled.length > 0 && off.length > 0 && (
        <div className="s-desc" style={{ marginTop: 14 }}>
          {off.map((m) => m.label).join(' and ')}{' '}
          {off.length === 1 ? 'is' : 'are'} available and switched off.{' '}
          <button className="btn ghost sm" onClick={() => openSettings('modules')}>
            Choose modules
          </button>
        </div>
      )}
    </div>
  )
}
