import { useEffect, useMemo, useState } from 'react'
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
import type { JobComposerJump } from '../../store/nav'
import { BroadcastPanel } from '../monitor/BroadcastPanel'
import { PatchPanel } from '../monitor/PatchPanel'
import { JobsPanel } from '../monitor/JobsPanel'
import { KeyRevokePanel } from './KeyRevokePanel'
import { CronEditPanel } from './CronEditPanel'
import { UnitInstallPanel } from './UnitInstallPanel'
// import { CicdTriggerPanel } from '../cicd/CicdTriggerPanel' — phase 2, with
// the module entry and the card below.
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
//  2. Tabs that carry their consequence. There are three of them, so there is
//     room to say what each one will do to a host. Monitoring's strip cannot
//     afford that at fourteen tabs; this one can afford it at three, and the
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
  patch: 'Installs packages in waves, and restarts hosts that ask for it.',
  jobs: 'Makes servers run things: once as a job, on a schedule, or as a service that survives you.',
  keyRevoke: 'Removes one SSH key from every account across the estate that trusts it.'
  // cicdTrigger: 'Starts a build on a CI server OpsMaxx does not administer, and
  //   cannot stop once it runs.' — phase 2, with its MODULES entry. TypeScript
  //   enforces this list against OperateModuleId, so it comes back when that does.
}

/**
 * The sub-tabs of Jobs, and the reason there is such a thing at all.
 *
 * Three writes used to sit on the Monitoring rail, bolted onto panels whose
 * whole job is reading: revoking a key from the key table, editing a crontab
 * from the schedule list, installing a `systemd --user` unit from the service
 * list. All three had to leave a destination whose contract is that nothing in
 * it writes. Where they LANDED was decided per case rather than by rule:
 *
 *  - Revoking a key became a module of its own. Nothing on this rail has a
 *    sentence it fits under, and filing it under Broadcast because it fans out
 *    would classify it by mechanism where every tab here is named by
 *    consequence.
 *  - The other two landed here, because Jobs' subject already covers them.
 *    "Make this server run something" is the same sentence three times over:
 *    once now (a job), every day at three (a crontab), and continuously with a
 *    restart policy (a unit). `serviceStep.ts` is already a Jobs file and it
 *    starts, stops and enables units; installing one is the missing first verb,
 *    not a new subject.
 *
 * Sub-tabs rather than three more top-level tabs, because the property this
 * rail is built on is that the dangerous side of the app stays small enough to
 * hold in your head. Six top-level tabs where there were three would have
 * spent that to save one click. Each sub-tab still states its own consequence:
 * the parent tab's line is an umbrella, and an umbrella is not a warning.
 */
type JobsSubTab = 'compose' | 'schedule' | 'install'

const JOBS_SUBTABS: { id: JobsSubTab; label: string; consequence: string }[] = [
  {
    id: 'compose',
    label: 'Run a job',
    consequence: 'Runs multi-step work across servers in waves, with a rollback you press yourself.'
  },
  {
    id: 'schedule',
    label: 'Change a schedule',
    consequence: "Replaces one server's crontab, after keeping a copy of it on that server."
  },
  {
    id: 'install',
    label: 'Install a service',
    consequence: 'Writes a systemd --user unit onto one server and enables it.'
  }
]

