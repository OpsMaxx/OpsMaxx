import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderPlus,
  HardDrive,
  MemoryStick,
  Plus,
  Server as ServerIcon,
  Trash2,
  Wrench
} from 'lucide-react'
import { useApp, useWorkspaceMonitorGroups, useWorkspaceServers } from '../../store/app'
import { EmptyState } from '../common/EmptyState'
import { ServerMonitorCard } from './ServerMonitorCard'
import { fleetTotals, useFleet } from '../../store/fleet'
import { bridgeHas } from '../../lib/bridge'
import { bytes, clsx } from '../../lib/format'
import type { MonitorGroup, Server } from '../../types'
import { AlertsPanel } from './AlertsPanel'
import { useAlerts } from '../../store/alerts'
import { FleetHealth } from './FleetHealth'
import { LocalHostCard } from './LocalHostCard'
import { FleetSearch } from './FleetSearch'
import { InventoryPanel } from './InventoryPanel'
import { AccessPanel } from './AccessPanel'
import { PosturePanel } from './PosturePanel'
import { DriftPanel } from './DriftPanel'
import { CapacityPanel } from './CapacityPanel'
import { LogTailPanel } from './LogTailPanel'
import { CronPanel } from './CronPanel'
import { ServicesPanel } from './ServicesPanel'
import { RulesPanel } from './RulesPanel'
import { ChangeLogPanel } from './ChangeLogPanel'
import {
  isOperateModule,
  moduleEnabled,
  modulesOnSurface,
  type ModuleDef,
  type ModuleId
} from '../../../../shared/modules'
import { openSettings, useNav } from '../../store/nav'
import { OperationsView } from '../operations/OperationsView'
import { splitTabStrip } from './tabStrip'
import { DockerPanel } from '../docker/DockerPanel'
import { KubernetesPanel } from '../kubernetes/KubernetesPanel'
import { ProcessesPanel } from '../processes/ProcessesPanel'

function pct(used: number, total: number): number {
  return total > 0 ? (used / total) * 100 : 0
}

/**
 * How many tabs may stand in the strip at once, Overview and Alerts included.
 *
 * Eight is not a taste judgement. At the app's minimum useful width the strip
 * wrapped onto a second row somewhere between eight and nine buttons, and a
 * wrapped row is where this went wrong before: enabling one module reflowed
 * every row and could exile Kubernetes onto a line of its own, so the position
 * of every tab depended on which OTHER modules were on. A ceiling makes each
 * tab's position depend only on the tabs before it.
 */
const MAX_STRIP_TABS = 8

// What is being dragged, and where it would land. Cards and groups share one
// drag state because a card can be dropped on a group header and a group can
// be dropped between groups — keeping two would let both highlight at once.
type Drag = { kind: 'card'; id: string } | { kind: 'group'; id: string } | null
type DropAt = { groupId: string; index: number } | null

