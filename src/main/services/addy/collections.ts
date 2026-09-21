import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { atomicWriteFileSync } from '../atomicWrite'
import { dataFileExists, loadData, saveData } from '../store'
import { AddyError } from './sidecar'
import { SYNCED_COLLECTIONS, type SyncedCollection } from '../../../shared/addy'
import { isReverseProxyKind, type VpnKind } from '../../../shared/vpn'

/**
 * Where each synced collection actually lives on this machine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A REGISTRY AND NOT A SWITCH STATEMENT
 * ---------------------------------------------------------------------------
 *
 * `SYNCED_COLLECTIONS` is the protocol's list and `internal/protocol/
 * collections.go` is its other half. Neither says where the bytes come from,
 * and the natural way to write the engine — a `switch` with a `default: break`
 * — makes a collection nobody wired indistinguishable from one deliberately
 * left out. That is the same defect `NOT_SYNCED` exists to prevent on the
 * other side of the line, and it is worse here: a missing case means a
 * collection that silently never syncs, with no error, until somebody notices
 * their databases never reached the second laptop.
 *
 * So every name in `SYNCED_COLLECTIONS` must appear either in `SOURCES` or in
 * `PENDING` with a reason, and `tests/addyCollections.test.ts` fails the build
 * otherwise.
 *
 * ---------------------------------------------------------------------------
 * BYTES, NOT OBJECTS
 * ---------------------------------------------------------------------------
 *
 * A source reads and writes a `Buffer`, and the engine seals whatever it is
 * handed without looking inside. That is what lets `vault` travel at all: it
 * is `opsmaxx-vault.json` verbatim, already ciphertext under the user's master
 * password, and nothing in the sync path may open it. Treating one collection
 * as bytes and the rest as JSON would have meant a second code path for the
 * one collection where a mistake is unrecoverable.
 */

export interface CollectionSource {
  /** The local bytes, or `null` when this machine has nothing to send.
   *
   *  `null` is not an empty value: an empty `servers` array is a real state a
   *  user can reach by deleting their last server, and pushing it is correct.
   *  `null` means the key or file is absent, which is "this machine has never
   *  had one" — and pushing THAT over another device's data is the mistake. */
  read(): Buffer | null
  /** Apply an inbound copy. Throws rather than half-writing. */
  write(body: Buffer): void
  /** True when applying this needs the renderer told, because the renderer
   *  holds the same data in memory and will otherwise write its stale copy
   *  back over the top on its next save. */
  readonly inRendererStore?: boolean
}

const userFile = (name: string): string => join(app.getPath('userData'), name)

/**
 * One key inside `opsmaxx-data.json`.
 *
 * Eleven of the sixteen collections live in that one blob, which the RENDERER
 * owns: it holds the whole thing in a zustand store and writes all of it on
 * every change. So applying an inbound copy has two halves, and the second is
 * not optional — see `inRendererStore`. Writing the file alone would be undone
 * by the renderer's next keystroke.
 */
function blobKey(key: string): CollectionSource {
  /**
   * The blob, or a refusal.
   *
   * `loadData` answers null for BOTH "there is no file" and "the file and its
   * backup are corrupt", which is right for the renderer — it starts clean
   * either way — and dangerous here, where the answer decides whether to
   * write. A corrupt file read as "this machine has nothing", so every
   * collection was adopted from the relay and the blob was rebuilt from an
   * empty object: `settings`, `tabs`, `activeWorkspaceId` and every other key
   * with no relay copy were destroyed, along with the module state, the vault
   * auto-lock and the local-terminal kill switch. `saveData` copies the
   * corrupt file to the backup on its way past, so the one good copy went too.
   */
  const blobOrRefuse = (): Record<string, unknown> | null => {
    const data = loadData() as Record<string, unknown> | null
    if (data) return data
    if (dataFileExists()) {
      throw new AddyError(
        'config-invalid',
        'the local data file cannot be read, so nothing will be written over it'
      )
    }
    return null
  }

  return {
    inRendererStore: true,
    read(): Buffer | null {
      const data = blobOrRefuse()
      if (!data || !(key in data)) return null
      return Buffer.from(JSON.stringify(data[key]), 'utf8')
    },
    write(body: Buffer): void {
      const data = blobOrRefuse() ?? {}
      // Parsed here rather than spliced as text: a body that is not JSON is a
      // corrupt object, and finding that out now is better than writing it
      // into the file every panel reads.
      const value = JSON.parse(body.toString('utf8'))
      data[key] = value
      saveData(data)

      /**
       * AND CHECK IT LANDED. `saveData` swallows every failure into a
       * `console.error` — correct for the renderer, which must not lose a
       * window because a save failed — and it makes this function's own
       * contract ("throws rather than half-writing") a lie.
       *
       * The consequence was not a missing write, it was an inverted one. The
       * engine recorded agreement for a pull that never reached disk, so the
       * next pass saw a local edit and no remote one and PUSHED the stale copy
       * over the account. Another device's work deleted everywhere, because a
       * disk was full, and the only trace a console line nobody reads.
       */
      const back = loadData() as Record<string, unknown> | null
      if (!back || JSON.stringify(back[key]) !== JSON.stringify(value)) {
        throw new AddyError(
          'internal',
          `${key} could not be written to the local data file`
        )
      }
    }
  }
}

