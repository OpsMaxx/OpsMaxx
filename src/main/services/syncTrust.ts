import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { atomicWriteFileSync } from './atomicWrite'
import { askInWindow } from './promptWindow'
import { mt } from './locale'
import { LocalizedError } from '../../shared/i18n'
import { getSecret } from './secrets'
import { hasOwnCredential, storedCredential } from './credentialLink'
import { vaultEntriesForResolve } from './vault'
import { loadData } from './store'
import type { HeldRecord, HeldKind } from '../../shared/addy'
import { UNKNOWN_WORKSPACE } from './policyEngine'

/**
 * Which synced changes THIS device's user has not confirmed yet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Sync carries records, and some records decide where a credential goes: a CI
 * connection names a vault entry AND the URL its token is sent to; a server
 * names the host its locally stored password is typed into. A device still on
 * the account — a stolen laptop that cannot unlock its own vault, say — could
 * push a record pairing someone else's vault entry with its own URL, and every
 * other unlocked device would send that secret there on its next poll, with
 * nobody asked. The sealed sync object proves the account wrote it, not that
 * the person at THIS keyboard wanted it.
 *
 * ---------------------------------------------------------------------------
 * HOW: A MARK WHEN SYNC LANDS A CHANGE, CLEARED BY A PERSON HERE
 * ---------------------------------------------------------------------------
 *
 * When sync writes a collection, `markArrivals` compares each record with this
 * device's copy and marks every destination or credential pointer that arrived
 * different — or the whole record, when it is new. A record is HELD while its
 * current value still equals what was marked: background callers fail closed,
 * and a foreground use asks once (`askToUse`). A person confirming clears the
 * mark; a person editing the field here changes the value, so it no longer
 * matches the mark and is theirs.
 *
 * Marks rather than a list of everything confirmed, because the confirmed
 * state is the ordinary one: records created here, and everything on disk the
 * day this shipped, carry no mark and need no seeding. And the mark is written
 * BEFORE the collection lands, by the same call — if it cannot be written, the
 * sync write throws and nothing arrives unmarked.
 *
 * The file is device-local (`NOT_SYNCED.syncTrust`): marks that synced would
 * let the device being guarded against clear its own.
 *
 * Values are stored as hashes, not hosts and URLs. `opsmaxx-data.json` is
 * sealed with the OS keystore because an estate is the reconnaissance half of
 * an attack, and a plaintext second copy beside it would undo that. A hash is
 * enough to say WHICH part changed; the record says what it changed to. The
 * plaintext exceptions are workspace ids (random, and the policy check has to
 * look the old one up) and host-key fingerprints (public by nature).
 *
 * WHICH DEVICE MADE A CHANGE IS NOT KNOWN HERE. The sealed object carries no
 * writer inside its plaintext, and the relay's say-so is not evidence, so the
 * prompt says "another of your devices" rather than naming one it cannot
 * prove.
 */

const FILE = (): string => join(app.getPath('userData'), 'opsmaxx-sync-trust.json')

interface Mark {
  /** field → hash of the value as it ARRIVED. Held while the value still matches. */
  fields: Record<string, string>
  /** It arrived as a new record, never seen on this device before sync. */
  arrived?: true
  /** A server moved by sync: the workspace it was in here, and the one sync put it in. */
  ws?: { from: string; to: string }
}

interface HostMark {
  /** The fingerprint sync wrote into the known-hosts file. */
  fp: string
  /** What this device's own copy said before, if it had one. */
  mine?: string
}

interface TrustFile {
  v: 1
  marks: Record<string, Mark>
  hostKeys: Record<string, HostMark>
  /** `seedLinkMarks` has run on this device. */
  linksSeeded?: true
  /** The file existed and could not be read: everything is held. */
  unreadable?: true
}

/**
 * Off disk every time, like the known-hosts file beside it. It is small, and a
 * cached copy would outlive "delete all data" and a revocation wipe.
 */
