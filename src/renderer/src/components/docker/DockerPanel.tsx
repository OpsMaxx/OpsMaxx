import { useId, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Container,
  HardDrive,
  Info,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { useApp } from '../../store/app'
import { sshHopsFor } from '../../lib/ssh'
import { LOCAL_TARGET } from '../../../../shared/execTarget'
import { clsx } from '../../lib/format'
import { hostChoices, anyConnected, resolveHostId } from '../../lib/hostChoices'
import {
  DOCKER_FAILURE_HELP,
  buildDockerNetworkPreview,
  buildDockerReclaimPreview,
  diffDockerReclaim,
  dockerReclaimBlocked,
  dockerReclaimKey,
  formatDockerEngineAge,
  groupByComposeProject,
  planDockerAction,
  planDockerReclaim,
  reclaimItemForContainer,
  validateContainerRef,
  type DockerAction,
  type DockerActionPlan,
  type DockerActionResult,
  type DockerBridge,
  type DockerContainer,
  type DockerDiskDetailProbe,
  type DockerDiskProbe,
  type DockerInspectProbe,
  type DockerProbe,
  type DockerReclaimDiff,
  type DockerNetworkProbe,
  type DockerReclaimItem,
  type DockerReclaimPlan,
  type DockerReclaimPreview,
  type DockerReclaimResult,
  type DockerStat
} from '../../../../shared/docker'
import type { Server } from '../../types'
import { ComposePanel } from './ComposePanel'
import { HealthLogPanel } from './HealthLog'
import { useFleet } from '../../store/fleet'
import { EngineUpgradePanel } from './EngineUpgrade'
import { jobApprovalFor, planJob, type JobSpec } from '../../../../shared/jobs'
import { ImageScanPanel } from './ImageScan'
import type { ImageScanProbe } from '../../../../shared/imageScan'
import { ReclaimDialog, ReclaimOutcome } from './Reclaim'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import type { MessageKey, Translate } from '../../../../shared/i18n'

// Containers on a server, and what an operator does with them.
//
// Two jobs, and the second one only earns its place because the first is done
// properly:
//
//  1. Do not lie when docker cannot be read. A missing binary, a stopped daemon
//     and a permissions problem all produce "nothing" from a naive
//     implementation, and they have three different fixes. That rule holds for
//     every read here, not only the container list: a `docker system df` that
//     renders four zeroes because the socket refused us is the same lie in a
//     more expensive place, since disk-full is the incident people come here
//     during.
//  2. Change state only through the approval model. `planDockerAction` in
//     shared/docker.ts decides how hard the user has to press, and this file
//     obeys it — it never decides for itself that something is safe enough to
//     skip. The dialog below is deliberately the same shape as the broadcast
//     one, because it is the same model and a second dialect of it would be a
//     second thing to reason about.
//
// The MCP bridge cannot reach any of this. An agent gets `execute_command`
// gated per server against an access group; restarting a container is a
// different risk with a different consent story.

function stateTone(state: string): string {
  if (state === 'running') return ''
  if (state === 'exited' || state === 'dead') return 'danger'
  return 'warn'
}

function healthTone(health: string | null): string {
  if (health === 'healthy') return ''
  if (health === 'unhealthy') return 'danger'
  return 'warn'
}

/**
 * The bridge, treated as possibly-not-there.
 *
 * `DockerBridge` is declared in shared/docker.ts and the preload is annotated
 * with it, so the two halves type-check against one contract. `Partial` here is
 * not superstition: the renderer and the preload land in separate diffs, and a
 * panel that throws `undefined is not a function` on a channel that has not been
 * wired yet is worse than one with a button that says so.
 */
function bridge(): Partial<DockerBridge> | undefined {
  return (window.opsmaxx as unknown as { docker?: Partial<DockerBridge> } | undefined)?.docker
}

/** Bytes as docker would have written them, for the totals docker does not total. */
function humanBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${n < 10 && i > 0 ? n.toFixed(2) : Math.round(n)}${units[i]}`
}

/**
 * Fold the network read into the disk-derived preview.
 *
 * Networks are a SECOND read -- `system df -v` lists none -- and this is where
 * the two meet. Two things it must not do.
 *
 * It must not silently omit networks when the read failed: the preview would
 * then look complete while offering nothing from a whole category, and nobody
 * on screen could tell that from a host with no removable networks. The failure
 * goes in as a withheld row, where it is visible.
 *
 * And it must be a pure function of the two reads, for the reason the disk
 * preview is: the confirm-time re-check compares a fresh preview against the
 * planned items, and that comparison only means something if the same reads
 * always produce the same offer set.
 */
function mergeNetworks(
  base: DockerReclaimPreview,
  nets: DockerNetworkProbe | null,
  t: Translate
): DockerReclaimPreview {
  if (nets === null) return base
  if (!nets.ok) {
    return {
      items: base.items,
      withheld: [
        ...base.withheld,
        {
          kind: 'network',
          id: '',
          label: t('docker.disk.networksLabel'),
          reason: t('docker.disk.networksUnreadable', { detail: nets.detail })
        }
      ]
    }
  }
  const add = buildDockerNetworkPreview(nets.networks, nets.use)
  return { items: [...base.items, ...add.items], withheld: [...base.withheld, ...add.withheld] }
}

/** Not a server id: no server can have it, because ids are UUIDs. */
const LOCAL_ID = 'local'

/** What a log pane shows, and the two choices that produced it. */
type LogPaneState = {
  name: string
  ref: string
  output: string
  lines: number
  timestamps: boolean
}

const DEFAULT_LOG_LINES = 200

const ACTION_LABEL: Record<DockerAction, MessageKey> = {
  start: 'docker.action.start',
  stop: 'docker.action.stop',
  restart: 'docker.action.restart'
}

const CONFIRM_ONE: Record<DockerAction, MessageKey> = {
  start: 'docker.action.confirmStartOne',
  stop: 'docker.action.confirmStopOne',
  restart: 'docker.action.confirmRestartOne'
}

const CONFIRM_MANY: Record<DockerAction, MessageKey> = {
  start: 'docker.action.confirmStartMany',
  stop: 'docker.action.confirmStopMany',
  restart: 'docker.action.confirmRestartMany'
}

/**
 * One container's logs, rendered either under its own row or in the panel at
 * the bottom. Identical markup both times: the difference between glancing at
 * it here and reading it properly down there is where it is mounted, not what
 * it says.
 *
 * Lines and timestamps belong to the PANE, not to the panel. They were panel
 * state read once at fetch time, so changing either left the output it
 * produced sitting there unchanged — a control that looked like it reloaded
 * and did not. With several panes open that would have been three selects
 * disagreeing about one number.
 */
function LogPane({
  pane,
  inline,
  onChange,
  onPopOut,
  onDock,
  onClose
}: {
  pane: LogPaneState
  inline?: boolean
  onChange: (next: Partial<Pick<LogPaneState, 'lines' | 'timestamps'>>) => void
  onPopOut?: () => void
  onDock?: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div style={inline ? { paddingBottom: 6 } : undefined}>
      <div
        className="row muted"
        style={{ fontSize: 11, marginTop: inline ? 4 : 10, gap: 8, alignItems: 'center' }}
      >
        <span className="grow">{t('docker.logs.title', { name: pane.name })}</span>
        <select
          className="input"
          style={{ maxWidth: 110 }}
          value={pane.lines}
          onChange={(e) => onChange({ lines: Number(e.target.value) })}
        >
          <option value={200}>{t('docker.logs.lines', { lines: 200 })}</option>
          <option value={1000}>{t('docker.logs.lines', { lines: 1000 })}</option>
          <option value={5000}>{t('docker.logs.lines', { lines: 5000 })}</option>
        </select>
        <label className="row" style={{ gap: 4, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={pane.timestamps}
            onChange={(e) => onChange({ timestamps: e.target.checked })}
          />
          {t('docker.logs.timestamps')}
        </label>
        {inline && onPopOut && (
          <button
            className="btn ghost sm"
            title={t('docker.logs.popOutTitle')}
            onClick={onPopOut}
          >
            {t('docker.logs.popOut')}
          </button>
        )}
        {!inline && onDock && (
          <button
            className="btn ghost sm"
            title={t('docker.logs.dockTitle')}
            onClick={onDock}
          >
            {t('docker.logs.dock')}
          </button>
        )}
        <button className="btn ghost sm" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
      {/* Inline keeps .bc-out's own 26px indent, which reads as "this belongs
          to the row above"; the bottom panel owns its width and cancels it. */}
      <pre
        className="bc-out"
        style={inline ? { maxHeight: 220 } : { marginLeft: 0, maxHeight: 300 }}
      >
        {pane.output}
      </pre>
    </div>
  )
}

export function DockerPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const t = useT()
  const [serverId, setServerId] = useState<string>('')
  // The package manager, from the facts the sampler already collects. Absent
  // means the facts have not been collected -- which the engine-upgrade panel
  // refuses on rather than guessing a distribution from.
  const allFacts = useFleet((st) => st.facts)
  const [probe, setProbe] = useState<DockerProbe | null>(null)
  const [loading, setLoading] = useState(false)
  // Keyed by container id — the key the rows already carry — so several
  // containers can be open at once and every pane knows its own row.
  const [logs, setLogs] = useState<Record<string, LogPaneState>>({})
  // The one pane the user asked to read in the big panel at the bottom instead.
  const [poppedOut, setPoppedOut] = useState<string | null>(null)
  // Sticky per panel: an operator who knows this account is not in the docker
  // group should not pay a failed round trip on every refresh.
  const [useSudo, setUseSudo] = useState(false)
  const [filter, setFilter] = useState('')
  // null = not asked yet. Probed only when a permission failure makes it
  // relevant, so an ordinary host never runs a sudo probe at all.
  const [sudoAvailable, setSudoAvailable] = useState<boolean | null>(null)

  const [disk, setDisk] = useState<DockerDiskProbe | null>(null)
  const [diskLoading, setDiskLoading] = useState(false)
  // The itemised form, asked for separately: `docker system df -v` walks every
  // image and volume on the host, so an operator who only wanted the four
  // category totals should not pay for it.
  const [diskItems, setDiskItems] = useState<DockerDiskDetailProbe | null>(null)
  // Networks come from their OWN read: `system df -v` lists none. Held beside
  // the disk listing and re-read with it, so the preview stays a pure function
  // of the reads on screen -- which is what makes the confirm-time re-check
  // mean anything.
  const [netItems, setNetItems] = useState<DockerNetworkProbe | null>(null)
  const [diskItemsLoading, setDiskItemsLoading] = useState(false)
  // Reclaim. NOTHING is pre-selected and there is no select-all: the lifecycle
  // model's rule is that targets are explicit, and a select-all checkbox is
  // `prune` reached by a click instead of a flag. The set is keyed by
  // `dockerReclaimKey`, which is kind + id and nothing that can move — a
  // selection keyed on a label would survive a retag, which is exactly the
  // change the re-preview exists to catch.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [reclaimPlan, setReclaimPlan] = useState<DockerReclaimPlan | null>(null)
  const [reclaimPhrase, setReclaimPhrase] = useState('')
  const [reclaimDiff, setReclaimDiff] = useState<DockerReclaimDiff | null>(null)
  const [reclaimChecking, setReclaimChecking] = useState(false)
  const [reclaiming, setReclaiming] = useState(false)
  const [reclaimResult, setReclaimResult] = useState<DockerReclaimResult | null>(null)
  const [stats, setStats] = useState<Record<string, DockerStat> | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  // The row whose Remove is reading the disk, and why a Remove could not open.
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeNote, setRemoveNote] = useState<string | null>(null)
  const reclaimDialogRef = useRef<HTMLDivElement>(null)
  // Prefix for the compose group headings' ids, which label their groups.
  const groupIdBase = useId()
  const [statsLoading, setStatsLoading] = useState(false)
  const [detail, setDetail] = useState<{ id: string; probe: DockerInspectProbe | null } | null>(null)

  const [pending, setPending] = useState<{ plan: DockerActionPlan; refs: string[]; labels: string[] } | null>(null)
  const [phrase, setPhrase] = useState('')
  const [acting, setActing] = useState(false)
  const [actionResult, setActionResult] = useState<{ action: DockerAction; result: DockerActionResult } | null>(null)

  const openContainerShell = useApp((st) => st.openContainerShell)
  // True when this host's containers are being read as root — either because
  // the user pinned it, or because the automatic retry had to. Line 426 already
  // uses exactly this pair to draw the "reading as root" banner; the shell has
  // to make the same decision or it opens a session that cannot reach the
  // socket the listing just used.
  const usedSudoNow = useSudo || (probe?.ok && probe.usedSudo === true)

  // Every host, not just the dialled ones. `status` is written on the edge of
  // a connect and never re-asserted, so filtering on it hid servers that were
  // reachable — and `docker ps` goes over SSH, which dials on demand, so a
  // live connection was never a precondition for reading one. See
  // lib/hostChoices.ts.
  const eligible = useMemo(() => hostChoices(servers), [servers])

  /**
   * "This machine" as a target.
   *
   * Deliberately a sentinel in this panel's own selection state rather than a
   * row in `servers`: that list is persisted and mirrored into the MCP data
   * cache, so a pseudo-server would become an agent-addressable target the
   * moment it was written. See shared/execTarget.ts.
   */
  //
  // Resolved rather than read straight off `serverId`, so the dropdown and the
  // target can never disagree. They did: with no server online the browser
  // rendered the only option as selected while the state was still '', which
  // showed "This machine" above a Read button that refused to run.
  //
  // A saved server stays the default when there is one; this machine is the
  // default only when there is nothing else, where the alternative is a dead
  // panel.
  /**
   * A STALE `serverId` MUST NOT SURVIVE THIS.
   *
   * `serverId` is component-local and outlives the server it names: delete the
   * server, or switch to a workspace without it, and this still holds the old
   * id. `servers.find` then returns undefined, `localSelected` is false, and
   * `targetCfg()` calls `cfgFor(undefined)` — which reads `.id` and throws.
   * That is a RENDER-time call (ComposePanel is handed a cfg as a prop), so it
   * does not fail a button, it takes the whole panel down through the error
   * boundary. Reported from 0.50.19 as "Cannot read properties of undefined
   * (reading 'id')" at cfgFor/targetCfg/DockerPanel.
   *
   * Resolving against the list that exists also fixes the blank `<select>` the
   * same staleness produced, which is what made the promise below — that the
   * dropdown and the target cannot disagree — not quite true.
   *
   * The resolution lives in lib/hostChoices.ts rather than here, because the
   * Kubernetes panel had the identical line and the first version of this
   * guard broke both the same way: it discarded the LOCAL sentinel as stale,
   * since the sentinel is by design not a row in `servers`. See resolveHostId,
   * which states why.
   */
  const selectedId = resolveHostId(serverId, servers, LOCAL_ID)
  const localSelected = selectedId === LOCAL_ID
  const server = localSelected ? undefined : servers.find((s) => s.id === selectedId)
  // Docker on this machine is worth offering whether or not any server is
  // online — it is the daemon most developers actually use.
  const hasTarget = localSelected || !!server
  /** What main is told to run the command against. */
  const targetCfg = (): unknown => (localSelected ? LOCAL_TARGET : cfgFor(server as Server))
  const targetName = localSelected ? t('docker.panel.thisMachine') : server?.name

  const cfgFor = (s: Server): unknown => ({
    sessionId: `docker-${s.id}`,
    cols: 80,
    rows: 24,
    serverId: s.id,
    host: s.host,
    port: s.port,
    username: s.username,
    auth: s.auth === 'password' || s.auth === 'agent' ? s.auth : 'key',
    hops: sshHopsFor(s)
  })

  // Commands are built from the container ID, never the display name.
  //
  // An id is hex, so it always passes the reference validator, it cannot
  // collide with another container's, and it cannot be a prefix of one — which
  // matters because the action parser attributes docker's error lines by
  // looking for the reference inside them. The name is what the user reads; the
  // id is what the host is told.
  const refOf = (c: DockerContainer): string => c.id

  // Every read below is a round trip that outlives the click that started it —
  // `Itemise` is allowed sixty seconds, and the panel stays fully usable while
  // it is in the air. If the operator switches server in that window, the
  // answer that eventually lands is about a host they are no longer looking
  // at: repository names, volume names and container names belonging to
  // somewhere else, rendered under the new server's heading with nothing to
  // say so — and the Itemise button hides itself once a listing exists, so
  // there is no way to notice or correct it. Each read stamps the generation
  // it started in; `clearReads` ends that generation, and an answer from a
  // dead one is dropped instead of shown.
  const generation = useRef(0)

  /**
   * Forget the selection and everything downstream of it.
   *
   * Called whenever the listing it was made against stops being the listing on
   * screen — a new read, a different server, a completed removal. A selection
   * that outlived its listing is a set of ids describing a host that is no
   * longer being looked at, which is the failure the whole re-preview step is
   * built to refuse.
   */
  const clearReclaim = (): void => {
    setPicked(new Set())
    setReclaimPlan(null)
    setReclaimPhrase('')
    setReclaimDiff(null)
    setReclaimChecking(false)
    setReclaiming(false)
  }

  const clearReads = (): void => {
    generation.current++
    setReclaimResult(null)
    setLogs({})
    setPoppedOut(null)
    setDisk(null)
    setDiskItems(null)
    setStats(null)
    setStatsError(null)
    setDetail(null)
    setActionResult(null)
    clearReclaim()
    // The reads being abandoned owned these. Left set, the new server's
    // buttons sit disabled until a request about the old one comes back.
    setDiskLoading(false)
    setDiskItemsLoading(false)
    setStatsLoading(false)
  }

  const load = async (sudoOverride?: boolean): Promise<void> => {
    if (!hasTarget) return
    setLoading(true)
    clearReads()
    const gen = generation.current
    try {
      const r = await withVaultUnlock(
        t('docker.panel.unlockReason'),
        // `async` so the optional chain's `undefined` (no bridge) is a resolved
        // value rather than a non-Promise return type.
        async () => bridge()?.list?.(targetCfg(), { sudo: sudoOverride ?? useSudo })
      )
      if (generation.current !== gen) return
      setProbe(r ?? null)
      // Only ask about sudo once something has actually been refused by it —
      // and only when the automatic retry did not already solve it, which it
      // usually does.
      if (r && !r.ok && r.reason === 'permission-denied') {
        const can = await bridge()?.canSudo?.(targetCfg())
        if (generation.current !== gen) return
        setSudoAvailable(can ?? false)
      } else {
        setSudoAvailable(null)
      }
    } catch (e) {
      if (generation.current !== gen) return
      setProbe({ ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      // In a finally, so a rejected invoke leaves a button the user can press
      // again rather than one that spins forever.
      setLoading(false)
    }
  }

  const closeLogs = (id: string): void => {
    setLogs((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)))
    setPoppedOut((cur) => (cur === id ? null : cur))
  }

  /** Reads one pane's logs with the choices that pane is currently showing. */
  const runLogs = async (id: string, pane: LogPaneState): Promise<void> => {
    setLogs((m) => ({ ...m, [id]: { ...pane, output: t('common.loading') } }))
    const gen = generation.current
    // A pane the user closed while this was in flight does not come back: the
    // answer is written only if its key is still there.
    const write = (output: string): void =>
      setLogs((m) => (m[id] ? { ...m, [id]: { ...pane, output } } : m))
    try {
      const r = await bridge()?.logs?.(targetCfg(), pane.ref, pane.lines, {
        sudo: useSudo,
        timestamps: pane.timestamps
      })
      if (generation.current !== gen) return
      write(r?.output || r?.error || t('docker.logs.noOutput'))
    } catch (e) {
      if (generation.current !== gen) return
      write(e instanceof Error ? e.message : String(e))
    }
  }

  const openLogs = async (c: DockerContainer): Promise<void> => {
    if (!hasTarget) return
    // The same button closes what it opened. An expander that only ever
    // expands is the next complaint.
    if (logs[c.id]) {
      closeLogs(c.id)
      return
    }
    const pane: LogPaneState = {
      name: c.name,
      ref: refOf(c),
      output: '',
      lines: DEFAULT_LOG_LINES,
      timestamps: false
    }
    // `docker:logs` is one of the handlers that can reject: the builder refuses
    // a reference it cannot prove safe rather than escaping it. Asking first
    // turns an unhandled rejection and a pane stuck on "Loading…" into a
    // sentence saying what happened.
    if (!validateContainerRef(pane.ref)) {
      setLogs((m) => ({
        ...m,
        [c.id]: { ...pane, output: t('docker.logs.unsafeId') }
      }))
      return
    }
    await runLogs(c.id, pane)
  }

  const loadDisk = async (): Promise<void> => {
    if (!hasTarget) return
    setDiskLoading(true)
    const gen = generation.current
    try {
      const r = await bridge()?.disk?.(targetCfg(), { sudo: useSudo })
      if (generation.current !== gen) return
      setDisk(r ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.disk') })
    } catch (e) {
      if (generation.current !== gen) return
      setDisk({ ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setDiskLoading(false)
    }
  }

  const loadDiskItems = async (): Promise<void> => {
    if (!hasTarget) return
    setDiskItemsLoading(true)
    const gen = generation.current
    try {
      const [r, n] = await Promise.all([
        bridge()?.diskDetail?.(targetCfg(), { sudo: useSudo }),
        bridge()?.networks?.(targetCfg(), { sudo: useSudo })
      ])
      if (generation.current !== gen) return
      // A fresh listing invalidates a selection made against the old one.
      clearReclaim()
      setDiskItems(
        r ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.diskDetail') }
      )
      setNetItems(
        n ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.networks') }
      )
    } catch (e) {
      if (generation.current !== gen) return
      setDiskItems({ ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setDiskItemsLoading(false)
    }
  }

  // ---- reclaim ----

  /**
   * What may be offered, derived from the listing on screen and nothing else.
   *
   * A pure function of one read, which is what makes the re-preview meaningful:
   * the same listing always yields the same offer set, so a difference between
   * two of them is a difference on the host rather than in this function.
   */
  const preview: DockerReclaimPreview | null = useMemo(
    () => (diskItems?.ok === true ? mergeNetworks(buildDockerReclaimPreview(diskItems.disk), netItems, t) : null),
    [diskItems, netItems, t]
  )
  const pickedItems: DockerReclaimItem[] = useMemo(
    () => (preview === null ? [] : preview.items.filter((i) => picked.has(dockerReclaimKey(i)))),
    [preview, picked]
  )

  const togglePick = (item: DockerReclaimItem): void => {
    const key = dockerReclaimKey(item)
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /**
   * Read the disk again, and refuse if it disagrees.
   *
   * The honest answer to everything that can move between the preview and the
   * click. It runs on the CONFIRM, not on the button that opens the dialog, so
   * the window it closes is the one the operator spent reading the caveats —
   * which is the window that actually matters, and the one a check done any
   * earlier would leave open.
   *
   * A read that FAILS is treated as a refusal too. "The disk could not be
   * re-read, so we went ahead on the old list" is precisely the sentence this
   * step exists to make impossible.
   */
  const confirmReclaim = async (): Promise<void> => {
    // `hasTarget`, not `server`: `server` is undefined by construction when the
    // dropdown is on this machine, so guarding on it made every one of these
    // return on its first line against the local daemon — silently, with no
    // IPC and nothing in the console. Everything below already goes through
    // `targetCfg()`, which has handled the local case since it was added.
    if (!hasTarget || reclaimPlan === null) return
    setReclaimChecking(true)
    const gen = generation.current
    try {
      const [fresh, freshNets] = await Promise.all([
        bridge()?.diskDetail?.(targetCfg(), { sudo: useSudo }),
        bridge()?.networks?.(targetCfg(), { sudo: useSudo })
      ])
      if (generation.current !== gen) return
      setNetItems(
        freshNets ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.networks') }
      )
      if (!fresh || !fresh.ok) {
        setDiskItems(
          fresh ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.diskDetail') }
        )
        setReclaimPlan(null)
        setReclaimResult({
          ok: false,
          reason: fresh?.ok === false ? fresh.reason : 'unknown',
          detail:
            fresh?.ok === false
              ? t('docker.reclaim.recheckFailedDetail', { detail: fresh.detail })
              : t('docker.reclaim.recheckFailed')
        })
        return
      }
      // `?? null` is not a shrug: an unwired bridge is exactly the case the
      // withheld row above is for, and the ?? keeps it on that path rather
      // than letting `undefined` mean "no networks".
      const again = mergeNetworks(
        buildDockerReclaimPreview(fresh.disk),
        freshNets ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.networks') },
        t
      )
      const diff = diffDockerReclaim(reclaimPlan.items, again)
      // The listing is replaced either way, so whatever happens next is chosen
      // against what the host actually holds now.
      setDiskItems(fresh)
      if (dockerReclaimBlocked(diff)) {
        setPicked(new Set())
        setReclaimDiff(diff)
        return
      }
      setReclaimPlan(null)
      setPicked(new Set())
      setReclaiming(true)
      const r = await bridge()?.reclaim?.(targetCfg(), reclaimPlan.items, { sudo: useSudo })
      setReclaimResult(r ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.reclaim') })
      // The listing and the category totals are both stale now, whatever
      // happened — a partial removal leaves some of it changed.
      const after = await bridge()?.diskDetail?.(targetCfg(), { sudo: useSudo })
      if (generation.current !== gen) return
      if (after) setDiskItems(after)
      void loadDisk()
    } catch (e) {
      if (generation.current !== gen) return
      setReclaimPlan(null)
      setReclaimResult({ ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setReclaimChecking(false)
      setReclaiming(false)
    }
  }

  /**
   * Remove one container from its own row.
   *
   * Not a second `docker rm`: it opens the Disk usage reclaim dialog with this
   * container as the only pick, so the re-read-and-refuse on confirm, the
   * caveats and the per-item outcome are the ones that path already has. The
   * disk is read here because that dialog is planned from the itemised read,
   * and a plan made from the container list alone would be one the confirm
   * step has nothing to compare against.
   */
  const requestRemove = async (c: DockerContainer): Promise<void> => {
    if (!hasTarget || removingId !== null) return
    setRemoveNote(null)
    setRemovingId(c.id)
    const gen = generation.current
    try {
      const [d, detail, nets] = await Promise.all([
        bridge()?.disk?.(targetCfg(), { sudo: useSudo }),
        bridge()?.diskDetail?.(targetCfg(), { sudo: useSudo }),
        bridge()?.networks?.(targetCfg(), { sudo: useSudo })
      ])
      if (generation.current !== gen) return
      clearReclaim()
      setReclaimResult(null)
      setDisk(d ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.disk') })
      setDiskItems(
        detail ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.diskDetail') }
      )
      setNetItems(nets ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.networks') })
      if (!d?.ok || !detail?.ok) {
        setRemoveNote(t('docker.remove.diskUnreadable', { name: c.name }))
        return
      }
      const found = reclaimItemForContainer(buildDockerReclaimPreview(detail.disk), c.id)
      if (found === null) {
        setRemoveNote(t('docker.remove.notListed', { name: c.name }))
        return
      }
      if ('withheld' in found) {
        setRemoveNote(t('docker.remove.withheld', { name: c.name, reason: found.withheld }))
        return
      }
      setPicked(new Set([dockerReclaimKey(found.item)]))
      setReclaimPlan(planDockerReclaim([found.item]))
      // The dialog lives in the Disk usage block, above the list this button
      // is on, so without this the click appears to do nothing.
      requestAnimationFrame(() => reclaimDialogRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    } catch (e) {
      if (generation.current !== gen) return
      setRemoveNote(t('docker.remove.failed', { name: c.name, error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setRemovingId(null)
    }
  }

  const running = probe?.ok ? probe.containers.filter((c) => c.state === 'running') : []

  const loadStats = async (): Promise<void> => {
    // See confirmReclaim: `hasTarget`, not `server`. This is the one the bug
    // report was about — "CPU & memory" did nothing at all on this machine,
    // which is also the default target when no saved server is online.
    if (!hasTarget || running.length === 0) return
    setStatsLoading(true)
    setStatsError(null)
    const gen = generation.current
    try {
      const r = await bridge()?.stats?.(targetCfg(), running.map(refOf), { sudo: useSudo })
      if (generation.current !== gen) return
      if (!r) setStatsError(t('docker.notWired.stats'))
      else if (!r.ok) setStatsError(`${DOCKER_FAILURE_HELP[r.reason]} ${r.detail}`)
      else {
        // docker keys stats by NAME, not by the reference it was given, so the
        // map is built on the name and read back through it.
        const byName: Record<string, DockerStat> = {}
        for (const s of r.stats) byName[s.name] = s
        setStats(byName)
      }
    } catch (e) {
      if (generation.current !== gen) return
      setStatsError(e instanceof Error ? e.message : String(e))
    } finally {
      setStatsLoading(false)
    }
  }

  const toggleDetail = async (c: DockerContainer): Promise<void> => {
    if (detail?.id === c.id) {
      setDetail(null)
      return
    }
    if (!hasTarget) return
    setDetail({ id: c.id, probe: null })
    const gen = generation.current
    try {
      const r = await bridge()?.inspect?.(targetCfg(), refOf(c), { sudo: useSudo })
      if (generation.current !== gen) return
      setDetail({
        id: c.id,
        probe: r ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.inspect') }
      })
    } catch (e) {
      if (generation.current !== gen) return
      setDetail({
        id: c.id,
        probe: { ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) }
      })
    }
  }

  // ---- state changes ----

  const runAction = async (action: DockerAction, refs: string[]): Promise<void> => {
    if (!hasTarget) return
    setPending(null)
    setPhrase('')
    setActing(true)
    setActionResult(null)
    try {
      const r = await bridge()?.act?.(targetCfg(), action, refs, { sudo: useSudo })
      setActionResult({
        action,
        result: r ?? { ok: false, reason: 'unknown', detail: t('docker.notWired.actions') }
      })
      // The list is now stale whatever happened — including when it failed,
      // because a partial fan-out leaves some containers changed.
      if (r?.ok) await load()
    } catch (e) {
      setActionResult({
        action,
        result: { ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) }
      })
    } finally {
      setActing(false)
    }
  }

  /**
   * Ask for an action, at whatever strength the plan says.
   *
   * The plan is never second-guessed here. `{ kind: 'none' }` runs on click
   * because the model says a single additive verb has already been approved by
   * the click; anything else opens the dialog. A panel that decided for itself
   * that some case was safe enough would be the model quietly ending.
   */
  const requestAction = (action: DockerAction, containers: DockerContainer[]): void => {
    const usable = containers.filter((c) => validateContainerRef(refOf(c)))
    if (usable.length === 0) return
    const refs = usable.map(refOf)
    const plan = planDockerAction(action, refs)
    if (plan.confirmation.kind === 'none') void runAction(action, refs)
    else setPending({ plan, refs, labels: usable.map((c) => c.name) })
  }

  const canConfirm =
    pending === null ||
    pending.plan.confirmation.kind !== 'type-to-confirm' ||
    phrase.trim() === pending.plan.confirmation.phrase

  /**
   * Filtered BEFORE grouping, so a project with no match disappears with its
   * header rather than leaving an empty heading behind.
   *
   * A host with thirty-five containers across nine compose projects had no way
   * to find one. The Kubernetes panel beside it has had a pod filter all along;
   * this is the same control over the same kind of list.
   */
  const allContainers = probe?.ok ? probe.containers : []
  const q = filter.trim().toLowerCase()
  const shown = q
    ? allContainers.filter((c) =>
        // Name, image and project: the three things actually on the row, so
        // what you can read is what you can search.
        `${c.name} ${c.image} ${c.composeProject ?? ''}`.toLowerCase().includes(q)
      )
    : allContainers
  const groups = groupByComposeProject(shown)
  const diskTotalReclaimable =
    disk?.ok === true
      ? disk.rows.reduce((sum, r) => sum + (r.reclaimableBytes ?? 0), 0)
      : null

  /**
   * The engine upgrade, as a job.
   *
   * The approval is minted from the SAME spec and target list the engine will
   * re-derive its plan from, which is what makes the record checkable. The
   * typed phrase is the one `planJob` asks for; a panel that invented its own
   * would be a second place for that to drift.
   */
  const launchEngineJob = async (spec: JobSpec): Promise<void> => {
    // Server-only, and not an oversight: the job model mints an approval
    // against a saved server's id and main re-derives the plan from it. Giving
    // that record a target that is not a server is a change to the consent
    // model, which deserves its own review rather than arriving as a side
    // effect of a dropdown gaining an option.
    if (!server) return
    const targets = [{ serverId: server.id, serverName: server.name }]
    const planned = planJob(spec, targets)
    const phrase =
      planned.confirmation.kind === 'type-to-confirm' ? planned.confirmation.phrase : null
    if (phrase !== null && window.prompt(t('docker.engine.prompt', { phrase, server: server.name })) !== phrase) {
      return
    }
    await window.opsmaxx?.jobs?.run?.({
      jobId: crypto.randomUUID(),
      spec,
      approval: jobApprovalFor(spec, targets, { phrase, confirmedAt: Date.now() }),
      targets: [{ serverId: server.id, serverName: server.name, cfg: cfgFor(server) }]
    })
  }

  // Every row draws the same slots — start|restart, stop|remove, shell — and
  // an empty one where a verb does not apply. Rows used to draw only the
  // buttons they had, so a stopped container's icons sat one column right of
  // the running ones above it and no column meant one thing. `alignSelf`
  // because .cron-row aligns on the baseline, and an empty box's baseline is
  // its bottom edge: it rode up and made its row 5px taller than the rest.
  const emptySlot = (
    <span className="icon-btn sm" aria-hidden style={{ visibility: 'hidden', alignSelf: 'center' }} />
  )

  const actionButtons = (c: DockerContainer): React.JSX.Element => (
    <>
      {c.state !== 'running' && (
        <button
          className="icon-btn sm"
          title={t('docker.row.startTitle', { name: c.name })}
          disabled={acting}
          onClick={() => requestAction('start', [c])}
        >
          <Play size={13} />
        </button>
      )}
      {c.state === 'exited' || c.state === 'created' || c.state === 'dead' ? (
        <button
          className="icon-btn sm"
          title={t('docker.row.removeTitle', { name: c.name })}
          disabled={acting || removingId !== null}
          onClick={() => void requestRemove(c)}
        >
          <Trash2 size={13} className={clsx(removingId === c.id && 'spin')} />
        </button>
      ) : (
        c.state !== 'running' && emptySlot
      )}
      {c.state === 'running' && (
        <>
          <button
            className="icon-btn sm"
            title={t('docker.row.restartTitle', { name: c.name })}
            disabled={acting}
            onClick={() => requestAction('restart', [c])}
          >
            <RotateCw size={13} />
          </button>
          <button
            className="icon-btn sm"
            title={t('docker.row.stopTitle', { name: c.name })}
            disabled={acting}
            onClick={() => requestAction('stop', [c])}
          >
            <Square size={13} />
          </button>
        </>
      )}
    </>
  )

  return (
    <div className="bc-panel">
      <div className="panel-head">
        <span className="panel-head-icon">
          <Container size={14} />
        </span>
        <h2 className="ui-section-title">{t('docker.panel.title')}</h2>
        <p className="ui-note panel-head-purpose">{t('docker.panel.purpose')}</p>
        <div className="panel-head-actions">
          <select
            className="input"
            style={{ maxWidth: 200 }}
            aria-label={t('docker.panel.hostLabel')}
            value={selectedId}
            onChange={(e) => {
              setServerId(e.target.value)
              setProbe(null)
              clearReads()
            }}
          >
            {/* First, and present even with no servers: the local daemon is the
                one most developers actually have running. */}
            <option value={LOCAL_ID}>{t('docker.panel.thisMachine')}</option>
            {eligible.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.note ? ` — ${s.note}` : ''}
              </option>
            ))}
          </select>
          {/* The button this whole exercise started from. It is the one thing
              to do on an unread panel and it was styled as an ordinary
              secondary control, indistinguishable from the dropdown beside it. */}
          <button
            className="btn primary"
            disabled={loading || !hasTarget}
            title={hasTarget ? t('docker.panel.readTitle', { name: targetName ?? '' }) : t('docker.panel.chooseHost')}
            onClick={() => void load()}
          >
            <RefreshCw size={13} className={clsx(loading && 'spin')} /> {probe ? t('common.refresh') : t('docker.panel.read')}
          </button>
        </div>
      </div>

      {/* Not a dead end any more: with no server online the panel falls back to
          this machine and is fully usable, so this states both facts rather
          than apologising. Saying only "no server is online" would now be
          false — something IS readable, and it is already selected. */}
      {/* About whether anything is DIALLED, not about what may be chosen. Every
          saved host is in the dropdown above either way. */}
      {!anyConnected(servers) && (
        <div className="panel-empty">
          <p className="panel-empty-title">{t('docker.panel.noneConnectedTitle')}</p>
          <p className="panel-empty-body">
            <Trans i18nKey="docker.panel.noneConnectedBody" components={{ b: <b /> }} />
          </p>
        </div>
      )}

      {!probe && !loading && hasTarget && (
        <div className="panel-empty">
          <p className="panel-empty-title">{t('docker.panel.unreadTitle')}</p>
          <p className="panel-empty-body">
            <Trans
              i18nKey="docker.panel.unreadBody"
              components={{ b: <b />, mono: <span className="mono" /> }}
            />
          </p>
        </div>
      )}

      {/* Three different problems, three different fixes. A panel that shows
          an empty list for all of them is lying about two. */}
      {probe && !probe.ok && (
        <div className="s-desc danger">
          <TriangleAlert size={12} /> {DOCKER_FAILURE_HELP[probe.reason]}
          <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
            {probe.detail}
          </div>
          {/* Offered the moment a permission failure is seen, rather than left
              for the user to work out. `sudo -n` never prompts, so if it is not
              available that is said plainly instead of producing a button that
              hangs on a password prompt with no tty to type into. */}
          {probe.reason === 'permission-denied' && sudoAvailable === true && (
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
              <button
                className="btn sm"
                onClick={() => {
                  setUseSudo(true)
                  void load(true)
                }}
              >
                {t('docker.sudo.retry')}
              </button>
              <span className="faint">{t('docker.sudo.available')}</span>
            </div>
          )}
          {probe.reason === 'permission-denied' && sudoAvailable === false && (
            <div className="faint" style={{ marginTop: 6 }}>
              {t('docker.sudo.needsPassword')}
            </div>
          )}
        </div>
      )}

      {/* Once root is in use, say so and leave a way back. A panel silently
          reading as root is the thing worth avoiding, not root itself. */}
      {(useSudo || (probe?.ok && probe.usedSudo)) && (
        <div className="s-desc warn">
          {probe?.ok && probe.usedSudo && !useSudo
            ? t('docker.sudo.readAsRoot')
            : t('docker.sudo.readingAsRoot')}{' '}
          <button
            className="btn ghost sm"
            onClick={() => {
              setUseSudo(false)
              void load(false)
            }}
          >
            {t('docker.sudo.stop')}
          </button>
        </div>
      )}

      {probe?.ok && (
        <>
          <div className="row muted" style={{ fontSize: 11, marginTop: 8, gap: 12, alignItems: 'center' }}>
            {/* null when the host answered with something that was not a
                version — podman's docker shim, most often. Saying nothing
                beats printing "docker null". */}
            <span>{probe.version ? `docker ${probe.version}` : 'docker'}</span>
            <span>{t('docker.panel.containerCount', { count: probe.containers.length })}</span>
            <span className="grow" />
            <button className="btn ghost sm" disabled={diskLoading} onClick={() => void loadDisk()}>
              <HardDrive size={12} className={clsx(diskLoading && 'spin')} /> {t('docker.disk.usage')}
            </button>
            <button
              className="btn ghost sm"
              disabled={statsLoading || running.length === 0}
              title={
                running.length === 0
                  ? t('docker.stats.nothingRunning')
                  : t('docker.stats.title')
              }
              onClick={() => void loadStats()}
            >
              <Activity size={12} className={clsx(statsLoading && 'spin')} /> {t('docker.stats.button')}
            </button>
          </div>

          {/* Grouping that could not be read is said out loud. "No compose
              projects here" and "this runtime would not tell me" look identical
              on screen otherwise, and only one of them is true. */}
          {probe.composeLabels === 'unavailable' && (
            <div className="faint" style={{ fontSize: 11 }}>
              {t('docker.panel.noComposeLabels')}
            </div>
          )}

          {/* The file half.
              The grouping above is read from container LABELS, which say what is
              running. This says what is declared — and therefore which declared
              service has no container at all, which is the one fact nothing on
              this panel could state before. It is a separate read behind a
              button because it costs a bounded filesystem search. */}
          {/* Gated on a target, because `cfg` is evaluated HERE — during
              render, not in a handler. Every other caller of `targetCfg()`
              sits behind a `hasTarget` guard inside an event handler; this one
              had nothing. The resolution above should make that unreachable;
              this is the half that does not depend on it being right. */}
          {hasTarget && (
            <ComposePanel
              server={server}
              cfg={targetCfg()}
              containers={probe.containers}
              sudo={usedSudoNow === true}
            />
          )}

          {/* Disk. The reclaimable column is the one people came for: it is the
              answer to "the disk is full and I do not know what is using it".
              What reclaims it is the ITEMISED view below, one ticked id at a
              time — never a prune. The figure here stays docker's own, computed
              on a host that knows which image layers are shared. */}
          {disk && !disk.ok && (
            <div className="s-desc danger">
              <TriangleAlert size={12} /> {DOCKER_FAILURE_HELP[disk.reason]}
              <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
                {disk.detail}
              </div>
            </div>
          )}
          {disk?.ok && (
            <>
              <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
                <span className="grow">{t('docker.disk.usage')}</span>
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    setDisk(null)
                    setDiskItems(null)
                  }}
                >
                  {t('common.close')}
                </button>
              </div>
              {disk.rows.map((r) => (
                <div key={r.type} className="cron-row">
                  <span className="mono cron-when">{r.type}</span>
                  <span className="faint cron-desc">
                    {t('docker.disk.inUse', { active: r.active ?? '?', total: r.total ?? '?' })}
                  </span>
                  <span className="grow" />
                  <span className="mono">{r.size}</span>
                  <span className={clsx('chip', (r.reclaimablePercent ?? 0) >= 50 && 'warn')}>
                    {r.reclaimable === '' ? '—' : t('docker.disk.reclaimable', { size: r.reclaimable })}
                  </span>
                </div>
              ))}
              {diskTotalReclaimable !== null && diskTotalReclaimable > 0 && (
                <div className="faint" style={{ fontSize: 11 }}>
                  {t('docker.disk.totalReclaimable', { size: humanBytes(diskTotalReclaimable) })}
                </div>
              )}

              {/* The itemised view.
                  The four rows above say WHICH CATEGORY is big. They cannot say
                  which image, and "images: 12.71GB" is not something an operator
                  can act on. It is a second read rather than a wider first one
                  because `-v` walks every image and volume on the host. */}
              {diskItems && !diskItems.ok && (
                <div className="s-desc danger">
                  <TriangleAlert size={12} /> {DOCKER_FAILURE_HELP[diskItems.reason]}
                  <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
                    {diskItems.detail}
                  </div>
                </div>
              )}
              {/* Offered until there is a listing to show — not until there is
                  a RESULT. Gating on `=== null` made a failed probe a dead
                  end: an SSH timeout is the most likely way this read fails,
                  it is the most transient, and the only way out of it was to
                  close the whole disk card. */}
              {!diskItems?.ok && (
                <div className="row" style={{ marginTop: 6, gap: 8, alignItems: 'center' }}>
                  <button className="btn ghost sm" disabled={diskItemsLoading} onClick={() => void loadDiskItems()}>
                    <HardDrive size={12} className={clsx(diskItemsLoading && 'spin')} />{' '}
                    {diskItems === null ? t('docker.disk.itemise') : t('docker.disk.tryAgain')}
                  </button>
                  {diskItems === null ? (
                    <span className="faint" style={{ fontSize: 11 }}>
                      {t('docker.disk.itemiseHint')}
                    </span>
                  ) : (
                    <button className="btn ghost sm" onClick={() => setDiskItems(null)}>
                      {t('common.close')}
                    </button>
                  )}
                </div>
              )}
              {diskItems?.ok && preview && (
                <>
                  <DiskItems
                    probe={diskItems}
                    preview={preview}
                    picked={picked}
                    onToggle={togglePick}
                    onClose={() => {
                      setDiskItems(null)
                      clearReclaim()
                    }}
                  />
                  {/* The bar. A COUNT and no byte figure, and that is not an
                      oversight: per-item sizes do not add up, because image
                      layers are shared, so "3.1GB selected" would be a number
                      this app invented. The honest total comes from re-reading
                      `docker system df` afterwards. */}
                  <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <button
                      className="btn"
                      disabled={pickedItems.length === 0 || reclaiming || reclaimChecking}
                      title={
                        pickedItems.length === 0
                          ? t('docker.disk.removeNoneTitle')
                          : t('docker.disk.removeTitle')
                      }
                      onClick={() => {
                        setReclaimDiff(null)
                        setReclaimPhrase('')
                        setReclaimResult(null)
                        setReclaimPlan(planDockerReclaim(pickedItems))
                      }}
                    >
                      <Trash2 size={13} />{' '}
                      {pickedItems.length === 0
                        ? t('docker.disk.removeSelected')
                        : t('docker.disk.removeCount', { count: pickedItems.length })}
                    </button>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {t('docker.disk.byIdNote')}
                    </span>
                  </div>
                </>
              )}
              {reclaimPlan && (
                <div ref={reclaimDialogRef}>
                  <ReclaimDialog
                    plan={reclaimPlan}
                    diff={reclaimDiff}
                    checking={reclaimChecking}
                    running={reclaiming}
                    phrase={reclaimPhrase}
                    onPhrase={setReclaimPhrase}
                    onConfirm={() => void confirmReclaim()}
                    onCancel={() => {
                      setReclaimPlan(null)
                      setReclaimDiff(null)
                      setReclaimPhrase('')
                    }}
                  />
                </div>
              )}
              {reclaimResult && <ReclaimOutcome result={reclaimResult} />}
            </>
          )}

          {statsError && <div className="s-desc danger">{statsError}</div>}
          {removeNote && <div className="s-desc danger">{removeNote}</div>}

          {probe.containers.length === 0 && (
            <div className="faint" style={{ fontSize: 12 }}>
              {t('docker.panel.noContainers')}
            </div>
          )}

          {/* Healthchecks, worst first. Asked for rather than read on every
              refresh: it is one `docker inspect` per open panel and the answer
              only matters when somebody is looking. It covers RUNNING
              containers -- a stopped one's health is whatever it was when it
              stopped, and presenting that beside live answers reads as
              current. */}
          {/* Item 42's engine upgrade. Beside the health log because both are
              questions about the DAEMON rather than about a container, and both
              are asked for rather than read on every refresh. */}
          {server && <EngineUpgradePanel
            manager={allFacts[server.id]?.facts?.packageManager ?? null}
            read={() =>
              // No fallback to apt. A server whose facts have not been
              // collected gets the `unchecked` refusal above rather than a
              // read built on a guess about its distribution.
              bridge()?.enginePrecheck?.(
                targetCfg(),
                allFacts[server.id]?.facts?.packageManager ?? 'apt'
              ) ??
              Promise.resolve({
                ok: false as const,
                detail: t('docker.notWired.enginePrecheck')
              })
            }
            // The plan goes to the JOBS surface with its approval minted the
            // way every other elevated job's is. An install with sudo is not
            // something to launch from a read panel on a click.
            onRun={(spec) => void launchEngineJob(spec)}
          />}

          <HealthLogPanel
            refs={probe.containers.filter((c) => c.state === 'running').map((c) => refOf(c))}
            read={(refs) =>
              bridge()?.healthLogs?.(targetCfg(), refs, { sudo: useSudo }) ??
              Promise.resolve({
                ok: false as const,
                reason: 'unknown' as const,
                detail: t('docker.notWired.healthLogs')
              })
            }
          />

          {/* Only once there is enough to hunt through. A filter over four rows
              is furniture. */}
          {allContainers.length > 8 && (
            <div
              className="row muted"
              style={{ fontSize: 'var(--fs-xs)', marginTop: 8, alignItems: 'center' }}
            >
              <span className="grow">
                {t('docker.panel.shownCount', { shown: shown.length, count: allContainers.length })}
              </span>
              <input
                className="input"
                style={{ maxWidth: 200 }}
                placeholder={t('docker.panel.filterPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}

          {/* Said plainly rather than left as an empty panel: with a filter on,
              "nothing here" is a statement about the filter, not the host. */}
          {q !== '' && shown.length === 0 && (
            <div className="faint" style={{ fontSize: 'var(--fs-sm)', marginTop: 8 }}>
              {t('docker.panel.noMatch', { filter, total: allContainers.length })}
            </div>
          )}

          {groups.map((g, gi) => (
            <div
              key={g.project ?? ' ungrouped'}
              role={groups.length > 1 ? 'group' : undefined}
              aria-labelledby={groups.length > 1 ? `${groupIdBase}-${gi}` : undefined}
            >
              {/* Only worth a header when there is more than one bucket —
                  otherwise it is a heading over the whole list saying nothing. */}
              {/* The group's rank, not a caption's. It was 11px muted text over
                  13px full-brightness mono rows, so the parent was the weakest
                  thing in the list and 35 containers read as one flat run
                  (user report). `.ui-subtitle` is the rank made for group
                  headers; --fw-title makes it read as bold against the rows.
                  The gap sits ABOVE the heading so it joins its own rows, not
                  the group before. An h3 under the panel's h2, so a screen
                  reader can jump between projects. */}
              {groups.length > 1 && (
                <div
                  className="row"
                  style={{ marginTop: 'var(--sp-5)', marginBottom: 'var(--sp-1)', alignItems: 'center' }}
                >
                  <h3
                    id={`${groupIdBase}-${gi}`}
                    className="ui-subtitle grow"
                    title={g.project ?? undefined}
                    style={{
                      margin: 0,
                      fontWeight: 'var(--fw-title)',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {g.project === null ? t('docker.panel.noProject') : g.project}
                  </h3>
                  {g.project !== null && g.containers.some((c) => c.state === 'running') && (
                    <button
                      className="btn ghost sm"
                      disabled={acting}
                      title={t('docker.project.restartTitle', { project: g.project })}
                      aria-label={t('docker.project.restartLabel', { project: g.project })}
                      onClick={() =>
                        requestAction(
                          'restart',
                          g.containers.filter((c) => c.state === 'running')
                        )
                      }
                    >
                      <RotateCw size={12} /> {t('docker.project.restart')}
                    </button>
                  )}
                </div>
              )}

              {g.containers.map((c) => {
                const stat = stats?.[c.name]
                const open = detail?.id === c.id
                const pane = logs[c.id]
                return (
                  <div key={c.id}>
                    <div className="cron-row">
                      <span className={clsx('chip', stateTone(c.state))}>{c.state}</span>
                      <span className="mono cron-when">{c.composeService ?? c.name}</span>
                      <span className="faint cron-desc">{c.image}</span>
                      <span className="faint grow" title={c.ports}>
                        {c.status}
                      </span>
                      {stat && (
                        <span
                          className="faint mono"
                          title={t('docker.stats.rowTitle', { mem: stat.memUsage, net: stat.netIo })}
                        >
                          {t('docker.stats.row', {
                            cpu: stat.cpuPercent === null ? '—' : `${stat.cpuPercent.toFixed(1)}%`,
                            mem: stat.memPercent === null ? '—' : `${stat.memPercent.toFixed(1)}%`
                          })}
                        </span>
                      )}
                      <button
                        className={clsx('icon-btn sm', open && 'on')}
                        title={t('docker.row.inspectTitle')}
                        onClick={() => void toggleDetail(c)}
                      >
                        <Info size={13} />
                      </button>
                      <button
                        className="icon-btn sm"
                        aria-expanded={!!pane}
                        title={pane ? t('docker.row.closeLogsTitle', { name: c.name }) : t('docker.row.logsTitle', { name: c.name })}
                        onClick={() => void openLogs(c)}
                      >
                        <ScrollText size={13} />
                      </button>
                      {actionButtons(c)}
                      {/* Only for a container that is actually running — `docker exec`
                          into a stopped one fails with a message the user then has to
                          go and read, and the button implies it would work.
                          Deliberately no confirmation dialog: the user picked this
                          container and pressed a button labelled shell, which is the
                          approval. A modal here would be the nag that teaches
                          click-through on the ones that matter. */}
                      {/* Server-only: a container shell is a PTY carried over that
                          server's SSH connection, and the local terminal takes no
                          initial command. On this machine the equivalent is
                          `docker exec -it` in a local terminal tab. */}
                      {c.state === 'running' && validateContainerRef(c.name) && server && (
                        <button
                          className="icon-btn sm"
                          title={t('docker.row.shellTitle', { name: c.name, server: server.name })}
                          // Carries the sudo decision the listing already made. Without it the
                  // panel lists containers as root and then opens a shell as an
                  // account that cannot reach the socket — one feature behaving
                  // as two, which is exactly what an operator reported.
                  onClick={() => server && openContainerShell(server.id, c.name, usedSudoNow)}
                        >
                          <SquareTerminal size={13} />
                        </button>
                      )}
                      {/* The shell's column, kept on rows that cannot have one. */}
                      {server && !(c.state === 'running' && validateContainerRef(c.name)) && emptySlot}
                    </div>

                    {open && (
                      <InspectDetail
                        probe={detail?.probe ?? null}
                        scan={
                          bridge()?.scanImage
                            ? (ref) => bridge()!.scanImage!(targetCfg(), ref)
                            : null
                        }
                      />
                    )}

                    {/* Under the row it belongs to, not at the foot of the
                        panel: clicking a button should change something the
                        eye can already see. */}
                    {pane && poppedOut !== c.id && (
                      <LogPane
                        pane={pane}
                        inline
                        onChange={(next) => void runLogs(c.id, { ...pane, ...next })}
                        onPopOut={() => setPoppedOut(c.id)}
                        onClose={() => closeLogs(c.id)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </>
      )}

      {/* The same dialog shape as broadcast's, because it is the same model.
          The plan decides its strength; this only renders it. */}
      {pending && (
        <div className="bc-confirm">
          <div className="s-title">
            {pending.refs.length === 1
              ? t(CONFIRM_ONE[pending.plan.action])
              : t(CONFIRM_MANY[pending.plan.action], { count: pending.refs.length })}
          </div>
          <div className="s-desc mono">{pending.labels.join(', ')}</div>
          {pending.plan.reasons.length > 0 && (
            <div className="s-desc warn">
              <TriangleAlert size={12} /> {pending.plan.reasons.join('; ')}.
            </div>
          )}
          {pending.plan.confirmation.kind === 'type-to-confirm' && (
            <div className="input-group" style={{ marginTop: 6 }}>
              <input
                className="input"
                placeholder={t('docker.common.typeToContinue', { phrase: pending.plan.confirmation.phrase })}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              className="btn primary"
              disabled={!canConfirm || acting}
              onClick={() => void runAction(pending.plan.action, pending.refs)}
            >
              {t(ACTION_LABEL[pending.plan.action])}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setPending(null)
                setPhrase('')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Per container, always. "The command exited 1" says nothing about which
          of five containers is still up, which is the only question afterwards. */}
      {actionResult && (
        <div className={clsx('s-desc', actionResult.result.ok ? '' : 'danger')}>
          {!actionResult.result.ok && (
            <>
              <TriangleAlert size={12} /> {DOCKER_FAILURE_HELP[actionResult.result.reason]}
              <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
                {actionResult.result.detail}
              </div>
              {actionResult.result.reason === 'permission-denied' && !useSudo && (
                <div className="faint" style={{ marginTop: 6 }}>
                  {t('docker.result.permissionDenied')}
                </div>
              )}
            </>
          )}
          {actionResult.result.ok && (
            <>
              <div>
                {t(actionResult.result.usedSudo ? 'docker.result.summaryAsRoot' : 'docker.result.summary', {
                  action: actionResult.action,
                  ok: actionResult.result.outcomes.filter((o) => o.ok).length,
                  total: actionResult.result.outcomes.length
                })}
              </div>
              {actionResult.result.outcomes
                .filter((o) => !o.ok)
                .map((o) => (
                  <div key={o.ref} className="mono danger" style={{ fontSize: 11 }}>
                    {o.ref.slice(0, 12)}: {o.error}
                  </div>
                ))}
              {actionResult.result.unattributed.map((line, i) => (
                <div key={i} className="mono faint" style={{ fontSize: 11 }}>
                  {line}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Only what the user explicitly popped out lands down here now. Every
          other pane stays attached to the row it was opened from. */}
      {poppedOut && logs[poppedOut] && (
        <LogPane
          pane={logs[poppedOut]}
          onChange={(next) => void runLogs(poppedOut, { ...logs[poppedOut], ...next })}
          onDock={() => setPoppedOut(null)}
          onClose={() => closeLogs(poppedOut)}
        />
      )}
    </div>
  )
}

/**
 * What a container is wired to.
 *
 * Environment is a COUNT and nothing else. The values are never read off the
 * host — the remote template computes `len` — because a container's environment
 * is where its database password lives, and this app's whole thesis is that
 * credentials do not leak. A "show env" button would be a one-line change and
 * that is exactly why the reason for its absence is written down here.
 */
function InspectDetail({
  probe,
  scan
}: {
  probe: DockerInspectProbe | null
  scan: ((ref: string) => Promise<ImageScanProbe>) | null
}): React.JSX.Element {
  const t = useT()
  if (probe === null) {
    return (
      <div className="faint" style={{ fontSize: 11, padding: '4px 0 8px 12px' }}>
        {t('docker.inspect.reading')}
      </div>
    )
  }
  if (!probe.ok) {
    return (
      <div className="s-desc danger" style={{ marginLeft: 12 }}>
        <TriangleAlert size={12} /> {DOCKER_FAILURE_HELP[probe.reason]}
        <div className="mono" style={{ marginTop: 4, opacity: 0.8 }}>
          {probe.detail}
        </div>
      </div>
    )
  }
  const i = probe.inspect
  return (
    <div style={{ padding: '4px 0 10px 12px', fontSize: 11 }} className="faint">
      <div className="row wrap" style={{ gap: 8, marginBottom: 4 }}>
        {i.health !== null && <span className={clsx('chip', healthTone(i.health))}>{i.health}</span>}
        <span className="chip">restart: {i.restartPolicy === '' ? t('docker.inspect.unset') : i.restartPolicy}</span>
        {/* A restart count climbing on its own is a crash loop, and it is the
            one number here that is a diagnosis rather than a fact. */}
        {(i.restartCount ?? 0) > 0 && (
          <span className={clsx('chip', (i.restartCount ?? 0) > 5 && 'warn')}>
            {t('docker.inspect.restarted', { n: i.restartCount ?? 0 })}
          </span>
        )}
        {i.exitCode !== null && i.status !== 'running' && <span className="chip">{t('docker.health.exit', { code: i.exitCode })}</span>}
        <span className="chip">{t('docker.inspect.envVars', { n: i.envCount ?? '?' })}</span>
        <span className="chip">logs: {i.logDriver === '' ? t('docker.inspect.unknown') : i.logDriver}</span>
      </div>
      <div className="mono">image {i.image}</div>
      {/* The scan lives beside the image reference because that is what it is
          about -- a container's vulnerabilities are its image's. Asked for, not
          run on open: it is a scanner invocation that may download a 111 MB
          database. */}
      {scan !== null && <ImageScanPanel image={i.image} scan={scan} />}
      {/* The reference and the digest disagree constantly, and that
          disagreement — "latest" is not the latest here — is frequently the
          bug being hunted. */}
      <div className="mono">digest {i.imageId.replace(/^sha256:/, '').slice(0, 19)}</div>
      <div className="mono">started {i.startedAt}</div>
      {i.ports.length > 0 && (
        <div className="mono">
          ports{' '}
          {i.ports
            .map((p) => (p.host === '' ? t('docker.inspect.notPublished', { port: p.container }) : `${p.host} → ${p.container}`))
            .join(', ')}
        </div>
      )}
      {i.mounts.length > 0 && (
        <div>
          {i.mounts.map((m) => (
            <div key={`${m.type}:${m.destination}`} className="mono">
              {m.type} {m.source} → {m.destination} ({m.mode})
            </div>
          ))}
        </div>
      )}
      {i.networks.length > 0 && (
        <div className="mono">
          networks {i.networks.map((n) => (n.ip === '' ? n.name : `${n.name} ${n.ip}`)).join(', ')}
        </div>
      )}
    </div>
  )
}

/**
 * The disk, item by item — with a checkbox against each thing that may go.
 *
 * The summary above answers "which category is big". This answers "which one",
 * which is the question an operator actually has at 2am.
 *
 * WHAT CHANGED FROM 21a, and what did not. There used to be no delete button
 * here, and the reason given was that "what is safe to remove depends on which
 * containers happen to be stopped right now, and a list rendered thirty seconds
 * ago cannot know that". That objection is still true and it is still not
 * answered by this component — it is answered by the two steps around it: the
 * offer set never contains a thing docker would refuse to remove anyway, and
 * the disk is read AGAIN immediately before anything runs, with the removal
 * abandoned if the two readings disagree. A checkbox here is a proposal, not a
 * decision.
 *
 * Nothing is ticked for you and there is no select-all. `shared/docker.ts`
 * states the rule — targets are explicit, there is no "all containers" action —
 * and a select-all box would be `prune` reached by a click instead of a flag.
 *
 * A row this refuses to offer still appears, greyed, with the reason on it. An
 * operator hunting 40GB needs to know that the 1.4GB volume is not offered
 * BECAUSE something is linked to it; a row that silently had no checkbox would
 * read as a rendering bug.
 *
 * THE NUMBER THIS COMPONENT DOES NOT COMPUTE: a total. Image SIZE counts layers
 * shared with other images, so adding the rows up overstates the disk, often by
 * a multiple — and it looks right in any fixture, because a fixture has no
 * shared layers. The headline stays with `docker system df`, which did the
 * arithmetic on the host and knows about the sharing. That holds for the
 * SELECTION too: the bar below this component counts rows, it does not add
 * bytes.
 */
function DiskItems({
  probe,
  preview,
  picked,
  onToggle,
  onClose
}: {
  probe: Extract<DockerDiskDetailProbe, { ok: true }>
  preview: DockerReclaimPreview
  picked: Set<string>
  onToggle: (item: DockerReclaimItem) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const d = probe.disk
  const offered = new Map(preview.items.map((i) => [dockerReclaimKey(i), i]))
  const refused = new Map(preview.withheld.map((w) => [dockerReclaimKey(w), w]))
  // Offered first, then the refused ones with their reason. Both, always: a
  // network the operator can see in `docker network ls` and not here is a list
  // that looks broken.
  const networks = [
    ...preview.items.filter((i) => i.kind === 'network'),
    ...preview.withheld.filter((w) => w.kind === 'network')
  ]

  /**
   * The checkbox, or the reason there isn't one.
   *
   * Both come from `buildDockerReclaimPreview` rather than from a rule written
   * again here. A second copy of "is this removable" living in the renderer is
   * how the box and the command eventually disagree about the same row.
   */
  const pick = (kind: string, id: string): React.JSX.Element => {
    const key = dockerReclaimKey({ kind, id })
    const item = offered.get(key)
    if (item === undefined) {
      const why = refused.get(key)
      return (
        <span
          className="faint mono"
          style={{ width: 14, display: 'inline-block', textAlign: 'center' }}
          title={why ? t('docker.disk.notOfferedWhy', { reason: why.reason }) : t('docker.disk.notOffered')}
        >
          ·
        </span>
      )
    }
    return (
      <input
        type="checkbox"
        checked={picked.has(key)}
        aria-label={t('docker.disk.removeItemLabel', { label: item.label })}
        title={t('docker.disk.removeItemTitle', { label: item.label, id: item.id })}
        onChange={() => onToggle(item)}
      />
    )
  }
  // Largest first, per kind. Sorting is most of the reason to itemise at all:
  // the answer is nearly always in the first two rows.
  const images = [...d.images].sort((a, b) => (b.uniqueSizeBytes ?? 0) - (a.uniqueSizeBytes ?? 0))
  const containers = [...d.containers].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
  const volumes = [...d.volumes].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
  const cache = [...d.buildCache].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
  const empty = images.length === 0 && containers.length === 0 && volumes.length === 0 && cache.length === 0

  // `.cron-when` has a minimum width and no maximum, and an image reference is
  // unbounded: `registry.example.com/platform/team/service:2024-11-04-abcdef`
  // pushed the size and the chips off the end of the row. Clipped here rather
  // than in the shared rule, which the scheduled-jobs table relies on.
  const nameCell: React.CSSProperties = {
    maxWidth: 320,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  }

  const heading = (text: string, count: number): React.JSX.Element => (
    <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
      <span className="grow">
        {text} ({count})
      </span>
    </div>
  )

  return (
    <>
      <div className="row muted" style={{ fontSize: 11, marginTop: 8, alignItems: 'center' }}>
        <span className="grow">{t('docker.disk.byItem')}</span>
        {/* Absolute, and computed on the host rather than looked up in a table
            of release dates that would need an owner and would eventually be
            wrong. Absent on a runtime that will not answer — podman's docker
            shim fails `.Server.*` templates outright — and saying nothing is
            the honest form of that. */}
        {probe.engine && <span className="faint">{formatDockerEngineAge(probe.engine, Date.now())}</span>}
        {/* This read has its own sudo failover, and the banner above the panel
            is about the CONTAINER LIST. Without this, a listing that had to
            escalate to root to be readable said nothing about it. */}
        {probe.usedSudo === true && <span className="faint">{t('docker.disk.readAsRoot')}</span>}
        <button className="btn ghost sm" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>

      <div className="faint" style={{ fontSize: 11 }}>
        {t('docker.disk.tickHint')}
      </div>

      {images.length > 0 && heading(t('docker.disk.images'), images.length)}
      {images.map((i) => (
        <div key={`${i.id}:${i.repository}:${i.tag}`} className="cron-row">
          {pick('image', i.id)}
          <span className="mono cron-when" style={nameCell} title={`${i.repository}:${i.tag}`}>
            {i.repository}:{i.tag}
          </span>
          <span className="faint cron-desc">
            {i.id} · {i.created}
          </span>
          <span className="grow" />
          {/* An untagged image with nothing running off it is the classic
              leftover — a previous build's layers, orphaned by the next one. */}
          {i.dangling && <span className="chip warn">{t('docker.disk.dangling')}</span>}
          <span className={clsx('chip', i.containers === 0 && 'warn')}>
            {i.containers === null || i.containers === undefined
              ? t('docker.disk.containersUnknown')
              : t('docker.disk.imageContainers', { count: i.containers })}
          </span>
          {/* UNIQUE SIZE, not SIZE. SIZE includes layers other images share, so
              it is the number that makes a 300MB image look like 900MB. */}
          <span
            className="mono"
            title={
              i.uniqueSize === ''
                // No UNIQUE SIZE column from this runtime, so the number shown
                // IS the total. Repeating it as "x including shared layers"
                // said the same figure twice and implied a comparison that was
                // never made.
                ? t('docker.disk.sizeNoUnique', { size: i.size })
                : t('docker.disk.sizeShared', { size: i.size })
            }
          >
            {i.uniqueSize === '' ? i.size : i.uniqueSize}
          </span>
        </div>
      ))}

      {containers.length > 0 && heading(t('docker.disk.containers'), containers.length)}
      {containers.map((c) => (
        <div key={c.id} className="cron-row">
          {pick('container', c.id)}
          <span className="mono cron-when" style={nameCell} title={c.name}>
            {c.name}
          </span>
          <span className="faint cron-desc">{c.image}</span>
          <span className="grow" />
          <span className={clsx('chip', stateTone(c.state))}>{c.status}</span>
          {/* The writable layer only. The image's bytes are in the table above,
              and adding the two together would count them twice. */}
          <span className="mono" title={t('docker.disk.writableLayer')}>
            {c.size}
          </span>
        </div>
      ))}

      {volumes.length > 0 && heading(t('docker.disk.volumes'), volumes.length)}
      {volumes.map((v) => (
        <div key={v.name} className="cron-row">
          {pick('volume', v.name)}
          {/* A generated 64-hex name is unreadable at full length and its first
              twelve characters are what `docker volume ls` shows anyway. A name
              a person typed is shown whole. */}
          <span className="mono cron-when" style={nameCell} title={v.name}>
            {v.anonymous ? v.name.slice(0, 12) : v.name}
          </span>
          {/* Named and anonymous are different risks wearing the same row.
              An anonymous volume with no links is usually rubbish; a NAMED one
              with no links is usually the database of something that happens to
              be stopped — and docker's own `volume prune` has skipped named
              ones since 23, which this deliberately does not. The plan says so
              in a caveat; the word here is so it is visible before the tick. */}
          <span className={clsx('faint cron-desc', !v.anonymous && 'warn')}>
            {v.anonymous ? t('docker.reclaim.anonymous') : t('docker.reclaim.named')}
          </span>
          <span className="grow" />
          {/* No links is not the same as unwanted: an anonymous volume with no
              links is usually rubbish, a NAMED one with no links is usually the
              database of something that happens to be stopped. */}
          {v.links === 0 && <span className={clsx('chip', v.anonymous && 'warn')}>{t('docker.disk.noContainers')}</span>}
          {(v.links ?? 0) > 0 && <span className="chip">{t('docker.disk.linked', { n: v.links ?? 0 })}</span>}
          <span className="mono">{v.size}</span>
        </div>
      ))}

      {cache.length > 0 && heading(t('docker.disk.buildCache'), cache.length)}
      {cache.map((c) => (
        <div key={c.id} className="cron-row">
          {/* Never a checkbox. A single build-cache entry has no `docker builder
              rm`; it comes out only through `builder prune --filter`, which is a
              prune, and nothing here runs one. */}
          {pick('cache', c.id)}
          <span className="mono cron-when">{c.id}</span>
          <span className="faint cron-desc">
            {t('docker.disk.cacheLastUsed', {
              type: c.type,
              when: c.lastUsed === '' ? t('docker.disk.cacheNever') : c.lastUsed
            })}
          </span>
          <span className="grow" />
          <span className="mono">{c.size}</span>
        </div>
      ))}

      {/* Networks come from their own read -- `system df -v` lists none -- so
          they are rendered from the preview rather than from a table of `d`.
          Both halves: the offered ones and the ones this will not offer, with
          the reason. A network attached only to a STOPPED container reports
          zero attachments to `docker network inspect`, and removing it on that
          basis breaks a `compose start` in a way recreating the network does
          not fix, so the withheld reason is the point of the row. */}
      {networks.length > 0 && heading(t('docker.disk.networks'), networks.length)}
      {networks.map((n) => (
        <div key={n.id === '' ? n.label : n.id} className="cron-row">
          {pick('network', n.id)}
          <span className="mono cron-when" style={nameCell} title={n.id}>
            {n.label}
          </span>
          <span className="faint cron-desc">{'reason' in n ? n.reason : t('docker.disk.networkUnattached')}</span>
          <span className="grow" />
          {/* No size. Docker says nothing about a network's footprint and
              `0 B` would read as a measurement of it. */}
        </div>
      ))}

      {/* An answer, and one worth printing: four headings with nothing under
          any of them renders as silence otherwise, which reads like a host
          that failed to load rather than a host holding nothing. */}
      {empty && (
        <div className="faint" style={{ fontSize: 11 }}>
          {t('docker.disk.empty')}
        </div>
      )}

      {/* Absent and empty are different sentences, and only one of them is
          about this host. podman has historically not printed a build cache
          table at all. */}
      {!d.sections.buildCache && (
        <div className="faint" style={{ fontSize: 11 }}>
          {t('docker.disk.noBuildCache')}
        </div>
      )}
      {d.unreadable > 0 && (
        <div className="faint" style={{ fontSize: 11 }}>
          {t('docker.disk.unreadableRows', { count: d.unreadable })}
        </div>
      )}
    </>
  )
}
