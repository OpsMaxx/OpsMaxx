import { app, clipboard } from 'electron'
import { askInWindow } from './promptWindow'
import { mt } from './locale'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readOpenSshKnownHosts, lookupInKnownHosts, canonicalHostname } from './opensshKnownHosts'
import { atomicWriteFileSync } from './atomicWrite'
import { clearHostKeyMark, hostKeyExpected } from './syncTrust'

// Trust-on-first-use host key checking. Without this, ssh2 accepts any host
// key presented, so a machine-in-the-middle on the path to a server can
// capture the session and any credentials sent over it.

const FILE = join(app.getPath('userData'), 'opsmaxx-known-hosts.json')

export interface KnownHost {
  id: string // "host:port"
  fingerprint: string
  addedAt: string
}

type HostMap = Record<string, KnownHost>

function read(): HostMap {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, 'utf8')) as HostMap
  } catch {
    /* ignore corrupt file */
  }
  return {}
}

function write(map: HostMap): void {
  atomicWriteFileSync(FILE, JSON.stringify(map, null, 2))
}

// OpenSSH-style fingerprint: base64 SHA-256 of the raw key, padding stripped.
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export function knownHostList(): KnownHost[] {
  return Object.values(read()).sort((a, b) => a.id.localeCompare(b.id))
}

export function knownHostForget(id: string): void {
  // A synced-change mark goes too: forgetting is a decision made here.
  clearHostKeyMark(id)
  const map = read()
  if (!map[id]) return
  delete map[id]
  write(map)
}

/**
 * Prompts that could not be shown because OpsMaxx had no window open, so the
 * connection error can say that instead of "not accepted" — which reads as
 * though somebody pressed Cancel.
 *
 * Keyed by the prompt's own promise, not the host: every connection that
 * joined the prompt holds that same promise and gets the same answer, and a
 * later attempt, with its own prompt, is not coloured by this one.
 */
const noWindow = new WeakSet<Promise<boolean>>()

/** Whether `verdict`, from verifyHostKey, refused because nobody could be asked. */
export function askedWithoutWindow(verdict: Promise<boolean>): boolean {
  return noWindow.has(verdict)
}

// Collapses concurrent prompts for the same host into one dialog — metrics,
// SFTP and a terminal can all connect at once on first use.
const pending = new Map<string, Promise<boolean>>()

export function verifyHostKey(
  host: string,
  port: number,
  key: Buffer,
  // Whether this caller may raise a dialog. A known-good key never prompts, and
  // a CHANGED key still refuses loudly regardless — an unattended caller only
  // loses the ability to establish trust for the first time, which is exactly
  // the decision that needs a person present.
  allowPrompt = true,
  /**
   * What to file this key under, when the dialled address is not the server's
   * identity — see SshHop.hostKeyId.
   */
  identity?: string
): Promise<boolean> {
  const id = identity ?? `${host}:${port || 22}`
  const fp = fingerprint(key)
  const map = read()
  const known = map[id]
  /**
   * WHAT THIS DEVICE ACCEPTED, NOT WHAT THE FILE SAYS.
   *
   * The known-hosts file syncs, so an entry in it may have been written by any
   * device on the account — including one that has also just pointed a server
   * at its own machine and planted that machine's key here, which turned a
   * redirect into a password captured with no prompt at all. Or it changes
   * only the fingerprint for the real host, and every device trusts a
   * machine-in-the-middle silently.
   *
   * So an entry that sync added or changed, and nobody here has accepted, is
   * held to what this device had before (services/syncTrust.ts marks it as it
   * lands). A host whose key this device already agreed with keeps working; a
   * synced entry for a host it never trusted is a first sighting and goes
   * through the normal prompt — which says another device shared it — and a
   * background caller refuses, as it would for any unknown host.
   */
  const trusted = hostKeyExpected(id, known?.fingerprint)
  if (trusted === fp) return Promise.resolve(true)
  const expected = trusted ?? (known && known.fingerprint !== fp ? known.fingerprint : undefined)

  if (expected) return changedKey(id, expected, fp, allowPrompt)

  // An unattended caller never prompts. It refuses and lets its own layer
  // report why.
  //
  // A trust-on-first-use dialog is only worth anything if it arrives at a
  // moment the person can reason about — "I am connecting to this host right
  // now, is that its fingerprint?" A background sweep raising one spontaneously,
  // with no action to correlate it to, teaches click-through on the single
  // dialog where click-through is how a machine-in-the-middle succeeds. Worse,
  // nothing cancels the pending promise, so five never-connected servers meant
  // five stacked modals nobody asked for.
  //
  // Deliberately decided in main and never taken from the renderer: a
  // renderer-settable "do not prompt" would let a compromised renderer suppress
  // host verification for real connections, which is the opposite of the point.
  if (!allowPrompt) return Promise.resolve(false)

  const inFlight = pending.get(id)
  if (inFlight) return inFlight

  // What OpenSSH already thinks of this host. This never grants trust by
  // itself — see opensshKnownHosts.ts for why — it only changes what the
  // prompt says, so a host you use daily in your terminal is not announced as
  // a total stranger. Revocation is the exception: it is a negative signal.
  const openssh = lookupInKnownHosts(readOpenSshKnownHosts(), host, port, fingerprint, fp)

  if (openssh.revoked) {
    return askInWindow({
        type: 'error',
        title: mt('main.hostKey.revokedTitle'),
        message: mt('main.hostKey.revokedMessage', { id }),
        detail: mt('main.hostKey.revokedDetail', { fp }),
        buttons: [mt('common.ok')],
        defaultId: 0
      })
      .then(() => false)
  }

  const recognised = openssh.trusted
  // The same key, written into the synced file by another of the user's
  // devices. Said, because it is true and worth knowing; never trusted on its
  // own, because a device on the account is exactly who could have written it.
  const shared = known?.fingerprint === fp
  const prompt: Promise<boolean> = askInWindow({
      type: recognised ? 'question' : 'warning',
      title: recognised ? mt('main.hostKey.confirmTitle') : mt('main.hostKey.unknownTitle'),
      message: recognised ? mt('main.hostKey.recognisedMessage', { id }) : mt('main.hostKey.unknownMessage', { id }),
      detail: recognised
        ? mt('main.hostKey.recognisedDetail', { fp, host: canonicalHostname(host, port) })
        : openssh.knownUnderAnotherKey
          ? mt('main.hostKey.otherKeyDetail', { fp })
          : shared
            ? mt('main.hostKey.sharedDetail', { fp })
            : mt('main.hostKey.unknownDetail', { fp }),
      buttons: [mt('main.hostKey.trustAndConnect'), mt('common.cancel')],
      // Pre-selecting Trust is only defensible when we have independent
      // evidence for this exact key; anything else keeps Cancel as the default.
      defaultId: recognised ? 0 : 1,
      cancelId: 1
    })
    .then((r) => {
      // No window to ask in is a refusal, as Cancel is: see askInWindow.
      if (!r) noWindow.add(prompt)
      if (r?.response !== 0) return false
      const current = read()
      current[id] = { id, fingerprint: fp, addedAt: new Date().toISOString() }
      write(current)
      clearHostKeyMark(id)
      return true
    })
    .finally(() => pending.delete(id))

  pending.set(id, prompt)
  return prompt
}