function read(): TrustFile {
  if (!existsSync(FILE())) return { v: 1, marks: {}, hostKeys: {} }
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as Partial<TrustFile>
    if (raw && typeof raw.marks === 'object' && raw.marks && typeof raw.hostKeys === 'object' && raw.hostKeys) {
      return { v: 1, marks: raw.marks, hostKeys: raw.hostKeys, ...(raw.linksSeeded === true ? { linksSeeded: true as const } : {}) }
    }
  } catch {
    /* below */
  }
  // A file that is there and cannot be read could have held any mark, and
  // reading it as "no marks" would release every one of them. So it reads as
  // "everything held" until a confirmation rebuilds it (see `mutate`).
  return { v: 1, marks: {}, hostKeys: {}, unreadable: true }
}

/** Read, change, write — rebuilding an unreadable file as every current
 *  record marked, so the first write after damage does not release the rest. */
function mutate(change: (t: TrustFile) => void): void {
  const t = read()
  if (t.unreadable) {
    delete t.unreadable
    const data = loadData()
    for (const kind of KINDS) for (const rec of recordsOf(data, kind)) markRecord(t, kind, rec, undefined)
  }
  change(t)
  atomicWriteFileSync(FILE(), JSON.stringify(t))
}

// ------------------------------------------------------------ the fields

const COLLECTION: Record<HeldKind, string> = {
  server: 'servers',
  database: 'databases',
  cicd: 'cicdConnections',
  vpn: 'vpns'
}
const KINDS: HeldKind[] = ['server', 'database', 'cicd', 'vpn']

/** What each field is called when a person is told it changed. */
const LABEL: Record<string, string> = {
  host: 'address',
  via: 'jump host',
  url: 'address',
  user: 'user name',
  credential: 'saved credential',
  tls: 'certificate checks',
  route: 'route',
  connection: 'connection settings'
}

type Rec = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** Hosts and URLs compared the way a resolver would: case and surrounding
 *  space are not a different destination. */
const norm = (v: unknown): string => str(v).trim().toLowerCase()

/** Stable JSON: object keys sorted, so a re-serialised record compares alike. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Rec
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/**
 * A VPN spec as one comparable string: keys sorted, and without the
 * machine-specific fields `vpnsSource` strips on landing — counting those
 * would call every profile changed the moment it arrived and was stripped.
 */
export function vpnConnectionKey(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return stable(spec)
  const rest = { ...(spec as Rec) }
  delete rest.binaryPath
  delete rest.sourcePath
  delete rest.strippedDirectives
  return stable(rest)
}

/**
 * The values that decide where a record's credential goes, or null when the
 * record carries no credential reference at all.
 *
 * Servers and databases are judged on the destination, and on the vault entry
 * the synced record links to (`credential`): a device with no credential of
 * its own logs in with that entry, so a synced change to it decides which
 * secret is sent exactly as a changed address decides where. On a device that
 * stores its own credential the link is unused, and `ownCredentialAside` drops
 * it before anything is judged. The host alone for a server, because the
 * host is what decides who receives the password — a port or account change
 * keeps it on the same machine, and the host-key check, keyed by host:port,
 * still stands in front of it.
 */
