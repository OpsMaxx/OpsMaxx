import type { ActivityView } from '../../types'
import { moduleEnabled, type ModuleId, type ModuleState } from '../../../../shared/modules'

export interface TourStep {
  id: string
  title: string
  body: string
  // Which view to switch to while this step shows, so the feature is on screen
  // behind the card rather than merely described.
  view?: ActivityView
  // A concrete thing to try, where there is one worth naming.
  action?: string
}

// ---------------------------------------------------------------------------
// TWO STEPS ON FIRST RUN, AND SIX DEFERRED — NOT SIX DELETED
// ---------------------------------------------------------------------------
//
// The tour used to be eight panels shown back to back before the user had done
// anything. Reading it in order, the problem is obvious:
//
//   1  a definition of the product
//   2  ~75 words on workspaces, multi-client isolation and shared vault
//      entries, for somebody with zero servers
//   3  add a server or import your SSH config   ← the only actionable step,
//                                                 and the only one they need
//   4  create your vault: a live, focused "Master password (min 12
//      characters)" field, 60 seconds into a first launch
//   5-7 monitoring, tunnels, AI
//   8  that is the tour
//
// It spent its highest-attention slots on org-scale concepts a solo first-run
// user has no model for, and reached the actual first action third, by which
// time tour fatigue has set in.
//
// Step 4 was the serious one. It is the single most irreversible commitment in
// the product — "it is never stored anywhere, so if you lose it the contents
// cannot be recovered" — and it was being asked for before the user had
// connected to anything or had any reason to care. A password chosen in that
// state is chosen carelessly, and it cannot be recovered.
//
// Steps 5 and 6 were also staged over screens that contradicted their own copy:
// "live CPU, memory, disk" narrated over the Fleet keys tab, which shows a
// disabled-feature notice; "tunnels and databases" over an empty frp panel, for
// a technology the Add Server dialog says "is never a transport".
//
// So: two steps up front, and the other six become FEATURE_TIPS, shown once
// each when the user first opens the view they describe. Nothing is deleted —
// every sentence survives, it just arrives when the reader has a reason to want
// it, and on the screen it is actually about, which is what fixes the staging
// mismatch as a side effect.
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'connections',
    title: 'Start with a server',
    body: 'Add a server once and reuse it everywhere — terminal, files, monitoring, tunnels and databases all work off the same connection. Each can route through unlimited jump hosts, each with its own credentials. If you already keep hosts in ~/.ssh/config, import them instead of retyping; ProxyJump comes across too.',
    view: 'connections',
    action: 'Add a server, or import your SSH config.'
  },
  {
    id: 'done',
    title: 'Everything else is behind one shortcut',
    body: 'Cmd/Ctrl+K opens the command palette, which reaches every server, workspace, tunnel and action in the app. The rest of OpsMaxx introduces itself as you open it, and this walkthrough is in Settings if you want it again.',
    action: 'Press Cmd/Ctrl+K.'
  }
]

/**
 * A step that used to be in the tour, shown once when its view is first opened.
 *
 * `view` is the trigger, not merely a backdrop: the tip fires because the user
 * went somewhere, which means they have a reason to read it. That is the whole
 * difference between this and a panel four of eight.
 */
export interface FeatureTip extends TourStep {
  view: ActivityView
  /**
   * The module this tip is about, where it is about one.
   *
   * A tip for a module the user switched off is a tip about a screen they cannot
   * reach, and showing it is worse than saying nothing: the walkthrough spends its
   * credibility describing a feature that is not there, which teaches the reader
   * that the rest of it may not be there either.
   *
   * Absent means the tip is about the app rather than about a module -- workspaces,
   * the vault, the AI bridge -- and is always eligible.
   */
  module?: ModuleId
  /**
   * Which Monitoring tab this tip belongs to, for the tips whose `view` is
   * `monitor`.
   *
   * Monitoring, Operations and the four promoted modules all share one
   * ActivityView, so `view` alone cannot tell them apart -- the same problem
   * FeatureTipCard already solved for `fleetRail`. A tip with a `tab` fires only
   * when that tab is the one on screen; one without fires on the Monitoring rail
   * generally.
   */
  tab?: ModuleId
}

