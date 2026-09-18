import { app, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { atomicWriteFileSync } from './atomicWrite'

// Trust-on-first-use for RDP server certificates, and the answer to the
// question `rejectUnauthorized: false` raises.
//
// The relay cannot ask Node to validate the certificate, and that is not a
// shortcut: RDP servers present a self-signed certificate by default, so
// ordinary CA validation would refuse essentially every real host. Windows'
// own client does not do CA validation either — it pins, and warns when the
// pin changes. That is what this file implements, and it is the same policy
// the app already applies to SSH host keys in knownhosts.ts.
//
// Why it has to live here rather than in the client: with NLA on, CredSSP
// binds to the server certificate, so a machine-in-the-middle that terminated
// TLS could not complete authentication — the client would catch it. With NLA
// off there is no binding and nothing else in the path checks anything, which
// is exactly the configuration a Linux `xrdp` host needs. Leaving that case
// unchecked would mean the one setup that cannot use CredSSP is also the one
// with no certificate check at all.

const FILE = join(app.getPath('userData'), 'opsmaxx-rdp-certs.json')

export interface TrustedRdpCert {
  /** "host:port" — the RDP host, never the bastion it was reached through. */
  id: string
  fingerprint: string
  addedAt: string
}

type CertMap = Record<string, TrustedRdpCert>

/**
 * The pin store, or a refusal.
 *
 * `null` means the file exists and could not be read as a trust store. That is
 * NOT the same as having no pins, and the difference is the only place this
 * design fails open: "no pins" means first contact, which prompts and is
 * clicked through, while a store that has been truncated or corrupted may well
 * have held the very pin that would have refused the connection. Turning the
 * second into the first makes destroying a local file cheaper than forging a
 * certificate, so the caller treats it as a hard refusal instead.
 *
 * The shape is validated rather than cast. `JSON.parse('null')` succeeds, and
 * the cast said otherwise, so a one-word file made `map[id]` throw inside a
 * floating promise — an uncaught exception in main rather than a refused
 * desktop.
 */
function read(): CertMap | null {
  if (!existsSync(FILE)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as CertMap
  } catch {
    return null
  }
}

function write(map: CertMap): void {
  // Via a temporary file, so an interrupted write cannot leave a half-written
  // trust store that reads as "nothing is trusted". This file IS the trust
  // store, so the temp path is created and never adopted — whatever is already
  // sitting at the predictable `${FILE}.tmp` would otherwise have chosen both
  // the mode and the destination of the pin list the rename then installs.
  // atomicWrite.ts is the one place that spells that out; this was a hand-rolled
  // copy of it that had drifted by a word (`recursive` on the rmSync).
  //
  // Defaults on both of the helper's optional arguments: 0600, and `.tmp`.
  atomicWriteFileSync(FILE, JSON.stringify(map, null, 2))
}

/** SHA-256 of the DER, formatted like the SSH fingerprints shown elsewhere. */
export function certFingerprint(der: Buffer): string {
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`
}

export function trustedRdpCertList(): TrustedRdpCert[] {
  // An unreadable store lists nothing rather than throwing at a settings
  // screen. The refusal that matters happens in verifyRdpCertificate.
  return Object.values(read() ?? {})
}

export function forgetRdpCert(id: string): void {
  const map = read()
  // Nothing to forget, and rewriting the file from an unreadable one would
  // destroy whatever pins are still in there.
  if (!map || !map[id]) return
  delete map[id]
  write(map)
}

// One prompt per host at a time. Two tabs opened against the same new server
// would otherwise stack two identical modals, and answering one would leave
// the other waiting for an answer to a question already settled.
const pending = new Map<string, Promise<boolean>>()

/**
 * Decide whether to continue with the certificate this host presented.
 *
 * `leafDer` is the server's own certificate, not the chain: the chain is what
 * the client needs for CredSSP, but identity is the leaf, and pinning an issuer
 * would trust every certificate that issuer ever signs.
 */
export function verifyRdpCertificate(host: string, port: number, leafDer: Buffer): Promise<boolean> {
  const id = `${host}:${port}`
  const fp = certFingerprint(leafDer)
  const map = read()
  if (map === null) {
    // FAIL CLOSED. The file exists and is not a trust store, so it may have
    // held the pin that would have refused this connection. Treating that as
    // "no pins" turns a hard refusal into a first-contact prompt, which makes
    // corrupting a local file cheaper than forging a certificate.
    return dialog
      .showMessageBox({
        type: 'error',
        title: 'Remote desktop certificates unreadable',
        message: 'The list of trusted remote desktop certificates could not be read.',
        detail:
          `${FILE}\n\nThe connection has been refused, because a damaged list cannot be ` +
          'told apart from one that would have refused this machine. Move or delete that ' +
          'file to start the list again — every host will then ask on first connection.',
        buttons: ['OK'],
        defaultId: 0
      })
      .then(() => false)
  }
  const known = map[id]

  if (known) {
    if (known.fingerprint === fp) return Promise.resolve(true)
    // A changed certificate is either a rebuilt or re-imaged machine — which is
    // common for Windows hosts — or an interception. Never decide it silently.
    return dialog
      .showMessageBox({
        type: 'error',
        title: 'Remote desktop certificate changed',
        message: `The certificate for ${id} does not match the one previously trusted.`,
        detail:
          `Expected: ${known.fingerprint}\nReceived: ${fp}\n\n` +
          'Windows presents a new certificate when a machine is rebuilt or re-imaged — but this is ' +
          'also what an interception looks like. The connection has been refused. If you are certain ' +
          'the machine changed, forget the saved certificate in Settings → Security and reconnect.',
        buttons: ['OK'],
        defaultId: 0
      })
      .then(() => false)
  }

  const inFlight = pending.get(id)
  if (inFlight) return inFlight

  const ask = dialog
    .showMessageBox({
      type: 'warning',
      title: 'Unrecognised remote desktop',
      message: `${id} is presenting a certificate this machine has not seen before.`,
      detail:
        `Fingerprint: ${fp}\n\n` +
        'Remote desktop servers are normally self-signed, so this is expected the first time you ' +
        'connect to a machine. Continue only if you recognise it. The fingerprint will be ' +
        'remembered, and you will be warned if it ever changes.',
      buttons: ['Connect', 'Cancel'],
      // Cancel is both the default and the escape action: the safe answer must
      // be the one a stray Return or Escape produces.
      defaultId: 1,
      cancelId: 1
    })
    .then((result) => {
      if (result.response !== 0) return false
      // Re-read rather than reusing `map`: the answer came from a person, and
      // another session may have written a pin while they were reading. A
      // store that became unreadable in the meantime is not overwritten.
      const current = read()
      if (!current) return false
      current[id] = { id, fingerprint: fp, addedAt: new Date().toISOString() }
      write(current)
      return true
    })
    .finally(() => pending.delete(id))

  pending.set(id, ask)
  return ask
}
