import { app } from 'electron'
import { release } from 'node:os'
import { isPortable } from '../portable'
import { getUpdatePrefs } from './updatePrefs'
import {
  listCachedDatabases,
  listCachedServers,
  listCachedTunnels,
  listCachedVpns,
  listCachedWorkspaces
} from './mcpDataCache'
import { getMcpConfig } from './mcpAuth'
import { isLocalTerminalEnabled } from './localGate'
import { isAccessWriteEnabled } from './accessWriteGate'
import { secretsAvailable, secretsBackend } from './secretsBackend'
import { redactOutput } from './secretRedaction'
import { loadData } from './store'
import { MODULES, moduleEnabled } from '../../shared/modules'
import type { ModuleState } from '../../shared/modules'
import { formatDiagnostics } from '../../shared/diagnostics'
import type { Diagnostics, DiagnosticsCrash } from '../../shared/diagnostics'

// The assembly half of "Copy diagnostics". It collects LOCAL FACTS ONLY —
// versions, counts and booleans; see src/shared/diagnostics.ts for the list and
// for why it is that short.
//
// WHAT THIS MODULE MAY IMPORT
//
// Not secrets.ts (its `exportSecrets` returns every stored credential in
// plaintext), not vault.ts, credentialResolver.ts, backup.ts, biometrics.ts,
// history.ts, sftp.ts or dbOps.ts. tests/diagnosticsImports.test.ts walks this
// file's real import closure and fails if any of them is reachable, so the rule
// is checked rather than remembered.
//
// Two facts therefore arrive as arguments instead of imports: the webhook
// projection (webhookAlerts.ts reads its URL through secrets.ts) and whether the
// AI bridge is actually listening (mcpServer.ts imports most of the
// application). Only booleans cross, which is all the payload can hold anyway.
//
// The secure-store facts are a DIRECT import, not a third probe, and that is the
// better answer rather than an exception to the rule. secretsBackend.ts exists
// so that `safeStorage.isEncryptionAvailable()` has somewhere to live that is
// not next to the ciphertext: it reaches `electron` and nothing else — no file
// path, no stored map, no `decryptString` — so there is nothing in its closure
// for the guard to object to. A probe would only have moved two calls up into
// src/main/index.ts and left the predicate duplicated between the collector's
// caller and secrets.ts, which is the drift this extraction exists to avoid.
// Probes are for facts whose module cannot be made clean; this one could.
//
// Counts do NOT come from the renderer. The server, workspace, database, tunnel
// and VPN lists live in a blob the renderer owns, but main already keeps a
// read-only mirror of it — mcpDataCache, primed at launch and refreshed on every
// `data:save` — so the numbers are read here. That keeps the Settings path a
// no-argument call and means a renderer cannot report counts the stored data
// does not support. The crash block is the only thing passed in, because the
// crash happened in the renderer and main never saw it.

export interface DiagnosticsProbes {
  /** `webhookStatus()` — already exactly the right shape: booleans, no URL. */
  webhook: { enabled: boolean; hasUrl: boolean; notifyOnResolved: boolean }
  /** `mcpServerStatus().running`. Enabled-but-not-listening is the bug class
   *  this whole config section exists for. */
  aiBridgeRunning: boolean
}

/** A crash report is renderer-supplied text. It is never executed and never
 *  written anywhere, but it should not be able to make the payload enormous
 *  either. */
const CRASH_FIELD_CAP = 4000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/** The renderer's settings out of the persisted blob — the same read
 *  localGate.ts and accessWriteGate.ts do on their own flags. */
function storedSettings(): Record<string, unknown> {
  try {
    const blob = loadData()
    const settings = isRecord(blob) ? blob.settings : null
    return isRecord(settings) ? settings : {}
  } catch {
    // Diagnostics are what someone reaches for when the app is already
    // misbehaving. An unreadable data file must degrade to fewer facts, never
    // to a failed call.
    return {}
  }
}

/**
 * The one field family in the payload that is not safe by construction.
 *
 * REDACT FIRST, THEN CAP — the same ordering, for the same reason, as
 * `redactThenCap` in credProxy.ts: capping first can cut the END marker off a
 * PEM block, after which the private-key pattern in secretRedaction.ts matches
 * nothing and the key is stored as prose.
 *
 * `scrubPaths` in src/shared/diagnostics.ts trims paths and nothing else, so it
 * is not a substitute for this: a `PGPASSWORD=` or a bearer token in an error
 * message is not a path. Neither pass removes hostnames or addresses — no rule
 * here can tell a host from a word — which is why the two UI strings say to
 * glance over the text rather than promising it is clean.
 */
function cleanCrashField(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text === '') return null
  return redactOutput(text).slice(0, CRASH_FIELD_CAP)
}

export function collectDiagnostics(
  probes: DiagnosticsProbes,
  crash?: DiagnosticsCrash | null
): Diagnostics {
  const settings = storedSettings()
  const updates = getUpdatePrefs()
  const modules = settings.modules as ModuleState | undefined

  return {
    version: app.getVersion(),
    channel: updates.channel,
    portable: isPortable,
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    secretStoreBackend: secretsBackend(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    nodeModuleVersion: process.versions.modules ?? 'unknown',
    counts: {
      workspaces: listCachedWorkspaces().length,
      servers: listCachedServers().length,
      databases: listCachedDatabases().length,
      tunnels: listCachedTunnels().length,
      vpnProfiles: listCachedVpns().length
    },
    modulesEnabled: MODULES.filter((m) => moduleEnabled(modules, m.id)).map((m) => m.id),
    config: {
      // Absence reads the way the renderer's own defaults read it:
      // resourceAlertsEnabled defaults on, fleetSamplingEnabled defaults off.
      alerts: settings.resourceAlertsEnabled !== false,
      backgroundChecks: settings.fleetSamplingEnabled === true,
      localTargetAllowed: isLocalTerminalEnabled(),
      keyWritesAllowed: isAccessWriteEnabled(),
      // Whether this machine can store a credential AT ALL. `setSecret`
      // refuses outright when this is false rather than writing plaintext, so
      // "the password I saved did not stick" and "SSH auth keeps failing" are
      // the same bug, and this is the line that says so. On Linux it is also
      // the pair to `secretStoreBackend` above.
      'secretStore.available': secretsAvailable(),
      'webhook.enabled': probes.webhook.enabled,
      'webhook.hasUrl': probes.webhook.hasUrl,
      'webhook.notifyOnResolved': probes.webhook.notifyOnResolved,
      'aiBridge.enabled': getMcpConfig().enabled,
      'aiBridge.running': probes.aiBridgeRunning,
      'update.autoCheck': updates.autoCheck,
      'update.autoDownload': updates.autoDownload,
      'update.autoInstallOnQuit': updates.autoInstallOnQuit,
      // Whether a check has ever COMPLETED, rather than when. The "check now"
      // button that was wired to a cache read would have shown up right here.
      'update.everChecked': updates.lastCheckedAt !== null
    },
    crash: crash
      ? {
          message: cleanCrashField(crash.message) ?? 'Unknown error',
          stack: cleanCrashField(crash.stack),
          componentStack: cleanCrashField(crash.componentStack)
        }
      : null
  }
}

/** The finished text, ready for the clipboard. */
export function diagnosticsText(
  probes: DiagnosticsProbes,
  crash?: DiagnosticsCrash | null
): string {
  return formatDiagnostics(collectDiagnostics(probes, crash))
}
