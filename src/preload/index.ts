import { contextBridge, ipcRenderer, clipboard, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AutoStartSettings, AutoStartState } from '../shared/autostart'
import type { UnitDraft, UserUnitsReading } from '../shared/userUnits'
import type { BackupAlarm } from '../shared/backup'
import type { HttpRequestSpec, HttpResult } from '../shared/httpClient'
import type {
  HttpSocketBridge,
  WsEvent,
  WsOpenResult,
  WsOpenSpec,
  WsSendResult
} from '../shared/httpSocket'
import type { CheckResult, HttpCheck } from '../shared/httpMonitor'
import type {
  AgentRunReport,
  CicdConnection,
  CicdLogChunk,
  CicdPanelState,
  CicdCapacity,
  CicdConfigSource,
  CicdQueueItem,
  CicdRun,
  CicdParam,
  CicdTriggerResult
} from '../shared/cicd'
import type { CredentialShape } from '../shared/credentialShape'
import type { DiagnosticsCrash } from '../shared/diagnostics'
import type { DebugBundle, DebugStatus, SaveResult } from '../shared/debug'
import type { LocalTarget } from '../shared/execTarget'
import type {
  SshConnectConfig,
  SshStatus,
  SftpEntry,
  SftpProgress,
  SftpResult,
  SftpUploadSummary,
  MetricsResult,
  SshCloseInfo,
  OnDemandTarget
} from '../shared/ssh'
import type {
  AccessChangePreview,
  AccessRunRequest,
  AccessRunResult,
  HostAccess
} from '../shared/access'
import type {
  InspectBodyPage,
  InspectCaInfo,
  InspectFlow,
  InspectOpaqueTunnel,
  InspectPinnedHost,
  InspectStartOptions,
  InspectStatus
} from '../shared/inspect'
import type { HostFacts } from '../shared/hostFacts'
import type { CloudFault, CloudProvider } from '../shared/cloud'
import type {
  CloudAccount,
  CloudAuthStatus,
  CloudInstance,
  CloudLocation
} from '../shared/cloudCommands'
import type { HostPosture } from '../shared/posture'
import type { FleetSampleEvent, FleetSamplerConfig, FleetSamplerStatus,
  FleetCollectResult,
  FleetSweepProgress
} from '../shared/fleet'
import type { BroadcastHostResult, BroadcastProgress, BroadcastRequest } from '../shared/broadcast'
import type {
  JobDetail,
  JobHostCapabilityReport,
  JobOutput,
  JobProgress,
  JobRecord,
  JobRunRequest,
  JobsBridge
} from '../shared/jobs'
import type { LogLine, LogSource, LogTailState, UnitChoice } from '../shared/logtail'
import type { CronEntry, CronSourceReport } from '../shared/cron'
import type { CapacityBridge, CapacityReport } from '../shared/capacity'
import type { HostDrift } from '../shared/drift'
import type { RuleDraftWire, RuleView, RulesBridge } from '../shared/rules'
import type {
  ManagedProcessView,
  ProcessDraft,
  ProcessLogLine,
  ProcessStatus,
  ProcessesBridge
} from '../shared/processes'
import type { ChangeLogBridge, ChangeLogFilter, ChangeLogPage } from '../shared/changelog'
import type { RunbookNote, RunbookView, RunbooksBridge } from '../shared/runbooks'
import type { StoreAlertKind } from '../shared/webhook'
import type { BytesReading } from '../shared/bytesForecast'
import type { EnginePrecheckProbe } from '../shared/enginePrecheck'
import type { PackageManager } from '../shared/hostFacts'
import type { ImageScanProbe } from '../shared/imageScan'
import type { SecurityListProbe } from '../shared/securityUpdates'
import type { K8sReviewProbe } from '../shared/k8sReview'
import type {
  DockerAction,
  DockerActionResult,
  DockerBridge,
  DockerDiskDetailProbe,
  DockerDiskProbe,
  DockerHealthLogProbe,
  DockerNetworkProbe,
  DockerInspectProbe,
  DockerLogsOptions,
  DockerProbe,
  DockerReclaimItem,
  DockerReclaimResult,
  DockerStatsProbe
} from '../shared/docker'
import type {
  ComposeConfigProbe,
  ComposeEnvProbe,
  ComposeEnvWriteResult,
  ComposePreloadBridge,
  ComposeImageWriteRequest,
  ComposeImageWriteResult,
  ComposeRevertPlan,
  ComposeListProbe,
  ComposeProjectRef
} from '../shared/compose'
import type {
  K8sCordonResult,
  K8sCordonTarget,
  K8sDrainAssessment,
  K8sDrainPlan,
  K8sDrainResult,
  K8sExecPlan,
  K8sExecResult,
  K8sExecTarget,
  K8sApiScan,
  K8sHelmList,
  K8sResources,
  K8sDiagnosis,
  K8sAllocatableProbe,
  K8sOverview,
  K8sProbe,
  K8sRolloutResult,
  K8sRolloutTarget,
  K8sUsage
} from '../shared/kubernetes'
import type {
  AlertPayload,
  StoredAlertEvent,
  StoredAlertRow,
  StoredDbAlertRow,
  WebhookConfig,
  WebhookDeliveryStatus,
  WebhookTestResult
} from '../shared/webhook'
import type { CredProxyCall, CredProxyRule, CredProxyStatus , CredProxyToken } from '../shared/credproxy'
import type {
  LocalCloseInfo,
  LocalConnectConfig,
  LocalShell,
  LocalStatus
} from '../shared/local'

export interface SshPromptRequest {
  id: string
  host: string
  username: string
  serverId?: string
  name: string
  instructions: string
  prompts: { prompt: string; echo: boolean }[]
}
import type { DbConnectConfig, DbInfo, DbQueryResult, DbTestResult } from '../shared/db'
import type { DbShellResult } from '../shared/dbshell'
import type { DbOpsReport } from '../shared/dbOps'
import type { VaultEntry, VaultListResult, VaultResult, VaultStatus } from '../shared/vault'
import type { KernelStatus } from '../shared/kernelStatus'
import type { StorageLayout } from '../shared/storageLayout'
import type { NetworkInfo } from '../shared/network'
import type { ListeningPortsInfo } from '../shared/listeningPorts'
import type { RdpDesktopSize, RdpTicketResult } from '../shared/rdp'
import type { TunnelConfig, TunnelResult, TunnelSshConfig, TunnelStatus } from '../shared/tunnel'
import type {
  FrpTokenResult,
  VpnDependent,
  VpnEngineInfo,
  VpnImportResult,
  VpnKeygenResult,
  VpnMintResult,
  VpnKind,
  VpnLogLine,
  VpnProfile,
  VpnPrompt,
  VpnPublicKeyResult,
  VpnResult,
  VpnSpec,
  VpnStartResult,
  VpnStatus,
  VpnValidation,
  VpnDiagnoseRefusal,
  VpnDiagnoseResult,
  VpnDiagnoseTarget
} from '../shared/vpn'
import type { VaultIndexResult } from '../shared/vaultIndex'
import type { KnownHost } from '../main/services/knownhosts'
import type { SshConfigHost } from '../shared/sshconfig'
import type {
  BackupDestination,
  BackupResult,
  BackupRunReport,
  BackupTargetsFile,
  DumpEngine,
  DumpRunReport,
  RemoteListResult
} from '../shared/backup'
import type { UpdatePrefs, UpdaterCapabilities, UpdaterStatus } from '../shared/updater'
import type {
  AccessGroup,
  PolicyAssignment,
  ServerAiMeta,
  McpGlobalConfig,
  McpAgentSession,
  ApprovalRequest,
  AuditEntry,
  CliPairingRequest
} from '../shared/mcp'

type WindowAction = 'minimize' | 'toggle-maximize' | 'close'
type ThemeMode = 'dark' | 'light' | 'system'

// Declared out here rather than inline in `api` so it can carry the JobsBridge
// annotation. See the comment at `jobs:` below for why the annotation is the
// point.
const jobsBridge: JobsBridge = {
  list: (limit?: number): Promise<JobRecord[]> => ipcRenderer.invoke('jobs:list', limit),
  get: (jobId: string): Promise<JobDetail | null> => ipcRenderer.invoke('jobs:get', jobId),
  // The request carries a `CommandApproval` — B3. It is not decoration and the
  // preload does not check it: main re-derives `planJob` over this very spec
  // and target list and refuses the run if the record disagrees, so a caller
  // that forges or omits one gets a sentence back rather than a job. Verifying
  // it here as well would be a second copy of the rule in the one place that
  // has no more information than the sender.
  run: (req: JobRunRequest): Promise<JobDetail> => ipcRenderer.invoke('jobs:run', req),
  cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke('jobs:cancel', jobId),
  // Pushed from the renderer's settings the way ssh.setPoolIdle is, because
  // that is where the switch the user flicks lives. Main holds the value and
  // the detached executor reads it per LAUNCH, so turning it off never
  // interferes with a job already running — and a job being reclaimed after a
  // restart is followed to its end either way, because there is a real process
  // on that host whatever this switch now says.
  setDetached: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('jobs:setDetached', enabled),
  capabilities: (): Promise<JobHostCapabilityReport[]> => ipcRenderer.invoke('jobs:capabilities'),
  onProgress: (fn: (p: JobProgress) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, p: JobProgress): void => fn(p)
    ipcRenderer.on('jobs:progress', h)
    return () => ipcRenderer.removeListener('jobs:progress', h)
  },
  // A separate channel from progress, not a variant of it. Output is high
  // volume and coalesced per tick; job and host transitions are rare and must
  // never be dropped behind a burst of apt chatter. One channel would make the
  // state machine share a queue with the noise.
  onOutput: (fn: (o: JobOutput) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, o: JobOutput): void => fn(o)
    ipcRenderer.on('jobs:output', h)
    return () => ipcRenderer.removeListener('jobs:output', h)
  }
}

/** What every cloud:* channel answers with. A failure is a value, not a throw. */
export type CloudReply<T> = { ok: true; value: T } | { ok: false; fault: CloudFault; error: string }

/**
 * Mirrors ProviderDetectionResult in services/cloud/binaries.ts.
 *
 * Restated rather than imported: that module reaches into node:fs and
 * node:child_process, and the renderer must not pull it in through a type-only
 * import that someone later makes a value import.
 */
export interface ProviderDetectionResult {
  installed: boolean
  executablePath?: string
  version?: string
  supported: boolean
  error?: string
}

import type { AddyPairingConfirmation, ConflictCopy } from '../shared/addy'
import type { ProvisionManifest, ProvisionPlan } from '../shared/provision'
import type {
  AgentApprovalRequest,
  AgentDecision,
  AgentIdentity,
  AgentStatus,
  SshAgentSettings
} from '../shared/sshAgentHost'

/** Mirrors RevocationTombstone in main/services/addy/revoke.ts. Declared
 *  rather than imported: the preload must not pull a main-process module into
 *  the renderer's bundle, and this is three fields. */
export interface AddyRevocation {
  accountId: string
  deviceId: string
  at: string
  stage: 'wiping' | 'wiped' | 'failed'
  error?: string
  cleared?: boolean
}