/** A whole file in userData, carried verbatim. */
function wholeFile(name: string): CollectionSource {
  return {
    read(): Buffer | null {
      const path = userFile(name)
      return existsSync(path) ? readFileSync(path) : null
    },
    write(body: Buffer): void {
      // Temp-then-rename, like every other writer of these files. A truncated
      // vault is the worst outcome available here.
      //
      // Through a string because that is what the shared writer takes, which
      // is exact for these three: all of them are JSON text, and a UTF-8 round
      // trip of UTF-8 is the same bytes. It would NOT be exact for arbitrary
      // binary, so a future binary collection needs a buffer-taking writer
      // rather than this function with its eyes shut.
      atomicWriteFileSync(userFile(name), body.toString('utf8'))
    }
  }
}

/**
 * `servers`, arriving disconnected.
 *
 * `Server.status` is live state about a socket THIS machine holds. It sits on
 * the server record because that is where the sidebar draws it from, and the
 * record is saved into `opsmaxx-data.json` — which is how a connection ended
 * up inside a synced collection without anyone deciding it should be.
 *
 * A second device imported the estate and every indicator was green while
 * nothing was connected and monitoring was empty. Those were the first
 * device's sockets, drawn on the second device's screen, and a status
 * indicator that is green for a machine you have never dialled is worse than
 * none: the one widget whose whole job is "is this up" answering confidently
 * and wrongly.
 *
 * `offline` rather than absent, because the type has four states and none of
 * them means "no opinion" — and because it is the true one for a machine this
 * process has no connection to, which is what it has a moment after a sync.
 *
 * Only the WRITE side. Stripping the field on `read()` as well would stop a
 * connect and a disconnect churning the collection, but it would also make
 * this device's payload permanently unequal to the one every device on an
 * older build pushes — and the engine compares bytes, so that is a conflict
 * copy per pass for as long as the fleet is mixed.
 * ponytail: status still travels outbound; strip on read too once no shipped
 * build sends it.
 */
function serversSource(): CollectionSource {
  const inner = blobKey('servers')
  return {
    inRendererStore: true,
    read: () => inner.read(),
    write(body: Buffer): void {
      const value: unknown = JSON.parse(body.toString('utf8'))
      // Not an array is not this function's problem to fix: `blobKey.write`
      // parses it too and the file it lands in is the one every panel reads,
      // so a shape nobody expects should arrive intact and be found, not be
      // quietly reshaped here.
      if (!Array.isArray(value)) {
        inner.write(body)
        return
      }
      const landed = value.map((sv) => ({ ...(sv as Record<string, unknown>), status: 'offline' }))
      inner.write(Buffer.from(JSON.stringify(landed), 'utf8'))
    }
  }
}