export function OperationsView({
  servers,
  modules,
  hidden,
  jobJump
}: {
  servers: Server[]
  modules: ModuleState | undefined
  /** A prefilled service step, set by openServiceJob and consumed by JobsPanel. */
  jobJump?: JobComposerJump
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
  const jump = useNav((s) => s.operationsJump)
  // Local rather than in nav, unlike `operationsTab` beside it. `OperationsTab`
  // is a union of MODULE ids so a nav pointer cannot name a tab its rail lacks;
  // a sub-tab is not a module and putting one in that union would break exactly
  // that property. Nothing is lost: this component never unmounts (see
  // `hidden`), so the sub-tab a person left survives crossing rails, and a
  // pointer from elsewhere gets here by naming a jump kind below.
  const [jobsSub, setJobsSub] = useState<JobsSubTab>('compose')
  const [honoured, setHonoured] = useState(0)

  // A jump into a sub-tab. The panels honour the jump's payload themselves —
  // this only makes the one being filled in the one on screen, which is the
  // half a panel cannot do for itself.
  useEffect(() => {
    if (!jump || jump.nonce === honoured) return
    if (jump.kind === 'cron-edit') setJobsSub('schedule')
    else if (jump.kind === 'unit-install') setJobsSub('install')
    else return
    setHonoured(jump.nonce)
  }, [jump, honoured])

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
  // The tab somebody ASKED for, when it is not the one they got. A pointer from
  // a Monitoring panel names a module that may be switched off — every operate
  // module ships off — and silently landing them on Broadcast instead would be
  // the "pointer that opens the wrong place" this codebase refuses. Naming it
  // costs one line and turns a wrong landing into an answered question.
  const asked = tab === activeTab ? null : off.find((m) => m.id === tab)
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

      {asked !== undefined && asked !== null && (
        <div className="panel-note is-unknown" data-testid="ops-tab-off">
          <b>{asked.label}</b> is switched off, so this is not it. {asked.detail}{' '}
          <button className="btn ghost sm" onClick={() => openSettings('modules')}>
            Choose modules
          </button>
        </div>
      )}

      {enabled.length === 0 && (
        // Not an apology for an empty page — a description of what the rail is
        // for. EVERY operate module ships off (`backfillModules`: an upgrade is
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
      {/* Jobs composes multi-step work and runs it across servers in waves, so
          it belongs on this side of the line rather than in a destination whose
          contract is that nothing in it writes. `openServiceJob` routes here
          directly for the same reason.

          Three panels behind one tab — see JOBS_SUBTABS. All three are mounted
          whenever the module is on and hidden when another sub-tab is showing,
          the same rule the tabs above follow and for the same reason: JobsPanel
          holds a run in component state, and a sub-tab strip that unmounted
          would throw one away every time somebody glanced at a crontab. */}
      {moduleEnabled(modules, 'jobs') && (
        <div className="ops-card" style={show('jobs')}>
          <div className="ops-subrail">
            {JOBS_SUBTABS.map((s) => (
              <button
                key={s.id}
                className={clsx('ops-subrail-btn', jobsSub === s.id && 'active')}
                data-testid={`jobs-sub-${s.id}`}
                onClick={() => setJobsSub(s.id)}
              >
                <span className="ops-subrail-label">{s.label}</span>
                <span className="ops-subrail-consequence">{s.consequence}</span>
              </button>
            ))}
          </div>
          <div style={jobsSub === 'compose' ? undefined : { display: 'none' }}>
            <JobsPanel servers={servers} jump={jobJump} />
          </div>
          <div style={jobsSub === 'schedule' ? undefined : { display: 'none' }}>
            <CronEditPanel servers={servers} />
          </div>
          <div style={jobsSub === 'install' ? undefined : { display: 'none' }}>
            <UnitInstallPanel servers={servers} />
          </div>
        </div>
      )}
      {/* Revoking a key is its own module rather than a sub-tab, for the reason
          written at CONSEQUENCE: it is the only write on this rail whose
          consequence is that somebody LOSES access, and it runs through neither
          the job engine nor the broadcast runner. */}
      {moduleEnabled(modules, 'keyRevoke') && (
        <div className="ops-card" style={show('keyRevoke')}>
          <KeyRevokePanel servers={servers} />
        </div>
      )}
      {/* The CI/CD trigger card is phase 2. `CicdTriggerPanel` is built and
          tested; it is not mounted because `cicdTrigger` is not a registered
          module yet, and `moduleEnabled` would not typecheck against an id the
          registry does not have. Restoring it is this block and the MODULES
          entry it names. */}

      {/* Some operate modules on and others off: say so here rather than
          leaving the person to guess that patching lives behind a setting. The
          list is empty when they are all on, so this costs nothing then. */}
      {enabled.length > 0 && off.length > 0 && (
        <div className="s-desc" style={{ marginTop: 14 }}>
          {/* Not `join(' and ')`. With four operate modules that produced "Patch
              and Jobs and Revoke a key", which reads as a machine listing rather
              than a sentence somebody wrote. */}
          {off
            .map((m) => m.label)
            .reduce((acc, label, i) =>
              i === off.length - 1 ? `${acc} and ${label}` : `${acc}, ${label}`
            )}{' '}
          {off.length === 1 ? 'is' : 'are'} available and switched off.{' '}
          <button className="btn ghost sm" onClick={() => openSettings('modules')}>
            Choose modules
          </button>
        </div>
      )}
    </div>
  )
}
