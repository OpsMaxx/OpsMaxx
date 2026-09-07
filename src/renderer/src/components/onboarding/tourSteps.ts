import type { ActivityView } from '../../types'

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
    body: 'Cmd/Ctrl+K opens the command palette, which reaches every server, workspace, tunnel and action in the app. The rest of ShellPilot introduces itself as you open it, and this walkthrough is in Settings if you want it again.',
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
    body: 'Claude Code, Claude Desktop and Codex can run commands and read files through ShellPilot, but never see a password, key, hostname or username. You choose per capability what is allowed, asked about or refused, and every action lands in the audit log.'
  }
]

/**
 * Everything, in the order it used to be shown.
 *
 * Settings offers to replay the walkthrough, and somebody who asks for it
 * explicitly is asking for the whole thing — deferring six of eight to a
 * trigger they have already passed would give them two panels and nothing else.
 */
export const FULL_WALKTHROUGH: TourStep[] = [TOUR_STEPS[0], ...FEATURE_TIPS, TOUR_STEPS[1]]
