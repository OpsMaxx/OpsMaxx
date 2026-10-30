import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Boxes,
  Gauge,
  HardDrive,
  Layers,
  RefreshCw,
  RotateCw,
  ScrollText,
  Server as ServerIcon,
  ShieldQuestion,
  Siren,
  SquareTerminal,
  TriangleAlert
} from 'lucide-react'
import { sshHopsFor } from '../../lib/ssh'
import { LOCAL_TARGET } from '../../../../shared/execTarget'
import { clsx } from '../../lib/format'
import { Explain } from '../common/Explain'
import { hostChoices, anyConnected, resolveHostId } from '../../lib/hostChoices'
import {
  K8S_FAILURE_HELP,
  k8sRelativeTime,
  nodeIsUnhealthy,
  countSchedulableNodes,
  planK8sCordon,
  planK8sDrain,
  planK8sRollout,
  readsAfterNamespaceChange,
  validatePodName,
  workloadIsDegraded,
  type K8sApiScan,
  type K8sCordonPlan,
  type K8sCordonTarget,
  type K8sCordonResult,
  type K8sDiagnosis,
  type K8sDrainAssessment,
  type K8sDrainPlan,
  type K8sDrainResult,
  type K8sEvent,
  type K8sExecPlan,
  type K8sExecResult,
  type K8sExecTarget,
  type K8sHelmList,
  type K8sNode,
  type K8sOverview,
  type K8sPod,
  type K8sProbe,
  type K8sRead,
  type K8sResources,
  type K8sRolloutPlan,
  type K8sRolloutResult,
  type K8sRolloutTarget,
  type K8sSchedulingAction,
  type K8sTextRead,
  type K8sUsage,
  type K8sWorkload,
  type K8sAllocatableProbe
} from '../../../../shared/kubernetes'
import { allocationHeadline } from '../../../../shared/k8sAllocatable'
import { useApp } from '../../store/app'
import {
  assessNodeSkew,
  pdbHeadroom,
  summariseUpgradeReadiness
} from '../../../../shared/k8sSkew'
import {
  reviewFindings,
  type K8sReviewProbe,
  type ReviewFinding
} from '../../../../shared/k8sReview'
import { approvalFor, type CommandApproval } from '../../../../shared/broadcast'
import type { Server } from '../../types'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { EmptyState } from '../common/EmptyState'
import { useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

// Pods on a cluster reachable from a server, and what you do about them.
//
// The first version of this panel was reconnaissance: it listed pods and read
// 200 static log lines, so it could tell you a pod was in CrashLoopBackOff and
// then had nothing further to say. Everything past the pod list is the "why",
// in roughly the order an operator asks for it — events, the previous
// container's logs, then the workload behind the pod and the node under it.
//
// FOUR THINGS HERE CHANGE THE CLUSTER, and each is treated as one:
//  - `rollout restart`, whose confirmation scales to blast radius the way
//    shared/broadcast.ts scales its own.
//  - Cordon and uncordon, a plain confirm in both directions. Nothing is
//    evicted, and the plan says so with the pod count — the single most common
//    misreading of that button is that it moved something.
//  - Drain, which is offered ONLY after a preflight read says it is safe, and
//    which is not offered at all when it is not. A refusal here is no dialog,
//    not a scarier one: the main process re-takes the same preflight and would
//    refuse anyway, so a disabled button with a tooltip would be a control that
//    cannot work.
//  - Exec, which mints a `CommandApproval` against the command string the MAIN
//    PROCESS built, not one built here — so if the two ever disagree,
//    `verifyApproval` refuses rather than running something this dialog did not
//    describe.
//
// Nothing here switches the context, applies a manifest, or deletes anything —
// see the header of shared/kubernetes.ts, which explains why single-pod
// deletion in particular is missing rather than forgotten, and why applying is
// a pipeline's job.

/**
 * The channels this panel calls, described where it calls them.
 *
 * `window.opsmaxx.k8s` is built in the preload and its type comes from
 * there, so the four operational channels do not exist on it until the main
 * process wires them. They are optional here on purpose: a panel that assumes a
 * channel exists renders a permanent spinner when it does not, and "this build
 * has no diagnose channel" is a sentence, not a mystery.
 */
interface K8sBridge {
  allocatable?: (cfg: unknown, context?: string) => Promise<K8sAllocatableProbe>
  read?: (cfg: unknown, context?: string, namespace?: string) => Promise<K8sProbe>
  logs?: (
    cfg: unknown,
    namespace: string,
    pod: string,
    lines: number,
    context?: string
  ) => Promise<{ ok: boolean; output: string; error?: string }>
  diagnose?: (
    cfg: unknown,
    namespace: string,
    pod: string,
    context?: string,
    previousLines?: number
  ) => Promise<K8sDiagnosis>
  overview?: (cfg: unknown, context?: string, namespace?: string) => Promise<K8sOverview>
  usage?: (cfg: unknown, context?: string, namespace?: string) => Promise<K8sUsage>
  rolloutRestart?: (
    cfg: unknown,
    target: K8sRolloutTarget,
    confirmed: boolean
  ) => Promise<K8sRolloutResult>
  cordon?: (
    cfg: unknown,
    target: K8sCordonTarget,
    confirmed: boolean
  ) => Promise<K8sCordonResult>
  drainPreflight?: (cfg: unknown, node: string, context?: string) => Promise<K8sDrainAssessment>
  drain?: (
    cfg: unknown,
    node: string,
    context: string | undefined,
    confirmed: boolean
  ) => Promise<K8sDrainResult & { plan?: K8sDrainPlan }>
  execPlan?: (target: K8sExecTarget) => Promise<{ plan: K8sExecPlan; command: string }>
  exec?: (cfg: unknown, target: K8sExecTarget, approval: unknown) => Promise<K8sExecResult>
  resources?: (cfg: unknown, context?: string, namespace?: string) => Promise<K8sResources>
  apiScan?: (cfg: unknown, context?: string) => Promise<K8sApiScan>
  review?: (cfg: unknown, context?: string) => Promise<K8sReviewProbe>
  helm?: (cfg: unknown, context?: string) => Promise<K8sHelmList>
}

const bridge = (): K8sBridge =>
  ((window.opsmaxx as { k8s?: K8sBridge } | undefined)?.k8s ?? {}) as K8sBridge

function podTone(p: K8sPod): string {
  if (/CrashLoopBackOff|Error|Failed|Evicted/i.test(p.status)) return 'danger'
  if (p.status === 'Succeeded' || p.status === 'Completed') return ''
  const [ready, total] = p.ready.split('/')
  if (p.status === 'Running' && ready === total) return ''
  return 'warn'
}

/**
 * What a block says when it could not be read.
 *
 * Every read renders through this rather than falling back to an empty list.
 * RBAC is per resource — a token that lists pods very often cannot list events
 * — so "no events" and "not allowed to see events" appear next to each other
 * constantly, and they mean opposite things.
 */
function Denied({ read, what }: { read: { reason: keyof typeof K8S_FAILURE_HELP; detail: string }; what: string }): React.JSX.Element {
  // `no-previous` and `no-metrics` are not the user's problem to fix and are
  // not failures of this account — dressing them in a red warning triangle
  // teaches people to ignore the triangle.
  const t = useT()
  const benign = read.reason === 'no-previous' || read.reason === 'no-metrics'
  return (
    <div className={clsx('s-desc', benign ? 'faint' : 'danger')}>
      {!benign && <TriangleAlert size={12} />}{' '}
      {t('k8s.panel.deniedLine', { what, help: K8S_FAILURE_HELP[read.reason] })}
      <div className="mono" style={{ marginTop: 4, opacity: 0.8, whiteSpace: 'pre-wrap' }}>
        {read.detail}
      </div>
    </div>
  )
}

function EventRows({ events }: { events: K8sEvent[] }): React.JSX.Element {
  return (
    <>
      {events.map((e, i) => (
        <div key={`${e.objectName}-${e.reason}-${e.lastSeen}-${i}`} className="cron-row">
          <span className={clsx('chip', e.type === 'Warning' && 'warn')}>{e.reason}</span>
          <span className="mono cron-when">{k8sRelativeTime(e.lastSeen) || '—'}</span>
          <span className="faint cron-desc" title={`${e.objectKind}/${e.objectName}`}>
            {e.objectName}
          </span>
          <span className="grow cron-cmd" title={e.message}>
            {e.message}
          </span>
          {/* A repeat count is the difference between "it hiccuped" and "it has
              been doing this four hundred times". */}
          {e.count > 1 && <span className={clsx('chip', e.count > 20 && 'warn')}>×{e.count}</span>}
        </div>
      ))}
    </>
  )
}

/** The key a pod's row — and the log pane under it — are both addressed by. */
const podKey = (p: { namespace: string; name: string }): string => `${p.namespace}/${p.name}`

/**
 * One pod's logs, rendered either under its own row or in the panel at the
 * bottom. Identical markup both times: the difference between glancing at it
 * here and reading it properly down there is where it is mounted, not what it
 * says.
 */
function LogPane({
  entry,
  inline,
  onPopOut,
  onDock,
  onClose
}: {
  entry: { pod: string; output: string }
  inline?: boolean
  onPopOut?: () => void
  onDock?: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div style={inline ? { paddingBottom: 6 } : undefined}>
      <div className="row muted" style={{ fontSize: 11, marginTop: inline ? 4 : 10 }}>
        <span className="grow">{t('k8s.panel.logsOf', { pod: entry.pod })}</span>
        {inline && onPopOut && (
          <button
            className="btn ghost sm"
            title={t('k8s.panel.popOutTitle')}
            onClick={onPopOut}
          >
            {t('k8s.panel.popOut')}
          </button>
        )}
        {!inline && onDock && (
          <button
            className="btn ghost sm"
            title={t('k8s.panel.dockTitle')}
            onClick={onDock}
          >
            {t('k8s.panel.dock')}
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
        {entry.output}
      </pre>
    </div>
  )
}


/** Pure, and at module scope so DiagPane can use it too — it was declared
 *  inside the component only because nothing outside needed it before. */
function textBlock(r: K8sTextRead, label: string): React.JSX.Element {
  return r.ok ? (
    <pre className="bc-out" style={{ marginLeft: 0, maxHeight: 260 }}>
      {r.text}
    </pre>
  ) : (
    <Denied read={r} what={label} />
  )
}

/**
 * One pod's diagnosis, rendered under the row it was opened from.
 *
 * Mirrors LogPane deliberately — same shape, same Close, same inline indent —
 * because the two open from adjacent buttons on the same row and reading as
 * one thing is the point.
 */
function DiagPane({
  entry,
  onClose
}: {
  entry: { pod: string; result: K8sDiagnosis | null; error?: string }
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div style={{ paddingBottom: 6 }}>
      <div className="row muted" style={{ fontSize: 11, marginTop: 4 }}>
        <span className="grow">{t('k8s.panel.diagnosisOf', { pod: entry.pod })}</span>
        <button className="btn ghost sm" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
          {entry.error && <div className="s-desc danger">{entry.error}</div>}
          {!entry.result && !entry.error && (
            <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.reading')}</div>
          )}
          {entry.result && (
            <>
              {/* Events first. They are the answer far more often than the
                  logs are, and a Pending pod has nothing else at all. */}
              <div className="s-title" style={{ marginTop: 6 }}>
                <Activity size={12} /> Events
              </div>
              {!entry.result.events.ok ? (
                <Denied read={entry.result.events} what="Events" />
              ) : entry.result.events.items.length === 0 ? (
                <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.noPodEvents')}</div>
              ) : (
                <EventRows events={entry.result.events.items} />
              )}

              <div className="s-title" style={{ marginTop: 10 }}>
                <ScrollText size={12} /> {t('k8s.panel.previousContainer')}
              </div>
              {textBlock(entry.result.previousLogs, t('k8s.panel.previousContainerLogs'))}

              <div className="s-title" style={{ marginTop: 10 }}>
                <Boxes size={12} /> describe
              </div>
              {textBlock(entry.result.describe, t('k8s.panel.describe'))}
            </>
          )}
    </div>
  )
}

function readEmpty<T>(r: K8sRead<T>): boolean {
  return r.ok && r.items.length === 0
}

/** Not a server id: no server can have it, because ids are UUIDs. */
const LOCAL_ID = 'local'

export function KubernetesPanel({ servers }: { servers: Server[] }): React.JSX.Element {
  const t = useT()
  const NOT_WIRED = t('k8s.panel.notWired')
  const [serverId, setServerId] = useState('')
  const [context, setContext] = useState('')
  const [namespace, setNamespace] = useState('')

  const [probe, setProbe] = useState<K8sProbe | null>(null)
  /**
   * A namespace the cluster does not have falls back to all namespaces.
   *
   * The belt to the braces above. Clearing the selection when the host or the
   * context changes covers the paths this panel controls; this covers the rest
   * — a namespace deleted on the cluster since it was picked, a kubeconfig
   * edited underneath us, a restored selection from a previous session.
   *
   * `<select>` with a value matching no option renders BLANK rather than
   * failing, so without this the control shows nothing at all while the reads
   * underneath it stay scoped to a namespace that is gone. Falling back to
   * "all namespaces" is the one choice that is always valid and always
   * truthful about what is being shown.
   */
  useEffect(() => {
    if (!probe?.ok || namespace === '') return
    if (!probe.namespaces.includes(namespace)) setNamespace('')
  }, [probe, namespace])
  const [loading, setLoading] = useState(false)
  // Keyed by `${namespace}/${name}` — the same key the pod rows are keyed by —
  // so several pods can be open at once and every pane knows its own row.
  const [logs, setLogs] = useState<Record<string, { pod: string; output: string }>>({})
  // The one pane the user asked to read in the big panel at the bottom instead.
  const [poppedOut, setPoppedOut] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // Item 40's watch list. Keyed on the CONTEXT rather than the server, because
  // a cluster reachable from three admin boxes is one thing to watch.
  const k8sWatch = useApp((st) => st.settings.k8sWatch) ?? []
  const watchContext = context || (probe?.ok ? probe.currentContext : null) || ''
  const watched = k8sWatch.some((w) => w.context === watchContext)
  const setWatch = (on: boolean): void => {
    const rest = k8sWatch.filter((w) => w.context !== watchContext)
    useApp
      .getState()
      .setSettings({ k8sWatch: on ? [...rest, { serverId, context: watchContext }] : rest })
  }

  const [view, setView] = useState<'pods' | 'cluster' | 'usage' | 'resources'>('pods')
  const [overview, setOverview] = useState<K8sOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [usage, setUsage] = useState<K8sUsage | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [alloc, setAlloc] = useState<K8sAllocatableProbe | null>(null)
  const [allocLoading, setAllocLoading] = useState(false)
  /**
   * Keyed by pod, like `logs`, and for the same reason.
   *
   * It was a single nullable slot rendered near the foot of the panel — after
   * the pods list, the workloads, usage and resources views, the node list and
   * four dialogs. On a cluster with a screenful of pods, pressing the button
   * changed nothing the eye could see, which is indistinguishable from a dead
   * button. It is the defect a17c1aa7 fixed for logs; diagnosis was never
   * migrated, and a second open pod silently replaced the first.
   */
  const [diag, setDiag] = useState<
    Record<string, { pod: string; result: K8sDiagnosis | null; error?: string }>
  >({})

  // The state change, and everything it needs to be deliberate.
  const [resources, setResources] = useState<K8sResources | null>(null)
  const [apiScan, setApiScan] = useState<K8sApiScan | null>(null)
  // The whole-cluster review. Its OWN button, not part of the refresh: it is
  // thirteen kubectl calls and the answer only matters when somebody is asking
  // the question it answers.
  const [review, setReview] = useState<K8sReviewProbe | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)

  const runReview = async (): Promise<void> => {
    if (!hasTarget) return
    setReviewLoading(true)
    try {
      const b = bridge()
      setReview(
        b.review
          ? await b.review(targetCfg(), context || undefined)
          : { ok: false, detail: NOT_WIRED }
      )
    } catch (e) {
      setReview({ ok: false, detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setReviewLoading(false)
    }
  }
  const [helm, setHelm] = useState<K8sHelmList | null>(null)
  const [resourcesLoading, setResourcesLoading] = useState(false)

  // Node lifecycle. `nodeBusy` is the node name, so two rows cannot be acted on
  // at once and the row that is working is the one that says so.
  const [nodeBusy, setNodeBusy] = useState('')
  const [nodePending, setNodePending] = useState<{ plan: K8sCordonPlan } | null>(null)
  const [nodePhrase, setNodePhrase] = useState('')
  // Trimmed, and compared exactly. A plan that does not ask for a word is
  // confirmed by opening the dialog at all.
  const nodeConfirmed =
    nodePending === null ||
    nodePending.plan.confirmation.kind !== 'type-to-confirm' ||
    nodePhrase.trim() === nodePending.plan.confirmation.phrase
  const [nodeResult, setNodeResult] = useState<K8sCordonResult | null>(null)
  // The preflight lives beside the drain dialog rather than inside it: it is a
  // READ, it takes a round trip, and the verdict is the thing the operator is
  // actually reading before deciding.
  const [drainCheck, setDrainCheck] = useState<{
    node: string
    assessment: K8sDrainAssessment | null
    plan: K8sDrainPlan | null
    loading: boolean
  } | null>(null)
  const [drainResult, setDrainResult] = useState<(K8sDrainResult & { plan?: K8sDrainPlan }) | null>(
    null
  )

  // Exec. `execCommand` is separate from the plan because the plan is only
  // minted once the command is typed — a dialog cannot describe a command that
  // does not exist yet.
  const [execFor, setExecFor] = useState<K8sPod | null>(null)
  const [execCommand, setExecCommand] = useState('')
  const [execContainer, setExecContainer] = useState('')
  const [execPhrase, setExecPhrase] = useState('')
  const [execBusy, setExecBusy] = useState(false)
  // `key` is podKey(namespace/name); `pod` is the bare name, kept only for the
  // sentence the result renders. The two are not interchangeable — see where
  // this is set.
  const [execResult, setExecResult] = useState<{
    key: string
    pod: string
    r: K8sExecResult
  } | null>(null)

  const [pending, setPending] = useState<{ plan: K8sRolloutPlan } | null>(null)
  const [phrase, setPhrase] = useState('')
  const [restarting, setRestarting] = useState(false)
  const [restartResult, setRestartResult] = useState<{ name: string; r: K8sRolloutResult } | null>(null)

  // Every host, not just the dialled ones — kubectl goes over SSH and dials on
  // demand, and `status` is written on the edge of a connect and never
  // re-asserted, so filtering on it hid reachable servers. See
  // lib/hostChoices.ts.
  const eligible = useMemo(() => hostChoices(servers), [servers])

  /**
   * "This machine" as a target.
   *
   * A sentinel in this panel's own selection state, never a row in `servers`:
   * that list is persisted and mirrored into the MCP data cache, so a pseudo
   * server would become an agent-addressable target the moment it was written.
   * See shared/execTarget.ts.
   *
   * Resolved rather than read straight off `serverId` so the dropdown and the
   * target can never disagree — with nothing online the browser would render
   * the only option as selected while the state was still ''.
   */
  /**
   * A STALE `serverId` MUST NOT SURVIVE THIS.
   *
   * `serverId` is component-local and outlives the server it names: delete the
   * server, or switch to a workspace that does not have it, and this still
   * holds the old id. `servers.find` then returns undefined, `localSelected`
   * is false, and `targetCfg()` calls `cfgFor(undefined)` — which reads `.id`
   * and throws. That is a render-time call (the compose panel is handed a cfg
   * as a prop), so it does not fail a button, it takes the whole panel down
   * through the error boundary. Reported from 0.50.19 as
   * "Cannot read properties of undefined (reading 'id')" at cfgFor/targetCfg.
   *
   * Resolving against the list that actually exists also fixes the blank
   * `<select>` the same staleness produced, and restores the promise the
   * comment below makes: the dropdown and the target cannot disagree.
   *
   * The resolution lives in lib/hostChoices.ts rather than here, because the
   * Docker panel had the identical line and the first version of this guard
   * broke both the same way: it discarded the LOCAL sentinel as stale, since
   * the sentinel is by design not a row in `servers`. See resolveHostId, which
   * states why.
   */
  const selectedId = resolveHostId(serverId, servers, LOCAL_ID)
  const localSelected = selectedId === LOCAL_ID
  const server = localSelected ? undefined : servers.find((s) => s.id === selectedId)
  // A local kubeconfig is the one most developers actually have — kind,
  // minikube, Docker Desktop, or a context pointing at a real cluster.
  const hasTarget = localSelected || !!server
  /** What main is told to run kubectl against. */
  const targetCfg = (): unknown => (localSelected ? LOCAL_TARGET : cfgFor(server as Server))
  const targetName = localSelected ? t('k8s.panel.thisMachine') : server?.name

  const cfgFor = (s: Server): unknown => ({
    sessionId: `k8s-${s.id}`,
    cols: 80,
    rows: 24,
    serverId: s.id,
    host: s.host,
    port: s.port,
    username: s.username,
    auth: s.auth === 'password' || s.auth === 'agent' ? s.auth : 'key',
    hops: sshHopsFor(s)
  })

  // `ns` overrides the namespace in state. Every one of these can be called
  // from the change handler of the control that sets that state, and React has
  // not applied it yet at that point — so reading it here would fetch the
  // selection the user just moved away from. `??` and not `||`: empty string is
  // "all namespaces", a real choice, not an absent one.
  const load = async (ctx?: string, ns?: string): Promise<void> => {
    if (!hasTarget) return
    setLoading(true)
    setLogs({})
    setPoppedOut(null)
    setDiag({})
    // Exec too. It is keyed by namespace/name, and that key means nothing
    // once the cluster underneath it has changed — a result from one
    // cluster would otherwise render under a same-named pod on the next.
    setExecFor(null)
    setExecResult(null)
    try {
      const r = await withVaultUnlock(
        t('k8s.panel.vaultReason'),
        async () => bridge().read?.(targetCfg(), ctx || undefined, (ns ?? namespace) || undefined)
      )
      setProbe(r ?? null)
    } catch (e) {
      setProbe({ ok: false, reason: 'unknown', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      // In a finally so a rejected invoke leaves a button that can be pressed
      // again rather than one that spins forever.
      setLoading(false)
    }
  }

  const loadOverview = async (ns?: string): Promise<void> => {
    if (!hasTarget) return
    setOverviewLoading(true)
    try {
      const fn = bridge().overview
      if (!fn) {
        const f = { ok: false, reason: 'unknown', detail: NOT_WIRED } as const
        setOverview({ deployments: f, statefulSets: f, daemonSets: f, nodes: f, serverVersion: null, pdbs: f, events: f })
        return
      }
      setOverview(await fn(targetCfg(), context || undefined, (ns ?? namespace) || undefined))
    } catch (e) {
      const f = {
        ok: false,
        reason: 'unknown',
        detail: e instanceof Error ? e.message : String(e)
      } as const
      setOverview({ deployments: f, statefulSets: f, daemonSets: f, nodes: f, serverVersion: null, pdbs: f, events: f })
    } finally {
      setOverviewLoading(false)
    }
  }

  /** Booked capacity. Takes no namespace: a node holds every pod on it. */
  const loadAllocatable = async (): Promise<void> => {
    if (!hasTarget) return
    setAllocLoading(true)
    try {
      const fn = bridge().allocatable
      if (!fn) {
        setAlloc({ ok: false, detail: NOT_WIRED })
        return
      }
      setAlloc(await fn(targetCfg(), context || undefined))
    } catch (e) {
      setAlloc({ ok: false, detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setAllocLoading(false)
    }
  }

  const loadUsage = async (ns?: string): Promise<void> => {
    if (!hasTarget) return
    setUsageLoading(true)
    try {
      const fn = bridge().usage
      if (!fn) {
        const f = { ok: false, reason: 'unknown', detail: NOT_WIRED } as const
        setUsage({ pods: f, nodes: f })
        return
      }
      setUsage(await fn(targetCfg(), context || undefined, (ns ?? namespace) || undefined))
    } catch (e) {
      const f = {
        ok: false,
        reason: 'unknown',
        detail: e instanceof Error ? e.message : String(e)
      } as const
      setUsage({ pods: f, nodes: f })
    } finally {
      setUsageLoading(false)
    }
  }

  const loadResources = async (ns?: string): Promise<void> => {
    if (!hasTarget) return
    setResourcesLoading(true)
    const ctx = context || undefined
    try {
      const b = bridge()
      const f = { ok: false, reason: 'unknown', detail: NOT_WIRED } as const
      setResources(
        b.resources
          ? await b.resources(targetCfg(), ctx, (ns ?? namespace) || undefined)
          : { pvcs: f, ingresses: f, roleBindings: f, secrets: f }
      )
      // Three separate round trips, not one, and the two extra ones are the
      // reads whose ABSENCE is normal: an api-scan against a cluster that will
      // not answer, and helm on a host that does not have it. Folding them into
      // the resources call would make every refresh wait on them.
      setApiScan(b.apiScan ? await b.apiScan(targetCfg(), ctx) : null)
      setHelm(
        b.helm
          ? await b.helm(targetCfg(), ctx)
          : { ok: false, reason: 'failed', detail: NOT_WIRED }
      )
    } catch (e) {
      const f = {
        ok: false,
        reason: 'unknown',
        detail: e instanceof Error ? e.message : String(e)
      } as const
      setResources({ pvcs: f, ingresses: f, roleBindings: f, secrets: f })
    } finally {
      setResourcesLoading(false)
    }
  }

  const podsOn = (node: string): number => (probe?.ok ? probe.pods : []).filter((p) => p.node === node).length

  const askToCordon = (n: K8sNode, action: K8sSchedulingAction): void => {
    setNodeResult(null)
    // Never carried across dialogs: a word typed for one node must not confirm
    // the next one.
    setNodePhrase('')
    setDrainCheck(null)
    // Computed here so the dialog can explain itself, and computed AGAIN in the
    // main process before anything runs — the same rule the restart follows.
    setNodePending({
      plan: planK8sCordon({
        node: n.name,
        action,
        // Only as many as this panel can see. When pods were listed for one
        // namespace rather than all of them this is an undercount, which is why
        // the plan's sentence is about eviction rather than about the number.
        // `scopedTo` as well as `allNamespaces`: a per-node pod count drawn
        // from a list narrowed to one namespace is not a smaller count, it is
        // a wrong one.
        podCount: probe?.ok && probe.allNamespaces && !probe.scopedTo ? podsOn(n.name) : null,
        // Null when the node list has not been read, rather than 0 or 1 — the
        // plan treats an absent count as unanswered and says so, instead of
        // deciding this is or is not the last node on a guess.
        schedulableNodes: overview?.nodes.ok ? countSchedulableNodes(overview.nodes.items) : null,
        context: context || (probe?.ok ? probe.currentContext : null)
      })
    })
  }

  const runCordon = async (): Promise<void> => {
    if (!server || !nodePending) return
    const target = nodePending.plan.target
    setNodeBusy(target.node)
    try {
      const fn = bridge().cordon
      const r = fn
        ? await fn(targetCfg(), target, true)
        : {
            ok: false,
            action: target.action,
            node: target.node,
            alreadyInState: false,
            output: '',
            node_status: '',
            reason: 'unknown' as const,
            detail: NOT_WIRED
          }
      setNodeResult(r)
      setNodePending(null)
      if (r.ok) void loadOverview()
    } finally {
      setNodeBusy('')
    }
  }

  /**
   * Read the drain verdict. This is the whole safety story of the button, so it
   * happens before any dialog and its answer is shown rather than summarised.
   */
  const checkDrain = async (node: string): Promise<void> => {
    if (!hasTarget) return
    setNodeResult(null)
    setNodePending(null)
    setDrainResult(null)
    setDrainCheck({ node, assessment: null, plan: null, loading: true })
    try {
      const fn = bridge().drainPreflight
      if (!fn) {
        setDrainCheck({ node, assessment: null, plan: null, loading: false })
        return
      }
      const a = await fn(targetCfg(), node, context || undefined)
      setDrainCheck({ node, assessment: a, plan: planK8sDrain(a), loading: false })
    } catch {
      setDrainCheck({ node, assessment: null, plan: null, loading: false })
    }
  }

  const runDrain = async (): Promise<void> => {
    if (!server || !drainCheck) return
    setNodeBusy(drainCheck.node)
    try {
      const fn = bridge().drain
      // The main process takes the preflight AGAIN and refuses on its own
      // reading — what is passed here is a confirmation, not a verdict.
      const r = fn
        ? await fn(targetCfg(), drainCheck.node, context || undefined, true)
        : {
            ok: false,
            node: drainCheck.node,
            evicted: [],
            pending: [],
            pdbRejected: [],
            partial: false,
            output: '',
            node_status: '',
            reason: 'unknown' as const,
            detail: NOT_WIRED
          }
      setDrainResult(r)
      setDrainCheck(null)
      setPhrase('')
      void loadOverview()
      void load(effectiveContext)
    } finally {
      setNodeBusy('')
    }
  }

  const runExec = async (): Promise<void> => {
    if (!server || !execFor) return
    setExecBusy(true)
    try {
      const b = bridge()
      const target: K8sExecTarget = {
        serverId: server.id,
        serverName: server.name,
        namespace: execFor.namespace,
        pod: execFor.name,
        container: execContainer.trim(),
        command: execCommand,
        context: context || (probe?.ok ? probe.currentContext : null)
      }
      if (!b.execPlan || !b.exec) {
        setExecResult({
          key: podKey(execFor),
          pod: execFor.name,
          r: { ok: false, output: '', containerExit: null, reason: 'unknown', detail: NOT_WIRED }
        })
        return
      }
      // The command string comes back from the MAIN PROCESS, and the approval
      // is minted against that rather than against anything built here. It is
      // the same builder either way, and that is the point: if the two ever
      // disagree, `verifyApproval` refuses instead of running something the
      // dialog did not describe.
      const { plan, command } = await b.execPlan(target)
      const approval: CommandApproval = approvalFor({
        surface: 'k8s-exec',
        commands: [command],
        targets: [{ serverId: server.id, serverName: server.name }],
        plan,
        phrase: execPhrase.trim(),
        confirmedAt: Date.now()
      })
      // Keyed by namespace/name, like `diag` and `logs`. A bare name is not an
      // identity here: two namespaces routinely hold a pod of the same name —
      // one Helm chart in `staging` and `prod` gives `web-0` twice — and this
      // list now spans namespaces by default. Matching on name alone rendered
      // one pod's command output under every same-named pod in the cluster.
      setExecResult({
        key: podKey(execFor),
        pod: execFor.name,
        r: await b.exec(targetCfg(), target, approval)
      })
      setExecFor(null)
      setExecCommand('')
      setExecContainer('')
      setExecPhrase('')
    } catch (e) {
      setExecResult({
        key: podKey(execFor),
        pod: execFor.name,
        r: {
          ok: false,
          output: '',
          containerExit: null,
          reason: 'unknown',
          detail: e instanceof Error ? e.message : String(e)
        }
      })
    } finally {
      setExecBusy(false)
    }
  }

  const closeLogs = (key: string): void => {
    setLogs((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== key)))
    setPoppedOut((cur) => (cur === key ? null : cur))
  }

  const closeDiag = (key: string): void =>
    setDiag((d) => {
      const { [key]: _gone, ...rest } = d
      return rest
    })

  const openLogs = async (p: K8sPod): Promise<void> => {
    if (!hasTarget) return
    const key = podKey(p)
    // The same button closes what it opened. An expander that only ever
    // expands is the next complaint.
    if (logs[key]) {
      closeLogs(key)
      return
    }
    const write = (output: string): void =>
      setLogs((m) => ({ ...m, [key]: { pod: p.name, output } }))
    // buildK8sLogsCommand refuses a name it cannot prove safe rather than
    // escaping it, so asking first turns a rejected invoke into a sentence.
    if (!validatePodName(p.name)) {
      write(t('k8s.panel.logsUnsafeName'))
      return
    }
    write(t('common.loading'))
    try {
      const r = await bridge().logs?.(targetCfg(), p.namespace, p.name, 200, context || undefined)
      write(r?.output || r?.error || t('k8s.panel.noOutput'))
    } catch (e) {
      write(e instanceof Error ? e.message : String(e))
    }
  }

  /** The first thing anyone runs on a pod that is not Running. */
  const diagnose = async (p: K8sPod): Promise<void> => {
    if (!hasTarget) return
    const key = podKey(p)
    // A toggle, like the logs button beside it: the thing that opened it is
    // the obvious thing to close it with.
    if (diag[key]) {
      closeDiag(key)
      return
    }
    const put = (v: { pod: string; result: K8sDiagnosis | null; error?: string }): void =>
      setDiag((d) => ({ ...d, [key]: v }))
    if (!validatePodName(p.name) ) {
      put({ pod: p.name, result: null, error: t('k8s.panel.diagnoseUnsafeName') })
      return
    }
    put({ pod: p.name, result: null })
    try {
      const fn = bridge().diagnose
      if (!fn) {
        put({ pod: p.name, result: null, error: NOT_WIRED })
        return
      }
      const r = await fn(targetCfg(), p.namespace, p.name, context || undefined, 200)
      put({ pod: p.name, result: r })
    } catch (e) {
      put({ pod: p.name, result: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const askToRestart = (w: K8sWorkload): void => {
    // The plan is computed here so the dialog can explain itself, and computed
    // AGAIN in the main process before anything runs — a plan that crossed IPC
    // is a value a caller could have written, not a decision.
    setRestartResult(null)
    setPhrase('')
    setPending({
      plan: planK8sRollout({
        kind: w.kind,
        namespace: w.namespace,
        name: w.name,
        desired: w.desired,
        strategy: w.strategy || null,
        context: context || (probe?.ok ? probe.currentContext : null)
      })
    })
  }

  const runRestart = async (): Promise<void> => {
    if (!server || !pending) return
    setRestarting(true)
    try {
      const fn = bridge().rolloutRestart
      const target = pending.plan.target
      const r = fn
        ? await fn(targetCfg(), target, true)
        : { ok: false, output: '', status: '', reason: 'unknown' as const, detail: NOT_WIRED }
      setRestartResult({ name: `${target.kind}/${target.name}`, r })
      setPending(null)
      setPhrase('')
      // Re-read, because the whole point is watching the replicas come back.
      if (r.ok) void loadOverview()
    } catch (e) {
      setRestartResult({
        name: `${pending.plan.target.kind}/${pending.plan.target.name}`,
        r: {
          ok: false,
          output: '',
          status: '',
          reason: 'unknown',
          detail: e instanceof Error ? e.message : String(e)
        }
      })
      setPending(null)
    } finally {
      setRestarting(false)
    }
  }

  const q = filter.trim().toLowerCase()
  // Contexts come off either branch: a failed read carries them when kubectl
  // read the kubeconfig before the cluster went quiet.
  const contextChoices = probe ? (probe.ok ? probe.contexts : (probe.contexts ?? [])) : []
  const currentContext = probe ? (probe.ok ? probe.currentContext : (probe.currentContext ?? null)) : null
  /**
   * The context a read will actually use.
   *
   * Falls through to the first listed one, because a kubeconfig need not mark
   * any context as current — and when none is marked, the picker rendered the
   * first entry as selected while the state behind it was still empty. Pressing
   * Refresh then re-read with no context at all and failed identically, which
   * looks like a control that does nothing. Display and behaviour read the same
   * value here.
   */
  const effectiveContext = context || currentContext || contextChoices[0]?.name || ''

  const allPods = probe?.ok ? probe.pods : []
  const pods =
    q === ''
      ? allPods
      : allPods.filter((p) =>
          `${p.namespace} ${p.name} ${p.status} ${p.node}`.toLowerCase().includes(q)
        )

  const canConfirm =
    !pending ||
    pending.plan.confirmation.kind !== 'type-to-confirm' ||
    phrase.trim() === pending.plan.confirmation.phrase

  const workloadRows = (r: K8sRead<K8sWorkload>, label: string): React.JSX.Element => {
    if (!r.ok) return <Denied read={r} what={label} />
    // The compact variant, not a bare grey sentence: Kubernetes is a flagship
    // surface and it had the barest empty states in the app, so a cluster with
    // nothing in a section looked identical to one that had failed to load it.
    if (r.items.length === 0)
      return (
        <EmptyState
          compact
          title={t('k8s.panel.noWorkloadsTitle', { kind: label.toLowerCase() })}
          message={t('k8s.panel.noWorkloadsMessage', { kind: label.toLowerCase() })}
        />
      )
    return (
      <>
        {r.items.map((w) => (
          <div key={`${w.namespace}/${w.name}`} className="cron-row">
            <span className={clsx('chip', workloadIsDegraded(w) && 'warn')}>
              {w.ready}/{w.desired}
            </span>
            <span className="faint cron-desc">{w.namespace}</span>
            <span className="mono grow cron-cmd" title={`${w.kind} ${w.namespace}/${w.name}`}>
              {w.name}
            </span>
            {/* Shown, not hidden: it is the difference between a restart nobody
                notices and one that takes the workload fully down, and it is
                what decides how hard the confirmation presses. */}
            {w.strategy && w.strategy !== 'RollingUpdate' && (
              <span className="chip warn">{w.strategy}</span>
            )}
            <button
              className="icon-btn sm"
              title={t('k8s.panel.restartTitle', { command: `kubectl rollout restart ${w.kind}/${w.name}` })}
              onClick={() => askToRestart(w)}
            >
              <RotateCw size={13} />
            </button>
          </div>
        ))}
      </>
    )
  }

  return (
    <div className="bc-panel">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Boxes size={14} className="faint" />
        <b className="grow">Kubernetes</b>
        <select
          className="input"
          style={{ maxWidth: 170 }}
          aria-label={t('k8s.panel.hostAria')}
          value={selectedId}
          onChange={(e) => {
            setServerId(e.target.value)
            setProbe(null)
            setLogs({})
            setPoppedOut(null)
            setDiag({})
            setExecFor(null)
            setExecResult(null)
            setOverview(null)
            setUsage(null)
            /**
             * The CHOICES made against the old host go too.
             *
             * Clearing the probe alone left `context` and `namespace` holding
             * names from the previous cluster. The namespace select is hidden
             * while the probe is null, so the stale value was invisible — and
             * then the next read was silently scoped to a namespace that
             * belongs to a different cluster and usually does not exist on
             * this one. The pane showed pods from the all-namespaces read
             * beside a dropdown naming a namespace nothing here has, which is
             * what "the dropdown does not refresh" looks like from outside.
             */
            setContext('')
            setNamespace('')
            setResources(null)
          }}
        >
          {/* First, and present even with no servers: a local kubeconfig is
              what most developers have in front of them. */}
          <option value={LOCAL_ID}>{t('k8s.panel.thisMachine')}</option>
          {eligible.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.note ? ` — ${s.note}` : ''}
            </option>
          ))}
        </select>
        {/* Choosing a context here passes --context for THIS read only. It does
            not run `kubectl config use-context`, which would repoint the
            cluster for every process on that host. */}
        {/* Shown on a FAILED read too, when kubectl got far enough to list
            them. A kubeconfig with several contexts and only one reachable is
            the ordinary state of a developer's machine; dropping the list
            because the current context is down left nothing to click but a
            refresh that fails the same way. */}
        {contextChoices.length > 1 && (
          <select
            className="input"
            style={{ maxWidth: 200 }}
            aria-label={t('k8s.panel.contextAria')}
            value={effectiveContext}
            onChange={(e) => {
              setContext(e.target.value)
              setOverview(null)
              setUsage(null)
              // Same reasoning as the host select: a namespace belongs to the
              // context it was chosen in. Two contexts on one kubeconfig are
              // routinely two different clusters.
              setNamespace('')
              setResources(null)
              void load(e.target.value, '')
            }}
          >
            {contextChoices.map((c) => (
              <option key={c.name} value={c.name}>
                {c.current ? t('k8s.panel.contextCurrent', { name: c.name }) : c.name}
              </option>
            ))}
          </select>
        )}
        {probe?.ok && probe.namespaces.length > 0 && (
          <select
            className="input"
            style={{ maxWidth: 170 }}
            value={namespace}
            onChange={(e) => {
              // Changing the namespace has to REREAD, not just discard.
              //
              // This cleared the cached reads and stopped, which left the pane
              // holding the previous namespace's pods and showed an empty
              // "namespace X" heading under the cluster tab. The data came back
              // only when the user clicked another tab, because those handlers
              // reload whatever is null — so the control appeared to do nothing
              // and the fix appeared to be "go somewhere else and come back".
              //
              // The context selector beside this one always reloaded. This is
              // the same control over the same reads and it behaves the same
              // way now.
              const ns = e.target.value
              setNamespace(ns)
              setOverview(null)
              setUsage(null)
              setResources(null)
              const again = readsAfterNamespaceChange(view)
              if (again.pods) void load(context, ns)
              if (again.overview) void loadOverview(ns)
              if (again.usage) void loadUsage(ns)
              if (again.resources) void loadResources(ns)
            }}
            title={t('k8s.panel.namespaceTitle')}
          >
            <option value="">{t('k8s.panel.allNamespaces')}</option>
            {probe.namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
        <Explain why={hasTarget ? t('k8s.panel.readOn', { target: targetName ?? '' }) : t('k8s.panel.chooseHost')}>
          <button
            className="btn"
            disabled={loading || !hasTarget}
            onClick={() => void load(effectiveContext)}
          >
            <RefreshCw size={13} className={clsx(loading && 'spin')} />{' '}
            {probe ? t('common.refresh') : t('k8s.panel.readCluster')}
          </button>
        </Explain>
      </div>

      {/* Not a dead end: with nothing online the panel falls back to this
          machine, so this names both facts rather than only the problem. */}
      {/* About whether anything is DIALLED. Every saved host is in the
          dropdown either way, and reading one dials it. */}
      {!anyConnected(servers) && (
        <div className="s-desc">{t('k8s.panel.noneConnected')}</div>
      )}

      {!probe && !loading && hasTarget && (
        <div className="s-desc">
          <Trans i18nKey="k8s.panel.intro" components={{ mono: <span className="mono" /> }} />
        </div>
      )}

      {/* Failure classes with different fixes. "No pods" for a permissions
          problem is the lie this panel exists to avoid. */}
      {probe && !probe.ok && <Denied read={probe} what={t('k8s.panel.readingCluster')} />}

      {probe?.ok && (
        <>
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            <button
              className={clsx('chip', view === 'pods' && 'on')}
              onClick={() => setView('pods')}
            >
              <Boxes size={12} /> Pods
            </button>
            <button
              className={clsx('chip', view === 'cluster' && 'on')}
              onClick={() => {
                setView('cluster')
                if (!overview) void loadOverview()
              }}
            >
              <Layers size={12} /> {t('k8s.panel.tabCluster')}
            </button>
            <button
              className={clsx('chip', view === 'usage' && 'on')}
              onClick={() => {
                setView('usage')
                if (!usage) void loadUsage()
              }}
            >
              <Gauge size={12} /> {t('k8s.panel.tabUsage')}
            </button>
            <button
              className={clsx('chip', view === 'resources' && 'on')}
              onClick={() => {
                setView('resources')
                if (!resources) void loadResources()
              }}
            >
              <HardDrive size={12} /> {t('k8s.panel.tabResources')}
            </button>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 11 }}>
              {probe.version ? `kubectl ${probe.version}` : 'kubectl'}
              {probe.currentContext ? ` · ${context || probe.currentContext}` : ''}
            </span>
          </div>

          {view === 'pods' && (
            <>
              <div className="row muted wrap" style={{ fontSize: 11, marginTop: 8, gap: 12 }}>
                <span>
                  {q === ''
                    ? t('k8s.panel.podCount', { count: pods.length })
                    : t('k8s.panel.podCountOf', { count: pods.length, total: allPods.length })}
                </span>
                {/* An empty list means something different depending on this, so
                    it is never left for the reader to assume. */}
                {!probe.allNamespaces && (
                  <span className="warn">{t('k8s.panel.oneNamespaceOnly')}</span>
                )}
                {/* A list narrowed by choice is not the same as a list narrowed
                    by RBAC, and saying so is the difference between "you picked
                    this" and "you cannot see the rest".
                    Not gated on `allNamespaces`: the two can both be true — an
                    account limited to one namespace that then picks it — and
                    suppressing the chip there left the user's own choice
                    unnamed in exactly the case where both explanations apply. */}
                {probe.scopedTo && (
                  <span className="faint">{t('k8s.panel.scopedTo', { namespace: probe.scopedTo })}</span>
                )}
                <span className="spacer" />
                {allPods.length > 0 && (
                  <input
                    className="input"
                    style={{ maxWidth: 180 }}
                    placeholder={t('k8s.panel.filterPods')}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                )}
              </div>

              {allPods.length === 0 && (
                <div className="faint" style={{ fontSize: 12 }}>
                  {probe.scopedTo
                    ? t('k8s.panel.noPodsIn', { namespace: probe.scopedTo })
                    : probe.allNamespaces
                      ? t('k8s.panel.noPods')
                      : t('k8s.panel.noPodsReadable')}
                </div>
              )}

              {pods.map((p) => {
                const key = podKey(p)
                const entry = logs[key]
                return (
                  <Fragment key={key}>
                    <div className="cron-row">
                      <span className={clsx('chip', podTone(p))}>{p.status}</span>
                      <span className="mono cron-when">{p.ready}</span>
                      <span className="faint cron-desc">{p.namespace}</span>
                      <span
                        className="mono grow cron-cmd"
                        title={t('k8s.panel.podOnNode', { pod: p.name, node: p.node || t('k8s.panel.unscheduled') })}
                      >
                        {p.name}
                      </span>
                      {p.restarts > 0 && (
                        <span className={clsx('chip', p.restarts > 5 ? 'danger' : 'warn')}>
                          {t('k8s.panel.restarts', { count: p.restarts })}
                        </span>
                      )}
                      {/* First, and to the left of the log button, because it is
                          what you actually want: a CrashLoopBackOff pod's CURRENT
                          logs are usually empty and its events are the story. */}
                      <button
                        className="icon-btn sm"
                        aria-expanded={!!diag[key]}
                        title={
                          diag[key]
                            ? t('k8s.panel.diagnoseCloseTitle')
                            : t('k8s.panel.diagnoseTitle')
                        }
                        onClick={() => void diagnose(p)}
                      >
                        <Siren size={13} />
                      </button>
                      <button
                        className="icon-btn sm"
                        aria-expanded={!!entry}
                        title={
                          entry
                            ? t('k8s.panel.logsCloseTitle')
                            : t('k8s.panel.logsTitle')
                        }
                        onClick={() => void openLogs(p)}
                      >
                        <ScrollText size={13} />
                      </button>
                      {/* Last, and deliberately the least prominent of the three.
                          The two beside it answer questions; this one runs code. */}
                      {/* Explain, not `title`: a disabled button never fires
                          its own tooltip, and this one's tooltip is the only
                          thing that says why it is disabled. */}
                      <Explain
                        why={
                          localSelected
                            ? t('k8s.panel.execLocalWhy')
                            : t('k8s.panel.execWhy')
                        }
                      >
                        <button
                          className="icon-btn sm"
                          // Server-only: the approval is minted against a saved
                          // server's id and main re-derives the command from it.
                          // Extending that consent record to a target that is not
                          // a server is its own decision, not a side effect of a
                          // dropdown option.
                          disabled={localSelected}
                          aria-label={t('k8s.panel.execAria')}
                          onClick={() => {
                            setExecResult(null)
                            setExecCommand('')
                            setExecContainer('')
                            setExecPhrase('')
                            // podKey on both sides. Comparing names alone
                            // disagreed with the render predicate below, so
                            // clicking exec on prod/web-0 while staging/web-0
                            // was open closed that one and opened nothing.
                            setExecFor(execFor && podKey(execFor) === key ? null : p)
                          }}
                        >
                          <SquareTerminal size={13} />
                        </button>
                      </Explain>
                    </div>
                    {/* Under the row it belongs to, not at the foot of the
                        panel: clicking a button should change something the
                        eye can already see. */}
                    {diag[key] && <DiagPane entry={diag[key]} onClose={() => closeDiag(key)} />}
                    {execFor?.namespace === p.namespace && execFor?.name === p.name && (
                      <>
        <div className="s-card" style={{ marginTop: 8 }}>
          <div className="s-title">
            <SquareTerminal size={12} />{' '}
            {t('k8s.panel.execHeading', { pod: `${execFor.namespace}/${execFor.name}` })}
          </div>
          <div className="input-group" style={{ marginTop: 6 }}>
            <input
              className="input mono"
              placeholder={t('k8s.panel.execPlaceholder', { example: 'cat /etc/nginx/nginx.conf' })}
              value={execCommand}
              onChange={(e) => setExecCommand(e.target.value)}
              autoFocus
            />
          </div>
          {/* Optional, and typed rather than picked from a list: the pod read
              does not carry container names, and a dropdown built from a guess
              would be worse than a blank. Left empty, kubectl chooses the
              default container and names it in the output. */}
          <div className="input-group" style={{ marginTop: 6 }}>
            <input
              className="input mono"
              placeholder={t('k8s.panel.execContainerPlaceholder')}
              value={execContainer}
              onChange={(e) => setExecContainer(e.target.value)}
            />
          </div>
          {execCommand.trim() !== '' && (
            <>
              <div className="s-desc danger">
                <TriangleAlert size={12} /> {t('k8s.panel.execWarning')}
              </div>
              <div className="s-desc faint">{t('k8s.panel.execNoTty')}</div>
              <div className="input-group" style={{ marginTop: 6 }}>
                <input
                  className="input"
                  placeholder={t('k8s.panel.execPhrase', { phrase: 'EXEC' })}
                  value={execPhrase}
                  onChange={(e) => setExecPhrase(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              className="btn primary"
              disabled={execBusy || execCommand.trim() === '' || execPhrase.trim() !== 'EXEC'}
              onClick={() => void runExec()}
            >
              {t('k8s.panel.run')}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setExecFor(null)
                setExecCommand('')
                setExecContainer('')
                setExecPhrase('')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div></>
                    )}
                    {execResult?.key === key && (
                      <div className={clsx('s-desc', execResult.r.ok ? '' : 'danger')}>
                        <span className="grow">
                          {execResult.r.ok
                            ? execResult.r.containerExit === null
                              ? execResult.pod
                              : t('k8s.panel.execExited', { pod: execResult.pod, code: execResult.r.containerExit })
                            : t('k8s.panel.execFailed', {
                                pod: execResult.pod,
                                help: execResult.r.reason ? K8S_FAILURE_HELP[execResult.r.reason] : ''
                              })}
                        </span>
                        <pre
                          className="mono"
                          style={{ marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}
                        >
                          {execResult.r.ok
                            ? execResult.r.output || t('k8s.panel.execNoOutput')
                            : execResult.r.detail}
                        </pre>
                        <button className="btn ghost sm" onClick={() => setExecResult(null)}>
                          {t('common.close')}
                        </button>
                      </div>
                    )}
                    {entry && poppedOut !== key && (
                      <LogPane
                        entry={entry}
                        inline
                        onPopOut={() => setPoppedOut(key)}
                        onClose={() => closeLogs(key)}
                      />
                    )}
                  </Fragment>
                )
              })}
            </>
          )}

          {view === 'cluster' && (
            <>
              <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
                <span className="grow">
                  {namespace ? t('k8s.panel.namespaceNamed', { namespace }) : t('k8s.panel.allNamespaces')}
                </span>
                <button className="btn ghost sm" disabled={overviewLoading} onClick={() => void loadOverview()}>
                  <RefreshCw size={12} className={clsx(overviewLoading && 'spin')} /> {t('common.refresh')}
                </button>
              </div>

              {!overview && overviewLoading && (
                <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.reading')}</div>
              )}

              {overview && (
                <>
                  <div className="s-title" style={{ marginTop: 8 }}>
                    <Layers size={12} /> Deployments
                  </div>
                  {workloadRows(overview.deployments, 'Deployments')}

                  {/* StatefulSets and DaemonSets are only drawn when there are
                      any, or when the read was refused. A permanently empty
                      heading is noise; a refused read is not. */}
                  {(!overview.statefulSets.ok || !readEmpty(overview.statefulSets)) && (
                    <>
                      <div className="s-title" style={{ marginTop: 8 }}>
                        <Layers size={12} /> StatefulSets
                      </div>
                      {workloadRows(overview.statefulSets, 'StatefulSets')}
                    </>
                  )}
                  {(!overview.daemonSets.ok || !readEmpty(overview.daemonSets)) && (
                    <>
                      <div className="s-title" style={{ marginTop: 8 }}>
                        <Layers size={12} /> DaemonSets
                      </div>
                      {workloadRows(overview.daemonSets, 'DaemonSets')}
                    </>
                  )}

                  {/* Item 40. A watch is what makes the pod-crashloop alert
                      fire at all: nothing can guess which server holds a
                      kubeconfig, so until an operator says "ask THIS server
                      about THIS cluster", the poll has nothing to do. */}
                  {serverId !== '' && (
                    <div className="s-note" style={{ marginTop: 10 }}>
                      {watched ? (
                        <>
                          <Trans
                            i18nKey="k8s.panel.watching"
                            values={{ server: servers.find((x) => x.id === serverId)?.name ?? '' }}
                            components={{ b: <b /> }}
                          />
                          <button className="btn ghost sm" onClick={() => setWatch(false)}>
                            {t('k8s.panel.stopWatching')}
                          </button>
                        </>
                      ) : (
                        <>
                          {t('k8s.panel.notWatching')}
                          <button className="btn ghost sm" onClick={() => setWatch(true)}>
                            {t('k8s.panel.watch')}
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Item 41's readiness report. The item itself -- cordon,
                      patch, reboot, uncordon as one job -- argues against being
                      built; what it asks for instead is the read that says
                      whether an upgrade is safe to start, and this is where it
                      belongs. */}
                  {overview.nodes.ok && overview.nodes.items.length > 0 && (
                    <div className="s-note" style={{ marginTop: 10 }}>
                      <b>
                        {
                          summariseUpgradeReadiness(
                            assessNodeSkew(
                              overview.serverVersion,
                              overview.nodes.items.map((n) => ({ name: n.name, kubeletVersion: n.version }))
                            ),
                            // `null`, not `[]`. An empty list would say the
                            // cluster has no budgets and so nothing that could
                            // block a drain, which is a measurement nobody
                            // took.
                            overview.pdbs.ok ? pdbHeadroom(overview.pdbs.items) : null
                          ).headline
                        }
                      </b>
                      {assessNodeSkew(
                        overview.serverVersion,
                        overview.nodes.items.map((n) => ({ name: n.name, kubeletVersion: n.version }))
                      )
                        .filter((k) => k.verdict !== 'ok')
                        .map((k) => (
                          <div key={k.node} className="r-sub faint">
                            {k.because}
                          </div>
                        ))}
                    </div>
                  )}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <ServerIcon size={12} /> Nodes
                  </div>
                  {!overview.nodes.ok ? (
                    <Denied read={overview.nodes} what="Nodes" />
                  ) : overview.nodes.items.length === 0 ? (
                    <EmptyState
                      compact
                      title={t('k8s.panel.noNodesTitle')}
                      message={t('k8s.panel.noNodesMessage')}
                    />
                  ) : (
                    overview.nodes.items.map((n) => (
                      <div key={n.name} className="cron-row">
                        <span className={clsx('chip', nodeIsUnhealthy(n) && 'danger')}>{n.status}</span>
                        <span className="mono cron-when">{n.age}</span>
                        <span className="faint cron-desc">{n.roles || '—'}</span>
                        <span className="mono grow cron-cmd">{n.name}</span>
                        <span className="faint">{n.version}</span>
                        {/* Cordon and uncordon are one button, because the node
                            is in one state or the other and offering both makes
                            the operator work out which one is a no-op. */}
                        {/SchedulingDisabled/.test(n.status) ? (
                          <button
                            className="btn ghost sm"
                            disabled={nodeBusy === n.name}
                            onClick={() => askToCordon(n, 'uncordon')}
                          >
                            {t('k8s.panel.uncordon')}
                          </button>
                        ) : (
                          <button
                            className="btn ghost sm"
                            disabled={nodeBusy === n.name}
                            onClick={() => askToCordon(n, 'cordon')}
                          >
                            {t('k8s.panel.cordon')}
                          </button>
                        )}
                        <Explain why={t('k8s.panel.checkDrainWhy')}>
                          <button
                            className="btn ghost sm"
                            disabled={nodeBusy === n.name || drainCheck?.loading === true}
                            onClick={() => void checkDrain(n.name)}
                          >
                            {t('k8s.panel.checkDrain')}
                          </button>
                        </Explain>
                      </div>
                    ))
                  )}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <Activity size={12} /> {t('k8s.panel.eventsNewestFirst')}
                  </div>
                  {!overview.events.ok ? (
                    <Denied read={overview.events} what="Events" />
                  ) : overview.events.items.length === 0 ? (
                    <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.noEvents')}</div>
                  ) : (
                    <EventRows events={overview.events.items} />
                  )}
                </>
              )}
            </>
          )}

          {view === 'usage' && (
            <>
              <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
                <span className="grow">
                  <Trans i18nKey="k8s.panel.usageHeading" components={{ mono: <span className="mono" /> }} />
                </span>
                <button className="btn ghost sm" disabled={usageLoading} onClick={() => void loadUsage()}>
                  <RefreshCw size={12} className={clsx(usageLoading && 'spin')} /> {t('common.refresh')}
                </button>
              </div>
              {!usage && usageLoading && (
                <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.reading')}</div>
              )}

              {/* USAGE AND BOOKED CAPACITY ARE DIFFERENT QUESTIONS, and putting
                  them under one heading is how they get confused. `kubectl top`
                  says what the pods are consuming right now; this says what the
                  scheduler has promised them. A node at 5% usage can be fully
                  booked and refuse the next pod, and only the second number
                  explains why. */}
              <div className="row muted" style={{ fontSize: 11, marginTop: 12 }}>
                <span className="grow">{t('k8s.panel.allocHeading')}</span>
                <button
                  className="btn ghost sm"
                  disabled={allocLoading}
                  onClick={() => void loadAllocatable()}
                >
                  <RefreshCw size={12} className={clsx(allocLoading && 'spin')} /> {t('k8s.panel.read')}
                </button>
              </div>
              {!alloc && allocLoading && (
                <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.reading')}</div>
              )}
              {alloc && !alloc.ok && (
                <div className="faint" style={{ fontSize: 12 }}>
                  {t('k8s.panel.allocFailed', { detail: alloc.detail ?? '' })}
                </div>
              )}
              {alloc?.ok && alloc.report && (
                <>
                  {/* The headline carries the unsized count beside the
                      percentage, because a cluster at 8% whose pods are unsized
                      has headroom nobody can compute. */}
                  <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>
                    {allocationHeadline(alloc.report)}
                  </div>
                  {alloc.report.nodes.map((n) => (
                    <div key={n.node} className="cron-row">
                      <span className="chip">
                        {n.cpuPct === null ? t('k8s.panel.cpuUnknown') : t('k8s.panel.cpuPct', { pct: Math.round(n.cpuPct) })}
                      </span>
                      <span className="chip">
                        {n.memPct === null ? t('k8s.panel.memUnknown') : t('k8s.panel.memPct', { pct: Math.round(n.memPct) })}
                      </span>
                      <span className="mono grow cron-cmd">{n.node}</span>
                      <span className="faint" style={{ fontSize: 11 }}>
                        {t('k8s.panel.allocPods', { count: n.podCount })}
                        {/* Never folded into the percentage: these contribute
                            nothing to it and can grow into whatever is left. */}
                        {n.cpuUnsetPods > 0 ? t('k8s.panel.allocNoCpu', { count: n.cpuUnsetPods }) : ''}
                        {n.partialPods > 0 ? t('k8s.panel.allocPartial', { count: n.partialPods }) : ''}
                        {n.cordoned ? t('k8s.panel.allocCordoned') : ''}
                      </span>
                    </div>
                  ))}
                  {alloc.report.unplaced.length > 0 && (
                    <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                      {t('k8s.panel.unplaced', {
                        pods: alloc.report.unplaced.map((u) => `${u.namespace}/${u.name} (${u.phase})`).join(', ')
                      })}
                    </div>
                  )}
                </>
              )}
              {usage && (
                <>
                  {!usage.nodes.ok ? (
                    <Denied read={usage.nodes} what={t('k8s.panel.nodeUsage')} />
                  ) : (
                    usage.nodes.items.map((n) => (
                      <div key={n.name} className="cron-row">
                        <span className="chip">{t('k8s.panel.cpuValue', { value: n.cpuPercent })}</span>
                        <span className="chip">{t('k8s.panel.memValue', { value: n.memoryPercent })}</span>
                        <span className="mono grow cron-cmd">{n.name}</span>
                        <span className="faint mono">
                          {n.cpu} · {n.memory}
                        </span>
                      </div>
                    ))
                  )}
                  {!usage.pods.ok ? (
                    <Denied read={usage.pods} what={t('k8s.panel.podUsage')} />
                  ) : (
                    usage.pods.items.map((p) => (
                      <div key={`${p.namespace}/${p.name}`} className="cron-row">
                        <span className="mono cron-when">{p.cpu}</span>
                        <span className="mono cron-when">{p.memory}</span>
                        <span className="faint cron-desc">{p.namespace}</span>
                        <span className="mono grow cron-cmd">{p.name}</span>
                      </div>
                    ))
                  )}
                </>
              )}
            </>
          )}

          {view === 'resources' && (
            <>
              <div className="row muted" style={{ fontSize: 11, marginTop: 8 }}>
                <span className="grow">
                  {namespace
                    ? t('k8s.panel.resourcesScopeNamespace', { namespace })
                    : t('k8s.panel.resourcesScopeAll')}
                </span>
                <button
                  className="btn ghost sm"
                  disabled={resourcesLoading}
                  onClick={() => void loadResources()}
                >
                  <RefreshCw size={12} className={clsx(resourcesLoading && 'spin')} /> {t('common.refresh')}
                </button>
              </div>
              {!resources && resourcesLoading && (
                <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.reading')}</div>
              )}

              {resources && (
                <>
                  <div className="s-title" style={{ marginTop: 8 }}>
                    <HardDrive size={12} /> PersistentVolumeClaims
                  </div>
                  {!resources.pvcs.ok ? (
                    <Denied read={resources.pvcs} what="PersistentVolumeClaims" />
                  ) : resources.pvcs.items.length === 0 ? (
                    <EmptyState
                      compact
                      title={t('k8s.panel.noClaimsTitle')}
                      message={t('k8s.panel.noClaimsMessage')}
                    />
                  ) : (
                    resources.pvcs.items.map((v) => (
                      <div key={`${v.namespace}/${v.name}`} className="cron-row">
                        <span className={clsx('chip', v.status !== 'Bound' && 'warn')}>{v.status}</span>
                        {/* Both numbers, always. A Pending claim has a request
                            and no capacity, and showing only the capacity puts a
                            blank where the size is. */}
                        <span className="mono cron-when">
                          {v.capacity || t('k8s.panel.requested', { size: v.requested })}
                        </span>
                        <span className="faint cron-desc">{v.namespace}</span>
                        <span className="mono grow cron-cmd">{v.name}</span>
                        <span className="faint">{v.storageClass || '—'}</span>
                        <span className="faint">{v.accessModes}</span>
                      </div>
                    ))
                  )}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <Activity size={12} /> Ingresses
                  </div>
                  {!resources.ingresses.ok ? (
                    <Denied read={resources.ingresses} what="Ingresses" />
                  ) : resources.ingresses.items.length === 0 ? (
                    <EmptyState
                      compact
                      title={t('k8s.panel.noIngressesTitle')}
                      message={t('k8s.panel.noIngressesMessage')}
                    />
                  ) : (
                    resources.ingresses.items.map((i) => (
                      <div key={`${i.namespace}/${i.name}`} className="cron-row">
                        {/* An empty address is a real state — nothing has
                            claimed this Ingress — and it is what a wrong
                            ingressClassName looks like. */}
                        <span className={clsx('chip', i.address === '' && 'warn')}>
                          {i.address || t('k8s.panel.noAddress')}
                        </span>
                        <span className="faint cron-desc">{i.namespace}</span>
                        <span className="mono grow cron-cmd" title={i.rules.join(' · ')}>
                          {i.name} · {i.rules.join(' · ') || t('k8s.panel.noRules')}
                        </span>
                        <span className="faint">{i.className || '—'}</span>
                        {i.tlsSecrets.length > 0 && (
                          <span className="chip">tls: {i.tlsSecrets.join(', ')}</span>
                        )}
                      </div>
                    ))
                  )}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <ShieldQuestion size={12} /> {t('k8s.panel.roleBindings')}
                  </div>
                  {!resources.roleBindings.ok ? (
                    <Denied read={resources.roleBindings} what={t('k8s.panel.roleBindings')} />
                  ) : (
                    resources.roleBindings.items.map((b) => (
                      <div key={`${b.clusterScoped ? '' : b.namespace}/${b.name}`} className="cron-row">
                        <span className={clsx('chip', b.clusterScoped && 'warn')}>
                          {b.clusterScoped ? t('k8s.panel.clusterScope') : b.namespace}
                        </span>
                        <span className="mono grow cron-cmd">{b.name}</span>
                        <span className="faint cron-desc">
                          {b.roleKind}/{b.roleName}
                        </span>
                        <span className="mono faint" title={b.subjects.join(' · ')}>
                          {b.subjects.join(' · ')}
                        </span>
                      </div>
                    ))
                  )}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <ShieldQuestion size={12} /> {t('k8s.panel.secretsHeading')}
                  </div>
                  <div className="faint" style={{ fontSize: 11 }}>{t('k8s.panel.secretsNote')}</div>
                  {!resources.secrets.ok ? (
                    <Denied read={resources.secrets} what="Secrets" />
                  ) : (
                    resources.secrets.items.map((k) => (
                      <div key={`${k.namespace}/${k.name}`} className="cron-row">
                        <span className="chip">{k.type}</span>
                        <span className="faint cron-desc">{k.namespace}</span>
                        <span className="mono grow cron-cmd">{k.name}</span>
                        <span className="mono faint">{k.keys.join(', ') || t('k8s.panel.noKeys')}</span>
                      </div>
                    ))
                  )}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <TriangleAlert size={12} /> {t('k8s.panel.reviewHeading')}
                  </div>
                  {/* Its own button. Thirteen kubectl calls, and the answer only
                      matters when somebody is asking the question it answers —
                      folding it into the refresh would make every refresh wait
                      on it. */}
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <button
                      className="btn ghost sm"
                      disabled={reviewLoading}
                      onClick={() => void runReview()}
                    >
                      {review === null ? t('k8s.panel.review') : t('k8s.panel.reviewAgain')}
                    </button>
                    {reviewLoading && (
                      <span className="faint" style={{ fontSize: 11 }}>
                        {t('k8s.panel.readingLower')}
                      </span>
                    )}
                  </div>
                  {review !== null && !review.ok && (
                    <div className="s-note is-alarm">{t('k8s.panel.reviewFailed', { detail: review.detail })}</div>
                  )}
                  {review?.ok === true &&
                    (() => {
                      const r = reviewFindings(review.blocks, Date.now())
                      const tone = (f: ReviewFinding): string =>
                        f.level === 'alarm' ? 'danger' : f.level === 'watch' ? 'warn' : ''
                      return (
                        <>
                          {/* WHAT WAS NOT LOOKED AT, first and always. A short
                              list of findings reads as a clean cluster, and a
                              denied read is the difference. */}
                          {r.blind.map((b2) => (
                            <div key={`${b2.section} ${b2.detail}`} className="s-note is-alarm">
                              <Trans
                                i18nKey="k8s.panel.reviewBlind"
                                values={{ section: b2.section }}
                                components={{ b: <b /> }}
                              />{' '}
                              <span className="mono">{b2.detail}</span>
                            </div>
                          ))}
                          {r.findings.map((f) => (
                            <div key={`${f.section} ${f.subject} ${f.because}`} className="cron-row">
                              <span className={clsx('chip', tone(f))}>{f.level}</span>
                              <span className="faint cron-desc">{f.section}</span>
                              <span className="mono cron-when">{f.subject}</span>
                              <span className="grow cron-cmd">{f.because}</span>
                            </div>
                          ))}
                          {r.notes.map((n) => (
                            <div key={n} className="faint" style={{ fontSize: 11 }}>
                              {n}
                            </div>
                          ))}
                        </>
                      )
                    })()}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <TriangleAlert size={12} /> {t('k8s.panel.deprecatedApis')}
                  </div>
                  {apiScan && (
                    <>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {apiScan.serverVersion
                          ? t('k8s.panel.serverVersion', { version: apiScan.serverVersion })
                          : t('k8s.panel.serverVersionUnknown')}
                      </div>
                      {apiScan.findings.length === 0 ? (
                        <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.apiScanClean')}</div>
                      ) : (
                        apiScan.findings.map((f) => (
                          <div key={f.groupVersion} className="cron-row">
                            <span className={clsx('chip', f.pastRemoval ? 'danger' : 'warn')}>
                              {f.pastRemoval
                                ? t('k8s.panel.apiPast', { version: f.removedIn })
                                : t('k8s.panel.apiGoesIn', { version: f.removedIn })}
                            </span>
                            <span className="mono grow cron-cmd">{f.groupVersion}</span>
                            <span className="faint">{t('k8s.panel.apiUse', { api: f.replacement })}</span>
                          </div>
                        ))
                      )}
                      {/* Rendered WITH the findings, never behind a toggle.
                          "Nothing found" is the sentence people act on, and it
                          is only honest next to what was not looked at. */}
                      <div className="s-desc faint" style={{ marginTop: 4 }}>
                        {t('k8s.panel.notChecked')}
                        <ul style={{ margin: '4px 0 0 16px' }}>
                          {apiScan.notChecked.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      </div>
                    </>
                  )}

                  <div className="s-title" style={{ marginTop: 10 }}>
                    <Layers size={12} /> {t('k8s.panel.helmReleases')}
                  </div>
                  {helm && !helm.ok && (
                    <div className="faint" style={{ fontSize: 12 }}>
                      {helm.detail}
                    </div>
                  )}
                  {helm?.ok &&
                    (helm.releases.length === 0 ? (
                      <div className="faint" style={{ fontSize: 12 }}>{t('k8s.panel.helmNone')}</div>
                    ) : (
                      helm.releases.map((r) => (
                        <div key={`${r.namespace}/${r.name}`} className="cron-row">
                          <span className={clsx('chip', r.status !== 'deployed' && 'warn')}>
                            {r.status}
                          </span>
                          <span className="mono cron-when">{t('k8s.panel.helmRevision', { revision: r.revision })}</span>
                          <span className="faint cron-desc">{r.namespace}</span>
                          <span className="mono grow cron-cmd">{r.name}</span>
                          <span className="faint">{r.chart}</span>
                        </div>
                      ))
                    ))}
                </>
              )}
            </>
          )}
        </>
      )}

      {/* ---- the state change, and the only dialog in this panel ---- */}
      {pending && (
        <div className="bc-confirm">
          <div className="s-title">
            {t('k8s.panel.restartConfirmTitle', { kind: pending.plan.target.kind, name: pending.plan.target.name })}
          </div>
          <div className="s-desc mono">
            kubectl rollout restart {pending.plan.target.kind}/{pending.plan.target.name} --namespace=
            {pending.plan.target.namespace}
            {pending.plan.target.context ? ` --context=${pending.plan.target.context}` : ''}
          </div>
          <div className={clsx('s-desc', pending.plan.risk === 'destructive' ? 'danger' : 'warn')}>
            <TriangleAlert size={12} /> {t('k8s.panel.changesCluster', { reasons: pending.plan.reasons.join('; ') })}
          </div>
          {/* Kept apart from the reasons: these are not arguments for pressing
              harder, they are things that would otherwise be discovered from a
              restart that appeared to work and changed nothing. */}
          {pending.plan.caveats.map((c) => (
            <div key={c} className="s-desc faint">
              {c}
            </div>
          ))}
          {pending.plan.confirmation.kind === 'type-to-confirm' && (
            <div className="input-group" style={{ marginTop: 6 }}>
              <input
                className="input"
                placeholder={t('k8s.panel.restartPhrase', { phrase: pending.plan.confirmation.phrase })}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              className="btn primary"
              disabled={!canConfirm || restarting}
              onClick={() => void runRestart()}
            >
              {t('k8s.panel.restart')}
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

      {/* ---- node scheduling ---- */}
      {nodePending && (
        <div className="s-card" style={{ marginTop: 8 }}>
          <div className="s-title">
            <ServerIcon size={12} />{' '}
            {nodePending.plan.target.action === 'cordon'
              ? t('k8s.panel.cordonNode', { node: nodePending.plan.target.node })
              : t('k8s.panel.uncordonNode', { node: nodePending.plan.target.node })}
          </div>
          <div className="s-desc mono">
            kubectl {nodePending.plan.target.action} {nodePending.plan.target.node}
            {nodePending.plan.target.context ? ` --context=${nodePending.plan.target.context}` : ''}
          </div>
          <div className="s-desc warn">
            <TriangleAlert size={12} /> {nodePending.plan.reasons.join('; ')}.
          </div>
          {nodePending.plan.caveats.map((c) => (
            <div key={c} className="s-desc faint">
              {c}
            </div>
          ))}
          {/* The plan can now escalate to a typed word — cordoning the last
              schedulable node takes the whole cluster out of service. Without
              this input the escalation would be computed and then silently
              ignored, and the action would still run on one click, which is
              worse than never having escalated at all. */}
          {nodePending.plan.confirmation.kind === 'type-to-confirm' && (
            <input
              className="input"
              style={{ marginTop: 8 }}
              autoFocus
              placeholder={
                nodePending.plan.target.action === 'cordon'
                  ? t('k8s.panel.cordonPhrase', { phrase: nodePending.plan.confirmation.phrase })
                  : t('k8s.panel.uncordonPhrase', { phrase: nodePending.plan.confirmation.phrase })
              }
              value={nodePhrase}
              onChange={(e) => setNodePhrase(e.target.value)}
            />
          )}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              className="btn primary"
              disabled={nodeBusy !== '' || !nodeConfirmed}
              onClick={() => void runCordon()}
            >
              {nodePending.plan.target.action === 'cordon' ? t('k8s.panel.cordon') : t('k8s.panel.uncordon')}
            </button>
            <button className="btn ghost" onClick={() => setNodePending(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {nodeResult && (
        <div className={clsx('s-desc', nodeResult.ok ? '' : 'danger')}>
          <span className="grow">
            {nodeResult.ok
              ? nodeResult.output
              : t(nodeResult.action === 'cordon' ? 'k8s.panel.notCordoned' : 'k8s.panel.notUncordoned', {
                  node: nodeResult.node,
                  help: nodeResult.reason ? K8S_FAILURE_HELP[nodeResult.reason] : ''
                })}
          </span>
          {/* Said out loud rather than folded into a plain success: somebody
              else's maintenance window is already open on this node. */}
          {nodeResult.alreadyInState && (
            <div className="warn" style={{ marginTop: 4 }}>
              {t('k8s.panel.alreadyInState')}
            </div>
          )}
          <div className="mono" style={{ marginTop: 4, opacity: 0.8, whiteSpace: 'pre-wrap' }}>
            {nodeResult.ok ? nodeResult.node_status : nodeResult.detail}
          </div>
          <button className="btn ghost sm" onClick={() => setNodeResult(null)}>
            {t('common.close')}
          </button>
        </div>
      )}

      {/* ---- the drain verdict, which IS the safety story ---- */}
      {drainCheck && (
        <div className="s-card" style={{ marginTop: 8 }}>
          <div className="s-title">
            <ShieldQuestion size={12} /> {t('k8s.panel.drainQuestion', { node: drainCheck.node })}
          </div>
          {drainCheck.loading && <div className="s-desc faint">{t('k8s.panel.drainReading')}</div>}
          {!drainCheck.loading && !drainCheck.assessment && (
            <div className="s-desc danger">{NOT_WIRED}</div>
          )}
          {drainCheck.assessment && drainCheck.plan && (
            <>
              <div className="s-desc">
                {t('k8s.panel.drainSummary', {
                  moving: drainCheck.assessment.evictable.length,
                  staying: drainCheck.assessment.daemonSetPods.length
                })}
              </div>

              {/* Reads that did not answer come FIRST and are styled as hard as
                  a blocker, because they are one. An empty budget list from a
                  denied read looks exactly like a cluster with no budgets. */}
              {drainCheck.assessment.unchecked.map((u) => (
                <div key={u.read} className="s-desc danger">
                  <TriangleAlert size={12} /> {t('k8s.panel.drainUnchecked', { read: u.read, meaning: u.meaning })}
                  <div className="mono faint" style={{ marginTop: 2 }}>
                    {u.detail}
                  </div>
                </div>
              ))}

              {drainCheck.assessment.blockers.map((b) => (
                <div key={`${b.kind}/${b.namespace}/${b.subject}`} className="s-desc danger">
                  <TriangleAlert size={12} />{' '}
                  <span className="mono">
                    {b.namespace}/{b.subject}
                  </span>{' '}
                  — {b.detail}
                </div>
              ))}

              {drainCheck.assessment.safe ? (
                <>
                  <div className="s-desc mono">
                    kubectl drain {drainCheck.node} --ignore-daemonsets
                    {context ? ` --context=${context}` : ''}
                  </div>
                  {drainCheck.plan.caveats.map((c) => (
                    <div key={c} className="s-desc faint">
                      {c}
                    </div>
                  ))}
                  <div className="input-group" style={{ marginTop: 6 }}>
                    <input
                      className="input"
                      placeholder={t('k8s.panel.drainPhrase', { phrase: 'DRAIN' })}
                      value={phrase}
                      onChange={(e) => setPhrase(e.target.value)}
                    />
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <button
                      className="btn primary"
                      disabled={phrase.trim() !== 'DRAIN' || nodeBusy !== ''}
                      onClick={() => void runDrain()}
                    >
                      {t('k8s.panel.drain')}
                    </button>
                    <button
                      className="btn ghost"
                      onClick={() => {
                        setDrainCheck(null)
                        setPhrase('')
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* NOT a disabled button with a tooltip, and not a scarier
                      dialog. There is nothing to press: the main process refuses
                      on its own reading of this same preflight, so offering the
                      control would be offering a button that cannot work. */}
                  <div className="s-desc">{t('k8s.panel.drainRefused')}</div>
                  <button className="btn ghost sm" onClick={() => setDrainCheck(null)}>
                    {t('common.close')}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {drainResult && (
        <div className={clsx('s-desc', drainResult.ok ? '' : 'danger')}>
          <span className="grow">
            {drainResult.ok
              ? t('k8s.panel.drained', { node: drainResult.node, count: drainResult.evicted.length })
              : t('k8s.panel.notDrained', { node: drainResult.node })}
          </span>
          {/* The half that a plain failure message hides. A blocked drain has
              still moved whatever it got through, and telling the operator the
              node is untouched is how somebody reboots it. */}
          {drainResult.partial && (
            <div className="warn" style={{ marginTop: 4 }}>
              {t('k8s.panel.drainPartial', { count: drainResult.evicted.length })}
            </div>
          )}
          {drainResult.pdbRejected.length > 0 && (
            <div style={{ marginTop: 4 }}>
              {t('k8s.panel.pdbHeld', { pods: drainResult.pdbRejected.join(', ') })}
            </div>
          )}
          <div className="mono" style={{ marginTop: 4, opacity: 0.8, whiteSpace: 'pre-wrap' }}>
            {drainResult.detail ?? drainResult.output}
          </div>
          <button className="btn ghost sm" onClick={() => setDrainResult(null)}>
            {t('common.close')}
          </button>
        </div>
      )}

      {/* The exec card and its result render under the pod's own row now.
          They used to sit here, after the pods list, the workloads, usage and
          resources views, the node list and four dialogs — so pressing the
          button scrolled nothing and changed nothing visible, which is
          indistinguishable from a dead button. Same defect a17c1aa7 fixed for
          logs. */}

      {restartResult && (
        <div className={clsx('s-desc', restartResult.r.ok ? '' : 'danger')}>
          <span className="grow">
            {restartResult.r.ok
              ? `${restartResult.name}: ${restartResult.r.output}`
              : t('k8s.panel.notRestarted', {
                  name: restartResult.name,
                  help: restartResult.r.reason ? K8S_FAILURE_HELP[restartResult.r.reason] : ''
                })}
          </span>
          <div className="mono" style={{ marginTop: 4, opacity: 0.8, whiteSpace: 'pre-wrap' }}>
            {restartResult.r.ok ? restartResult.r.status : restartResult.r.detail}
          </div>
          <button className="btn ghost sm" onClick={() => setRestartResult(null)}>
            {t('common.close')}
          </button>
        </div>
      )}

      {/* Diagnosis panes live under their own rows now. Nothing is left at
          the foot of the panel: a button that changes something 800 lines
          below the click is indistinguishable from a dead one. */}
      {/* Only what the user explicitly popped out lands down here now. Every
          other pane stays attached to the row it was opened from. */}
      {poppedOut && logs[poppedOut] && (
        <LogPane
          entry={logs[poppedOut]}
          onDock={() => setPoppedOut(null)}
          onClose={() => closeLogs(poppedOut)}
        />
      )}
    </div>
  )
}
