import type { DiskMount } from './mounts'
// Shared SSH types used by main, preload and renderer.

export type SshAuth = 'password' | 'key' | 'agent'

export interface SshHop {
  host: string
  port: number
  /**
   * The identity this hop's HOST KEY is remembered under, when `host:port` is
   * not it.
   *
   * A hop routed through a VPN or a tunnel is rewritten to dial
   * `127.0.0.1:<a freshly allocated port>`, and the known-hosts entry used to
   * be keyed on that. A port that is different on every connection is an
   * identity that can never match twice, so a server behind Tailscale asked to
   * be trusted again every single time -- and each yes wrote a useless entry
   * for `127.0.0.1:<port>`, which is not merely noise: a later, unrelated
   * service on that port would inherit the trust.
   *
   * The fingerprint check is unchanged. This only says which name the answer is
   * filed under, and the right name is the server the user chose, not the
   * loopback address the transport happens to be using this minute.
   */
  hostKeyId?: string
  username: string
  auth: SshAuth
  password?: string
  keyPath?: string
  privateKey?: string
  passphrase?: string
  /**
   * Where this hop's SSH agent listens, when `auth` is 'agent'.
   *
   * Set per hop rather than per connection because each hop authenticates
   * independently, and a jump host and its target can legitimately use
   * different agents. Absent means the ambient SSH_AUTH_SOCK — which in a
   * desktop app is whatever the session manager provided, and is frequently NOT
   * the agent the user actually keeps their keys in. See shared/sshAgent.ts.
   */
  agentSocket?: string
}

export interface SshConnectConfig extends SshHop {
  sessionId: string
  cols: number
  rows: number
  hops?: SshHop[]
  /**
   * Run this instead of the login shell, on a PTY.
   *
   * The only caller is a container shell: `docker exec -it <ref> /bin/sh` is a
   * PTY over a channel, which is the same shape a login shell is — so it is a
   * transport, not a second terminal.
   *
   * MUST be built by a validating builder in shared/ (buildDockerShellCommand),
   * never assembled from user text. A field on the connect config that accepts
   * arbitrary strings is "run anything on any saved server" with none of the
   * confirmation broadcast has, and it would be reachable from anywhere that
   * can open a tab.
   */
  initialCommand?: string
}

export type SshStatusPhase = 'connecting' | 'hop' | 'authenticating' | 'ready' | 'closed' | 'error'

// Why a shell session ended, as far as the far end told us. Everything is
// optional: a connection dropped mid-flight reports nothing at all.
export interface SshCloseInfo {
  // Exit status of the remote shell, when it exited normally.
  code?: number
  // Signal that killed it, e.g. 'HUP' when the server timed the session out.
  signal?: string
}

export interface SshStatus {
  sessionId: string
  phase: SshStatusPhase
  message?: string
  hopIndex?: number
  hopCount?: number
}

export interface SftpEntry {
  name: string
  dir: boolean
  link: boolean
  size: number
  mtime: number
  perms: string
}

export interface SftpResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

// Emitted while a file transfer runs so the Files view can show progress.
export interface SftpProgress {
  key: string
  name: string
  transferred: number
  total: number
  // 1-based position in the current batch.
  index: number
  count: number
}

export interface SftpUploadSummary {
  uploaded: string[]
  failed: { name: string; error: string }[]
}

