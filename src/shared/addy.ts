/**
 * The shared contract between OpsMaxx and addy.
 *
 * Collection NAMES are the load-bearing part. A name appears in every sealed
 * object's AAD, so a client writing `servers` and a client reading `Servers`
 * are two clients that cannot sync -- and the failure is an AEAD error rather
 * than anything that says why.
 *
 * `internal/protocol/collections.go` in the addy repo is the other half, and
 * `tests/addyTrustBoundary.test.ts` pins them against each other.
 */

/** Every T0 collection. Sorted, so two implementations enumerate it alike. */
export const SYNCED_COLLECTIONS = [
  'apiCollections',
  'apiWorkspace',
  'cicdConnections',
  'databases',
  /**
   * What the user actually CALLS each device, keyed on its `pub_sign`.
   *
   * It exists because the roster's own label is a BIRTH NAME: entries are
   * immutable and renames are local, so a user who renamed `quiet-otter-41` to
   * "work laptop" two years ago would see the pseudonym on the one screen where
   * recognition matters. Worse, the pseudonym generator does not attempt
   * uniqueness and prescribes renaming as the fix for collisions -- which only
   * happen at scale -- so the user most likely to have renamed is the user with
   * the most devices, and the one for whom re-pairing a machine at another site
   * is most expensive.
   *
   * As a collection rather than a roster operation it costs no protocol change,
   * and the epoch problem solves itself: a rotation already re-seals every T0
   * collection, which is exactly what an immutable chain entry cannot do.
   */
  'deviceNames',
  'env',
  'folders',
  'httpChecks',
  'knownHosts',
  'manifest',
  'monitorGroups',
  'servers',
  'tunnels',
  /**
   * The vault travels as OPAQUE BYTES -- `opsmaxx-vault.json` verbatim, already
   * ciphertext under the user's master password.
   *
   * Nothing in the sync path ever opens it, so `locked`, `secured` and `open`
   * are all irrelevant to syncing, and the recovery phrase is not a skeleton
   * key for it. Two secrets, each doing the job it was designed for.
   */
  'vault',
  'vpns',
  'workspaces',
] as const

export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number]

/**
 * Everything deliberately device-local, with the reason.
 *
 * A REASON IS MANDATORY. "We didn't get to it" and "this must never sync" look
 * identical in a list of names, and only one of them is a decision. Without
 * this list, absence is indistinguishable from "I haven't added one yet" -- a
 * silent failure with no error and no symptom until somebody notices their
 * database connections never reached the second laptop.
 *
 * The entries marked UNDECIDED are the finding rather than the list. A review
 * of this guardrail found it pinned only against `Persisted`, while
 * `ALL_DATA_FILES` -- the authoritative enumeration of what this app writes to
 * disk -- is much longer. Every file that is not a `Persisted` key therefore
 * fell outside the guardrail entirely. They are all classified now, and the six
 * that are genuinely undecided say so, because they are user-authored data
 * currently destroyed on a device wipe with no copy anywhere.
 */