export function fieldsOf(kind: HeldKind, rec: Rec): Record<string, string> | null {
  switch (kind) {
    case 'server': {
      // The host decides who receives the password, and so do these: a cloud
      // target names the real machine behind an IAP or SSM forward, and an
      // RDP KDC proxy or auth setting decides where a ticket derived from the
      // password is sent. A synced change to any of them is held like a
      // changed host.
      const rdp = (rec.rdp && typeof rec.rdp === 'object' ? rec.rdp : {}) as Rec
      return {
        host: norm(rec.host),
        cloud: stable(rec.cloud),
        rdp: `${str(rdp.kdcProxyUrl)}|${rdp.nla === false ? 0 : 1}|${str(rdp.domain)}`,
        credential: str(rec.vaultEntryId)
      }
    }
    case 'database':
      // TLS off and a different VPN route both expose the password without
      // changing the host; a workspace move lifts AI restrictions on it.
      return {
        host: norm(rec.host),
        via: str(rec.sshServerId),
        tls: rec.ssl === true ? '1' : '0',
        vpn: str(rec.vpnProfileId),
        ws: str(rec.workspaceId),
        // With the `uri` flag, which decides whether the entry is read as a
        // password or as a whole connection string (see credentialLink.ts).
        credential: rec.vaultEntryId ? `${rec.uri === true ? 'u' : 'p'}|${str(rec.vaultEntryId)}` : ''
      }
    case 'cicd':
      return {
        url: `${str(rec.provider)}|${norm(rec.baseUrl).replace(/\/+$/, '')}`,
        user: str(rec.username),
        credential: str(rec.vaultEntryId),
        // A synced `insecureTls` or a planted CA lets whoever sits on the path
        // read the token as easily as a changed URL would.
        tls: `${rec.insecureTls === true ? 1 : 0}|${str(rec.caPem)}`,
        route: stable(rec.route),
        // A move into a workspace with fewer AI restrictions.
        ws: str(rec.workspaceId)
      }
    case 'vpn': {
      if (!rec.spec || typeof rec.spec !== 'object') return null
      const text = vpnConnectionKey(rec.spec)
      // Every vault pointer on a profile is a `VpnSecretRef`, so this is the
      // test for "starting it uses a credential". Tailscale has none: it signs
      // in through a browser and holds nothing of ours.
      if (!text.includes('"vaultEntryId"')) return null
      return { connection: text, ws: str(rec.workspaceId) }
    }
  }
}

const hashOf = (kind: HeldKind, id: string, field: string, value: string): string =>
  createHash('sha256').update(`${kind}\0${id}\0${field}\0${value}`).digest('hex').slice(0, 32)

function recordsOf(data: unknown, kind: HeldKind): Rec[] {
  const list = (data as Rec | null)?.[COLLECTION[kind]]
  if (!Array.isArray(list)) return []
  return list.filter((r): r is Rec => !!r && typeof r === 'object' && typeof (r as Rec).id === 'string')
}

/** Mark what `rec` brings that `local` (this device's copy) did not have. */
function markRecord(t: TrustFile, kind: HeldKind, rec: Rec, local: Rec | undefined): void {
  const id = rec.id as string
  const key = `${kind}:${id}`
  const prev = t.marks[key]
  const now = fieldsOf(kind, rec) ?? {}
  const was = local ? (fieldsOf(kind, local) ?? {}) : {}
  const mark: Mark = { fields: { ...prev?.fields } }
  if (!local || prev?.arrived) mark.arrived = true
  for (const [f, v] of Object.entries(now)) {
    if (!local || was[f] !== v) mark.fields[f] = hashOf(kind, id, f, v)
  }
  if (kind === 'server' && local) {
    const from = prev?.ws && prev.ws.to === str(local.workspaceId) ? prev.ws.from : str(local.workspaceId)
    const to = str(rec.workspaceId)
    if (from && to && from !== to) mark.ws = { from, to }
    else delete mark.ws
  }
  if (Object.keys(mark.fields).length > 0 || mark.ws) t.marks = { ...t.marks, [key]: mark }
}

// ------------------------------------------------------- marking

/**
 * Sync is about to write `incoming` over `local` for one collection: mark
 * what arrives different. Throws if the marks cannot be saved, so the caller's
 * write never happens without them.
 */