export const FEATURE_TIPS: FeatureTip[] = [
  {
    id: 'tip-workspaces',
    view: 'connections',
    title: 'Workspaces keep clients and environments apart',
    body: 'Servers, databases, tunnels and vault entries each belong to a workspace — switch with the picker in the title bar, and password-protect a workspace to keep one client’s infrastructure out of sight. A vault entry can also be marked shared, when the same credential is genuinely used from several workspaces.',
    action: 'Try the workspace picker at the top left.'
  },
  {
    // Fires when the user opens the vault, which is the moment they are already
    // thinking about a credential — not 60 seconds into a first launch.
    id: 'tip-vault',
    view: 'vault',
    title: 'The vault is where credentials live',
    body: 'Passwords, SSH keys and API keys, encrypted with AES-256-GCM under a master password. Entries belong to a workspace, or are marked shared when the same credential is used from several. A server references an entry rather than keeping its own copy, so rotating a credential is one edit instead of a hunt. On a Mac with Touch ID you can unlock with a fingerprint.'
  },
  {
    id: 'tip-monitor',
    view: 'monitor',
    title: 'Monitoring, including what is broken',
    body: 'Live CPU, memory, disk and network per server, totalled across the fleet. Failed systemd units and listening ports come back on the same poll, so you can see what a server exposes and what has fallen over without opening a shell.'
  },
  {
    id: 'tip-tunnels',
    view: 'tunnels',
    title: 'Tunnels, and databases behind a bastion',
    body: 'Local and remote port forwards plus a SOCKS5 proxy. The database client speaks PostgreSQL, MySQL, SQL Server, MongoDB and Redis, and can reach a database that is only routable from inside the network.'
  },
  {
    id: 'tip-databases',
    view: 'databases',
    title: 'Databases, over a connection you already have',
    body: 'Five engines, with the query editor and schema browser reading through an SSH tunnel or a VPN profile when the database is not routable from here. Credentials go to your operating system’s secure storage, never into the workspace file.'
  },
  {
    id: 'tip-ai',
    view: 'ai',
    title: 'AI agents, without handing over credentials',
    body: 'Claude Code, Claude Desktop and Codex can run commands and read files through OpsMaxx, but never see a password, key, hostname or username. You choose per capability what is allowed, asked about or refused, and every action lands in the audit log.'
  },

  // The promoted modules, which had no tips at all.
  //
  // They were tabs in a strip nobody was introduced to; now they are icons in the
  // rail, which is more discoverable and no more self-explanatory. Each of these
  // carries a `module`, so it is never shown to somebody who switched the module
  // off, and a `tab`, so it fires on its own destination rather than anywhere on
  // the shared Monitoring ActivityView.
  {
    id: 'tip-docker',
    view: 'monitor',
    module: 'docker',
    tab: 'docker',
    title: 'Containers, on whichever server they are on',
    body: 'Every container on a server with its logs and a shell inside it, grouped by compose project, using the docker binary already there. The disk view itemises what is reclaimable and removes only what you tick — nothing is pruned wholesale. A shell inside a container is arbitrary code execution on that host, which is the same power the terminal tab already grants on the same credential.'
  },
  {
    id: 'tip-kubernetes',
    view: 'monitor',
    module: 'kubernetes',
    tab: 'kubernetes',
    title: 'Clusters, read through the kubectl already on the server',
    body: 'Contexts, namespaces, pods and their logs, plus nodes, workloads and what is actually requesting your capacity. Reading only: it never switches your context, never execs into a pod, and never applies or deletes anything — so there is nothing here that can change a cluster.'
  },
  {
    id: 'tip-cicd',
    view: 'monitor',
    module: 'cicd',
    tab: 'cicd',
    title: 'Pipelines, beside the servers they change',
    body: 'Connect Jenkins, GitLab CI or GitHub Actions and read what it did — run history and the log of the step that failed — next to the server the run changed. This is the one tab that talks to a service outside your estate, on a timer, with a token you paste in. Starting and cancelling are here too, behind a second module you switch on separately.'
  },
  {
    id: 'tip-processes',
    view: 'monitor',
    module: 'processes',
    tab: 'processes',
    title: 'Long-lived programs on this machine',
    body: 'A dev server, a worker, a script that should outlive the terminal that started it — with restart policies, backoff, crash-loop detection and a log ring, from the supervisor that already keeps VPN engines alive. Nothing here runs on a remote server and nothing starts by itself: the only thing that starts a process is you pressing Start.'
  }
]

/**
 * The tips a given module state can actually justify showing.
 *
 * Filtered here rather than in the arrays above, and that is deliberate: `TOUR_STEPS`,
 * `FEATURE_TIPS` and `FULL_WALKTHROUGH` are the COMPLETE lists and stay that way
 * — tests/onboardingTour.test.ts pins `FULL_WALKTHROUGH` to exactly their union, on
 * the argument that a replay from Settings is somebody asking for the whole thing.
 * Adaptation is a question about one install at one moment, so it belongs at the
 * point of use.
 */
export function tipsFor(modules: ModuleState | undefined): FeatureTip[] {
  return FEATURE_TIPS.filter((t) => !t.module || moduleEnabled(modules, t.module))
}

/**
 * The walkthrough, adapted to what this install actually has.
 *
 * Used by the replay from Settings. Somebody who asks for the walkthrough wants
 * all of it, which is why `FULL_WALKTHROUGH` exists — but "all of it" cannot
 * honestly include four panels about modules they have switched off. The first and
 * last steps are never about a module, so the shape is preserved: it still opens on
 * adding a server and still ends on the command palette.
 */
export function walkthroughFor(modules: ModuleState | undefined): TourStep[] {
  return [TOUR_STEPS[0], ...tipsFor(modules), TOUR_STEPS[1]]
}

/**
 * Everything, in the order it used to be shown.
 *
 * Settings offers to replay the walkthrough, and somebody who asks for it
 * explicitly is asking for the whole thing — deferring six of eight to a
 * trigger they have already passed would give them two panels and nothing else.
 */
export const FULL_WALKTHROUGH: TourStep[] = [TOUR_STEPS[0], ...FEATURE_TIPS, TOUR_STEPS[1]]