export const NOT_SYNCED: Readonly<Record<string, string>> = {
  tabs: 'per-device window state; syncing it would fight the user on two screens',
  panes: 'per-device window state; syncing it would fight the user on two screens',
  activeTabId: 'per-device window state; syncing it would fight the user on two screens',
  activeWorkspaceId: 'per-device window state; syncing it would fight the user on two screens',
  tabCwd: 'per-device window state; syncing it would fight the user on two screens',
  settings: 'the cosmetic subset is the T2 public profile; the rest is per-device',
  theme: 'carried in the T2 public profile so a new device looks right before pairing',
  version: 'a local on-disk seed marker, not user data',
  // WHICH RELAY THIS MACHINE JOINED, and emphatically not something to sync.
  // It is per-device by construction: the account id is shared, but the TLS
  // pin is this machine's view of the relay and the enrolment date is when
  // THIS device joined. Syncing it would also be circular — it is the note
  // that tells a device how to reach the thing that would carry it.
  addy: 'this device\'s note of which relay it joined; per-device, and the route to sync itself',
  // WHAT THIS MACHINE HAS ALREADY AGREED TO: per collection, the relay ETag it
  // last matched, the highest counter it has seen and a hash of its own copy
  // at that moment. Per-device by definition — it is one device's record of
  // its own history — and syncing it would have every device adopt every other
  // device's idea of what it had already done, which is how a machine that has
  // been off for a week decides it is up to date.
  addySync: 'one device\'s record of what it has already synced; per-device by definition',
  // Files another device SENT to this one, waiting to be collected. They
  // arrived here deliberately, for this machine, and syncing them would send
  // every transfer to every device — which is the opposite of what picking a
  // recipient meant.
  addyTransfers: 'files sent to this device in particular; syncing them would undo the choice of recipient',
  // A machine-only grant means "this secret is readable on THIS machine
  // without the master password", and the secret it names is excluded from
  // every export precisely so it cannot travel. Syncing the record of such a
  // grant would carry an authorisation to a device where the thing it
  // authorises does not exist — a standing permission for nothing, and on the
  // new device an entry no revoke there can act on.
  secretGrants: 'when each machine-only grant was made; the grant is bound to one machine',
  // Both of these were written to userData and named in NO list until now —
  // not the wipe list, not this one. They surfaced together when the wipe list
  // was derived from the source rather than maintained by hand.
  //
  // The OAuth store holds live access and refresh tokens minted for MCP
  // clients on this machine, plus the consents behind them. Syncing it would
  // carry working credentials to a second device and hand it sessions nobody
  // there consented to.
  mcpOauth: 'live OAuth tokens and consents minted for this machine; syncing them would copy credentials',
  // A trace of what the app did here, recorded only after an explicit switch.
  // It is about one machine's behaviour and belongs to the bug report it was
  // started for.
  debug: 'an opt-in local trace of this machine; not user data to carry anywhere',

  runbooks:
    'UNDECIDED: user-authored notes about their own estate, unreproducible, and currently lost on a device wipe',
  rules: 'UNDECIDED: automation rules with pinned server ids; the same shape as runbooks',
  processes: 'UNDECIDED: managed long-running process definitions',
  backupTargets: 'UNDECIDED: where backups go; holds no credential but maps where the estate copies live',
  credproxyRules: 'UNDECIDED: which third-party endpoints this machine forwards to',
  envSecrets: 'UNDECIDED: which environment variables were registered as secret-bearing',

  mcpConfig: 'device-local: names the loopback port and this install own bridge entry',
  aiPolicy: 'device-local: an access-control decision that must not be settable from a synced object',
  history:
    'device-local: an append-only command log; syncing it would put every command run anywhere on every machine',
  localSessions: 'device-local: an append-only log of local shells, their paths and directories',
  jobApprovals: 'device-local: an append-only record of who approved what',
  credproxyAudit: 'device-local: an append-only record of every credential forwarded and to whom',
  aiAudit: 'device-local: an append-only record of every AI action',
  inspectCA:
    'device-local: a certificate authority installed into THIS machine OS trust store; syncing it would install one machine interception CA on every other',
  rdpCerts: 'device-local: trusted RDP host certificates, per-machine like known hosts',
  vaultBio: 'device-local: a biometric enrolment bound to this machine secure enclave',
  vpnState:
    'device-local: engine key material, including a tsnet node identity that IS this device on the tailnet',
  externalEdit: 'device-local: scratch copies of remote files opened in the user own editor',
  instanceId: 'device-local: deliberately excluded from wipe and reused nowhere in addy',

  /**
   * Found by this guardrail on its first run, which is the guardrail working:
   * each was written to disk and classified nowhere. Device-local is right for
   * all four, and the reason is the point.
   */
  secrets:
    'device-local: safeStorage credentials. They reach another device inside the vault collection or a backup bundle, never as their own synced object -- a sync path carrying unsealed credentials would be a second way to lose them',
  wslocks:
    'device-local: workspace lock passwords protect a workspace on THIS machine; syncing them would make one machine unlock decision apply everywhere',
  mcpSessions:
    'device-local: live agent sessions, bound to this install bridge and meaningless on another machine',
  inspectCapture:
    'device-local: plaintext request and response bodies spilled by the traffic inspector. Swept on every inspector start, and the last thing that should acquire a second copy on another machine',
}

/**
 * The two optional UI surfaces, and the only parts of addy that are modules.
 *
 * SYNC IS CORE, NOT A MODULE, and there was no choice about that: it must
 * import `services/vault` and `services/secrets`, both of which are in
 * MODULE_FORBIDDEN_IMPORTS and MODULE_FORBIDDEN_BRIDGE, enforced by a real
 * import-closure walk. A module would have turned `main` red on its first
 * commit. The precedent is already set and is right anyway -- VPN, tunnels and
 * backup are not modules either.
 */
export const ADDY_MODULE_IDS = ['addyClipboard', 'addyTransfer'] as const

/**
 * NEITHER OF THESE IS A REGISTERED MODULE, and this constant is the record of
 * a decision rather than a list of ids in use.
 *
 * Both surfaces shipped, and both are gated — just not by the module registry:
 *
 *  - the clipboard is gated by a SETTING, because what it actually costs is
 *    two global shortcuts taken from every application on the machine, and the
 *    switch has to say that where somebody will read it. A module toggle in
 *    Settings plus a shortcut warning on the panel would be two switches for
 *    one thing, and the one people find would be the one without the warning.
 *  - file transfer is a row on a panel that is already behind the `addy`
 *    module. A module inside a module buys nothing.
 *
 * Kept, rather than deleted, because "we decided against it" and "nobody has
 * got to it" look identical once the names are gone — which is the same
 * argument NOT_SYNCED makes about reasons.
 */

/**
 * Error codes `addyd` may emit.
 *
 * Its own union rather than an entry in `VpnErrorCode`, which has nothing to do
 * with relays. The Go side asserts every constant it can emit appears here, and
 * the direction is one-way: addyd may emit a subset, never a superset.
 */