export function markArrivals(kind: HeldKind, local: unknown[], incoming: unknown[]): void {
  // REFUSED, not filtered, when any record has an id that is not a non-empty
  // string, or two records share one. A one-element array as an id was
  // skipped here and still found its credential by id (`getSecret(["x"])`
  // reads key "x"), so a database got no mark and its password went wherever
  // the record pointed; two copies of one id let the second erase the first's
  // mark. Nothing this app writes has either, so the whole write is refused.
  const seen = new Set<string>()
  for (const r of incoming) {
    if (!r || typeof r !== 'object') continue
    const id = (r as Rec).id
    if (typeof id !== 'string' || id === '' || seen.has(id)) {
      throw new Error(`a synced ${COLLECTION[kind]} record has a missing, malformed or repeated id; the copy was refused`)
    }
    seen.add(id)
  }
  const asData = (list: unknown[]): Rec => ({ [COLLECTION[kind]]: list })
  const mine = new Map(recordsOf(asData(local), kind).map((r) => [r.id as string, r]))
  const theirs = recordsOf(asData(incoming), kind)
  mutate((t) => {
    for (const rec of theirs) markRecord(t, kind, rec, mine.get(rec.id as string))
    // A record sync deleted takes its mark with it.
    const ids = new Set(theirs.map((r) => `${kind}:${r.id as string}`))
    for (const key of Object.keys(t.marks)) if (key.startsWith(`${kind}:`) && !ids.has(key)) delete t.marks[key]
  })
}

/** The known-hosts file is about to be replaced by a synced copy: mark every
 *  entry it adds or changes, with what this device's own copy said. */
export function markHostKeyArrivals(local: unknown, incoming: unknown): void {
  const fpOf = (map: unknown, id: string): string | undefined => {
    const fp = ((map as Rec | null)?.[id] as Rec | undefined)?.fingerprint
    return typeof fp === 'string' ? fp : undefined
  }
  mutate((t) => {
    for (const id of Object.keys((incoming as Rec | null) ?? {})) {
      const fp = fpOf(incoming, id)
      const mine = fpOf(local, id)
      if (!fp || fp === mine) continue
      // An entry already marked keeps what THIS device had before the first
      // synced change, not the synced value a second change replaced -- or
      // the removal a first pass made (see below).
      const prev = t.hostKeys[id]
      const before = prev && (prev.fp === mine || (prev.fp === REMOVED && mine === undefined)) ? prev.mine : mine
      t.hostKeys = { ...t.hostKeys, [id]: before ? { fp, mine: before } : { fp } }
    }
    // AN ENTRY SYNC REMOVED keeps what this device had. Deleting a host in one
    // pass and re-adding it with another key in the next turned the hard
    // "changed key" refusal into a first-connection prompt, because by the
    // second pass this device's own copy no longer held the old key.
    for (const id of Object.keys((local as Rec | null) ?? {})) {
      const mine = fpOf(local, id)
      if (mine && fpOf(incoming, id) === undefined && !t.hostKeys[id]) {
        t.hostKeys = { ...t.hostKeys, [id]: { fp: REMOVED, mine } }
      }
    }
  })
}

/** Stands for "sync removed this entry" in a host-key mark. */
const REMOVED = '-removed-'

/**
 * Hold every vault link already on disk, once, on the first launch of the
 * version that reads them.
 *
 * `markArrivals` marks what changes WHEN sync lands it, and a link landed by a
 * build that did not judge links was marked as nothing: an older build keeps
 * the field (the store spreads records) without looking at it. No build before
 * this one writes the field itself, so every link present now came by sync and
 * nobody here confirmed it. A device that stores its own credential for the
 * record does not use the link, and `ownCredentialAside` keeps this mark from
 * troubling it.
 */
export function seedLinkMarks(data: unknown = loadData()): void {
  if (read().linksSeeded) return
  mutate((t) => {
    for (const kind of ['server', 'database'] as const) {
      for (const rec of recordsOf(data, kind)) {
        const credential = fieldsOf(kind, rec)?.credential
        if (!credential) continue
        const key = `${kind}:${rec.id as string}`
        const prev = t.marks[key]
        t.marks = { ...t.marks, [key]: { ...prev, fields: { ...prev?.fields, credential: hashOf(kind, rec.id as string, 'credential', credential) } } }
      }
    }
    t.linksSeeded = true
  })
}