/**
 * A key that differs from the one this device trusted: a rebuilt server, or an
 * interception. Never decided silently — but never a dead end either.
 *
 * The old dialog refused and pointed at a settings page, which left a person
 * who had just reinstalled a server hunting for the one control that fixes it.
 * Now, when a person is connecting, it offers that control here: replace the
 * trusted key, behind a second question that says plainly what the first one
 * risks, with Cancel the default on both. Copy puts both fingerprints on the
 * clipboard, to compare against the server's console.
 *
 * A BACKGROUND CALLER GETS NO REPLACE BUTTON. A sampler raising "trust this new
 * key?" at a moment nobody chose is the dialog the first-sighting branch above
 * refuses to show, and for the same reason: it teaches the click that lets an
 * interception through. It says what to do instead — open the server — and
 * that connection asks with the button.
 *
 * One dialog per host at a time, joined by every connection that hits it: a
 * terminal, SFTP and the sampler meeting the same rebuilt server stacked three
 * modals before.
 */
function changedKey(id: string, expected: string, fp: string, person: boolean): Promise<boolean> {
  const key = `changed:${id}`
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const compare = mt('main.hostKey.compare', {
    expected,
    fp,
    command: 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
  })
  const copy = (): void => clipboard.writeText(`${id}\ntrusted: ${expected}\npresented: ${fp}\n`)
  const ask = async (): Promise<boolean> => {
    for (;;) {
      const r = await askInWindow({
        type: 'error',
        title: mt('main.hostKey.changedTitle'),
        message: mt('main.hostKey.changedMessage', { id }),
        detail: person
          ? mt('main.hostKey.changedDetailPerson', { compare })
          : mt('main.hostKey.changedDetailBackground', { compare }),
        buttons: person
          ? [mt('common.cancel'), mt('main.hostKey.copyFingerprints'), mt('main.hostKey.replaceTrustedKey')]
          : [mt('common.ok'), mt('main.hostKey.copyFingerprints')],
        defaultId: 0,
        cancelId: 0
      })
      if (r?.response === 1) {
        copy()
        continue
      }
      if (!person || r?.response !== 2) return false
      const sure = await askInWindow({
        type: 'warning',
        title: mt('main.hostKey.replaceTitle'),
        message: mt('main.hostKey.replaceMessage', { id }),
        detail: mt('main.hostKey.replaceDetail', { fp }),
        buttons: [mt('common.cancel'), mt('main.hostKey.replaceAndConnect')],
        defaultId: 0,
        cancelId: 0
      })
      if (sure?.response !== 1) return false
      const current = read()
      current[id] = { id, fingerprint: fp, addedAt: new Date().toISOString() }
      write(current)
      clearHostKeyMark(id)
      return true
    }
  }
  const p = ask().finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}