export type AddyErrorCode =
  | 'config-invalid'
  | 'not-paired'
  | 'pairing-refused'
  | 'pairing-expired'
  | 'sas-mismatch'
  | 'roster-invalid'
  | 'roster-forked'
  | 'roster-rewound'
  | 'schema-too-new'
  | 'quota-exceeded'
  | 'relay-unreachable'
  | 'peer-unreachable'
  | 'internal'

/**
 * One conflict copy, as the chooser sees it.
 *
 * Declared here rather than in the main-process service because the renderer
 * needs it and must not import a main module -- that pulls Electron, the vault
 * and the sidecar into the renderer's bundle for the sake of four fields.
 */
export interface ConflictCopy {
  id: number
  collection: string
  /** Hex of the device that wrote the LOSING copy. */
  device: string
  createdAt: string
  /** The losing copy's contents, unsealed. Absent when it could not be opened
   *  -- sealed under an epoch this device no longer holds, most likely -- with
   *  `problem` saying so. */
  losing?: unknown
  /** The copy that won, as it stands on the relay now. */
  winning?: unknown
  problem?: string
}

/** What both devices show once a pairing has been confirmed.
 *
 *  Declared here so the renderer can name it without importing a main module. */
export interface AddyPairingConfirmation {
  /** Seven emoji, identical on both devices. */
  sas: string[]
  /** The same list as words, so a phone call works as well as a photograph. */
  sasWords: string
  peer: { pubSign: string; pubEnc?: string }
  /** Present only on the joining device: its own public halves, for the other
   *  device to write into the roster entry that adds it. */
  self?: { pubSign: string; pubEnc: string }
}

/**
 * The state the Sync & devices panel renders.
 *
 * Declared HERE, in the shared contract, rather than on either side: the
 * renderer wrote this shape first, as a request for what it needed to stop
 * guessing (`components/addy/addyStatus.ts`), and main now answers it. Two
 * copies of it would let the answer drift from the question silently, which is
 * exactly how a panel ends up rendering a field nobody sets.
 *
 * THE RULE IT ENCODES: a figure nobody measured must not render as though it
 * had been. `devices` is OMITTED — never `[]` — while this device has not
 * verified a roster, `lastSeen` is `null` rather than 0, and `sync.running`
 * says whether there is an engine at all, so "last sync: never" cannot be read
 * as a fleet that has fallen behind.
 */
export interface AddyStatusDevice {
  /** `pub_sign`, hex. Stable for the life of the device. */
  id: string
  /** The pseudonym from the roster, opened in the sidecar under the profile
   *  key of the epoch the device was added in. Falls back to the key's first
   *  bytes when this device does not hold that epoch. */
  label: string
  /** The device this window is running on. */
  self: boolean
  /** Epoch ms the relay last saw it. `null` when it does not report that. */
  lastSeen: number | null
  /** Epoch ms it joined the account. `null` when unknown. */
  addedAt: number | null
  revoked?: boolean
}

export interface AddyStatusSync {
  /** Is there a sync engine running in this build at all. Every other figure
   *  on the panel is read through this one. */
  running: boolean
  /** This device has authenticated to the relay. */
  connected: boolean
  lastSyncAt: number | null
  error?: { message: string; at: number; code?: string }
  /** Conflict copies waiting for a choice. */
  conflicts: number
  /** Objects carried in the last few sync windows, oldest first. Omitted
   *  rather than sent flat, because a flat line claims nothing synced. */
  history?: number[]
}

export interface AddyStatusSnapshot {
  enrolled: boolean
  relayURL?: string
  accountId?: string
  /** Omitted, not empty, until a roster has been verified on this device. */
  devices?: AddyStatusDevice[]
  sync: AddyStatusSync
}

/**
 * One file that has arrived on this device and is sitting in quarantine.
 *
 * Declared here so the renderer can name it without importing a main module.
 * `path` is on THIS machine — it is what the reveal-in-folder action needs —
 * and nothing in the renderer ever reads the file itself.
 */
export interface ArrivedTransfer {
  id: string
  name: string
  size: number
  path: string
  /** The sending device's `pub_sign`, hex. Empty for a file read back off
   *  disk, where the sender is no longer recorded. */
  from: string
  at: number
}

/**
 * Whether the two global clipboard shortcuts are actually held.
 *
 * `held` is what the OS granted, not what the user asked for. A global
 * shortcut can be refused because another application already has it —
 * `Cmd/Ctrl+Shift+C` is the developer tools in every browser — and a switch
 * reading "on" over a combination nothing holds is indistinguishable from one
 * that works, which is the shape of a feature people conclude is broken.
 */
export interface ClipboardShortcutState {
  held: boolean
  /** Combinations another application already holds. */
  blocked: string[]
  /** False when this device is not on an account, where nothing is held
   *  whatever the setting says. */
  attached: boolean
}