/** Clear every mark: a restored backup is the person's own choice of state. */
export function clearAllMarks(): void {
  // Seeded too: the links a restore brings are as much its choice as the rest.
  if (existsSync(FILE())) atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, marks: {}, hostKeys: {}, linksSeeded: true }))
}

/** Confirm one record: its marks go, workspace move included. */
export function confirmRecord(kind: HeldKind, id: string): void {
  mutate((t) => {
    delete t.marks[`${kind}:${id}`]
  })
}

/** A credential was typed in here for `secretId`: storing a password against
 *  a record is the person saying where it goes, so its destination marks go. */
export function confirmSecretOwner(secretId: string): void {
  const id = secretId.replace(/:rdp$/, '')
  // A desktop password says where THAT password goes. It says nothing about
  // which vault entry the SSH side would use, so a held link stays held.
  const keep = secretId.endsWith(':rdp') ? ['credential'] : []
  for (const kind of ['server', 'database'] as const) {
    if (read().marks[`${kind}:${id}`]?.fields) clearFields(kind, id, keep)
  }
}

function clearFields(kind: HeldKind, id: string, keep: string[] = []): void {
  mutate((t) => {
    const m = t.marks[`${kind}:${id}`]
    if (!m) return
    const kept = Object.fromEntries(Object.entries(m.fields).filter(([f]) => keep.includes(f)))
    if (m.ws || Object.keys(kept).length) t.marks[`${kind}:${id}`] = { fields: kept, ...(m.ws ? { ws: m.ws } : {}) }
    else delete t.marks[`${kind}:${id}`]
  })
}

// ------------------------------------------------------------ checking

/**
 * `fields` without the vault link when this device stores a credential of its
 * own for the record: that credential wins (see credentialLink.ts), so the
 * link is not what would be sent, and a synced change to it is not a reason
 * to stop this device using the one somebody typed in here.
 */
function ownCredentialAside(id: string, fields: Record<string, string>): Record<string, string> {
  if (!('credential' in fields) || !hasOwnCredential(id)) return fields
  const rest = { ...fields }
  delete rest.credential
  return rest
}

/** Which of `now` are still the values sync brought and nobody here
 *  confirmed. Empty means usable. */
export function heldFields(kind: HeldKind, id: string, now: Record<string, string>): string[] {
  const t = read()
  if (t.unreadable) return Object.keys(now)
  const m = t.marks[`${kind}:${id}`]
  if (!m) return []
  return Object.keys(now).filter((f) => m.fields[f] !== undefined && m.fields[f] === hashOf(kind, id, f, now[f]))
}

/**
 * A server judged on its stored record, not on the address being dialled.
 *
 * Judging the dialled host missed two things: a server reached through a VPN
 * or cloud forward is dialled at 127.0.0.1, which never matched a held host,
 * and the cloud and RDP fields that also decide where the credential goes
 * were not compared at all. `dialled` is used only for a server this device
 * has no record of.
 */
export function serverFieldsNow(serverId: string, dialled: string): Record<string, string> {
  const id = serverId.replace(/:rdp$/, '')
  const rec = recordsOf(loadData(), 'server').find((r) => r.id === id)
  const fields = ownCredentialAside(id, fieldsOf('server', rec ?? { host: dialled }) ?? { host: norm(dialled) })
  // A desktop's own password never uses the link, so a held link is not a
  // reason to hold it.
  if (serverId.endsWith(':rdp')) delete fields.credential
  return fields
}

/** Whether a server's stored credential may be used without asking. */
export function serverCredentialHeld(secretId: string, dialled: string): boolean {
  return heldFields('server', secretId.replace(/:rdp$/, ''), serverFieldsNow(secretId, dialled)).length > 0
}