/**
 * `vpns`, arriving without the parts that belong to the machine that sent it.
 *
 * Same shape and same reason as `serversSource()` above, applied to fields
 * that are not live state but are still nobody's business but one computer's.
 *
 * `OpenVpnSpec.binaryPath` is an absolute path on the machine whose form it
 * was typed into, and the OpenVPN driver treats its mere presence as the
 * user's confirmed choice — so `resolveEngineBinary` short-circuits on it and
 * never looks at the engine OpsMaxx ships. Across a mixed fleet that is a
 * refusal quoting somebody else's disk: a Windows user told
 * `/opt/homebrew/bin/openvpn` "does not exist", with no mention of installing
 * OpenVPN; a Mac user told `C:\Program Files\...` "is a relative path, which
 * depends on the working directory". Both bypassed a bundled engine that
 * would have worked. Absent is not a downgrade — it is the auto-detect that
 * is correct on every machine.
 *
 * `OpenVpnSpec.sourcePath` is the `.ovpn` file a profile was discovered from,
 * and it exists to make a RE-SCAN idempotent: the file is still on disk, so it
 * turns up again and is skipped because this field names it. A path from
 * another machine names nothing here, so all it can do is suppress nothing and
 * show a stranger's home directory in this machine's import report.
 *
 * `autoStart` on a reverse proxy is the security one. `vpnStartup` starts
 * every `autoStart` profile at launch, and for frp and ngrok starting means
 * publishing THIS machine's localhost port — with ngrok, to the public
 * internet. The consent gate that `start()` refuses without,
 * `acknowledgedExposure`, is a tick about one machine's ports, and it crosses
 * in the same record. So the second computer opened a port on a decision its
 * owner made about the first one, unattended, at login. Stripped for frp and
 * ngrok only: `autoStart` on a WireGuard or OpenVPN profile publishes nothing
 * and is a preference that should travel.
 *
 * Only the WRITE side, for the reason `serversSource()` sets out at length —
 * the engine compares bytes, and a read-side strip would be a conflict copy
 * per pass for as long as any device runs an older build.
 *
 * A STRIPPED COPY DOES NOT PROPAGATE BY ITSELF, and it is worth being exact
 * about why, because the obvious reading is wrong. `writeBack` in sync.ts
 * records `localHash` from what the source reads back AFTER the transform, not
 * from the payload it was handed — so the next pass sees `localChanged` false
 * and the outcome is `unchanged`. That is the whole of what commit 3137a839
 * fixed: recording the payload instead turned every transforming source into a
 * clobber loop, one per sync interval, which is how every server on every
 * device went grey. So the device that stripped a field sits on its stripped
 * copy quietly, and the device that set the field keeps it indefinitely.
 *
 * What it costs is still real, and it is not what it costs for `Server.status`,
 * because these are saved settings rather than live state. The collection syncs
 * WHOLE: the first genuine local edit anywhere in `vpns` on the stripped device
 * — renaming one unrelated profile is enough — pushes its copy of every
 * profile, and that is the pass where the other machine's `binaryPath`
 * override, or its frp `autoStart`, goes. Not immediately, and not on a timer;
 * on somebody's next edit. Off and auto-detect are the safe directions to lose
 * them in, which is why this is the trade taken.
 * ponytail: the honest fix is a machine-local override for the rest of these.
 * Do that when someone needs an engine path that sticks. NOT beside `settings`
 * as this note used to say — that is a key of `opsmaxx-data.json`, and `save()`
 * in the renderer's persist.ts writes a fixed object literal, so any key main
 * added to that blob is destroyed on the renderer's next save. Silent data
 * loss, no error anywhere.
 *
 * `TailscaleSpec.hostname` IS HANDLED, and is still deliberately not stripped
 * here. It has a per-device override stored beside the node key it
 * disambiguates, in `vpn-state/tailscale-<id>/hostname` — see
 * `readDeviceHostname` in drivers/tailscale.ts, and `tailscaleHostname()` in
 * shared/vpn.ts, which is the one place that decides which name wins. The
 * synced `hostname` stays the default, because it is a name the user chose and
 * dropping it would hand the node to the sidecar's invention.
 *
 * That directory was already the right home: `NOT_SYNCED.vpnState` classifies
 * it as the tsnet node identity that IS this device, `ALL_DATA_DIRS` already
 * covers it for wipe and backup, and the value never enters the synced blob —
 * so unlike a stripped field it does not reach the relay even as ciphertext.
 * No guardrail entry was needed, which is the tell that it belongs there.
 *
 * On urgency, so nobody reads this as either an emergency or noise: the `-1`
 * suffix Tailscale appends is STABLE once the node key persists. Both nodes
 * work and both MagicDNS names resolve, so what this fixes is a permanently
 * confusing admin console rather than churn.
 */