export interface HostMetrics {
  /**
   * CPU usage as a percentage, or null when it could not be measured.
   *
   * Null, never zero, for the same reason inodePct and load1 are: the probe is
   * one compound exec, and a host with no procfs, no `grep`, or a link that
   * cut the stream short yields no CPU section at all. Zero there is a
   * perfectly idle machine, and an idle reading on the alert path posts an
   * all-clear for a host that is still pegged.
   */
  cpu: number | null // percent 0-100
  /**
   * Utilisation per core over the same window, index 0 = cpu0, or null when
   * /proc/stat gave no per-core lines to diff.
   *
   * Beside the aggregate, never instead of it: one core at 88% on an eight-core
   * box is 11% of the machine, and reporting either number alone answers the
   * wrong question.
   */
  cpuCores: number[] | null
  /** Memory used as a percentage, or null when MemTotal could not be read. A
   *  cgroup-only container and an unreadable /proc/meminfo both land here, and
   *  0/0 is not 0%. */
  memPct: number | null
  memUsed: number // bytes
  /**
   * The columns `free` prints beside `used`, in bytes, or null when
   * /proc/meminfo did not name them.
   *
   * `memUsed` is `MemTotal - MemAvailable`, which is what modern `free` calls
   * used. htop's Mem bar is a different quantity — it excludes the reclaimable
   * cache that `free` counts as available — so the two differ by roughly the
   * size of the page cache, and a user comparing them has no way to see why
   * unless the parts are on screen too.
   */
  memAvailable: number | null
  memFree: number | null
  /** Buffers + page cache + reclaimable slab: `free`'s buff/cache column. */
  memCache: number | null
  memTotal: number
  /**
   * Root filesystem usage as a percentage, or null when `df` said nothing.
   *
   * Null, never zero, for the same reason cpu, memPct, inodePct and load1 are:
   * a probe that could not measure a disk is not a disk that is empty, and 0%
   * is the most reassuring number this field can hold.
   *
   * It used to be `number`, paired with `diskTotal > 0` as the "was this
   * measured" signal. That convention worked where it was applied — the alert
   * path checks it and says so — but four other call sites did not, and each
   * printed or recorded a confident 0%. A type that cannot be dereferenced
   * without answering the question is the version nobody can forget.
   */
  diskPct: number | null
  diskUsed: number
  diskTotal: number
  /**
   * Inode usage of `/` as a percentage, or null.
   *
   * A filesystem can be 40% full and completely unwritable because it has run
   * out of inodes — a mail spool or a build cache with millions of tiny files
   * is the usual way — and `df -k` shows nothing wrong at all. Null, never
   * zero, when it could not be measured: `df -i` is absent on some busybox
   * userlands, and btrfs and zfs legitimately report no inode total. Zero
   * there would read as an empty filesystem and post an all-clear.
   */
  inodePct?: number | null
  /**
   * Every real filesystem on the server — item 47.
   *
   * BESIDE `diskPct`, not instead of it. `diskPct` is the ROOT filesystem and
   * has meant that in every sample stored since the history store was written,
   * so it goes on meaning it; this is the rest of them, which is where a full
   * /var or /data actually lives.
   *
   * Optional, because a sample read back from an older store has none — and
   * absent is not `[]`. `[]` means `df` answered and no real filesystem came
   * back; absent means nobody asked.
   */
  mounts?: DiskMount[]
  /**
   * One-minute load average, or null when /proc/loadavg could not be read.
   *
   * Raw, not divided by `cores`: the division belongs wherever the threshold
   * is, and a caller that has both numbers can do it. A container without
   * /proc mounted reports null rather than 0, which would be a perfectly idle
   * machine.
   */
  load1?: number | null
  netRx: number // cumulative bytes
  netTx: number
  uptime: number // seconds
  hostname: string
  kernel: string
  cores: number
  // null means the tool is not on the host at all — a container without
  // systemd, or a box with neither ss nor netstat. That is a different thing
  // from an empty list, which means the tool ran and found nothing, and the
  // UI has to be able to tell them apart: "no failed services" and "cannot
  // see services" are not the same answer.
  services: ServiceUnit[] | null
  listeners: PortListener[] | null
  // Which probe produced the listeners, so the UI can say why the process
  // column is empty on a host where only netstat exists and it ran unprivileged.
  listenerSource: 'ss' | 'netstat' | null
}

// A systemd unit, as reported by `systemctl list-units`.
export interface ServiceUnit {
  name: string
  // active | failed | activating | inactive
  active: string
  // running | exited | dead | failed
  sub: string
  description: string
}

// A socket in LISTEN state, from `ss` or `netstat`.
export interface PortListener {
  proto: string
  address: string
  port: number
  // Only present when the probe ran with enough privilege to see the owner;
  // an unprivileged user sees the socket but not whose it is.
  process?: string
  pid?: number
}

export interface MetricsResult {
  ok: boolean
  error?: string
  data?: HostMetrics
}

/**
 * What an on-demand host read must be given.
 *
 * These are the reads a person asks for by pressing a button — filesystems,
 * kernel, security-update list, a systemd timer, a kubeconfig — as opposed to
 * the ones the background sweep takes. They all end at `openChain`, which
 * reaches a server behind a bastion by walking `hops`.
 *
 * It exists because `cfg: unknown` let the wrong object through. Four call
 * sites passed the RENDERER's `Server` record straight in, and a `Server`
 * carries its chain as `route`, not `hops` — so the chain was dropped in
 * silence and every one of those reads dialled the private address directly:
 *
 *   The filesystems could not be read: connect ETIMEDOUT 192.168.19.7:1051
 *
 * on a host the background monitor was sampling perfectly well one panel over.
 * A first fix wrapped the handlers in resolveChainSecrets/withVpnTransport,
 * which repaired credentials and VPN and left the shape mismatch untouched,
 * because the config it was resolving had never carried the chain.
 *
 * Typing it is what makes the mistake impossible rather than merely fixed:
 * `SshAuth` is 'password' | 'key' | 'agent', while the renderer's `AuthMethod`
 * also has 'certificate', so a raw `Server` is not assignable here and every
 * one of those call sites fails to compile. Build the value with
 * `sshTargetFor(server)`.
 *
 * A local target is admitted because these same handlers serve "this machine",
 * which owns no credentials and no chain.
 */
export type OnDemandTarget =
  | { local: true }
  | (SshHop & { serverId?: string; hops?: SshHop[]; vpnProfileId?: string; serverName?: string })