/** A database judged on what is actually being dialled. */
export function databaseFieldsNow(cfg: { id?: string; host?: string; ssh?: { serverId?: string } }): Record<string, string> {
  // The dialled address and jump, plus what the stored record says about TLS,
  // VPN and workspace, which the dialled config may not carry.
  const rec = recordsOf(loadData(), 'database').find((r) => r.id === cfg.id)
  const stored = rec ? (fieldsOf('database', rec) ?? {}) : {}
  return ownCredentialAside(str(cfg.id), { ...stored, host: norm(cfg.host), via: str(cfg.ssh?.serverId) })
}

/**
 * The workspace this device had a server in before a move that arrived by
 * sync, while that move is unconfirmed and still where the server is. Null
 * when nothing is pending.
 *
 * The AI policy reads restrictions and protection from a server's workspace,
 * so a move made on another device could lift both here. Until it is
 * confirmed, the policy applies the old workspace's rules as well.
 */
export function pendingWorkspace(serverId: string, currentWs: string): string | null {
  const t = read()
  // Damaged marks cannot say whether a move is pending, and "a damaged file
  // holds everything" covers policy too: the unknown former workspace is
  // treated as No AI Access and Protected by its readers.
  if (t.unreadable) return UNKNOWN_WORKSPACE
  const ws = t.marks[`server:${serverId}`]?.ws
  return ws && ws.to === currentWs ? ws.from : null
}

/**
 * The host key this device should hold `id` to, given what the synced file
 * says: the file's own value, unless that value was written by sync and not
 * accepted here — then what this device had before, or nothing at all.
 */
export function hostKeyExpected(id: string, fileFp: string | undefined): string | undefined {
  const t = read()
  // Damaged marks could have said anything about any host, so none is trusted
  // on the file's word until a person here accepts it again.
  if (t.unreadable) return undefined
  const m = t.hostKeys[id]
  if (m && (m.fp === fileFp || (m.fp === REMOVED && fileFp === undefined))) return m.mine
  return fileFp
}

/** This device accepted (or forgot) a key for `id` itself. */
export function clearHostKeyMark(id: string): void {
  if (!(id in read().hostKeys)) return
  mutate((t) => {
    delete t.hostKeys[id]
  })
}

// ------------------------------------------------------------ asking

/** A held record was used by something with no person to ask, or the person
 *  said no. The message is what the caller shows. */
export class SyncHeldError extends LocalizedError {
  constructor(name: string) {
    super('main.syncTrust.held', { name })
    this.name = 'SyncHeldError'
  }
}

function describeChange(fields: string[], arrived: boolean): string {
  if (arrived) return mt('main.syncTrust.changeArrived')
  const names = [...new Set(fields.map((f) => LABEL[f] ?? f))]
  return names.length === 1
    ? mt('main.syncTrust.changedOne', { field: names[0] })
    : mt('main.syncTrust.changedMany', { fields: names.slice(0, -1).join(', '), last: names[names.length - 1] })
}

/**
 * Which vault entry a confirmation would release, named — the half of the
 * question an address alone does not answer. A link that pointed at another
 * of the user's entries would send THAT secret to the address above.
 */
function signsInWith(entryId: string | undefined): string {
  if (!entryId) return ''
  const entry = vaultEntriesForResolve()?.find((e) => e.id === entryId)
  return ` ${entry ? mt('main.syncTrust.signsInWithEntry', { name: entry.name }) : mt('main.syncTrust.signsInWithVault')}`
}

const asking = new Map<string, Promise<boolean>>()

/**
 * Ask the person once whether a held record may be used, and remember a yes.
 *
 * Only for a caller with a person behind it. Concurrent asks for one record
 * share a dialog, the way host-key prompts do — a terminal, SFTP and metrics
 * all open at once on first use. No window is a no, as Cancel is.
 */