const api = {
  platform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('app:platform'),
  // addy: the satellite relay. Sync, pairing and continuity.
  //
  // The renderer never holds a key and never sees one. Everything here either
  // asks main a question about state main already owns, or asks it to do
  // something whose keys live in the addyd sidecar -- the same division the
  // vault and credential proxy already use, for the same reason.
  /**
   * The SSH agent this app serves.
   *
   * Note the direction: this is the agent OTHER TOOLS talk to, not the one
   * OpsMaxx talks to for a given host. The second is `ssh.*` and is unrelated.
   */
  sshAgent: {
    status: (): Promise<AgentStatus> => ipcRenderer.invoke('sshAgent:status'),
    /** Keys the agent can offer, including ones that will not parse -- those
     *  carry a `problem` and are shown with it rather than silently missing. */
    identities: (): Promise<AgentIdentity[]> => ipcRenderer.invoke('sshAgent:identities'),
    /** Start, stop or reconfigure in one call: the settings carry `enabled`. */
    configure: (settings: SshAgentSettings): Promise<AgentStatus> =>
      ipcRenderer.invoke('sshAgent:configure', settings),
    /** Answer a pending approval. The SCOPE comes from the renderer because
     *  the user chose it there; main never infers one. */
    resolve: (id: string, decision: AgentDecision): Promise<boolean> =>
      ipcRenderer.invoke('sshAgent:resolve', id, decision),
    /** Prompts outstanding right now. Read on mount, because a prompt raised
     *  while no window was open would otherwise never be seen. */
    pending: (): Promise<AgentApprovalRequest[]> => ipcRenderer.invoke('sshAgent:pending'),
    onApprovalEvent: (
      cb: (e: { type: 'created' | 'resolved'; request: AgentApprovalRequest }) => void
    ): (() => void) => {
      const h = (
        _e: IpcRendererEvent,
        ev: { type: 'created' | 'resolved'; request: AgentApprovalRequest }
      ): void => cb(ev)
      ipcRenderer.on('sshAgent:approval-event', h)
      return () => ipcRenderer.removeListener('sshAgent:approval-event', h)
    }
  },
  /**
   * Importing from another password manager.
   *
   * Preview only from here: the entries come back decrypted, the renderer
   * shows them, and saving goes through the ordinary `vault.save` -- so an
   * import cannot reach the vault by a path nothing else uses.
   */
  importVault: {
    bitwardenPreview: (source: {
      serverURL: string
      email: string
      password: string
      twoFactorCode?: string
    }): Promise<{ entries?: VaultEntry[]; skipped?: { name: string; reason: string }[]; error?: string }> =>
      ipcRenderer.invoke('import:bitwardenPreview', source)
  },
  /**
   * Setting up a fresh machine from a manifest.
   *
   * Preview then apply, and apply takes the manifest that was previewed. The
   * post-restore script is shown in full and approved separately, every time:
   * a manifest arrives by email, and a hook that ran on less than that would be
   * a delivery mechanism rather than a feature.
   */
  provision: {
    preview: (manifest: unknown): Promise<ProvisionPlan> =>
      ipcRenderer.invoke('provision:preview', manifest),
    apply: (opts: {
      manifest: ProvisionManifest
      passphrase: string
      hookApproved: boolean
    }): Promise<{ ok: boolean; done: string[]; failed?: string; hookOutput?: string }> =>
      ipcRenderer.invoke('provision:apply', opts)
  },
  addy: {
    /**
     * Whether this device has been revoked, and how far the wipe got.
     *
     * Read before the first frame is drawn. The revocation screen is a BLOCK,
     * not a notice, so it has to be resolved before anything that could show a
     * server name or a vault entry mounts.
     */
    revocation: (): Promise<AddyRevocation | null> => ipcRenderer.invoke('addy:revocation'),
    /** Acknowledge a finished wipe so the machine can be set up again, as a
     *  new device. Recovers nothing: the data is already gone. */
    clearRevocation: (): Promise<void> => ipcRenderer.invoke('addy:clearRevocation'),

    /** Conflict copies waiting for a choice, with BOTH sides already opened --
     *  the relay cannot open either, so this is the only place they can be
     *  made comparable. Empty when no account is configured. */
    conflicts: (): Promise<ConflictCopy[]> => ipcRenderer.invoke('addy:conflicts'),
    /** Write the chosen contents and drop the copy, in that order: the reverse
     *  loses the losing copy if the write fails. */
    resolveConflict: (id: number, collection: string, chosen: unknown): Promise<void> =>
      ipcRenderer.invoke('addy:resolveConflict', id, collection, chosen),
    /** Drop a copy without writing anything, for the user who looked at both
     *  and decided the winner was right. */
    discardConflict: (id: number): Promise<void> => ipcRenderer.invoke('addy:discardConflict', id),

    /**
     * Mint an account on a relay.
     *
     * The recovery phrase comes back ONCE and is never obtainable again --
     * there is no call that returns it, deliberately. Whatever the renderer
     * does with it, it has to do now.
     */
    createAccount: (
      baseURL: string,
      invite: string,
      label: string
    ): Promise<{ accountId: string; mnemonic: string }> =>
      ipcRenderer.invoke('addy:createAccount', baseURL, invite, label),

    /** Start a pairing and return the code IMMEDIATELY. The other device has
     *  not answered yet; `awaitPairing` is what resolves when it does. */
    beginPairing: (baseURL: string): Promise<{ code: string; pairingId: string }> =>
      ipcRenderer.invoke('addy:beginPairing', baseURL),
    /** Resolves with the emoji to compare, once the other device has proved it
     *  knows the code. Rejects if it never does, or if the proof fails. */
    awaitPairing: (): Promise<AddyPairingConfirmation> => ipcRenderer.invoke('addy:awaitPairing'),
    /** The other side: both halves of what the first device showed. */
    joinPairing: (
      baseURL: string,
      code: string,
      pairingId: string
    ): Promise<AddyPairingConfirmation> =>
      ipcRenderer.invoke('addy:joinPairing', baseURL, code, pairingId),
    /** Ends it and forgets the shared secret. For "these do not match", and
     *  for closing the panel. */
    cancelPairing: (): Promise<void> => ipcRenderer.invoke('addy:cancelPairing'),

    /** Send what is on the clipboard to every other device on the account.
     *  Explicit, on a keystroke -- nothing is mirrored in the background. */
    sendClipboard: (): Promise<{ sent: number; skipped?: string }> =>
      ipcRenderer.invoke('addy:sendClipboard'),
    /** Put the newest thing sent to this device onto the clipboard. */
    receiveClipboard: (): Promise<{ applied: boolean; from?: string; reason?: string }> =>
      ipcRenderer.invoke('addy:receiveClipboard')
  },
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  autoStart: {
    get: (): Promise<AutoStartState> => ipcRenderer.invoke('app:autoStart'),
    set: (next: AutoStartSettings): Promise<AutoStartState> =>
      ipcRenderer.invoke('app:setAutoStart', next)
  },
  window: {
    control: (action: WindowAction): Promise<void> =>
      ipcRenderer.invoke('window:control', action),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_e: unknown, value: boolean): void => cb(value)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    }
  },
  theme: {
    set: (mode: ThemeMode): Promise<boolean> => ipcRenderer.invoke('theme:set', mode)
  },
  dialog: {
    openKey: (): Promise<string | null> => ipcRenderer.invoke('dialog:openKey'),
    /** The same picker, plus the key's PEM body when the file is one — so a key
     *  can be stored in the vault as material rather than as a path to
     *  plaintext on disk. `material: null` means the user picked something that
     *  is not a private key, and the caller keeps the path. */
    openKeyMaterial: (): Promise<{ path: string; material: string | null } | null> =>
      ipcRenderer.invoke('dialog:openKeyMaterial'),
    openUpload: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:openUpload'),
    saveJson: (suggestedName: string, contents: string): Promise<boolean> =>
      ipcRenderer.invoke('dialog:saveJson', suggestedName, contents),
    openJson: (): Promise<string | null> => ipcRenderer.invoke('dialog:openJson'),
    openScheme: (): Promise<string | null> => ipcRenderer.invoke('dialog:openScheme')
  },
  /**
   * ping and traceroute, run from a chosen target.
   *
   * The command is built by shared/netTools.ts, which refuses any host that is
   * not a hostname or an IP literal — main re-asserts the shape, so this is not
   * a general exec channel.
   */
  netTools: {
    run: (
      cfg: OnDemandTarget,
      command: string,
      timeoutMs?: number
    ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> =>
      ipcRenderer.invoke('net-tools:run', cfg, command, timeoutMs)
  },
  clipboard: {
    read: (): string => clipboard.readText(),
    write: (text: string): void => clipboard.writeText(text)
  },
  /**
   * The text for a bug report: versions, counts and booleans about THIS
   * installation, assembled in main. No names, no addresses, no paths, no
   * credentials, and no file written anywhere — so it is handed back in full for
   * the user to read before they post it, and `clipboard.write` above is how it
   * gets copied.
   *
   * `crash` is only passed from the error boundary, which is the one caller that
   * knows something main never saw.
   */
  diagnostics: {
    text: (crash?: DiagnosticsCrash | null): Promise<string> =>
      ipcRenderer.invoke('diagnostics:text', crash ?? null)
  },
  /**
   * The other half of a bug report: what the app DID.
   *
   * Unlike `diagnostics` above, this is NOT safe by construction. `build`
   * returns the diagnostics block plus a trace of which internal operations ran
   * and which failed, and a failure names what it failed to reach — hostnames,
   * usernames, paths, the text of an error a server wrote. `redactOutput` takes
   * the secrets out at the writer and cannot take a hostname out, so the
   * renderer shows the whole thing before the user can do anything with it.
   *
   * There is no `copy` here on purpose. A report is SAVED: an attachment is
   * inert, while pasted text renders as Markdown and is read by automation,
   * which is the line CONTRIBUTING.md already draws for long logs. `save`
   * returns what actually happened — written, cancelled, or why not — because
   * the path it replaces claimed success whenever nothing threw.
   *
   * No `setEnabled` either: the toggle is an ordinary renderer setting and
   * reaches main on `data:save` like every other one.
   */
  debug: {
    status: (): Promise<DebugStatus> => ipcRenderer.invoke('debug:status'),
    build: (): Promise<DebugBundle> => ipcRenderer.invoke('debug:build'),
    save: (text: string): Promise<SaveResult> => ipcRenderer.invoke('debug:save', text),
    /** Remove the trace. The user's copy of their own hostnames is theirs. */
    delete: (): Promise<void> => ipcRenderer.invoke('debug:delete'),
    /** Fire-and-forget, and dropped in main when debug mode is off. `send`
     *  rather than `invoke` so an error report cannot itself await main. */
    event: (kind: string, message: string, stack?: string): void =>
      ipcRenderer.send('debug:event', kind, message, stack)
  },
  /**
   * Cloud provider detection, sign-in state and resource discovery.
   *
   * Read-only, all of it: these ask the user's own provider CLI what it can
   * see. Connecting is still ssh.connect - a cloud server is dialled exactly
   * like any other, and main resolves the provider from the saved record.
   */
  cloud: {
    /** `force` skips the per-run cache: what "Check again" is for. */
    detect: (
      provider: CloudProvider,
      force?: boolean
    ): Promise<CloudReply<ProviderDetectionResult>> =>
      ipcRenderer.invoke('cloud:detect', provider, force),
    authStatus: (provider: CloudProvider, account?: string): Promise<CloudReply<CloudAuthStatus>> =>
      ipcRenderer.invoke('cloud:authStatus', provider, account),
    accounts: (provider: CloudProvider): Promise<CloudReply<CloudAccount[]>> =>
      ipcRenderer.invoke('cloud:accounts', provider),
    locations: (provider: CloudProvider, account: string): Promise<CloudReply<CloudLocation[]>> =>
      ipcRenderer.invoke('cloud:locations', provider, account),
    instances: (
      provider: CloudProvider,
      account: string,
      location: string
    ): Promise<CloudReply<CloudInstance[]>> =>
      ipcRenderer.invoke('cloud:instances', provider, account, location)
  },
  ssh: {
    connect: (cfg: SshConnectConfig & { serverId?: string }): Promise<void> =>
      ipcRenderer.invoke('ssh:connect', cfg),
    write: (id: string, data: string): void => ipcRenderer.send('ssh:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('ssh:resize', id, cols, rows),
    close: (id: string): void => ipcRenderer.send('ssh:close', id),
    /** Dial, then hang up. Nothing is pooled and nothing is saved. */
    test: (cfg: SshConnectConfig & { serverId?: string }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('ssh:test', cfg),
    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const ch = `ssh:data:${id}`
      const h = (_e: IpcRendererEvent, d: string): void => cb(d)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    },
    onStatus: (id: string, cb: (s: SshStatus) => void): (() => void) => {
      const ch = `ssh:status:${id}`
      const h = (_e: IpcRendererEvent, s: SshStatus): void => cb(s)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    },
    onPrompt: (cb: (req: SshPromptRequest) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, req: SshPromptRequest): void => cb(req)
      ipcRenderer.on('ssh:prompt', h)
      return () => ipcRenderer.removeListener('ssh:prompt', h)
    },
    /** What credential a server has, with none of its value. For the
     *  failure card: the server's "all methods failed" reads the same whether
     *  a key was rejected or none was ever stored. */
    credentialShape: (serverId: string): Promise<CredentialShape> =>
      ipcRenderer.invoke('ssh:credential-shape', serverId),
    /** Drop a remembered second-factor answer, so the server asks again. */
    forgetKbAnswer: (serverId: string): Promise<boolean> =>
      ipcRenderer.invoke('ssh:forget-kb-answer', serverId),
    poolList: (): Promise<{ key: string; host: string; username: string; sessions: number }[]> =>
      ipcRenderer.invoke('ssh:pool-list'),
    poolClose: (key: string): Promise<void> => ipcRenderer.invoke('ssh:pool-close', key),
    /** Forget the shared connection to a server without closing it, so the
     *  next connect authenticates afresh and other panes on it survive. */
    poolEvict: (serverId: string): Promise<number> =>
      ipcRenderer.invoke('ssh:pool-evict', serverId),
    defaultKeys: (): Promise<
      { path: string; fileName: string; algorithm: string | null; encrypted: boolean }[]
    > => ipcRenderer.invoke('ssh:defaultKeys'),
    /** One listed key's PEM body, by FILE NAME — main resolves it against its
     *  own scan of ~/.ssh, so nothing is readable here that is not already
     *  listed by `defaultKeys` above. */
    keyMaterial: (fileName: string): Promise<string | null> =>
      ipcRenderer.invoke('ssh:keyMaterial', fileName),
    setPoolIdle: (minutes: number): Promise<void> => ipcRenderer.invoke('ssh:pool-idle', minutes),
    replyPrompt: (id: string, answers: string[], remember?: boolean, serverId?: string): void =>
      ipcRenderer.send('ssh:prompt-reply', id, answers, remember, serverId),
    onClose: (id: string, cb: (info: SshCloseInfo) => void): (() => void) => {
      const ch = `ssh:close:${id}`
      const h = (_e: IpcRendererEvent, info: SshCloseInfo): void => cb(info ?? {})
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    }
  },
  // Mirrors `ssh` above, channel for channel, but a separate namespace rather
  // than one with a `kind` discriminator: the two take different configs, and a
  // union the renderer has to narrow at every call site is how a local session
  // ends up in a code path that tries to dial it.
  //
  // Nothing here is reachable from the MCP bridge or the CLI, deliberately.
  // tests/localTerminalNotExposed.test.ts is what keeps that true.
  local: {
    shells: (refresh?: boolean): Promise<LocalShell[]> =>
      ipcRenderer.invoke('local:shells', refresh),
    connect: (cfg: LocalConnectConfig): Promise<void> => ipcRenderer.invoke('local:connect', cfg),
    write: (id: string, data: string): void => ipcRenderer.send('local:write', id, data),
    // Reports how many UTF-16 code units the terminal has actually parsed, which
    // is what lets main stop reading the pty when the renderer falls behind.
    // Code units, not bytes: main counts the same unit on the way out, and
    // mixing the two accrues a deficit that never repays and wedges the session.
    ack: (id: string, units: number): void => ipcRenderer.send('local:ack', id, units),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('local:resize', id, cols, rows),
    close: (id: string): void => ipcRenderer.send('local:close', id),
    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const ch = `local:data:${id}`
      const h = (_e: IpcRendererEvent, d: string): void => cb(d)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    },
    onStatus: (id: string, cb: (s: LocalStatus) => void): (() => void) => {
      const ch = `local:status:${id}`
      const h = (_e: IpcRendererEvent, s: LocalStatus): void => cb(s)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    },
    onClose: (id: string, cb: (info: LocalCloseInfo) => void): (() => void) => {
      const ch = `local:close:${id}`
      const h = (_e: IpcRendererEvent, info: LocalCloseInfo): void => cb(info ?? {})
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    }
  },
  http: {
    /**
     * Send one HTTP request from the main process. `spec.via` decides whether
     * it leaves this machine directly or travels down a server's SSH
     * connection; `spec.via.server` carries no credentials, because main
     * merges those from the encrypted store by serverId.
     */
    request: (spec: HttpRequestSpec): Promise<HttpResult> =>
      ipcRenderer.invoke('http:request', spec),
    /**
     * One monitor check. Returns the status and the duration and NOT the body:
     * a check running every minute has no use for a response payload, and
     * shipping one across IPC on a timer is the difference between a monitor
     * and a download.
     */
    check: (
      spec: HttpRequestSpec
    ): Promise<{ ok: true; status: number; durationMs: number } | { ok: false; error: string }> =>
      ipcRenderer.invoke('http:check', spec),
    /** Pick an OpenAPI description from disk. Returns its path and its
     *  contents, or null if the picker was dismissed. Both halves, because the
     *  collection stores the path and the client is handed the text. */
    chooseSpecFile: (): Promise<{ path: string; text: string } | null> =>
      ipcRenderer.invoke('http:chooseSpecFile'),
    /** Re-read a description a collection already points at. */
    readSpecFile: (path: string): Promise<string> => ipcRenderer.invoke('http:readSpecFile', path)
  },
  /**
   * WebSocket sessions, opened in main over the same three routes a request
   * takes. The reason this is not `new WebSocket()` in the renderer: the
   * browser cannot set handshake headers, cannot be handed a private CA, and
   * cannot reach a service bound to a server's loopback.
   */
  httpSocket: {
    open: (spec: WsOpenSpec): Promise<WsOpenResult> => ipcRenderer.invoke('ws:open', spec),
    send: (id: string, data: string | ArrayBuffer): Promise<WsSendResult> =>
      ipcRenderer.invoke('ws:send', id, data),
    close: (id: string, code?: number, reason?: string): Promise<void> =>
      ipcRenderer.invoke('ws:close', id, code, reason),
    onEvent: (id: string, cb: (event: WsEvent) => void): (() => void) => {
      const ch = `ws:event:${id}`
      const h = (_e: IpcRendererEvent, event: WsEvent): void => cb(event)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    }
  } satisfies HttpSocketBridge,
  /**
   * Service checks, which run in main whether or not anything is displaying
   * them. The renderer owns the LIST (it is user configuration, persisted with
   * the workspace) and main owns the RUNNING of it, so this bridge is: here is
   * the list, tell me what happened.
   */
  // ---- CI/CD ----
  //
  // The renderer owns the connection records and hands them to main; main owns
  // the token and never hands it back. `verify` is the one call that carries a
  // secret in this direction, because at that moment there is no vault entry
  // yet — the user has typed a token and wants to know if it works.
  cicd: {
    // No arguments. This tells main the SAVED connections changed; main
    // re-reads the file and discovers each account's pipelines itself. The
    // renderer never names a vault entry or a destination — a renderer that
    // could would be naming which credential goes to which host.
    configure: (): Promise<void> => ipcRenderer.invoke('cicd:configure'),
    snapshot: (): Promise<CicdPanelState[]> => ipcRenderer.invoke('cicd:snapshot'),
    agentRuns: (): Promise<AgentRunReport[]> => ipcRenderer.invoke('cicd:agentRuns'),
    refresh: (connectionId?: string): Promise<void> =>
      ipcRenderer.invoke('cicd:refresh', connectionId),
    getRun: (
      connectionId: string,
      pipelineRef: string,
      runId: string,
      attempt?: number
    ): Promise<{ run: unknown; steps: unknown[] }> =>
      ipcRenderer.invoke('cicd:getRun', connectionId, pipelineRef, runId, attempt),
    createSecret: (label: string, token: string): Promise<string> =>
      ipcRenderer.invoke('cicd:createSecret', label, token),
    verify: (
      connection: CicdConnection,
      secret: string
    ): Promise<
      { ok: true; identity: string; scopes?: string[]; expiresAt?: number } | { ok: false; error: string }
    > => ipcRenderer.invoke('cicd:verify', connection, secret),
    listParams: (connectionId: string, pipelineRef: string): Promise<CicdParam[]> =>
      ipcRenderer.invoke('cicd:listParams', connectionId, pipelineRef),
    getConfig: (connectionId: string, pipelineRef: string): Promise<CicdConfigSource> =>
      ipcRenderer.invoke('cicd:getConfig', connectionId, pipelineRef),
    recentRuns: (connectionId: string, pipelineRef: string, limit?: number): Promise<CicdRun[]> =>
      ipcRenderer.invoke('cicd:recentRuns', connectionId, pipelineRef, limit),
    queue: (
      connectionId: string
    ): Promise<{ items: CicdQueueItem[]; capacity: CicdCapacity }> =>
      ipcRenderer.invoke('cicd:queue', connectionId),
    setJobEnabled: (
      connectionId: string,
      pipelineRef: string,
      enabled: boolean
    ): Promise<CicdTriggerResult> =>
      ipcRenderer.invoke('cicd:setJobEnabled', connectionId, pipelineRef, enabled),
    cancelQueueItem: (connectionId: string, itemId: number): Promise<CicdTriggerResult> =>
      ipcRenderer.invoke('cicd:cancelQueueItem', connectionId, itemId),
    getLog: (
      connectionId: string,
      pipelineRef: string,
      runId: string,
      stepName?: string,
      cursor?: string
    ): Promise<CicdLogChunk> =>
      ipcRenderer.invoke('cicd:getLog', connectionId, pipelineRef, runId, stepName, cursor),
    trigger: (
      connectionId: string,
      pipelineRef: string,
      ref: string,
      params?: Record<string, string>
    ): Promise<CicdTriggerResult> =>
      ipcRenderer.invoke('cicd:trigger', connectionId, pipelineRef, ref, params),
    cancel: (connectionId: string, pipelineRef: string, runId: string): Promise<CicdTriggerResult> =>
      ipcRenderer.invoke('cicd:cancel', connectionId, pipelineRef, runId),
    rerun: (connectionId: string, pipelineRef: string, runId: string): Promise<CicdTriggerResult> =>
      ipcRenderer.invoke('cicd:rerun', connectionId, pipelineRef, runId),
    deleteSecrets: (vaultEntryId: string): Promise<void> =>
      ipcRenderer.invoke('cicd:deleteSecrets', vaultEntryId),
    onState: (cb: (event: CicdPanelState) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, event: CicdPanelState): void => cb(event)
      ipcRenderer.on('cicd:state', h)
      return () => ipcRenderer.removeListener('cicd:state', h)
    }
  },
  serviceChecks: {
    set: (checks: HttpCheck[]): Promise<void> => ipcRenderer.invoke('serviceChecks:set', checks),
    history: (): Promise<Record<string, CheckResult[]>> =>
      ipcRenderer.invoke('serviceChecks:history'),
    onResult: (cb: (event: { checkId: string; result: CheckResult }) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, event: { checkId: string; result: CheckResult }): void =>
        cb(event)
      ipcRenderer.on('serviceChecks:result', h)
      return () => ipcRenderer.removeListener('serviceChecks:result', h)
    }
  },
  sftp: {
    /**
     * `cfg` is a connection config, or the local marker for this machine —
     * main serves that half from node:fs behind the same channel. The key
     * registered here decides which half answers every later call in the
     * session, so a target cannot be varied call by call.
     */
    connect: (
      key: string,
      cfg: (SshConnectConfig & { serverId?: string }) | LocalTarget
    ): Promise<SftpResult<{ home: string }>> => ipcRenderer.invoke('sftp:connect', key, cfg),
    list: (key: string, path: string): Promise<SftpResult<SftpEntry[]>> =>
      ipcRenderer.invoke('sftp:list', key, path),
    read: (key: string, path: string): Promise<SftpResult<string>> =>
      ipcRenderer.invoke('sftp:read', key, path),
    write: (key: string, path: string, content: string): Promise<SftpResult> =>
      ipcRenderer.invoke('sftp:write', key, path, content),
    mkdir: (key: string, path: string): Promise<SftpResult> => ipcRenderer.invoke('sftp:mkdir', key, path),
    rename: (key: string, from: string, to: string): Promise<SftpResult> =>
      ipcRenderer.invoke('sftp:rename', key, from, to),
    remove: (key: string, path: string, dir: boolean): Promise<SftpResult> =>
      ipcRenderer.invoke('sftp:delete', key, path, dir),
    upload: (key: string, localPaths: string[], remoteDir: string): Promise<SftpResult<SftpUploadSummary>> =>
      ipcRenderer.invoke('sftp:upload', key, localPaths, remoteDir),
    // Dropped files only carry a path via webUtils; File.path was removed in
    // Electron 32.
    pathFor: (file: File): string => webUtils.getPathForFile(file),
    onProgress: (cb: (p: SftpProgress) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: SftpProgress): void => cb(p)
      ipcRenderer.on('sftp:progress', h)
      return () => ipcRenderer.removeListener('sftp:progress', h)
    },
    disconnect: (key: string): Promise<void> => ipcRenderer.invoke('sftp:disconnect', key),
    editExternal: (
      key: string,
      path: string,
      command: string
    ): Promise<{ ok: boolean; error?: string; localPath?: string }> =>
      ipcRenderer.invoke('sftp:edit-external', key, path, command),
    stopExternal: (path: string): Promise<void> =>
      ipcRenderer.invoke('sftp:edit-external-stop', path),
    onExternalSaved: (
      cb: (r: { remotePath: string; ok: boolean; error?: string }) => void
    ): (() => void) => {
      const h = (_e: IpcRendererEvent, r: { remotePath: string; ok: boolean; error?: string }): void =>
        cb(r)
      ipcRenderer.on('sftp:external-saved', h)
      return () => ipcRenderer.removeListener('sftp:external-saved', h)
    }
  },
  metrics: {
    sample: (
      key: string,
      cfg: SshConnectConfig & { serverId?: string },
      // True only where a person is looking at this one host. See the handler.
      interactive?: boolean
    ): Promise<MetricsResult> => ipcRenderer.invoke('metrics:sample', key, cfg, interactive),
    disconnect: (key: string): Promise<void> => ipcRenderer.invoke('metrics:disconnect', key)
  },
  // Outbound alert delivery. The URL never comes back across this bridge —
  // `status()` reports only whether one is set, because it is a bearer
  // credential and the renderer has no use for its value.
  webhook: {
    status: (): Promise<WebhookConfig> => ipcRenderer.invoke('webhook:status'),
    delivery: (): Promise<WebhookDeliveryStatus> => ipcRenderer.invoke('webhook:delivery'),
    configure: (cfg: { enabled: boolean; notifyOnResolved: boolean }): Promise<WebhookConfig> =>
      ipcRenderer.invoke('webhook:configure', cfg),
    setUrl: (url: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('webhook:set-url', url),
    test: (): Promise<WebhookTestResult> => ipcRenderer.invoke('webhook:test'),
    notify: (payload: AlertPayload): Promise<void> => ipcRenderer.invoke('webhook:notify', payload)
  },
  // The API credential proxy — roadmap item 7.
  //
  // The one credential in this bridge that deliberately travels TOWARDS the
  // renderer is `token()`. Every other secret in this app stays in main, and
  // the webhook URL a few lines above is the model: there is no getter for it
  // because the user never needs to see it. This one is different in kind —
  // it is the string the user pastes into their own script, so a token that
  // never leaves main is a proxy nobody can call. It is not an API key; it is
  // what a caller presents INSTEAD of one, and the panel says so out loud.
  //
  // The API keys themselves never appear here, in either direction. A rule
  // carries a vault entry id, and the value behind it is read in main at
  // request time and injected onto the wire.
  credproxy: {
    status: (): Promise<CredProxyStatus> => ipcRenderer.invoke('credproxy:status'),
    rules: (): Promise<CredProxyRule[]> => ipcRenderer.invoke('credproxy:rules'),
    calls: (limit?: number): Promise<CredProxyCall[]> => ipcRenderer.invoke('credproxy:calls', limit),
    saveRule: (
      draft: unknown
    ): Promise<{ ok: true; rule: CredProxyRule } | { ok: false; error: string }> =>
      ipcRenderer.invoke('credproxy:save-rule', draft),
    removeRule: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('credproxy:remove-rule', id),
    start: (port?: number): Promise<{ ok: boolean; error?: string; status: CredProxyStatus }> =>
      ipcRenderer.invoke('credproxy:start', port),
    stop: (): Promise<CredProxyStatus> => ipcRenderer.invoke('credproxy:stop'),
    tokens: (): Promise<CredProxyToken[]> => ipcRenderer.invoke('credproxy:tokens'),
    createToken: (
      name: string,
      expiresAt: string | null
    ): Promise<{ ok: boolean; id?: string; token?: string; error?: string }> =>
      ipcRenderer.invoke('credproxy:create-token', name, expiresAt),
    revokeToken: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('credproxy:revoke-token', id),
    tokenValue: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('credproxy:token-value', id),
    token: (): Promise<{ ok: boolean; token?: string; error?: string }> =>
      ipcRenderer.invoke('credproxy:token'),
    rotateToken: (): Promise<{ ok: boolean; token?: string; error?: string }> =>
      ipcRenderer.invoke('credproxy:rotate-token')
  },
  // The durable side of alerting — roadmap item 19b.
  //
  // Two methods, both named. `record` writes one raise or resolve; `history`
  // reads the log newest-first. There is no filter or query argument on
  // purpose: the history store's rule is that no SQL crosses its boundary, and
  // a general read surface here would be the first step to losing it.
  alerts: {
    record: (event: StoredAlertEvent, at?: number): Promise<boolean> =>
      ipcRenderer.invoke('alerts:record', event, at),
    history: (limit?: number): Promise<StoredAlertRow[]> => ipcRenderer.invoke('alerts:history', limit),
    // Item 18's database verdicts, which item 19b alerts on and does not
    // recompute. A separate named read rather than a filter argument on
    // `history`: the store's rule is named statements only, and "let the caller
    // say which kind" is the first step of the query surface that rule exists
    // to refuse.
    dbEvents: (limit?: number): Promise<StoredDbAlertRow[]> =>
      ipcRenderer.invoke('alerts:db-events', limit)
  },
  // Roadmap item 26. One method, taking a host and a window and nothing else,
  // for the same reason `alerts` above has no filter argument: a general read
  // surface here is the first step to losing the history store's rule that no
  // SQL crosses its boundary. `satisfies CapacityBridge` so a channel added to
  // the contract and forgotten here is a compile error rather than a method the
  // panel calls at runtime and finds undefined.
  capacity: {
    trends: (hostId: string, windowDays: number): Promise<CapacityReport | null> =>
      ipcRenderer.invoke('capacity:trends', hostId, windowDays),
    dbGrowth: (
      connectionId: string,
      windowDays: number,
      ceilingBytes?: number
    ): Promise<BytesReading | null> =>
      ipcRenderer.invoke('capacity:db-growth', connectionId, windowDays, ceilingBytes)
  } satisfies CapacityBridge,
  // Roadmap item 27. Four channels and deliberately no fifth: there is no
  // `run` and no `test`, because a button that fired a rule on demand would be
  // a way to run a pinned job without the dialog that pins it.
  //
  // `create` carries a `CommandApproval` the panel minted with
  // `jobApprovalFor`, exactly as `jobs.run` does, and the preload does not
  // check it for the same reason: main re-derives `planJob` over that very spec
  // and target list — at creation AND at every firing — so a caller that forges
  // or omits one gets a refusal rather than a rule. Verifying here as well
  // would be a second copy of the rule in the one place with no more
  // information than the sender.
  //
  // `satisfies RulesBridge` so a channel added to the contract and forgotten
  // here is a compile error rather than a method the panel calls at runtime and
  // finds undefined.
  rules: {
    list: (): Promise<RuleView[]> => ipcRenderer.invoke('rules:list'),
    create: (draft: RuleDraftWire): Promise<RuleView | null> =>
      ipcRenderer.invoke('rules:create', draft),
    setEnabled: (id: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('rules:enable', id, enabled),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('rules:remove', id)
  } satisfies RulesBridge,
  // Roadmap item 1 — supervised LOCAL processes.
  //
  // Eight channels and no subscription, deliberately. A crash-looping process
  // writes as fast as the OS will let it, and a push channel would repaint the
  // renderer at that rate: the ring in main is bounded, but a stream out of a
  // bounded ring is not. The panel polls and asks for one capped page, so the
  // cost of a process that has lost its mind is fixed rather than emergent.
  //
  // `list` returns keys and sources for the environment and NEVER a value —
  // main does not send one, literal or resolved. Editing a value is "replace
  // this one", which needs no read.
  //
  // `satisfies ProcessesBridge` so a channel added to the contract and
  // forgotten here is a compile error rather than a method the panel calls at
  // runtime and finds undefined.
  processes: {
    list: (): Promise<ManagedProcessView[]> => ipcRenderer.invoke('processes:list'),
    status: (): Promise<ProcessStatus[]> => ipcRenderer.invoke('processes:status'),
    create: (draft: ProcessDraft): Promise<ManagedProcessView | null> =>
      ipcRenderer.invoke('processes:create', draft),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('processes:remove', id),
    start: (id: string): Promise<ProcessStatus | null> =>
      ipcRenderer.invoke('processes:start', id),
    stop: (id: string): Promise<ProcessStatus | null> => ipcRenderer.invoke('processes:stop', id),
    restart: (id: string): Promise<ProcessStatus | null> =>
      ipcRenderer.invoke('processes:restart', id),
    logs: (id: string, limit?: number): Promise<ProcessLogLine[]> =>
      ipcRenderer.invoke('processes:logs', id, limit)
  } satisfies ProcessesBridge,
  // Roadmap item 14. One method, taking a filter and returning a page, for the
  // reason `capacity` above has one: the merge, the ordering, the redaction and
  // the per-source budget all live in main, and what crosses is the ANSWER.
  //
  // There is no write beside it and there will not be one: this is a reader
  // over four append-only records, and a change log that can be edited is not
  // a change log. `satisfies ChangeLogBridge` so a method added to the contract
  // and forgotten here is a compile error rather than something the panel finds
  // undefined at runtime.
  changelog: {
    read: (filter?: ChangeLogFilter): Promise<ChangeLogPage> =>
      ipcRenderer.invoke('changelog:read', filter)
  } satisfies ChangeLogBridge,
  // Roadmap item 28. Two channels, and the third one people ask for is the
  // point of the item: there is no `run`, because a button that repeats what
  // we did last time is how an outage gets repeated deliberately. The commands
  // this returns were the right answer to a DIFFERENT incident; running one is
  // a job, with a plan and an approval, started the ordinary way.
  //
  // `read` takes a kind and a host and nothing else — no filter, no range, no
  // ordering — for the reason `alerts` and `capacity` above take none: the
  // history store's rule is named statements only, and "let the caller narrow
  // it" is the first step of the query surface that rule exists to refuse.
  runbooks: {
    read: (kind: StoreAlertKind, hostId: string | null): Promise<RunbookView> =>
      ipcRenderer.invoke('runbook:read', kind, hostId),
    saveNote: (
      kind: StoreAlertKind,
      hostId: string | null,
      text: string
    ): Promise<{ ok: boolean; note: RunbookNote | null }> =>
      ipcRenderer.invoke('runbook:save-note', kind, hostId, text)
  } satisfies RunbooksBridge,
  k8s: {
    read: (cfg: OnDemandTarget, context?: string, namespace?: string): Promise<K8sProbe> =>
      ipcRenderer.invoke('k8s:read', cfg, context, namespace),
    logs: (
      cfg: unknown,
      namespace: string,
      pod: string,
      lines: number,
      context?: string
    ): Promise<{ ok: boolean; output: string; error?: string }> =>
      ipcRenderer.invoke('k8s:logs', cfg, namespace, pod, lines, context),
    // Deliberately no `previous` argument on `logs`. An unwired handler would
    // ignore the extra parameter and return CURRENT logs under a "previous"
    // label, which is worse than not offering it. Previous-container logs reach
    // the panel only through `diagnose`, where the section marker comes from
    // the command itself.
    diagnose: (
      cfg: unknown,
      namespace: string,
      pod: string,
      context?: string,
      previousLines?: number
    ): Promise<K8sDiagnosis> =>
      ipcRenderer.invoke('k8s:diagnose', cfg, namespace, pod, context, previousLines),
    overview: (cfg: unknown, context?: string, namespace?: string): Promise<K8sOverview> =>
      ipcRenderer.invoke('k8s:overview', cfg, context, namespace),
    usage: (cfg: unknown, context?: string, namespace?: string): Promise<K8sUsage> =>
      ipcRenderer.invoke('k8s:usage', cfg, context, namespace),
    /** Takes NO namespace: a node's load is every pod on it, whatever namespace
     *  the operator is looking at. See the command builder. */
    allocatable: (cfg: unknown, context?: string): Promise<K8sAllocatableProbe> =>
      ipcRenderer.invoke('k8s:allocatable', cfg, context),
    rolloutRestart: (
      cfg: unknown,
      target: K8sRolloutTarget,
      confirmed: boolean
    ): Promise<K8sRolloutResult> =>
      ipcRenderer.invoke('k8s:rollout-restart', cfg, target, confirmed),
    cordon: (
      cfg: unknown,
      target: K8sCordonTarget,
      confirmed: boolean
    ): Promise<K8sCordonResult> => ipcRenderer.invoke('k8s:cordon', cfg, target, confirmed),
    drainPreflight: (
      cfg: unknown,
      node: string,
      context?: string
    ): Promise<K8sDrainAssessment> => ipcRenderer.invoke('k8s:drain-preflight', cfg, node, context),
    drain: (
      cfg: unknown,
      node: string,
      context: string | undefined,
      confirmed: boolean
    ): Promise<K8sDrainResult & { plan?: K8sDrainPlan }> =>
      ipcRenderer.invoke('k8s:drain', cfg, node, context, confirmed),
    // Two calls on purpose. The plan call returns the exact command string the
    // approval must be minted against, so the renderer cannot approve one
    // thing and send another — `verifyApproval` in the main process compares
    // them and refuses when they differ.
    resources: (cfg: unknown, context?: string, namespace?: string): Promise<K8sResources> =>
      ipcRenderer.invoke('k8s:resources', cfg, context, namespace),
    apiScan: (cfg: unknown, context?: string): Promise<K8sApiScan> =>
      ipcRenderer.invoke('k8s:api-scan', cfg, context),
    review: (cfg: unknown, context?: string): Promise<K8sReviewProbe> =>
      ipcRenderer.invoke('k8s:review', cfg, context),
    helm: (cfg: unknown, context?: string): Promise<K8sHelmList> =>
      ipcRenderer.invoke('k8s:helm', cfg, context),
    execPlan: (target: K8sExecTarget): Promise<{ plan: K8sExecPlan; command: string }> =>
      ipcRenderer.invoke('k8s:exec-plan', target),
    exec: (cfg: unknown, target: K8sExecTarget, approval: unknown): Promise<K8sExecResult> =>
      ipcRenderer.invoke('k8s:exec', cfg, target, approval)
  },
  // `satisfies DockerBridge` so a channel added to the contract and forgotten
  // here is a compile error rather than a method the panel calls at runtime and
  // finds undefined.
  docker: {
    list: (cfg: unknown, opts?: { sudo?: boolean; autoSudo?: boolean }): Promise<DockerProbe> =>
      ipcRenderer.invoke('docker:list', cfg, opts),
    canSudo: (cfg: unknown): Promise<boolean> => ipcRenderer.invoke('docker:can-sudo', cfg),
    logs: (
      cfg: unknown,
      ref: string,
      lines: number,
      opts?: DockerLogsOptions
    ): Promise<{ ok: boolean; output: string; error?: string }> =>
      ipcRenderer.invoke('docker:logs', cfg, ref, lines, opts),
    disk: (cfg: unknown, opts?: { sudo?: boolean; autoSudo?: boolean }): Promise<DockerDiskProbe> =>
      ipcRenderer.invoke('docker:disk', cfg, opts),
    diskDetail: (
      cfg: unknown,
      opts?: { sudo?: boolean; autoSudo?: boolean }
    ): Promise<DockerDiskDetailProbe> => ipcRenderer.invoke('docker:disk-detail', cfg, opts),
    inspect: (
      cfg: unknown,
      ref: string,
      opts?: { sudo?: boolean; autoSudo?: boolean }
    ): Promise<DockerInspectProbe> => ipcRenderer.invoke('docker:inspect', cfg, ref, opts),
    scanImage: (cfg: unknown, ref: string): Promise<ImageScanProbe> =>
      ipcRenderer.invoke('docker:scan-image', cfg, ref),
    enginePrecheck: (cfg: unknown, manager: PackageManager): Promise<EnginePrecheckProbe> =>
      ipcRenderer.invoke('docker:engine-precheck', cfg, manager),
    networks: (
      cfg: unknown,
      opts?: { sudo?: boolean; autoSudo?: boolean }
    ): Promise<DockerNetworkProbe> => ipcRenderer.invoke('docker:networks', cfg, opts),
    healthLogs: (
      cfg: unknown,
      refs: string[],
      opts?: { sudo?: boolean; autoSudo?: boolean }
    ): Promise<DockerHealthLogProbe> => ipcRenderer.invoke('docker:health-logs', cfg, refs, opts),
    stats: (
      cfg: unknown,
      refs: string[],
      opts?: { sudo?: boolean; autoSudo?: boolean }
    ): Promise<DockerStatsProbe> => ipcRenderer.invoke('docker:stats', cfg, refs, opts),
    act: (
      cfg: unknown,
      action: DockerAction,
      refs: string[],
      opts?: { sudo?: boolean; timeoutSec?: number }
    ): Promise<DockerActionResult> => ipcRenderer.invoke('docker:act', cfg, action, refs, opts),
    // Removal by id, and the only method here that deletes anything. There is
    // deliberately no `prune` sibling: the objection to prune was that its
    // blast radius is not knowable from the UI offering it, and this takes the
    // blast radius as a literal list.
    reclaim: (
      cfg: unknown,
      items: DockerReclaimItem[],
      opts?: { sudo?: boolean }
    ): Promise<DockerReclaimResult> => ipcRenderer.invoke('docker:reclaim', cfg, items, opts)
  } satisfies DockerBridge,
  // The file half. `satisfies ComposePreloadBridge` for the same reason as above: a
  // channel added to the contract and forgotten here becomes a compile error
  // rather than a method the panel calls and finds undefined.
  //
  // There is no `down`, no `rm` and no `stop` on this bridge, and no channel
  // that returns the contents of an env file. `pull` and `up -d` are absent on
  // purpose too: they are jobs, and they reach the host through the jobs bridge
  // so they inherit its approval record rather than growing a second one.
  compose: {
    list: (
      cfg: unknown,
      opts?: { sudo?: boolean; autoSudo?: boolean; search?: boolean }
    ): Promise<ComposeListProbe> => ipcRenderer.invoke('compose:list', cfg, opts),
    config: (
      cfg: unknown,
      project: ComposeProjectRef,
      opts?: { sudo?: boolean; autoSudo?: boolean }
    ): Promise<ComposeConfigProbe> => ipcRenderer.invoke('compose:config', cfg, project, opts),
    envNames: (
      cfg: unknown,
      paths: string[],
      opts?: { sudo?: boolean; autoSudo?: boolean }
    ): Promise<ComposeEnvProbe> => ipcRenderer.invoke('compose:env-names', cfg, paths, opts),
    readFile: (
      cfg: unknown,
      path: string,
      opts?: { sudo?: boolean }
    ): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke('compose:read-file', cfg, path, opts),
    /**
     * Write one `.env` variable from the vault.
     *
     * TAKES A REFERENCE, NOT A VALUE, and that asymmetry is the point: this
     * function has no parameter that could carry a secret, so the renderer
     * cannot send one even by mistake. Main resolves the entry, writes it, and
     * answers with a line number.
     */
    writeEnvValue: (
      cfg: unknown,
      req: { path: string; name: string; serverId: string },
      ref: {
        vaultEntryId: string
        slot: 'password' | 'privateKey' | 'username' | 'field'
        fieldKey?: string
      },
      opts?: { sudo?: boolean }
    ): Promise<ComposeEnvWriteResult> =>
      ipcRenderer.invoke('compose:write-env-value', cfg, req, ref, opts),
    /** Reads the backup beside the file and returns a plan. Writes nothing. */
    planRevert: (
      cfg: unknown,
      req: { path: string; service: string },
      opts?: { sudo?: boolean }
    ): Promise<ComposeRevertPlan> => ipcRenderer.invoke('compose:plan-revert', cfg, req, opts),
    writeImageTag: (
      cfg: unknown,
      req: ComposeImageWriteRequest,
      opts?: { sudo?: boolean }
    ): Promise<ComposeImageWriteResult> =>
      ipcRenderer.invoke('compose:write-image-tag', cfg, req, opts)
  } satisfies ComposePreloadBridge,
  services: {
    collect: (
      targets: { serverId: string; serverName: string; cfg: unknown }[]
    ): Promise<{ serverId: string; serverName: string; reading: UserUnitsReading }[]> =>
      ipcRenderer.invoke('services:collect', targets),
    write: (
      target: { cfg: unknown },
      draft: UnitDraft
    ): Promise<{ ok: boolean; output?: string; error?: string }> =>
      ipcRenderer.invoke('services:write', target, draft)
  },
  cron: {
    collect: (
      targets: { serverId: string; serverName: string; cfg: unknown }[]
    ): Promise<
      {
        serverId: string
        serverName: string
        entries: CronEntry[]
        unparsed: number
        sources?: CronSourceReport[]
        error?: string
      }[]
    > => ipcRenderer.invoke('cron:collect', targets),
    // Kept beside `collect` rather than in a namespace of its own, because the
    // panel checks for these at runtime: a main process that has not been
    // taught the channels answers nothing, and an edit button that does nothing
    // is worse than no edit button.
    planEdit: (
      target: { serverId: string; serverName: string; cfg: unknown },
      edit: unknown,
      opts?: unknown
    ): Promise<unknown> => ipcRenderer.invoke('cron:plan-edit', target, edit, opts),
    write: (
      target: { serverId: string; serverName: string; cfg: unknown },
      req: { before: string; after: string; token: string; runId: string; approval?: unknown }
    ): Promise<unknown> => ipcRenderer.invoke('cron:write-edit', target, req)
  },
  logtail: {
    start: (
      tailId: string,
      source: LogSource,
      targets: { serverId: string; serverName: string; cfg: unknown }[]
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('logtail:start', tailId, source, targets),
    stop: (tailId: string): Promise<boolean> => ipcRenderer.invoke('logtail:stop', tailId),
    units: (cfg: unknown): Promise<{ ok: boolean; units: UnitChoice[]; error?: string }> =>
      ipcRenderer.invoke('logtail:units', cfg),
    logfiles: (cfg: unknown): Promise<{ ok: boolean; files: string[]; error?: string }> =>
      ipcRenderer.invoke('logtail:logfiles', cfg),
    pause: (tailId: string): Promise<boolean> => ipcRenderer.invoke('logtail:pause', tailId),
    resume: (tailId: string): Promise<boolean> => ipcRenderer.invoke('logtail:resume', tailId),
    onLine: (fn: (l: LogLine) => void): (() => void) => {
      const h = (_e: unknown, l: LogLine): void => fn(l)
      ipcRenderer.on('logtail:line', h)
      return () => ipcRenderer.removeListener('logtail:line', h)
    },
    onState: (fn: (s: LogTailState) => void): (() => void) => {
      const h = (_e: unknown, s: LogTailState): void => fn(s)
      ipcRenderer.on('logtail:state', h)
      return () => ipcRenderer.removeListener('logtail:state', h)
    }
  },
  broadcast: {
    run: (req: BroadcastRequest): Promise<BroadcastHostResult[]> => ipcRenderer.invoke('broadcast:run', req),
    cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('broadcast:cancel', runId),
    onProgress: (fn: (p: BroadcastProgress) => void): (() => void) => {
      const h = (_e: unknown, p: BroadcastProgress): void => fn(p)
      ipcRenderer.on('broadcast:progress', h)
      return () => ipcRenderer.removeListener('broadcast:progress', h)
    }
  },
  // Roadmap item B1. A broadcast that outlives its panel: the row is in the
  // store before the first host is touched, so closing the window loses the
  // view and not the record.
  //
  // Annotated against JobsBridge rather than left to `typeof api` to infer.
  // Main and the preload are two halves of one interface and nothing else
  // checks that they agree: a handler added in one and forgotten in the other
  // is `undefined is not a function` the first time someone presses the button,
  // in a packaged app, with no stack worth reading. With the annotation it is a
  // compile error in both directions — a missing method fails to satisfy the
  // interface, an extra one is an excess property.
  jobs: jobsBridge,
  // Background sampling of the whole estate, scheduled in main so it continues
  // when the monitor is not on screen. `metrics` above is the foreground path:
  // one server, fast cadence, driven by a mounted card.
  fleet: {
    configure: (cfg: FleetSamplerConfig): Promise<FleetSamplerStatus> =>
      ipcRenderer.invoke('fleet:configure', cfg),
    status: (): Promise<FleetSamplerStatus> => ipcRenderer.invoke('fleet:status'),
    sampleNow: (): Promise<FleetSamplerStatus> => ipcRenderer.invoke('fleet:sample-now'),
    /** Collect now, ignoring the hourly schedules. What "Check now" means. */
    collectNow: (serverIds?: string[]): Promise<FleetCollectResult> =>
      ipcRenderer.invoke('fleet:collect-now', serverIds),
    // Host facts as the sampler last collected them — roadmap item C. Read-only
    // and never a trigger: `at` is when the collection happened and is normally
    // much older than a metrics sample, because facts are collected hourly.
    // `error` is set independently of the metrics error, since a host can
    // answer a metrics sample perfectly and still refuse this probe.
    facts: (
      serverId: string
    ): Promise<{ facts?: HostFacts; at?: number; error?: string; errorAt?: number; intervalMs: number }> =>
      ipcRenderer.invoke('fleet:facts', serverId),
    // The security-update LIST, asked for rather than sampled: the counts come
    // with `facts` every hour, and this is the tens of rows behind them.
    securityList: (cfg: OnDemandTarget): Promise<SecurityListProbe> =>
      ipcRenderer.invoke('fleet:security-list', cfg),
    /** Running vs installed kernels. Asked for, not sampled. */
    kernel: (cfg: OnDemandTarget): Promise<KernelStatus | { error: string }> =>
      ipcRenderer.invoke('fleet:kernel', cfg),
    /** Disks, filesystems, LVM, software RAID. Asked for, not sampled. */
    storage: (cfg: OnDemandTarget): Promise<StorageLayout | { error: string }> =>
      ipcRenderer.invoke('fleet:storage', cfg),
    /** Interfaces with their IPv4/IPv6 addresses, and the resolvers in use. */
    network: (cfg: OnDemandTarget): Promise<NetworkInfo | { error: string }> =>
      ipcRenderer.invoke('fleet:network', cfg),
    /** Listening TCP/UDP sockets, with the owning process where visible. */
    listeningPorts: (cfg: OnDemandTarget): Promise<ListeningPortsInfo | { error: string }> =>
      ipcRenderer.invoke('fleet:listening-ports', cfg),
    /** One timer and the service it activates. Both, because a timer that fires
     *  into a failing service looks healthy from the timer alone. */
    timer: (
      cfg: OnDemandTarget,
      timerUnit: string,
      serviceUnit: string
    ): Promise<{ timer: Record<string, string>; service: Record<string, string> } | { error: string }> =>
      ipcRenderer.invoke('fleet:timer', cfg, timerUnit, serviceUnit),
    // Who can get into a server, as the sampler last collected it — roadmap
    // item 23. Read-only and never a trigger, exactly like `facts`.
    //
    // `access` absent with no `error` means the probe has not run for this
    // server yet. That is a THIRD state, distinct from both "collected, and it
    // trusts no keys" and "the collection failed", and the panel has to keep it
    // distinct — a host nobody has looked at is not a host with no keys.
    access: (
      serverId: string
    ): Promise<{ access?: HostAccess; at?: number; error?: string; errorAt?: number; intervalMs: number }> =>
      ipcRenderer.invoke('fleet:access', serverId),
    // A server's security posture, as the sampler last collected it — roadmap
    // item 24. Read-only and never a trigger, exactly like `facts` and
    // `access`, and with the same third state: `posture` absent with no `error`
    // means the probe has not run for this server yet. A host nobody has looked
    // at is not a host with no firewall, and the panel keeps the two apart.
    //
    // There is no write beside this and there is not going to be one casually.
    // src/shared/posture.ts states the refusal in full: every button this
    // panel could grow — `ufw enable`, `setenforce`, an sshd_config edit — can
    // lock the operator out of the host they would use to undo it, with none
    // of the dead-man's switch that earns `accessRun` its place above.
    posture: (
      serverId: string
    ): Promise<{ posture?: HostPosture; at?: number; error?: string; errorAt?: number; intervalMs: number }> =>
      ipcRenderer.invoke('fleet:posture', serverId),
    /**
     * The same reading for THIS machine, taken now.
     *
     * Takes no target on purpose: it cannot be pointed at a server, so it
     * cannot become a second way to probe one outside the sampler's cadence.
     * Nothing it returns is cached or persisted — see the handler.
     */
    postureLocal: (): Promise<
      { ok: true; posture: HostPosture } | { ok: false; reason: string; detail: string }
    > => ipcRenderer.invoke('fleet:posture-local'),
    driftLocal: (
      ctx?: { hostname?: string; serverName?: string }
    ): Promise<{ ok: true; drift: HostDrift } | { ok: false; reason: string; detail: string }> =>
      ipcRenderer.invoke('fleet:drift-local', ctx ?? {}),
    // A server's watched configuration files, as the sampler last collected
    // them — roadmap item 25. Read-only and never a trigger, exactly like
    // `facts`, `access` and `posture`, and with the same third state: `drift`
    // absent with no `error` means the probe has not run for this server yet.
    // A host nobody has looked at is not a host whose configuration matches
    // everybody else's, and the comparison keeps the two apart.
    //
    // Each reading carries two hashes and a BOUNDED, ALREADY-REDACTED preview.
    // The preview lives in the sampler's memory and nowhere else — it is not in
    // the durable store and does not survive a restart.
    //
    // There is no write beside this and there is not going to be one.
    // src/shared/drift.ts states the refusal in full: bringing a host into line
    // is a job, and it goes through the plan and the approval a job carries.
    // This panel could not decide which side is right in any case — a host that
    // was fixed first and a host that drifted look identical from here.
    drift: (
      serverId: string
    ): Promise<{ drift?: HostDrift; at?: number; error?: string; errorAt?: number; intervalMs: number }> =>
      ipcRenderer.invoke('fleet:drift', serverId),
    // Changing who can get in — roadmap item 23, the write half.
    //
    // TWO CALLS AND NOT ONE, on purpose. `accessPlan` asks main what a change
    // would do and what it refuses to do; `accessRun` carries back the command
    // text the operator was shown, and main will not touch a host unless that
    // matches what it derives for itself. A single "revoke this key" call would
    // have nothing to compare, which is precisely the state broadcast was in
    // before B3.
    //
    // `accessRun` is a WRITE and the only one on this bridge that edits an
    // authorized_keys file. It stages behind the host's own rollback and
    // confirms over a session that authenticated afterwards; a host that never
    // gets that confirmation puts its previous file back by itself. The three
    // outcomes it can report are not two — see AccessCommitOutcome.
    accessPlan: (
      req: Omit<AccessRunRequest, 'token' | 'confirmedCommand'>
    ): Promise<AccessChangePreview> => ipcRenderer.invoke('access:plan', req),
    accessRun: (req: AccessRunRequest): Promise<AccessRunResult> =>
      ipcRenderer.invoke('access:run', req),
    onSample: (cb: (event: FleetSampleEvent) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, event: FleetSampleEvent): void => cb(event)
      ipcRenderer.on('fleet:sample', h)
      return () => ipcRenderer.removeListener('fleet:sample', h)
    },
    /**
     * How far the running sweep has got. Separate from `onSample` because it
     * fires BEFORE each server is asked rather than after it answers — which
     * is the difference between naming the host a check is waiting on and
     * naming the one it has already finished with.
     */
    onProgress: (cb: (p: FleetSweepProgress) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: FleetSweepProgress): void => cb(p)
      ipcRenderer.on('fleet:progress', h)
      return () => ipcRenderer.removeListener('fleet:progress', h)
    }
  },
  db: {
    test: (cfg: DbConnectConfig): Promise<DbTestResult> => ipcRenderer.invoke('db:test', cfg),
    query: (cfg: DbConnectConfig, text: string): Promise<DbQueryResult> =>
      ipcRenderer.invoke('db:query', cfg, text),
    info: (cfg: DbConnectConfig): Promise<DbInfo> => ipcRenderer.invoke('db:info', cfg),
    shell: (cfg: DbConnectConfig, line: string): Promise<DbShellResult> =>
      ipcRenderer.invoke('db:shell', cfg, line),
    close: (id: string): Promise<void> => ipcRenderer.invoke('db:close', id),
    // Read-only operational answers for PostgreSQL and MySQL/MariaDB. There is
    // no write counterpart and there is not meant to be one.
    ops: (cfg: DbConnectConfig): Promise<DbOpsReport> => ipcRenderer.invoke('db:ops', cfg),
    /**
     * The size sampler's desired state, and what it is doing.
     *
     * These handlers have existed in main since the sampler was written and
     * had no bridge and no caller, so the sampler never ran at all — every
     * database size series was empty and nothing said why. The renderer owns
     * the connection list, so it is the only thing that can say what to sample.
     *
     * `targets` carry a resolved config and NO credential: main looks one up by
     * the record's id, which is what keeps every password on that side.
     */
    samplerConfigure: (cfg: {
      enabled: boolean
      targets: { connectionId: string; cfg: DbConnectConfig }[]
      intervalMs: number
    }): Promise<unknown> => ipcRenderer.invoke('db:sampler-configure', cfg),
    samplerStatus: (): Promise<unknown> => ipcRenderer.invoke('db:sampler-status')
  },
  notify: {
    show: (title: string, body: string): Promise<boolean> =>
      ipcRenderer.invoke('notify:show', title, body)
  },
  backup: {
    export: (password: string): Promise<BackupResult> => ipcRenderer.invoke('backup:export', password),
    inspect: (password: string, path?: string): Promise<BackupResult> =>
      ipcRenderer.invoke('backup:inspect', password, path),
    import: (password: string, path: string): Promise<BackupResult> =>
      ipcRenderer.invoke('backup:import', password, path),
    deleteAll: (): Promise<BackupResult> => ipcRenderer.invoke('backup:deleteAll'),
    /**
     * A backup was written to a destination — scheduled, or by the Run button.
     *
     * The renderer keeps the "a current backup exists" flag, and only the
     * manual export could lower it. A scheduled run had no way to say it had
     * just made one, so setting up automatic backups left the warning on
     * forever. This is how an unattended run reports itself.
     */
    onRan: (cb: (info: { at: string; destination: string }) => void): (() => void) => {
      const h = (_e: unknown, info: { at: string; destination: string }): void => cb(info)
      ipcRenderer.on('backup:ran', h)
      return () => ipcRenderer.removeListener('backup:ran', h)
    },
    /**
     * A scheduled run was due and could not be attempted.
     *
     * Distinct from a failed run: nothing was tried and nothing is broken. The
     * status bar says so because a backup that has quietly stopped is the one
     * state this feature can least afford to keep to itself.
     */
    onSkipped: (
      cb: (info: { destinationId: string; destinationName: string; reason: string }) => void
    ): (() => void) => {
      const h = (
        _e: unknown,
        info: { destinationId: string; destinationName: string; reason: string }
      ): void => cb(info)
      ipcRenderer.on('backup:skipped', h)
      return () => ipcRenderer.removeListener('backup:skipped', h)
    },
    relaunch: (): Promise<void> => ipcRenderer.invoke('backup:relaunch'),
    // Destinations. Note what is NOT here: no credential, in either direction.
    // An SFTP destination names a saved server and an S3 one names a vault
    // entry, and main resolves both — so the renderer can configure where the
    // vault gets uploaded without ever holding the key to the place it lands.
    destinations: (): Promise<BackupTargetsFile> => ipcRenderer.invoke('backup:destinations'),
    /**
     * Keep a destination's unattended passphrase on this machine, or clear it.
     *
     * Write-only on purpose. Nothing reads one back across this bridge — the
     * panel asks only WHETHER one is set — because a channel that returned it
     * would put the passphrase back in the window, which is precisely what
     * keeping it in the OS keychain is for.
     */
    setMachinePassphrase: (id: string, passphrase: string | null): Promise<BackupResult> =>
      ipcRenderer.invoke('backup:setMachinePassphrase', id, passphrase),
    hasMachinePassphrase: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('backup:hasMachinePassphrase', id),
    alarms: (): Promise<BackupAlarm[]> => ipcRenderer.invoke('backup:alarms'),
    saveDestinations: (destinations: BackupDestination[]): Promise<BackupTargetsFile> =>
      ipcRenderer.invoke('backup:saveDestinations', destinations),
    runDestination: (id: string, password: string): Promise<BackupRunReport> =>
      ipcRenderer.invoke('backup:runDestination', id, password),
    listRemote: (id: string): Promise<RemoteListResult> => ipcRenderer.invoke('backup:listRemote', id),
    inspectRemote: (id: string, name: string, password: string): Promise<BackupResult> =>
      ipcRenderer.invoke('backup:inspectRemote', id, name, password),
    discardStaged: (path: string): Promise<void> => ipcRenderer.invoke('backup:discardStaged', path),
    chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('backup:chooseDirectory'),
    dumpableDatabases: (): Promise<{ id: string; name: string; engine: DumpEngine }[]> =>
      ipcRenderer.invoke('backup:dumpableDatabases'),
    dumpDatabase: (destinationId: string, databaseId: string): Promise<DumpRunReport> =>
      ipcRenderer.invoke('backup:dumpDatabase', destinationId, databaseId)
  },
  updater: {
    check: (): Promise<void> => ipcRenderer.invoke('updater:check'),
    status: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updater:status'),
    install: (): Promise<void> => ipcRenderer.invoke('updater:install'),
    openReleasePage: (): Promise<void> => ipcRenderer.invoke('updater:openReleasePage'),
    download: (): Promise<void> => ipcRenderer.invoke('updater:download'),
    getPrefs: (): Promise<UpdatePrefs> => ipcRenderer.invoke('updater:getPrefs'),
    setPrefs: (patch: Partial<UpdatePrefs>): Promise<UpdatePrefs> =>
      ipcRenderer.invoke('updater:setPrefs', patch),
    capabilities: (): Promise<UpdaterCapabilities> => ipcRenderer.invoke('updater:capabilities'),
    onStatus: (cb: (s: UpdaterStatus) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, s: UpdaterStatus): void => cb(s)
      ipcRenderer.on('updater:status-event', h)
      return () => ipcRenderer.removeListener('updater:status-event', h)
    }
  },
  sshConfig: {
    read: (): Promise<{ ok: boolean; path: string; hosts?: SshConfigHost[]; error?: string }> =>
      ipcRenderer.invoke('sshconfig:read')
  },
  knownHosts: {
    list: (): Promise<KnownHost[]> => ipcRenderer.invoke('knownhosts:list'),
    forget: (id: string): Promise<void> => ipcRenderer.invoke('knownhosts:forget', id)
  },
  // Remote desktop. Deliberately two calls and no more: main mints a ticket
  // for one saved server, and the renderer connects with it. There is no
  // "connect to host" here, because a renderer that could name a destination
  // could use the loopback relay to reach anything this machine can.
  rdp: {
    /**
     * Ask main for a one-shot ticket to this server's desktop.
     *
     * The result carries the password, because the CredSSP exchange happens
     * inside the WASM client in the renderer and there is nowhere else for it
     * to happen. What the renderer cannot do is choose whose password it is.
     */
    ticket: (serverId: string, size?: RdpDesktopSize): Promise<RdpTicketResult> =>
      ipcRenderer.invoke('rdp:ticket', serverId, size),
    /** Why the relay's last attempt on this server failed, or null. The error
     *  PDU the WASM client reports carries an integer and an HTTP status, so
     *  this is the only place the actual reason exists. */
    lastError: (serverId: string): Promise<string | null> =>
      ipcRenderer.invoke('rdp:lastError', serverId)
  },
  tunnel: {
    start: (cfg: TunnelConfig, ssh: TunnelSshConfig): Promise<TunnelResult> =>
      ipcRenderer.invoke('tunnel:start', cfg, ssh),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('tunnel:stop', id),
    list: (): Promise<TunnelStatus[]> => ipcRenderer.invoke('tunnel:list'),
    onStatus: (id: string, cb: (s: TunnelStatus) => void): (() => void) => {
      const ch = `tunnel:status:${id}`
      const h = (_e: IpcRendererEvent, s: TunnelStatus): void => cb(s)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    }
  },
  vpn: {
    list: (): Promise<VpnStatus[]> => ipcRenderer.invoke('vpn:list'),
    start: (id: string): Promise<VpnStartResult> => ipcRenderer.invoke('vpn:start', id),
    // Returns the result rather than discarding it: a stop can fail (an engine
    // that will not exit), and a caller that cannot see that will cheerfully
    // report "stopped" over the top of an error.
    stop: (id: string, force = false): Promise<VpnResult> =>
      ipcRenderer.invoke('vpn:stop', id, force),
    reload: (id: string): Promise<VpnResult> => ipcRenderer.invoke('vpn:reload', id),
    validate: (spec: VpnSpec): Promise<VpnValidation> => ipcRenderer.invoke('vpn:validate', spec),
    probe: (kind: VpnKind): Promise<VpnEngineInfo> => ipcRenderer.invoke('vpn:probe', kind),
    // Returns vault refs, never key material: the main-process handler stores
    // the secrets and hands back pointers.
    import: (kind: VpnKind, text: string, baseDir?: string): Promise<VpnImportResult> =>
      ipcRenderer.invoke('vpn:import', kind, text, baseDir),
    // The profile's secrets, staged into the vault. Called once when a profile
    // is created from an import.
    commitImport: (
      profileName: string,
      workspaceId: string,
      kind: VpnKind,
      text: string,
      baseDir?: string
    ): Promise<{ ok: boolean; error?: string; spec?: VpnSpec; vaultEntryId?: string }> =>
      ipcRenderer.invoke('vpn:commitImport', profileName, workspaceId, kind, text, baseDir),
    logs: (id: string, limit?: number): Promise<VpnLogLine[]> =>
      ipcRenderer.invoke('vpn:logs', id, limit),
    /** Probe a running tunnel from the inside. The host and port are the
     *  operator's; there is no default, and a probe with neither still reports
     *  the handshake. */
    diagnose: (
      id: string,
      target: VpnDiagnoseTarget
    ): Promise<VpnDiagnoseResult | VpnDiagnoseRefusal> =>
      ipcRenderer.invoke('vpn:diagnose', id, target),
    dependents: (id: string): Promise<VpnDependent[]> => ipcRenderer.invoke('vpn:dependents', id),
    // A WireGuard keypair, stored the same way an imported one is: the main
    // handler puts the private key in the vault and hands back a ref. The key
    // itself comes back too, so the user can reveal and copy the one they just
    // made — nothing persists it, and `privateKeyRef` is the only part that
    // goes on the profile.
    //
    // Store a key in the vault and hand back the ref the profile carries.
    //
    // `privateKey` is required: this channel no longer mints. Minting moved to
    // `wireguardMint` below so that generating a key and cancelling the form
    // leaves nothing behind, which means every call here is a deliberate write.
    // `replaces` is the entry this profile pointed at before, released once the
    // new one is safely written.
    wireguardKeygen: (req: {
      profileName: string
      workspaceId: string
      privateKey: string
      replaces?: string
    }): Promise<VpnKeygenResult> => ipcRenderer.invoke('vpn:wireguardKeygen', req),
    // Mint a keypair and store nothing. Separate from `wireguardKeygen` above
    // because that one writes to the vault: the form generates through this,
    // holds the pair, and stages it through the other only on Save — so
    // cancelling a dialog leaves no entry behind.
    wireguardMint: (): Promise<VpnMintResult> => ipcRenderer.invoke('vpn:wireguardMint'),
    // `wg pubkey`. No vault write and no side effect, so it is safe to call
    // while the user is still typing a key in.
    wireguardPublicKey: (privateKey: string): Promise<VpnPublicKeyResult> =>
      ipcRenderer.invoke('vpn:wireguardPublicKey', privateKey),
    // The frp server token the guided tunnel setup collects. Writes to the
    // vault and returns a ref; the token itself never comes back, and the
    // renderer holds it only for as long as the setup form is open.
    frpToken: (req: {
      profileName: string
      workspaceId: string
      token: string
      replaces?: string
    }): Promise<FrpTokenResult> => ipcRenderer.invoke('vpn:frpToken', req),
    // Called when a profile is deleted. The profile itself lives in the
    // renderer's data blob, but its key material lives in the vault and would
    // otherwise be orphaned there with no UI pointing at it.
    deleteSecrets: (vaultEntryId: string): Promise<void> =>
      ipcRenderer.invoke('vpn:deleteSecrets', vaultEntryId),
    // Read-only. Profiles are persisted by the renderer as part of the ordinary
    // `data:save` blob, exactly like servers and tunnels — a second writer for
    // the same JSON file is how that file gets corrupted. This exists so main,
    // the MCP tools and the CLI all read the same list the UI shows, without
    // each re-deriving it.
    profiles: (): Promise<VpnProfile[]> => ipcRenderer.invoke('vpn:profiles'),
    onStatus: (id: string, cb: (s: VpnStatus) => void): (() => void) => {
      const ch = `vpn:status:${id}`
      const h = (_e: IpcRendererEvent, s: VpnStatus): void => cb(s)
      ipcRenderer.on(ch, h)
      return () => ipcRenderer.removeListener(ch, h)
    },
    // Log lines only stream while someone is subscribed; otherwise they stop
    // at the ring buffer in main and the drawer pulls them with logs().
    onLog: (id: string, cb: (l: VpnLogLine) => void): (() => void) => {
      const ch = `vpn:log:${id}`
      const h = (_e: IpcRendererEvent, l: VpnLogLine): void => cb(l)
      ipcRenderer.on(ch, h)
      ipcRenderer.send('vpn:log-subscribe', id)
      return () => {
        ipcRenderer.removeListener(ch, h)
        ipcRenderer.send('vpn:log-unsubscribe', id)
      }
    },
    onPrompt: (cb: (p: VpnPrompt) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: VpnPrompt): void => cb(p)
      ipcRenderer.on('vpn:prompt', h)
      return () => ipcRenderer.removeListener('vpn:prompt', h)
    },
    replyPrompt: (id: string, value: string | null): void =>
      ipcRenderer.send('vpn:prompt-reply', id, value)
  },
  /**
   * The HTTPS traffic inspector.
   *
   * Bodies are the one thing this bridge does NOT hand over wholesale: a flow
   * carries a capped base64 preview and a byte count, and `body()` fetches a
   * page of the rest on demand. A renderer that holds every response it has
   * ever seen works for ten minutes and then takes the window with it.
   */
  inspect: {
    status: (): Promise<InspectStatus> => ipcRenderer.invoke('inspect:status'),
    start: (opts?: InspectStartOptions): Promise<InspectStatus> =>
      ipcRenderer.invoke('inspect:start', opts),
    stop: (): Promise<InspectStatus> => ipcRenderer.invoke('inspect:stop'),
    flows: (limit?: number): Promise<InspectFlow[]> => ipcRenderer.invoke('inspect:flows', limit),
    clear: (): Promise<void> => ipcRenderer.invoke('inspect:clear'),
    body: (
      flowId: string,
      side: 'request' | 'response',
      offset?: number,
      limit?: number
    ): Promise<InspectBodyPage> => ipcRenderer.invoke('inspect:body', flowId, side, offset, limit),
    setPassthrough: (hosts: string[]): Promise<InspectStatus> =>
      ipcRenderer.invoke('inspect:setPassthrough', hosts),
    allowPinned: (host: string): Promise<InspectStatus> =>
      ipcRenderer.invoke('inspect:allowPinned', host),
    ca: (): Promise<InspectCaInfo> => ipcRenderer.invoke('inspect:ca'),
    regenerateCa: (): Promise<InspectCaInfo> => ipcRenderer.invoke('inspect:regenerateCa'),
    forgetCa: (): Promise<void> => ipcRenderer.invoke('inspect:forgetCa'),
    installTrust: (
      store: 'system' | 'nss'
      // `manualCommand` carries the terminal command that finishes the job
      // when every automatic route was refused — see the macOS incident in
      // `src/main/services/inspectTrust.ts`. It has to cross the bridge or the
      // panel has nothing to offer but the button that already failed.
    ): Promise<{ ok: boolean; declined?: boolean; message?: string; manualCommand?: string }> =>
      ipcRenderer.invoke('inspect:installTrust', store),
    removeTrust: (
      store: 'system' | 'nss'
    ): Promise<{ ok: boolean; declined?: boolean; message?: string }> =>
      ipcRenderer.invoke('inspect:removeTrust', store),
    /** The environment a shell needs to be intercepted, for the "copy for my
     *  own terminal" button. Sessions OpsMaxx starts get it applied. */
    env: (): Promise<Record<string, string>> => ipcRenderer.invoke('inspect:env'),
    onFlow: (cb: (f: InspectFlow) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, f: InspectFlow): void => cb(f)
      ipcRenderer.on('inspect:flow', h)
      return () => ipcRenderer.removeListener('inspect:flow', h)
    },
    onStatus: (cb: (s: InspectStatus) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, s: InspectStatus): void => cb(s)
      ipcRenderer.on('inspect:status', h)
      return () => ipcRenderer.removeListener('inspect:status', h)
    },
    onPinned: (cb: (p: InspectPinnedHost) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: InspectPinnedHost): void => cb(p)
      ipcRenderer.on('inspect:pinned', h)
      return () => ipcRenderer.removeListener('inspect:pinned', h)
    },
    onOpaque: (cb: (o: InspectOpaqueTunnel) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, o: InspectOpaqueTunnel): void => cb(o)
      ipcRenderer.on('inspect:opaque', h)
      return () => ipcRenderer.removeListener('inspect:opaque', h)
    },
    onCleared: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on('inspect:cleared', h)
      return () => ipcRenderer.removeListener('inspect:cleared', h)
    }
  },
  /**
   * The vault as NAMES, for a picker.
   *
   * A separate namespace from `vault` on purpose: `vault.list()` returns
   * passwords, `vault` is forbidden to modules, and a names-only method sitting
   * inside it would make the whole namespace legal for them again. See
   * `shared/vaultIndex.ts`.
   */
  vaultIndex: {
    list: (): Promise<VaultIndexResult> => ipcRenderer.invoke('vault-index:list')
  },
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:status'),
    create: (password: string): Promise<VaultResult> => ipcRenderer.invoke('vault:create', password),
    unlock: (password: string): Promise<VaultResult> => ipcRenderer.invoke('vault:unlock', password),
    lock: (): Promise<VaultResult> => ipcRenderer.invoke('vault:lock'),
    list: (): Promise<VaultListResult> => ipcRenderer.invoke('vault:list'),
    save: (entries: VaultEntry[]): Promise<VaultResult> => ipcRenderer.invoke('vault:save', entries),
    changePassword: (current: string, next: string): Promise<VaultResult> =>
      ipcRenderer.invoke('vault:change-password', current, next),
    destroy: (): Promise<VaultResult> => ipcRenderer.invoke('vault:destroy'),
    bioSupport: (): Promise<{ available: boolean; kind: string; reason?: string }> =>
      ipcRenderer.invoke('vault:bio-support'),
    bioEnabled: (): Promise<boolean> => ipcRenderer.invoke('vault:bio-enabled'),
    bioEnable: (scope: 'session' | 'persistent' = 'session'): Promise<VaultResult> =>
      ipcRenderer.invoke('vault:bio-enable', scope),
    bioScope: (): Promise<'session' | 'persistent' | null> => ipcRenderer.invoke('vault:bio-scope'),
    setAutoLock: (minutes: number): Promise<void> => ipcRenderer.invoke('vault:set-auto-lock', minutes),
    onAutoLocked: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on('vault:auto-locked', h)
      return () => ipcRenderer.removeListener('vault:auto-locked', h)
    },
    /**
     * The idle timeout, which now SECURES rather than locks.
     *
     * A separate channel rather than a payload on the one above, because the
     * renderer does the same thing on both — drop every decrypted entry — and
     * says something different about it. "Locked" is a thing the user must
     * undo before anything works again; "secured" is a thing they only notice
     * if they wanted to look at the vault. One channel with a flag would have
     * made every existing subscriber's ignorance of the flag look deliberate.
     */
    onSecured: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on('vault:secured', h)
      return () => ipcRenderer.removeListener('vault:secured', h)
    },
    bioDisable: (): Promise<VaultResult> => ipcRenderer.invoke('vault:bio-disable'),
    bioUnlock: (): Promise<VaultResult> => ipcRenderer.invoke('vault:bio-unlock')
  },
  workspaceLock: {
    ids: (): Promise<string[]> => ipcRenderer.invoke('wslock:ids'),
    verify: (id: string, password: string): Promise<boolean> =>
      ipcRenderer.invoke('wslock:verify', id, password),
    set: (id: string, password: string, current?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('wslock:set', id, password, current),
    remove: (id: string, current: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('wslock:remove', id, current),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('wslock:delete', id)
  },
  secrets: {
    available: (): Promise<boolean> => ipcRenderer.invoke('secrets:available'),
    set: (id: string, value: string): Promise<boolean> => ipcRenderer.invoke('secrets:set', id, value),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('secrets:delete', id)
  },
  data: {
    load: <T>(): Promise<T | null> => ipcRenderer.invoke('data:load'),
    save: (data: unknown): Promise<void> => ipcRenderer.invoke('data:save', data)
  },
  aiPolicy: {
    listGroups: (): Promise<AccessGroup[]> => ipcRenderer.invoke('aiPolicy:listGroups'),
    createGroup: (name: string): Promise<AccessGroup> => ipcRenderer.invoke('aiPolicy:createGroup', name),
    saveGroup: (group: AccessGroup): Promise<AccessGroup> => ipcRenderer.invoke('aiPolicy:saveGroup', group),
    deleteGroup: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('aiPolicy:deleteGroup', id),
    listAssignments: (): Promise<PolicyAssignment[]> => ipcRenderer.invoke('aiPolicy:listAssignments'),
    setAssignment: (scope: PolicyAssignment['scope'], groupId: string | null): Promise<PolicyAssignment> =>
      ipcRenderer.invoke('aiPolicy:setAssignment', scope, groupId),
    removeAssignment: (id: string): Promise<void> => ipcRenderer.invoke('aiPolicy:removeAssignment', id),
    listServerMeta: (): Promise<ServerAiMeta[]> => ipcRenderer.invoke('aiPolicy:listServerMeta'),
    setServerAliases: (serverId: string, aliases: string[]): Promise<ServerAiMeta> =>
      ipcRenderer.invoke('aiPolicy:setServerAliases', serverId, aliases),
    listWorkspaces: (): Promise<{ id: string; name: string }[]> => ipcRenderer.invoke('aiPolicy:listWorkspaces'),
    listServers: (workspaceId?: string): Promise<{ id: string; workspaceId: string; name: string }[]> =>
      ipcRenderer.invoke('aiPolicy:listServers', workspaceId)
  },
  aiMcp: {
    getConfig: (): Promise<McpGlobalConfig> => ipcRenderer.invoke('aiMcp:getConfig'),
    setConfig: (
      patch: Partial<McpGlobalConfig>
    ): Promise<{ config: McpGlobalConfig; error?: string }> => ipcRenderer.invoke('aiMcp:setConfig', patch),
    status: (): Promise<{ running: boolean; port: number | null }> => ipcRenderer.invoke('aiMcp:status'),
    createSession: (input: {
      agentName: string
      workspaces: { id: string; name: string }[]
      groupId: string | null
      groupName: string
      ttlMinutes: number | null
    }): Promise<{ session: McpAgentSession; token: string }> => ipcRenderer.invoke('aiMcp:createSession', input),
    listSessions: (): Promise<McpAgentSession[]> => ipcRenderer.invoke('aiMcp:listSessions'),
    revokeSession: (id: string): Promise<void> => ipcRenderer.invoke('aiMcp:revokeSession', id),
    deleteSession: (id: string): Promise<boolean> => ipcRenderer.invoke('aiMcp:deleteSession', id),
    setSessionGroup: (id: string, groupId: string | null, groupName: string): Promise<McpAgentSession | null> =>
      ipcRenderer.invoke('aiMcp:setSessionGroup', id, groupId, groupName),
    // A client waiting on the OAuth flow. It holds nothing but what is needed to
    // decide: who is asking, and where the browser will be sent back to. The
    // PKCE challenge and the code stay in main.
    listAuthorizations: (): Promise<
      { id: string; clientName: string; redirectUri: string; createdAt: number }[]
    > => ipcRenderer.invoke('aiMcp:listAuthorizations'),
    approveAuthorization: (
      consentId: string,
      grant: { groupId: string; groupName: string; workspaces: { id: string; name: string }[] }
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('aiMcp:approveAuthorization', consentId, grant),
    denyAuthorization: (consentId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('aiMcp:denyAuthorization', consentId),
    explainAccess: (
      sessionId: string,
      serverId: string | null
    ): Promise<
      {
        capability: string
        label: string
        decision: 'allow' | 'ask' | 'deny'
        reason: string
        fromScope: 'allow' | 'ask' | 'deny'
        fromSession: 'allow' | 'ask' | 'deny' | null
        decidedBy: 'scope' | 'session' | 'both'
      }[] | null
    > => ipcRenderer.invoke('aiMcp:explainAccess', sessionId, serverId),
    killAllSessions: (): Promise<{ revoked: number; denied: number }> =>
      ipcRenderer.invoke('aiMcp:killAllSessions'),
    listApprovals: (): Promise<ApprovalRequest[]> => ipcRenderer.invoke('aiMcp:listApprovals'),
    // Resolved ones, for the Approvals page only — never for the modal queue.
    recentApprovals: (): Promise<ApprovalRequest[]> => ipcRenderer.invoke('aiMcp:recentApprovals'),
    respondApproval: (id: string, decision: 'approved' | 'denied'): Promise<boolean> =>
      ipcRenderer.invoke('aiMcp:respondApproval', id, decision),
    // Resolves false when the fuse did NOT move: the request was already
    // answered, the clock already denied it, or the extension ceiling in
    // approvals.ts is spent. The renderer must not treat the call itself as the
    // extension -- the new deadline comes back on the `extended` event below,
    // which is main's timer rather than the renderer's arithmetic.
    extendApproval: (id: string, seconds: number): Promise<boolean> =>
      ipcRenderer.invoke('aiMcp:extendApproval', id, seconds),
    listAudit: (limit?: number): Promise<AuditEntry[]> => ipcRenderer.invoke('aiMcp:listAudit', limit),
    onApprovalEvent: (
      cb: (e: { type: 'created' | 'resolved' | 'extended'; request: ApprovalRequest }) => void
    ): (() => void) => {
      const h = (
        _e: IpcRendererEvent,
        ev: { type: 'created' | 'resolved' | 'extended'; request: ApprovalRequest }
      ): void => cb(ev)
      ipcRenderer.on('ai:approval-event', h)
      return () => ipcRenderer.removeListener('ai:approval-event', h)
    },
    claudeCodeCommand: (token: string, port: number): Promise<string> =>
      ipcRenderer.invoke('aiMcp:claudeCodeCommand', token, port),
    writeClaudeDesktopConfig: (
      token: string,
      port: number
    ): Promise<{ ok: boolean; path: string; backedUpTo?: string; error?: string }> =>
      ipcRenderer.invoke('aiMcp:writeClaudeDesktopConfig', token, port),
    writeCodexConfig: (
      token: string,
      port: number
    ): Promise<{ ok: boolean; path: string; backedUpTo?: string; error?: string }> =>
      ipcRenderer.invoke('aiMcp:writeCodexConfig', token, port),
    onCreateServerRequest: (
      cb: (e: { id: string; request: Record<string, unknown> }) => void
    ): (() => void) => {
      const h = (_e: IpcRendererEvent, ev: { id: string; request: Record<string, unknown> }): void => cb(ev)
      ipcRenderer.on('aiMcp:create-server', h)
      return () => ipcRenderer.removeListener('aiMcp:create-server', h)
    },
    replyCreateServer: (id: string, result: { ok: boolean; serverId?: string; error?: string }): void =>
      ipcRenderer.send('aiMcp:create-server-reply', id, result),
    onConfigWriteRequest: (
      cb: (e: { id: string; request: Record<string, unknown> }) => void
    ): (() => void) => {
      const h = (_e: IpcRendererEvent, ev: { id: string; request: Record<string, unknown> }): void => cb(ev)
      ipcRenderer.on('aiMcp:config-write', h)
      return () => ipcRenderer.removeListener('aiMcp:config-write', h)
    },
    replyConfigWrite: (id: string, result: { ok: boolean; id?: string; error?: string }): void =>
      ipcRenderer.send('aiMcp:config-write-reply', id, result),
    cancelPairing: (id: string): Promise<void> => ipcRenderer.invoke('aiMcp:cancelPairing', id),
    onPairingEvent: (
      cb: (e: { type: 'created' | 'resolved' | 'expired'; request: CliPairingRequest }) => void
    ): (() => void) => {
      const h = (
        _e: IpcRendererEvent,
        ev: { type: 'created' | 'resolved' | 'expired'; request: CliPairingRequest }
      ): void => cb(ev)
      ipcRenderer.on('ai:pairing-event', h)
      return () => ipcRenderer.removeListener('ai:pairing-event', h)
    }
  }
}

contextBridge.exposeInMainWorld('opsmaxx', api)

export type OpsMaxxApi = typeof api