function GroupSection({
  group,
  index,
  cards,
  drag,
  dropAt,
  groupDrop,
  setDrag,
  setDropAt,
  setGroupDrop,
  commit
}: {
  group: MonitorGroup
  index: number
  cards: Server[]
  drag: Drag
  dropAt: DropAt
  groupDrop: number | null
  setDrag: (d: Drag) => void
  setDropAt: (d: DropAt) => void
  setGroupDrop: (i: number | null) => void
  commit: () => void
}): React.JSX.Element {
  const openServer = useApp((s) => s.openServer)
  const toggleMonitorGroup = useApp((s) => s.toggleMonitorGroup)
  const renameMonitorGroup = useApp((s) => s.renameMonitorGroup)
  const deleteMonitorGroup = useApp((s) => s.deleteMonitorGroup)
  const [renaming, setRenaming] = useState(false)

  const draggingCard = drag?.kind === 'card'
  const draggingGroup = drag?.kind === 'group'

  // A slot opens where the card would land. Rendered as a real grid item so
  // the surrounding cards move aside instead of the drop being a guess.
  const slotAt = (i: number): React.JSX.Element | null =>
    draggingCard && dropAt?.groupId === group.id && dropAt.index === i ? (
      <div
        key={`slot-${i}`}
        className="card-slot"
        // Hovering the slot must hold the position it is already showing.
        // Without this the event reaches the grid, which reads any uncovered
        // space as "drop at the end", and the gap jumps away from the cursor.
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          commit()
        }}
      />
    ) : null

  return (
    <section className={clsx('monitor-group', groupDrop === index && 'group-dragover')}>
      <div
        className={clsx('mg-head', draggingCard && dropAt?.groupId === group.id && 'dragover')}
        draggable={!group.system && !renaming}
        onDragStart={() => !group.system && setDrag({ kind: 'group', id: group.id })}
        onDragEnd={() => {
          setDrag(null)
          setDropAt(null)
          setGroupDrop(null)
        }}
        onDragOver={(e) => {
          if (draggingGroup && !group.system) {
            e.preventDefault()
            setGroupDrop(index)
            return
          }
          // Dropping a card on the header files it at the end of the group,
          // which is the only way to reach a collapsed one.
          if (draggingCard) {
            e.preventDefault()
            setDropAt({ groupId: group.id, index: cards.length })
          }
        }}
        onDrop={(e) => {
          e.preventDefault()
          commit()
        }}
        onClick={() => !renaming && toggleMonitorGroup(group.id)}
        onDoubleClick={() => !group.system && setRenaming(true)}
      >
        <ChevronRight size={15} className={clsx('chev', !group.collapsed && 'open')} />
        {renaming ? (
          <input
            className="mg-rename"
            autoFocus
            defaultValue={group.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v) renameMonitorGroup(group.id, v)
              setRenaming(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="mg-name">{group.name}</span>
        )}
        <span className="count">{cards.length}</span>
        <span className="grow" />
        {!group.system && !renaming && (
          <button
            className="icon-btn xs"
            title="Delete group — its cards move back to Ungrouped"
            onClick={(e) => {
              e.stopPropagation()
              deleteMonitorGroup(group.id)
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {!group.collapsed && (
        <div
          className="monitor"
          onDragOver={(e) => {
            if (!draggingCard) return
            e.preventDefault()
            setDropAt({ groupId: group.id, index: cards.length })
          }}
          onDrop={(e) => {
            e.preventDefault()
            commit()
          }}
        >
          {cards.map((s, i) => (
            <div key={s.id} style={{ display: 'contents' }}>
              {slotAt(i)}
              <div
                className={clsx('card-drag', drag?.kind === 'card' && drag.id === s.id && 'dragging')}
                draggable
                onDragStart={() => setDrag({ kind: 'card', id: s.id })}
                onDragEnd={() => {
                  setDrag(null)
                  setDropAt(null)
                }}
                onDragOver={(e) => {
                  if (!draggingCard) return
                  e.preventDefault()
                  // Left half of a card means "before it", right half "after".
                  e.stopPropagation()
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = e.clientX > r.left + r.width / 2
                  setDropAt({ groupId: group.id, index: after ? i + 1 : i })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  commit()
                }}
              >
                <ServerMonitorCard server={s} onOpen={() => openServer(s.id, 'monitor')} />
              </div>
            </div>
          ))}
          {slotAt(cards.length)}
          {cards.length === 0 && (
            <div className="mg-empty">Drag cards here</div>
          )}
        </div>
      )}
    </section>
  )
}

export function FleetMonitor(): React.JSX.Element {
  const servers = useWorkspaceServers()
  const openServerTab = useApp((s) => s.openServer)
  // A disabled module is one more branch, not a new mechanism — the same way
  // the activity bar and viewbar already hide what does not apply.
  const modules = useApp((s) => s.settings.modules)
  const alertCount = useAlerts((s) => Object.keys(s.active).length)

  // Sub-navigation, added after looking at the composite rather than at each
  // panel on its own.
  //
  // Every module built today appended a panel to this page. With all of them on
  // that was five stacked forms ABOVE the health summary and the server cards —
  // so the thing the page is named for sat below four tools nobody was using at
  // that moment, and the first screen was a wall of inputs. Each panel was
  // reasonable; the page was not.
  //
  // Panels stay MOUNTED and are hidden rather than unmounted. A running
  // broadcast or an open log tail must survive looking at the overview — and
  // LogTailPanel stops its remote command on unmount, so switching tab would
  // otherwise kill a tail the user is in the middle of reading.
  //
  // `alerts` is a FIXED tab beside Overview rather than a module, and that is a
  // decision rather than an omission. Modules default OFF for every existing
  // install — `backfillModules` guarantees an upgrade is not consent — so an
  // alert inbox registered as one would be invisible to everybody who already
  // has the app, while the status-bar chip went on pointing at this page. A
  // pointer to a tab that is not there is worse than no pointer. Alerting is
  // also not optional weight: the store, the durable log and the sampler are
  // already paid for, and this tab is a table over rows that exist either way.
  const tab = useNav((s) => s.monitorTab)
  const setTab = useNav((s) => s.setMonitorTab)
  const rail = useNav((s) => s.fleetRail)
  const [moreOpen, setMoreOpen] = useState(false)
  const [offOpen, setOffOpen] = useState(false)
  // Item 43. Held in nav for the same reason the tab is: the failed-unit list
  // that sets it is several components away from the panel that consumes it.
  const logTailJump = useNav((s) => s.logTailJump)
  // Item 43's sibling: a prefilled service step, set from the same failed-unit
  // list and consumed several components away.
  const jobComposerJump = useNav((s) => s.jobComposerJump)

  // Only the READ half. The modules that change servers moved to Operations —
  // see ModuleSurface in src/shared/modules.ts for why, and OperationsView for
  // what they moved into.
  const tabs = useMemo<ModuleDef[]>(
    () => modulesOnSurface('read').filter((m) => moduleEnabled(modules, m.id)),
    [modules]
  )
  // The read modules a person has NOT switched on, so the strip can say they
  // exist. Nothing in Monitoring used to: ten of the thirteen read modules ship
  // off, and a user who never opened Settings never learned the product had
  // them.
  const offTabs = useMemo<ModuleDef[]>(
    () => modulesOnSurface('read').filter((m) => !moduleEnabled(modules, m.id)),
    [modules]
  )

  // A module switched off while its tab is open would otherwise leave the page
  // blank with no way back. `isOperateModule` is the new half of the same
  // guard: an `operate` id can still reach `monitorTab` through a persisted
  // store written before the split, and its panel is not mounted here any more.
  const activeTab =
    tab === 'overview' || tab === 'alerts' || (!isOperateModule(tab) && tabs.some((t) => t.id === tab))
      ? tab
      : 'overview'
  const show = (id: 'overview' | 'alerts' | ModuleId): React.CSSProperties | undefined =>
    activeTab === id ? undefined : { display: 'none' }

  // One row, hard ceiling, overflow behind `More`.
  //
  // Grouping was the other candidate and it loses. Thirteen read modules do not
  // fall into a small fixed set of groups anyone would agree on — Capacity is
  // as much "storage" as "trends", Change log is as much "audit" as "history" —
  // and a wrong grouping is worse than none, because it makes a person look in
  // the group we chose rather than in the strip. A ceiling makes no claim about
  // what the tabs mean. It only claims that eight is as many as a row holds,
  // which is a fact about the window rather than an opinion about the estate.
  //
  // The ceiling counts Overview and Alerts, because a row does not care which
  // buttons are fixed. That leaves six module slots. The rule that makes an
  // overflow survivable — the selected tab is always in the strip — is in
  // splitTabStrip, where it can be stated without mounting this component.
  const stripped = useMemo(
    () => splitTabStrip(tabs, activeTab, MAX_STRIP_TABS - 2),
    [tabs, activeTab]
  )
  const groups = useWorkspaceMonitorGroups()
  const hosts = useFleet((s) => s.hosts)
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const syncMonitorLayout = useApp((s) => s.syncMonitorLayout)
  const moveMonitorCard = useApp((s) => s.moveMonitorCard)
  const moveMonitorGroup = useApp((s) => s.moveMonitorGroup)
  const addMonitorGroup = useApp((s) => s.addMonitorGroup)

  const [drag, setDrag] = useState<Drag>(null)
  const [dropAt, setDropAt] = useState<DropAt>(null)
  const [groupDrop, setGroupDrop] = useState<number | null>(null)

  // Files newly added servers onto the wall and drops ones that are gone.
  // Keyed on the server set and the workspace, and a no-op when the layout is
  // already right, so it cannot loop with its own state update.
  const serverIds = servers.map((s) => s.id).join(',')
  useEffect(() => {
    syncMonitorLayout()
  }, [serverIds, workspaceId, syncMonitorLayout])

  // Sweep the estate now that somebody is looking at it, so the health panel
  // is not showing whatever the last scheduled sweep found up to a couple of
  // minutes ago. Once per mount: the background interval owns the cadence from
  // here, and re-requesting on every server edit would be a full sweep per
  // keystroke in the rename box.
  useEffect(() => {
    if (!bridgeHas(window.opsmaxx?.fleet as Record<string, unknown> | undefined, 'sampleNow')) {
      return
    }
    void window.opsmaxx?.fleet?.sampleNow()
  }, [])

  const online = servers.filter((s) => s.status === 'online').length
  const totals = fleetTotals(
    servers.map((s) => s.id),
    hosts
  )

  const commit = (): void => {
    if (drag?.kind === 'card' && dropAt) moveMonitorCard(drag.id, dropAt.groupId, dropAt.index)
    if (drag?.kind === 'group' && groupDrop !== null) moveMonitorGroup(drag.id, groupDrop)
    setDrag(null)
    setDropAt(null)
    setGroupDrop(null)
  }

  // Covers both rails, because both are empty for the same reason and neither
  // has anything useful to show first. The message names the rail so the
  // activity-bar icon the user just pressed is the one being answered.
  if (servers.length === 0) {
    return (
      <div className="panel-body">
        <EmptyState
          icon={rail === 'operations' ? <Wrench size={26} /> : <Activity size={26} />}
          title={rail === 'operations' ? 'Nothing to operate on' : 'Nothing to monitor'}
          message={
            rail === 'operations'
              ? 'Add a server before running commands or installing updates across the estate.'
              : 'Add a server to start streaming live CPU, memory, disk and network metrics.'
          }
        />
      </div>
    )
  }

  const byId = new Map(servers.map((s) => [s.id, s]))

  return (
    <>
    <div className="content" style={rail === 'operations' ? { display: 'none' } : undefined}>
      {/* Sticky, and this is the single change with the most effect on the page.
          `.content` is the scroll container, so the title and the strip used to
          scroll away — one screen down, nothing on screen said which of the
          tabs you were in, on a page whose whole job is to be several different
          pages. A tab strip you cannot see is a tab strip you cannot use. */}
      <div className="monitor-sticky">
        <div className="content-header">
          <div>
            <h1 className="ui-page-title">Monitoring</h1>
            {/* "reading only" rather than "live metrics": it is the contract of
                the destination now, not a description of the overview tab. */}
            <div className="sub ui-note">
              {online} of {servers.length} servers online · reading only
            </div>
          </div>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => addMonitorGroup('New group')}>
            <FolderPlus size={14} /> New group
          </button>
        </div>

        {/* Always rendered, where it used to appear only once a module was on.
            Overview and Alerts are both here whatever the module state is, and a
            bar that vanished would take the inbox with it. */}
        <div className="segment monitor-tabs monitor-strip">
          <button
            className={clsx('seg-btn', activeTab === 'overview' && 'active')}
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
          <button
            className={clsx('seg-btn', activeTab === 'alerts' && 'active')}
            onClick={() => setTab('alerts')}
          >
            Alerts
            {/* The count, so the tab says whether it is worth opening. Only when
                there is one: a permanent "0" trains people to stop reading it. */}
            {alertCount > 0 && <span className="chip danger" style={{ marginLeft: 6 }}>{alertCount}</span>}
          </button>
          {stripped.head.map((m) => (
            <button
              key={m.id}
              className={clsx('seg-btn', activeTab === m.id && 'active')}
              onClick={() => setTab(m.id)}
            >
              {m.label}
            </button>
          ))}

          <span className="grow" />

          {stripped.rest.length > 0 && (
            <div className="mon-pop-host">
              <button
                className={clsx('seg-btn', moreOpen && 'active')}
                aria-expanded={moreOpen}
                onClick={() => {
                  setMoreOpen((v) => !v)
                  setOffOpen(false)
                }}
              >
                More <ChevronDown size={13} />
              </button>
              {moreOpen && (
                <div className="mon-pop">
                  {stripped.rest.map((m) => (
                    <button
                      key={m.id}
                      className="mon-pop-row"
                      onClick={() => {
                        setTab(m.id)
                        setMoreOpen(false)
                      }}
                    >
                      <span className="s-title">{m.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* The ten capabilities nobody can see.
              Correctly switching every module off on upgrade has a cost, and
              the old line here only paid it when they were ALL off — so a fresh
              install, which has three of the thirteen read modules on,
              advertised nothing, and a person who never opened Settings never
              learned the product had drift comparison. This says so from the
              strip, with each module's own one-line `detail`, and it disappears
              entirely once everything is on. */}
          {offTabs.length > 0 && (
            <div className="mon-pop-host">
              <button
                className={clsx('seg-btn', offOpen && 'active')}
                title={`${offTabs.length} more monitoring modules are available and switched off`}
                aria-expanded={offOpen}
                onClick={() => {
                  setOffOpen((v) => !v)
                  setMoreOpen(false)
                }}
              >
                <Plus size={14} />
              </button>
              {offOpen && (
                <div className="mon-pop wide">
                  <div className="s-desc" style={{ marginBottom: 6 }}>
                    Switched off. Enabling one adds a tab here.
                  </div>
                  {offTabs.map((m) => (
                    <div key={m.id} className="mon-pop-row static">
                      <span className="s-title">{m.label}</span>
                      <span className="s-desc">{m.detail}</span>
                    </div>
                  ))}
                  <button
                    className="btn sm primary"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      setOffOpen(false)
                      openSettings('modules')
                    }}
                  >
                    Choose modules
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mounted always and hidden with the rest, for the reason written at
          `tab` above: the panel reads the durable log on mount, and a tab that
          unmounted would re-read it on every visit while the chip that sent you
          here already knew the answer. */}
      <div style={show('alerts')}>
        <AlertsPanel />
      </div>

      {moduleEnabled(modules, 'fleetSearch') && (
        <div style={show('fleetSearch')}>
          <FleetSearch servers={servers} onOpen={(id) => openServerTab(id, 'monitor')} />
        </div>
      )}
      {moduleEnabled(modules, 'inventory') && (
        <div style={show('inventory')}>
          <InventoryPanel servers={servers} onOpen={(id) => openServerTab(id, 'monitor')} />
        </div>
      )}
      {moduleEnabled(modules, 'access') && (
        <div style={show('access')}>
          <AccessPanel servers={servers} onOpen={(id) => openServerTab(id, 'monitor')} />
        </div>
      )}
      {moduleEnabled(modules, 'capacity') && (
        <div style={show('capacity')}>
          <CapacityPanel servers={servers} />
        </div>
      )}
      {moduleEnabled(modules, 'posture') && (
        <div style={show('posture')}>
          <PosturePanel servers={servers} onOpen={(id) => openServerTab(id, 'monitor')} />
        </div>
      )}
      {moduleEnabled(modules, 'drift') && (
        <div style={show('drift')}>
          <DriftPanel servers={servers} />
        </div>
      )}
      {/* Patch and Broadcast used to be mounted here, between Drift and
          LogTail. They are the two `operate` modules and they now live on the
          Operations rail — same components, mounted by OperationsView at the
          bottom of this file's own render so a live broadcast survives coming
          back here to read a log. */}
      {moduleEnabled(modules, 'logTail') && (
        <div style={show('logTail')}>
          <LogTailPanel servers={servers} jump={logTailJump ?? undefined} />
        </div>
      )}
      {moduleEnabled(modules, 'cron') && (
        <div style={show('cron')}>
          <CronPanel servers={servers} />
        </div>
      )}
      {moduleEnabled(modules, 'services') && (
        <div style={show('services')}>
          <ServicesPanel servers={servers} />
        </div>
      )}
      {moduleEnabled(modules, 'rules') && (
        <div style={show('rules')}>
          <RulesPanel servers={servers} />
        </div>
      )}
      {moduleEnabled(modules, 'changeLog') && (
        <div style={show('changeLog')}>
          <ChangeLogPanel servers={servers} />
        </div>
      )}
      {/* Roadmap item 1. No `servers` prop, and that is the feature rather than
          an omission: this panel supervises processes on THIS machine and has
          nothing to say about the estate. See the remote refusal at the top of
          src/shared/processes.ts. */}
      {moduleEnabled(modules, 'processes') && (
        <div style={show('processes')}>
          <ProcessesPanel />
        </div>
      )}
      {moduleEnabled(modules, 'docker') && (
        <div style={show('docker')}>
          <DockerPanel servers={servers} />
        </div>
      )}
      {moduleEnabled(modules, 'kubernetes') && (
        <div style={show('kubernetes')}>
          <KubernetesPanel servers={servers} />
        </div>
      )}

      <div style={show('overview')}>
        <FleetHealth servers={servers} />

        {/* This machine, beside the estate. Asked for on mount rather than
            sampled — see the note in LocalHostCard on why it is deliberately
            not an entry in the fleet inventory. */}
        <LocalHostCard />

      {totals.reporting > 0 && (
        <div className="fleet-totals">
          <div className="ft-item">
            <ServerIcon size={14} className="faint" />
            <div>
              <div className="ft-value">{totals.reporting}</div>
              <div className="ft-label">
                {totals.reporting === servers.length
                  ? 'servers reporting'
                  : `of ${servers.length} servers reporting`}
              </div>
            </div>
          </div>
          <div className="ft-item">
            <Cpu size={14} className="faint" />
            <div>
              <div className="ft-value">{totals.cores}</div>
              <div className="ft-label">vCPU total</div>
            </div>
          </div>
          <div className="ft-item">
            <MemoryStick size={14} className="faint" />
            <div>
              <div className="ft-value">{bytes(totals.memTotal)}</div>
              <div className="ft-label">
                RAM · {bytes(totals.memUsed)} used ({pct(totals.memUsed, totals.memTotal).toFixed(0)}%)
              </div>
            </div>
          </div>
          <div className="ft-item">
            <HardDrive size={14} className="faint" />
            <div>
              <div className="ft-value">{bytes(totals.diskTotal)}</div>
              <div className="ft-label">
                Disk · {bytes(totals.diskUsed)} used ({pct(totals.diskUsed, totals.diskTotal).toFixed(0)}%)
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        className="monitor-groups"
        // A drag that ends outside any target must not leave the wall stuck in
        // a highlighted state.
        onDragEnd={() => {
          setDrag(null)
          setDropAt(null)
          setGroupDrop(null)
        }}
      >
        {groups.map((g, i) => (
          <GroupSection
            key={g.id}
            group={g}
            index={i}
            cards={g.serverIds.map((id) => byId.get(id)).filter((s): s is Server => !!s)}
            drag={drag}
            dropAt={dropAt}
            groupDrop={groupDrop}
            setDrag={setDrag}
            setDropAt={setDropAt}
            setGroupDrop={setGroupDrop}
            commit={commit}
          />
        ))}
        </div>
      </div>
    </div>

    {/* The other rail, a sibling rather than a route.
        Monitoring and Operations are two destinations with two icons, and this
        component mounts both because the alternative is App.tsx unmounting one
        to show the other. LogTailPanel stops its remote command on unmount and
        BroadcastPanel holds a live fan-out in component state; a split that
        unmounted would mean crossing rails killed a tail or stranded a run.
        Hidden, never unmounted, is the same property the tab strip above has
        always had \u2014 the split just widened what it covers. */}
    <OperationsView
      servers={servers}
      modules={modules}
      hidden={rail !== 'operations'}
      jobJump={jobComposerJump ?? undefined}
    />
    </>
  )
}