export function askToUse(
  kind: HeldKind,
  id: string,
  name: string,
  now: Record<string, string>,
  destination: string
): Promise<boolean> {
  const fields = heldFields(kind, id, now)
  if (fields.length === 0) return Promise.resolve(true)
  const key = `${kind}:${id}`
  const inFlight = asking.get(key)
  if (inFlight) return inFlight
  const p = askInWindow({
    type: 'warning',
    title: mt('main.syncTrust.confirmTitle'),
    message: mt('main.syncTrust.confirmMessage', { name }),
    detail: mt('main.syncTrust.confirmDetail', {
      change: describeChange(fields, read().marks[key]?.arrived === true),
      destination,
      signsIn: signsInWith(now.credential)
    }),
    buttons: [mt('main.syncTrust.allow'), mt('main.syncTrust.deny')],
    defaultId: 1,
    cancelId: 1
  })
    .then((r) => {
      if (r?.response !== 0) return false
      clearFields(kind, id)
      return true
    })
    .finally(() => asking.delete(key))
  asking.set(key, p)
  return p
}

/** `askToUse` for a record as saved — a VPN profile, a CI connection. */
export function askToUseRecord(kind: HeldKind, rec: Rec): Promise<boolean> {
  const f = fieldsOf(kind, rec)
  if (!f) return Promise.resolve(true)
  return askToUse(kind, str(rec.id), str(rec.name) || str(rec.id), f, destinationOf(kind, rec))
}

/** `askToUse` for a database about to be dialled, judged on the dialled
 *  address. Nothing is asked for one with no credential stored here. */
export async function askToUseDatabase(cfg: {
  id: string
  name?: string
  host: string
  port: number
  ssh?: { serverId?: string }
}): Promise<void> {
  if (!storedCredential(cfg.id)) return
  await askToUse('database', cfg.id, cfg.name || cfg.host, databaseFieldsNow(cfg), `${cfg.host}:${cfg.port}`)
}

// ------------------------------------------------------- what is held

/**
 * Every held record, for the Sync & devices panel and the badges.
 *
 * A server or database counts only while this device holds a credential for
 * it: with none stored there is nothing for a changed address to receive, and
 * a newly paired device would otherwise open on a list of every server in the
 * estate. A server's workspace move counts whatever it holds, because that one
 * is about AI policy, not credentials.
 */
export function heldRecords(data: unknown = loadData()): HeldRecord[] {
  const out: HeldRecord[] = []
  const t = read()
  for (const kind of KINDS) {
    for (const rec of recordsOf(data, kind)) {
      const id = rec.id as string
      const f = fieldsOf(kind, rec)
      const judged = f && (kind === 'server' || kind === 'database') ? ownCredentialAside(id, f) : f
      let changed = judged ? heldFields(kind, id, judged).map((c) => LABEL[c] ?? c) : []
      if ((kind === 'server' || kind === 'database') && !storedCredential(id) && !getSecret(`${id}:rdp`)) changed = []
      if (kind === 'server' && pendingWorkspace(id, str(rec.workspaceId))) changed = [...changed, 'workspace']
      if (changed.length === 0) continue
      out.push({
        kind,
        id,
        name: str(rec.name) || id,
        changed,
        arrived: t.marks[`${kind}:${id}`]?.arrived === true,
        destination: destinationOf(kind, rec)
      })
    }
  }
  return out
}

function destinationOf(kind: HeldKind, rec: Rec): string {
  switch (kind) {
    case 'server':
      return `${str(rec.username) ? `${str(rec.username)}@` : ''}${str(rec.host)}`
    case 'database':
      return `${str(rec.host)}${typeof rec.port === 'number' ? `:${rec.port}` : ''}`
    case 'cicd':
      return str(rec.baseUrl)
    case 'vpn': {
      const spec = (rec.spec ?? {}) as Rec
      if (spec.kind === 'frp') return `${str(spec.serverAddr)}:${String(spec.serverPort ?? '')}`
      if (spec.kind === 'wireguard' && Array.isArray(spec.peers)) {
        return spec.peers.map((p) => str((p as Rec).endpoint)).filter(Boolean).join(', ') || 'a WireGuard peer'
      }
      return `a ${str(spec.kind) || 'VPN'} profile`
    }
  }
}