function vpnsSource(): CollectionSource {
  const inner = blobKey('vpns')
  return {
    inRendererStore: true,
    read: () => inner.read(),
    write(body: Buffer): void {
      const value: unknown = JSON.parse(body.toString('utf8'))
      // Not an array is not this function's problem to fix — see
      // `serversSource()`.
      if (!Array.isArray(value)) {
        inner.write(body)
        return
      }
      inner.write(Buffer.from(JSON.stringify(value.map(landProfile)), 'utf8'))
    }
  }
}

/** One profile, with this machine's answer to the machine-specific fields.
 *  A shape that is not a profile is passed through untouched: it belongs in
 *  the file where somebody can find it, not quietly reshaped here. */
function landProfile(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const profile = { ...(raw as Record<string, unknown>) }
  const spec = profile.spec
  if (!spec || typeof spec !== 'object') return profile
  const kind = (spec as { kind?: unknown }).kind
  if (kind === 'openvpn') {
    const landed = { ...(spec as Record<string, unknown>) }
    delete landed.binaryPath
    delete landed.sourcePath
    profile.spec = landed
  }
  // Via the shared predicate rather than `kind === 'frp' || kind === 'ngrok'`,
  // which is the spelling shared/vpn.ts says goes wrong the moment a third
  // reverse proxy is added.
  if (typeof kind === 'string' && isReverseProxyKind(kind as VpnKind)) profile.autoStart = false
  return profile
}

export const SOURCES: Partial<Record<SyncedCollection, CollectionSource>> = {
  apiCollections: blobKey('apiCollections'),
  apiWorkspace: blobKey('apiWorkspace'),
  cicdConnections: blobKey('cicdConnections'),
  databases: blobKey('databases'),
  folders: blobKey('folders'),
  httpChecks: blobKey('httpChecks'),
  monitorGroups: blobKey('monitorGroups'),
  servers: serversSource(),
  tunnels: blobKey('tunnels'),
  vpns: vpnsSource(),
  workspaces: blobKey('workspaces'),

  // Opaque. Already ciphertext under the master password, and the recovery
  // phrase is not a skeleton key for it — two secrets, each doing the job it
  // was designed for. Nothing in this path opens it.
  vault: wholeFile('opsmaxx-vault.json'),
  // Hostnames and their key fingerprints. Syncing it is what stops a second
  // machine asking about every host in the estate as though it were new,
  // which is the prompt people learn to click through.
  knownHosts: wholeFile('opsmaxx-known-hosts.json'),
  // WHICH environment variables were registered as secret-bearing and what
  // they point at — not the values, which are in the keychain and machine
  // bound. The pointers are what a second machine needs.
  env: wholeFile('opsmaxx-env-secrets.json')
}

/**
 * Named in the protocol, not carried yet, each with the reason.
 *
 * A REASON IS MANDATORY here for the same argument `NOT_SYNCED` makes: "we did
 * not get to it" and "this cannot be carried yet" look identical in a list of
 * names, and only one of them is a decision.
 */
export const PENDING: Partial<Record<SyncedCollection, string>> = {
  // There is no local store to read. The provisioning manifest is M6 work and
  // its format was deliberately designed early so this needs no protocol
  // change when it arrives — see docs/plans/addy.md. Wiring a source now would
  // mean inventing the file it reads.
  manifest:
    'hot-device provisioning has no local store yet; the collection name is reserved so M6 needs no protocol change',
  // Addy's own: what the user CALLS each device, keyed on pub_sign. Nothing
  // writes it because nothing can rename a device yet. The collection exists
  // because the roster label is a birth name and entries are immutable, so the
  // rename has to live somewhere that a rotation re-seals.
  deviceNames:
    'no rename affordance exists yet, so there is nothing local to carry; the roster label stands in until there is'
}

/** Every name accounted for, or the build fails. Exported for the test. */
export function unaccountedCollections(): string[] {
  return SYNCED_COLLECTIONS.filter((c) => !(c in SOURCES) && !(c in PENDING))
}
