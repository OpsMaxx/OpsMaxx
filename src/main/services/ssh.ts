import net from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import type { ClientChannel } from 'ssh2'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { WebContents } from 'electron'
import type { SshCloseInfo, SshConnectConfig, SshHop, SshStatus, SshStatusPhase } from '../../shared/ssh'
import type { CloudTarget } from '../../shared/cloud'
import { agentForHop } from '../../shared/sshAgent'
import { debugRecord } from './debugLog'
import { askedWithoutWindow, verifyHostKey } from './knownhosts'
// Names only, and only for an error message: a hop is addressed by the
// friendly name of a saved server, so that is what a failure has to say.
import { getCachedServer } from './mcpDataCache'
import { isEncryptedPrivateKey, isSecurityKeyPrivateKey, defaultIdentityPath } from './sshKeys'
import {
  assertCertificateUsable,
  certificateAuthHandler,
  certificateKey,
  parseOpenSshCertificate
} from './cloud/certKey'

interface Session {
  conn: PooledConnection | null
  stream: ClientChannel | null
}

const sessions = new Map<string, Session>()

export interface KeyboardPrompt {
  prompt: string
  echo: boolean
}
export interface KeyboardRequest {
  host: string
  username: string
  // Present when the hop maps to a saved server, so an answer can be stored.
  serverId?: string
  name: string
  instructions: string
  prompts: KeyboardPrompt[]
}
export type Prompter = (req: KeyboardRequest) => Promise<string[]>

// Servers enforcing multi-factor auth (AuthenticationMethods
// publickey,keyboard-interactive) accept the key and then ask for a second
// factor. Without answering that challenge the connection fails with a generic
// "All configured authentication methods failed".
let prompter: Prompter | null = null
export function setSshPrompter(p: Prompter): void {
  prompter = p
}

/**
 * A previously saved answer for a hop, or null.
 *
 * Separate from `prompter` because an unattended connection may USE a stored
 * answer — it is not a guess and needs nobody — while it must never raise a
 * dialog. Folding the two together is what left the background sampler
 * prompting, and then submitting an empty answer when nobody replied.
 */
export type StoredKbAnswer = (hop: SshHop, prompts: KeyboardPrompt[]) => string | null
let storedKbAnswer: StoredKbAnswer | null = null
export function setStoredKbAnswer(f: StoredKbAnswer): void {
  storedKbAnswer = f
}

function send(wc: WebContents, channel: string, ...args: unknown[]): void {
  if (!wc.isDestroyed()) wc.send(channel, ...args)
}

function status(wc: WebContents, sessionId: string, phase: SshStatusPhase, extra: Partial<SshStatus> = {}): void {
  send(wc, `ssh:status:${sessionId}`, { sessionId, phase, ...extra } satisfies SshStatus)
}

// "All configured authentication methods failed" is what ssh2 reports for
// every auth problem, including ones we can identify precisely here. Check the
// key material up front and fail with something actionable instead.
function loadPrivateKey(hop: SshHop): string {
  if (hop.privateKey) return hop.privateKey
  /**
   * No key named: use the default identities, exactly as `ssh` does.
   *
   * This used to throw. That made an empty key field mean "authenticate with
   * nothing", where every other SSH client treats it as "try the usual
   * identities" — and the field's own grey placeholder already said
   * `~/.ssh/id_ed25519`, so the form was describing the behaviour a user
   * expected and the code was doing the opposite. The server then refused
   * every method, which reads as a broken key rather than as a key never
   * sent, and was reported that way.
   *
   * The file used is named in any failure below, so picking a different key
   * from the one `ssh` would have picked is visible rather than silent.
   */
  if (!hop.keyPath) {
    const fallback = defaultIdentityPath()
    if (!fallback) {
      throw new Error(
        `No private key is configured for ${hop.username}@${hop.host}, and no default key was found in ~/.ssh. Edit the server and select a key file, or switch it to password/agent authentication.`
      )
    }
    return readKeyFile(fallback, hop)
  }
  return readKeyFile(hop.keyPath.replace(/^"(.*)"$/, '$1').trim(), hop)
}

/**
 * Read and sanity-check one key file.
 *
 * Split out so a key chosen by the user and one found by the default-identity
 * search get identical treatment — the .ppk, public-key and passphrase
 * messages are the most useful things this file says, and a fallback path
 * that skipped them would fail with ssh2's generic error instead.
 */
function readKeyFile(path: string, hop: SshHop): string {
  if (!existsSync(path)) {
    throw new Error(`Private key not found: ${path}`)
  }

  let key: string
  try {
    key = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`Could not read private key ${path}: ${(err as Error).message}`)
  }

  if (key.startsWith('PuTTY-User-Key-File')) {
    throw new Error(
      `${path} is a PuTTY .ppk key, which is not supported. Convert it in PuTTYgen with Conversions → Export OpenSSH key, then select the converted file.`
    )
  }
  if (/^ssh-(rsa|ed25519|dss)\s|^ecdsa-sha2-/.test(key.trim())) {
    throw new Error(
      `${path} is a public key, not a private key. Select the matching private key file (the one without the .pub suffix).`
    )
  }
  if (!/-----BEGIN [^-]*PRIVATE KEY-----/.test(key)) {
    throw new Error(`${path} does not look like a private key file.`)
  }
  if (isEncryptedPrivateKey(key.slice(0, 512)) && !hop.passphrase) {
    throw new Error(
      `${path} is passphrase-protected. Edit the server and enter the key passphrase.`
    )
  }
  return key
}

/**
 * Resolve the agent for this hop, or say why we could not.
 *
 * Shared by the explicit `agent` auth mode and by the `sk-` redirect below, so
 * a hardware key reaches exactly the agent a user's own `ssh` would use rather
 * than a second guess at the same question.
 */
function agentAuth(hop: SshHop): Partial<ConnectConfig> {
  const { agent, error } = agentForHop(hop.agentSocket, {
    env: process.env,
    home: homedir(),
    platform: process.platform
  })
  if (error) throw new Error(error)
  return { agent }
}

function authFor(hop: SshHop): Partial<ConnectConfig> {
  switch (hop.auth) {
    case 'password':
      return { password: hop.password }
    case 'agent': {
      /**
       * The hop's own agent first, the ambient one only as a fallback.
       *
       * This used to read `process.env.SSH_AUTH_SOCK` and nothing else, which
       * is wrong in a desktop app: the app inherits whatever agent the session
       * manager launched it with — on macOS, launchd's own — and a user whose
       * keys live in Bitwarden, 1Password or KeePassXC has none of them there.
       * The symptom was "All configured authentication methods failed" against
       * a host that connects fine from a terminal, because `ssh` had read the
       * `IdentityAgent` line and we had thrown it away.
       *
       * A resolution error is raised rather than swallowed: an agent we cannot
       * find is a thing the user can fix, and reporting it as a generic auth
       * failure sends them to check their username instead.
       */
      return agentAuth(hop)
    }
    case 'certificate': {
      /**
       * An OpenSSH certificate, presented in place of a registered key.
       *
       * Handed to ssh2 through `authHandler` rather than `privateKey`: that
       * option is filtered to a string or Buffer and anything else is silently
       * dropped, after which publickey never enters the allowed-methods list
       * and the failure reads as a rejected credential. See
       * certificateAuthHandler for the whole story.
       *
       * The window is checked here rather than left to the server, because a
       * server refuses an expired certificate with the same
       * "Permission denied (publickey)" it uses for everything else - which
       * sends the user to look at their cloud roles instead of at an expiry
       * they can fix by signing in again.
       */
      if (!hop.certificate) throw new Error('No certificate was supplied for this connection.')
      const cert = parseOpenSshCertificate(hop.certificate)
      assertCertificateUsable(cert)
      const certKeyFile = loadPrivateKey(hop)
      if (isSecurityKeyPrivateKey(certKeyFile.slice(0, 512))) {
        // Not routed to the agent like the plain-key case: a certificate is
        // presented INSTEAD of the registered key, and certificateAuthHandler
        // needs a signer we do not have for a handle. Say which of the two
        // things is unsupported rather than letting certificateKey throw
        // about a key it could not parse.
        throw new Error(
          'This connection uses an OpenSSH certificate over a hardware-backed (FIDO2) key, which OpsMaxx cannot sign. Set the connection to use an SSH agent instead.'
        )
      }
      const key = certificateKey(certKeyFile, cert, hop.passphrase)
      return { authHandler: certificateAuthHandler(hop.username, key) as never }
    }
    case 'key':
    default: {
      const key = loadPrivateKey(hop)
      /**
       * A FIDO2 key is signed by the authenticator, not by us.
       *
       * `sk-ssh-ed25519@openssh.com` and its ECDSA sibling hold a credential
       * handle, not a private key — signing is a CTAP2 assertion and a touch.
       * ssh2 cannot do it, and `DEFAULT_IDENTITIES` offers `id_ed25519_sk` and
       * `id_ecdsa_sk`, so a user whose only key is a YubiKey was offered that
       * key by us and then told "All configured authentication methods
       * failed".
       *
       * The system agent already does this properly on macOS and Linux,
       * including the touch prompt, so the key is handed to it rather than
       * linking libfido2 to re-implement it here. Nothing about our OWN agent
       * changes: sshAgent/agent.ts still refuses smartcard opcodes, which is
       * us as a server and this is us as a client.
       */
      if (isSecurityKeyPrivateKey(key.slice(0, 512))) return agentAuth(hop)
      return { privateKey: key, passphrase: hop.passphrase }
    }
  }
}

// Interactive typing feels laggy without this. Node sockets have Nagle's
// algorithm on by default, which holds a small keystroke packet back waiting
// for more data — up to ~40ms per character round trip. OpenSSH sets
// TCP_NODELAY for exactly this reason; ssh2 does not.
/**
 * How long to wait for the TCP connection itself.
 *
 * This is what makes an unreachable host fail quickly, and it used to be
 * `readyTimeout` doing the job by proxy — which is why that could not be
 * raised for a handshake that has to wait on a person. Separating them lets
 * each be what it actually is: a network deadline here, a human one below.
 */
const TCP_CONNECT_MS = 15000

function tcpSocket(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.setNoDelay(true)
    socket.setTimeout(TCP_CONNECT_MS, () => {
      socket.destroy()
      reject(
        new Error(
          `Timed out connecting to ${host}:${port} after ${TCP_CONNECT_MS / 1000}s. Nothing answered on that address and port.`
        )
      )
    })
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      // The deadline was for CONNECTING. An established session is allowed to
      // sit idle — a terminal waiting on a person types nothing for minutes.
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/**
 * The handshake deadlines.
 *
 * Two, because a handshake has two very different phases. Before any
 * challenge, a server that has accepted TCP and then says nothing is broken
 * and should fail fast. After one, the connection is waiting on a HUMAN
 * reading a code off their phone, and the only correct deadline is longer
 * than the dialog they are answering.
 */
const HANDSHAKE_QUIET_MS = 20000
/** Comfortably past the prompt's own two-minute limit, so the dialog always
 *  closes before the connection does — whichever way the user goes. */
const HANDSHAKE_HUMAN_MS = 135000
/** ssh2's own timer, purely so a bug in ours cannot hang a connection. */
const HANDSHAKE_BACKSTOP_MS = 150000

async function connectClient(
  hop: SshHop,
  sock?: NodeJS.ReadableStream,
  allowPrompt = true
): Promise<Client> {
  // The credentials are settled BEFORE a socket exists. Resolving them can
  // fail on its own (a hardware key with no agent to route it to), and that
  // used to happen inside the promise below, after tcpSocket() had opened the
  // connection and dropped its error listener. The rejected promise left the
  // socket open with nothing listening, so the server hanging up surfaced as
  // an uncaught ECONNRESET in the main process.
  //
  // A `sock` handed in is a channel forwarded for this connection alone, so
  // it is ours to close as well: on a pooled bastion nothing else would until
  // the bastion itself went away.
  const discard = (t: NodeJS.ReadableStream | undefined): void =>
    (t as { destroy?: () => void } | undefined)?.destroy?.()
  let auth: ReturnType<typeof authFor>
  try {
    auth = authFor(hop)
  } catch (err) {
    discard(sock)
    throw err
  }
  // Hops ride an SSH channel, which has no TCP options of its own; only the
  // first, real socket needs the flag.
  const transport = sock ?? (await tcpSocket(hop.host, hop.port || 22))
  // Until ssh2 takes the transport in client.connect(), nothing else owns it:
  // any failure before that point has to close it here.
  let handedOff = false
  return new Promise<Client>((resolve, reject) => {
    const client = new Client()

    /**
     * Our own handshake deadline, so it can be extended when a person is asked
     * something. ssh2's `readyTimeout` is armed at connect and cannot be
     * reset, which is why it could never be both short for a dead server and
     * long for a verification code.
     */
    let deadline: ReturnType<typeof setTimeout> | null = null
    const clearDeadline = (): void => {
      if (deadline) clearTimeout(deadline)
      deadline = null
    }
    const armDeadline = (ms: number, why: string): void => {
      clearDeadline()
      deadline = setTimeout(() => {
        client.end()
        reject(new Error(why))
      }, ms)
      if (typeof deadline.unref === 'function') deadline.unref()
    }
    armDeadline(
      HANDSHAKE_QUIET_MS,
      `Timed out during the SSH handshake with ${hop.username}@${hop.host} after ${HANDSHAKE_QUIET_MS / 1000}s. The host accepted the connection but did not finish authenticating.`
    )

    // Set by the host verifier below when WE hung up, so the error handler can
    // tell that apart from the host going away.
    let refusedHostKey = false
    // ...and when that was because OpsMaxx had no window to ask in.
    let noWindowToAsk = false

    const config: ConnectConfig = {
      host: hop.host,
      port: hop.port || 22,
      username: hop.username,
      /**
       * A backstop only. The real deadline is `armHandshakeDeadline` below.
       *
       * This used to be `agent ? 90000 : 20000`, on the reasoning that "for a
       * password or a key there is nothing to approve". That premise is false
       * wherever a server sets `AuthenticationMethods publickey,keyboard-
       * interactive`: the key is accepted and THEN a person is asked for a
       * verification code from their phone. Twenty seconds is not enough for
       * that, so the handshake died while the dialog was still open — and the
       * prompt itself waits two minutes, so the two deadlines disagreed by a
       * factor of six.
       *
       * It reached the user as "All configured authentication methods
       * failed", which reads as a rejected credential and sends somebody to
       * check their key. Reported exactly that way: "the private key
       * mechanism is not working anymore".
       */
      readyTimeout: HANDSHAKE_BACKSTOP_MS,
      keepaliveInterval: 15000,
      // Required for the second factor after a public key is accepted.
      tryKeyboard: true,
      // Trust-on-first-use: unknown hosts prompt, changed keys are refused.
      hostVerifier: ((key: Buffer, cb: (ok: boolean) => void) => {
        const verdict = verifyHostKey(hop.host, hop.port || 22, key, allowPrompt, hop.hostKeyId)
        void verdict.then((ok) => {
          // Remember that WE refused, so the error below can say so. ssh2's
          // own message for this is "Host denied (verification failed)", which
          // is true and tells the user nothing they can act on -- and reaching
          // the fleet monitor it became "did not answer the last check", which
          // is not even true: the host answered, and we hung up on it.
          if (!ok) refusedHostKey = true
          if (!ok) noWindowToAsk = askedWithoutWindow(verdict)
          cb(ok)
        })
      }) as never,
      ...auth,
      // A pre-established socket: our own TCP connection, or the channel
      // opened through the previous hop.
      sock: transport as never
    }
    client.on('ready', () => {
      clearDeadline()
      resolve(client)
    })
    // ssh2's typings for this event are narrower than its runtime signature.
    ;(client as unknown as { on: (e: string, cb: (...a: never[]) => void) => void }).on(
      'keyboard-interactive',
      ((
        name: string,
        instructions: string,
        _lang: string,
        prompts: KeyboardPrompt[],
        finish: (answers: string[]) => void
      ) => {
        /**
         * A person is now involved, so the clock changes.
         *
         * This is the whole fix: the server has accepted the key and is
         * asking for a second factor, which means somebody has to read a code
         * off their phone. Twenty seconds killed that mid-dialog and reported
         * it as an authentication failure.
         *
         * Extended before the answering path is chosen, because the saved-
         * answer and password shortcuts below both still have to complete
         * against a deadline, and a stored answer resolving instantly is not
         * a reason to leave the short one armed.
         */
        armDeadline(
          HANDSHAKE_HUMAN_MS,
          `Timed out waiting for the second factor for ${hop.username}@${hop.host}. The challenge was not answered in time.`
        )

        // A single hidden prompt on a password-auth server is the password
        // itself; anything else is a real challenge for the user.
        const single = prompts.length === 1 && !prompts[0].echo
        if (hop.auth === 'password' && hop.password && single) {
          finish([hop.password])
          return
        }

        /**
         * An unattended connection must not ask, and must not guess.
         *
         * `allowPrompt` is false for the fleet sampler and every other
         * background caller — the comments at those call sites already say
         * "this is the unattended caller" — but this handler ignored it and
         * prompted anyway. Two things followed, and the second is the serious
         * one:
         *
         *  1. A verification-code dialog appeared out of a background sweep,
         *     attached to nothing the user had done.
         *  2. Unanswered, it resolved to `finish([])` — a wrong answer. Every
         *     sweep interval spent another failed authentication against the
         *     host, and enough of those trip MaxAuthTries, fail2ban or an
         *     account lockout. The user's own INTERACTIVE connections then
         *     fail too, with "All configured authentication methods failed",
         *     which reads as a broken credential and is really a server that
         *     has stopped listening to this client.
         *
         * That is why turning off background checks clears it, and why the
         * same host answers `ssh` from a terminal at the same moment.
         *
         * A stored answer is still used: it is not a guess and needs nobody.
         * Otherwise the connection ends here rather than submitting an empty
         * answer, so a background sweep costs no failed authentication at all.
         */
        if (!allowPrompt) {
          const stored = storedKbAnswer?.(hop, prompts)
          if (stored) {
            finish([stored])
            return
          }
          clearDeadline()
          client.end()
          reject(
            new Error(
              `${hop.username}@${hop.host} asks for a second factor, which a background check cannot answer. Connect to it once from a terminal tab to authenticate, or turn off background checking for it.`
            )
          )
          return
        }

        if (!prompter) {
          finish([])
          return
        }
        void prompter({
          host: hop.host,
          username: hop.username,
          serverId: (hop as SshHop & { serverId?: string }).serverId,
          name,
          instructions,
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo }))
        })
          .then(finish)
          .catch(() => finish([]))
      }) as never
    )
    client.on('error', (err) => {
      clearDeadline()
      // An unattended caller cannot establish trust for the first time -- that
      // decision needs a person -- so a background sweep against a server the
      // user has only ever reached interactively fails here, silently and
      // forever. Saying which of the two it is turns "unreachable" into
      // something the user can finish in one action.
      if (refusedHostKey) {
        const keyId = hop.hostKeyId ?? `${hop.host}:${hop.port || 22}`
        reject(
          new Error(
            noWindowToAsk
              ? `OpsMaxx has no trusted host key for ${keyId} and no open window to ask in. ` +
                'Open OpsMaxx and connect to this server once to confirm its fingerprint.'
              : allowPrompt
                ? `The host key for ${hop.hostKeyId ?? `${hop.host}:${hop.port || 22}`} was not accepted.`
                : `OpsMaxx has no trusted host key for ${hop.hostKeyId ?? `${hop.host}:${hop.port || 22}`}, ` +
                  'and a background check is not allowed to ask for one. Open a terminal to this server ' +
                  'once and confirm its fingerprint; checks will run on their own after that.'
          )
        )
        return
      }
      reject(err)
    })
    // ssh2 validates the config (it parses the key, so a wrong passphrase
    // lands here) and can throw BEFORE it attaches its own listeners to the
    // socket. Only once connect() returns does ssh2 own it.
    try {
      client.connect(config)
    } catch (err) {
      clearDeadline()
      throw err
    }
    handedOff = true
  }).catch((err: unknown) => {
    if (!handedOff) discard(transport)
    throw err
  })
}

/**
 * Which link of the chain failed, carried on the error itself.
 *
 * A chained server that will not come up reports one line to the monitor, and
 * until this existed that line said nothing about WHERE it broke. Measured
 * against two real sshd's (tests/jumpHostBackground.test.ts), the failures a
 * bastion produces are not merely vague, they are misdirection:
 *
 *   * a bastion whose credential is wrong        -> "All configured
 *     authentication methods failed", which every reader takes to be the
 *     TARGET's credential, and sends them to re-check a key that is fine;
 *   * a bastion that will not forward            -> "(SSH) Channel open
 *     failure: " with an empty reason;
 *   * a target that is down behind a good bastion -> the SAME string, so the
 *     two cases a user would act on differently are indistinguishable;
 *   * a bastion that is simply unreachable       -> "connect ECONNREFUSED
 *     10.20.0.10:22", an address they may never have typed.
 *
 * `hopIndex` is absent when the TARGET itself failed, which is what lets a
 * caller tell "this one server is down" from "everything behind that bastion
 * is". `hopServerId` is the saved server the hop names, for callers that route
 * by it rather than display it — see FleetSampler's sweep.
 */
export interface SshChainError extends Error {
  /** 0-based position in `hops`. Absent means the target, not a jump host. */
  hopIndex?: number
  hopServerId?: string
}

/**
 * How a hop is named to a person.
 *
 * The saved server's own name first: this app addresses jump hosts by the
 * friendly name of a server that already exists, so that is the string the
 * user chose and the one they can act on. `user@host:port` only when the hop
 * names no saved server, or names one this process has not cached yet.
 */
function hopLabel(hop: SshHop & { serverId?: string }): string {
  const name = hop.serverId ? getCachedServer(hop.serverId)?.name : undefined
  // The NAME INSTEAD OF the address, not beside it. These strings travel as
  // far as any other connection error does, and the MCP bridge is one of the
  // places they land — where an agent is deliberately never shown a hostname,
  // an address or an account. A hop that names a saved server always has a
  // name; one that does not was typed as an address by the user in the route
  // editor, so the address is the only handle they have on it and is the one
  // thing they can match it by.
  return name ?? `${hop.username}@${hop.host}:${hop.port || 22}`
}

/**
 * Attribute a failure to a hop, once.
 *
 * Idempotent on purpose: `acquireOne` opens the forward from the PREVIOUS hop
 * and then authenticates THIS one, so a forward failure would otherwise be
 * relabelled by the walk as the wrong end of the link it broke on. The first
 * layer to know is the one that names it.
 */
function atHop(err: unknown, hop: SshHop & { serverId?: string }, index: number, count: number): SshChainError {
  const e = (err instanceof Error ? err : new Error(String(err))) as SshChainError
  if (e.hopIndex !== undefined) return e
  const labelled: SshChainError = new Error(
    `Jump host ${index + 1} of ${count} — ${hopLabel(hop)} — could not be reached: ${e.message}`
  )
  labelled.hopIndex = index
  labelled.hopServerId = hop.serverId
  return labelled
}

// forwardOut on the previous hop opens a channel to the next hop's host:port,
// which becomes the transport socket for the next SSH client — a jump chain.
function hopForward(
  prev: Client,
  target: SshHop,
  /**
   * The hop the channel is being opened FROM, when there is one to name.
   *
   * This is the half of the distinction the walk cannot make on its own: the
   * bastion authenticated perfectly and then could not carry the connection
   * onwards, which is a different fault, in a different place, from the
   * bastion refusing us — and ssh2 gives both the same empty-reasoned string.
   */
  via?: { hop: SshHop & { serverId?: string }; index: number; count: number }
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    prev.forwardOut('127.0.0.1', 0, target.host, target.port || 22, (err, stream) => {
      if (!err) {
        resolve(stream as unknown as NodeJS.ReadableStream)
        return
      }
      if (!via) {
        reject(err)
        return
      }
      const failure: SshChainError = new Error(
        `Jump host ${via.index + 1} of ${via.count} — ${hopLabel(via.hop)} — authenticated, but could not ` +
          `open a connection onwards to ${target.host}:${target.port || 22}: ${err.message}. ` +
          'That is the jump host reaching the next address, not the next address refusing to authenticate.'
      )
      failure.hopIndex = via.index
      failure.hopServerId = via.hop.serverId
      reject(failure)
    })
  })
}

// Walk the jump chain, each hop tunnelled through the previous, then connect
// to the target. Shared by the shell (sshConnect) and SFTP services.
export async function openChain(
  cfg: SshHop & {
    hops?: SshHop[]
    vpnProfileId?: string
    cloudTarget?: CloudTarget
    serverName?: string
    serverId?: string
  },
  onHop?: (index: number, count: number) => void,
  /**
   * False for a caller with nobody in front of it, exactly as on `acquire`.
   *
   * This walker had no such parameter at all, so every caller on it took
   * `connectClient`'s default and could raise a verification-code dialog or a
   * trust-on-first-use dialog no matter who asked. `sshTest` is the one that
   * mattered: it is reached from the MCP bridge's `test_connection`, and its
   * own comment already said it does not prompt.
   */
  allowPrompt = true
): Promise<{ clients: Client[]; client: Client; close?: () => void }> {
  // A cloud server is dialled through whatever its provider brokered. Checked
  // first because it is the more specific case: a cloud target carries its own
  // address and credential, and the VPN question does not arise for one.
  if (cfg.cloudTarget) return openChainOverCloud(cfg, onHop, allowPrompt)
  // A server behind a VPN is dialled through a loopback forward into the
  // tunnel. Only the first hop needs rewriting — everything after it is
  // reached through the hop before, so the chain is already inside.
  if (cfg.vpnProfileId) return openChainOverVpn(cfg, onHop, allowPrompt)
  return openChainDirect(cfg, onHop, allowPrompt)
}

/**
 * The unpooled cloud path.
 *
 * `acquire` has its own (cloudDial) because the pool needs the release attached
 * to the CONNECTION rather than to the call. This one serves the callers that
 * deliberately do not pool - sshTest and sshOpenFresh, which exist to prove
 * that THIS credential authenticates right now - and hands the release back as
 * the chain's `close`, which those callers already invoke.
 */
async function openChainOverCloud(
  cfg: SshHop & {
    hops?: SshHop[]
    cloudTarget?: CloudTarget
    serverName?: string
    serverId?: string
  },
  onHop?: (index: number, count: number) => void,
  allowPrompt = true
): Promise<{ clients: Client[]; client: Client; close?: () => void }> {
  assertNoJumpChain(cfg)
  const { brokerFor } = await import('./cloud/providers')
  const target = cfg.cloudTarget as CloudTarget
  const prepared = await brokerFor(target.type).prepare(target)
  recordCloudLifecycle(target.type, cfg.serverName, prepared.notes)

  const next = { ...cfg, ...prepared.hop }

  try {
    const chain = await openChainDirect(next, onHop, allowPrompt)
    return {
      ...chain,
      // openChainDirect opens no transport of its own, so the release is the
      // whole teardown.
      close: () => {
        void prepared.release()
      }
    }
  } catch (err) {
    await prepared.release()
    throw err
  }
}

async function openChainOverVpn(
  cfg: SshHop & {
    hops?: SshHop[]
    vpnProfileId?: string
    cloudTarget?: CloudTarget
    serverName?: string
    serverId?: string
  },
  onHop?: (index: number, count: number) => void,
  allowPrompt = true
): Promise<{ clients: Client[]; client: Client; close?: () => void }> {
  const { vpnOpenForward, vpnStart } = await import('./vpn/manager')
  const vpnId = cfg.vpnProfileId as string

  const started = await vpnStart(vpnId)
  if (!started.ok) {
    // The VPN's own message, not a connect timeout twenty seconds later.
    throw new Error(started.error ?? 'The VPN for this server could not be started.')
  }

  const first = cfg.hops?.[0] ?? cfg
  let fwd: { port: number; close: () => void } | null = null
  try {
    fwd = await vpnOpenForward(vpnId, first.host, first.port, {
      kind: 'server',
      id: cfg.serverId ?? first.host,
      name: cfg.serverName ?? first.host
    })
  } catch (err) {
    // System mode has a real route and no forward to open, so dial directly.
    if ((err as { code?: string }).code !== 'unsupported') throw err
  }

  if (!fwd) {
    const { registerVpnConsumer } = await import('./vpn/dependencies')
    const release = registerVpnConsumer(vpnId, {
      kind: 'server',
      id: cfg.serverId ?? first.host,
      name: cfg.serverName ?? first.host
    })
    const chain = await openChainDirect(cfg, onHop, allowPrompt).catch((e) => {
      release()
      throw e
    })
    return { ...chain, close: release }
  }

  const local = fwd
  // Same rewrite, same reason to carry the real identity with it: this is the
  // other route a VPN-forwarded hop takes, and a host key filed under a
  // loopback port is filed under nothing.
  const rewritten: SshHop = {
    ...first,
    host: '127.0.0.1',
    port: local.port,
    hostKeyId: first.hostKeyId ?? `${first.host}:${first.port || 22}`
  }
  const next = cfg.hops?.length
    ? { ...cfg, hops: [rewritten, ...cfg.hops.slice(1)] }
    : { ...cfg, ...rewritten }

  try {
    const chain = await openChainDirect(next, onHop, allowPrompt)
    return { ...chain, close: () => local.close() }
  } catch (err) {
    local.close()
    throw err
  }
}

async function openChainDirect(
  cfg: SshHop & { hops?: SshHop[] },
  onHop?: (index: number, count: number) => void,
  allowPrompt = true
): Promise<{ clients: Client[]; client: Client }> {
  const hops = cfg.hops ?? []
  const clients: Client[] = []
  let sock: NodeJS.ReadableStream | undefined
  try {
    for (let i = 0; i < hops.length; i++) {
      onHop?.(i, hops.length)
      // Labelled here as well as on the pooled walk: tunnels, `Test route`,
      // sshTest and the ephemeral forwards a database dials all come through
      // this one, and a chain failure has to say which hop on every path that
      // can show one to a person.
      const client = await connectClient(hops[i], sock, allowPrompt).catch((err) => {
        throw atHop(err, hops[i], i, hops.length)
      })
      clients.push(client)
      sock = await hopForward(client, i + 1 < hops.length ? hops[i + 1] : cfg, {
        hop: hops[i],
        index: i,
        count: hops.length
      })
    }
    const client = await connectClient(cfg, sock, allowPrompt)
    clients.push(client)
    return { clients, client }
  } catch (err) {
    // Nobody else holds these: the chain is only handed out whole. A failure
    // at hop i used to leave hops 0..i-1 authenticated and open, one session
    // left on each bastion per failed attempt until the server timed it out.
    // Ending a client also closes the channel forwarded through it.
    for (const c of clients.reverse()) {
      try {
        c.end()
      } catch {
        /* a transport already gone must not replace the error naming the hop */
      }
    }
    throw err
  }
}

// ---------------------------------------------------------------- pooling
//
// One authenticated connection per server, shared by every terminal session,
// SFTP browser and metrics sampler — the equivalent of OpenSSH's
// ControlMaster. Without it each new session re-runs authentication, which on
// a server with two-factor auth means another code prompt every time.

/**
 * A name for ONE authentication, minted once and never reused.
 *
 * `key` below identifies a ROUTE — `srv:abc` is the same string before and
 * after a reconnect, which is exactly what the pool wants and exactly what a
 * caller asking "did this command run over the connection that wrote the file"
 * must not be given. This counter answers that question instead: every id is
 * distinct, ids for pooled and unpooled connections come from the same
 * sequence, and an unpooled connection is never entered into the pool — so
 * `pooledConnectionIds()` cannot contain a `fresh#` id unless somebody has
 * changed what unpooled means, which is the thing worth catching.
 */
let connectionSeq = 0
function mintConnectionId(prefix: 'pooled' | 'fresh'): string {
  connectionSeq += 1
  return `${prefix}#${connectionSeq}`
}

export interface PooledConnection {
  key: string
  /** This authentication, not this route. See mintConnectionId. */
  id: string
  host: string
  username: string
  client: Client
  refs: number
  idle?: ReturnType<typeof setTimeout>
  // The hop this connection was opened through, held for as long as this
  // connection lives so a shared bastion is not torn down underneath it.
  parent?: PooledConnection
  // Tears down whatever transport this connection was dialled through: a VPN
  // forward and its live-dependent registration, or a cloud provider's tunnel
  // and the temporary credential directory beside it. Held here rather than by
  // the caller because the pool outlives any one acquire(): the socket must
  // stay up until the last session using it lets go.
  transportRelease?: () => void
}

const pool = new Map<string, PooledConnection>()
/**
 * Opens in flight, with the intent each one was started under.
 *
 * `allowPrompt` is stored beside the promise because joining an open is
 * joining its ANSWER to a second factor, not just its socket. An unattended
 * open ends the connection rather than answering a challenge, so a terminal
 * that joined one got no verification-code dialog and a failure — which is
 * exactly "it is not asking for the code any more".
 */
const connecting = new Map<string, { promise: Promise<PooledConnection>; allowPrompt: boolean }>()

// Identity of a single hop. Includes the parent so the same host reached by a
// different route is not mistaken for the same connection.
export function hopKey(
  hop: SshHop & {
    serverId?: string
    vpnProfileId?: string
    cloudTarget?: CloudTarget
    poolTag?: string
  },
  parentKey?: string
): string {
  const self = hop.serverId
    ? `srv:${hop.serverId}`
    : `${hop.username}@${hop.host}:${hop.port || 22}`
  // The transport is part of a connection's identity, not a detail of how it
  // was dialled.
  //
  // `vpnProfileId` stops a server whose profile changed from reusing a pooled
  // connection still riding the old tunnel — the UI would say one network while
  // the bytes went over another.
  //
  // `poolTag` covers the sharper case: a hop dialled through a VPN forward has
  // had its host and port rewritten to an ephemeral loopback port, but a hop
  // with a serverId keys on that id alone — so without a tag, a direct
  // connection and a tunnelled one to the same server would share a key.
  //
  // It names the VPN and NOT the forward's port. A port that changes on every
  // call is an identity that never repeats, and a key that never repeats is a
  // pool that never hits: see vpnDial, where that cost every VPN-routed command
  // its own full authentication. The forward cannot go stale under a live
  // connection because the connection owns it -- `transportRelease` closes it when
  // the connection is destroyed, not when an acquire ends.
  //
  // `rev` is the credentials half of the same argument the VPN paragraph
  // above makes. A hop with a serverId keys on that id alone, so editing a
  // server's host, port, username or auth changed the record and left every
  // key identical -- the next connect was handed a pooled connection still
  // authenticated to the old box. Bumped by `updateServer` on every save, so
  // it also covers a credential rotation, which changes no field on the
  // record at all.
  //
  // APPENDED as its own `|` segment rather than folded into `self`, and that
  // is load-bearing: `keyOwnsServer` below accepts `srv:<id>` followed by a
  // `|`, so eviction and session recovery keep working untouched. Folding it
  // into `self` would break both silently.
  const via = hop.vpnProfileId ? `|vpn:${hop.vpnProfileId}` : ''
  const tag = hop.poolTag ? `|${hop.poolTag}` : ''
  const rev = hop.rev ? `|rev:${hop.rev}` : ''
  return parentKey ? `${parentKey}>${self}${via}${tag}${rev}` : `${self}${via}${tag}${rev}`
}

function destroy(conn: PooledConnection): void {
  try {
    conn.client.end()
  } catch {
    /* ignore */
  }
  // Let the bastion go once nothing is riding on it any more.
  if (conn.parent) release(conn.parent)
  // Same for the VPN forward underneath it. Doing this here rather than in
  // release() matters: release() is also the idle path, and a connection
  // sitting in the idle window still has a live socket through the forward.
  try {
    conn.transportRelease?.()
  } catch {
    /* a forward that is already gone must not stop the rest of the teardown */
  }
  conn.transportRelease = undefined
}

// Acquires one hop, reusing a live connection when there is one. `parent` must
// already be ref-held by the caller; ownership transfers to the returned
// connection, or is released when an existing one is reused instead.
async function acquireOne(
  hop: SshHop & { serverId?: string },
  parent: PooledConnection | null,
  allowPrompt = true,
  /** False on the one retry below, so this can never bounce more than once. */
  mayRetry = true,
  /**
   * Which hop `parent` is, so a forward that will not open can name it.
   *
   * Passed per call rather than held on the PooledConnection, and that is not
   * an accident: a pooled bastion is SHARED, and its position in the chain is a
   * property of the chain being walked, not of the connection. Two servers
   * behind the same bastion can sit at different depths.
   */
  via?: { hop: SshHop & { serverId?: string }; index: number; count: number }
): Promise<PooledConnection> {
  const key = hopKey(hop, parent?.key)

  const existing = pool.get(key)
  if (existing) {
    existing.refs++
    if (existing.idle) clearTimeout(existing.idle)
    existing.idle = undefined
    if (parent) release(parent)
    return existing
  }

  // Collapse concurrent opens so a terminal and a metrics poll starting
  // together authenticate once, not twice.
  const inflight = connecting.get(key)
  if (inflight) {
    try {
      const conn = await inflight.promise
      conn.refs++
      if (parent) release(parent)
      return conn
    } catch (err) {
      /**
       * An attended caller must not inherit an unattended refusal.
       *
       * The collapse above is right whenever the open succeeds — one code
       * typed, one authentication, every caller served. It is wrong when the
       * open was started by something that is not allowed to ask: the
       * keyboard-interactive handler ends that connection the moment a
       * challenge arrives, and the person who opened a terminal a millisecond
       * later then watches it fail having never been asked for anything.
       *
       * So wait for it — the unattended refusal is immediate, so this costs
       * milliseconds — and dial again with the dialog allowed. Waiting rather
       * than opening a second socket straight away is what keeps the success
       * path collapsed to a single authentication.
       */
      if (!allowPrompt || inflight.allowPrompt || !mayRetry) {
        if (parent) release(parent)
        throw err
      }
      return acquireOne(hop, parent, allowPrompt, false, via)
    }
  }

  const promise = (async () => {
    // Reached through the bastion when there is one.
    const sock = parent ? await hopForward(parent.client, hop, via) : undefined
    const client = await connectClient(hop, sock, allowPrompt)
    const conn: PooledConnection = {
      key,
      id: mintConnectionId('pooled'),
      host: hop.host,
      username: hop.username,
      client,
      refs: 1,
      parent: parent ?? undefined
    }
    pool.set(key, conn)
    client.on('close', () => {
      if (pool.get(key) === conn) pool.delete(key)
      // Release the VPN forward here too, not only from destroy().
      //
      // destroy() runs on the idle path, and with `setPoolIdle(-1)` it never
      // runs at all — so a connection the network dropped kept its loopback
      // listener, its goroutines in netd, and its live-dependent registration
      // for the life of the app. That registration is what the stop
      // confirmation counts, so it went on naming sessions that no longer
      // existed. A dead client can never need its forward again.
      try {
        conn.transportRelease?.()
      } catch {
        /* a forward already gone must not break the close path */
      }
      conn.transportRelease = undefined
    })
    return conn
  })().finally(() => {
    // Only if it is still ours: a failed open that an attended caller retried
    // has already been replaced here, and deleting that one would uncollapse
    // every joiner behind it.
    if (connecting.get(key)?.promise === promise) connecting.delete(key)
  })

  connecting.set(key, { promise, allowPrompt })
  try {
    return await promise
  } catch (err) {
    if (parent) release(parent)
    throw err
  }
}

// Every hop is pooled in its own right, so several servers behind the same
// bastion share one authenticated bastion connection — the code is requested
// once, not once per destination.
export async function acquire(
  cfg: SshHop & {
    serverId?: string
    hops?: SshHop[]
    vpnProfileId?: string
    cloudTarget?: CloudTarget
    serverName?: string
  },
  onHop?: (index: number, count: number) => void,
  // False for unattended callers. An unknown host is then refused rather than
  // raising a trust dialog nobody is present to reason about. Set in main only
  // — never taken from the renderer. See verifyHostKey.
  allowPrompt = true
): Promise<PooledConnection> {
  // Behind a VPN, the first hop is dialled through a loopback forward into the
  // tunnel. The forward is attached to the pooled connection rather than
  // released here, because the pool outlives this call — closing it now would
  // cut the connection the moment it was handed over.
  // A cloud server is reached through whatever its provider brokered: a tunnel,
  // or an address the provider resolved, plus a credential that expires on its
  // own. Same shape as vpnDial and released the same way - the process has to
  // outlive the acquire and die with the connection.
  /**
   * A cloud target the pool already holds is not brokered again.
   *
   * vpnDial is cheap enough to run and throw away on a pool hit - it starts an
   * already-running profile and opens one forward. Brokering a cloud
   * connection is not: it is three or four provider CLI invocations and, for a
   * private instance, spawning a tunnel and waiting for it to bind. Running
   * that on every acquire and discarding it on the hit would put several
   * seconds and several API calls behind every `sshExec` - and the metrics
   * sampler calls one on a timer, so it would spawn and kill a tunnel forever.
   *
   * Safe to check here because acquireOne's hit path is synchronous: nothing
   * awaits between the lookup below and its own, so the entry cannot vanish in
   * between. `connecting` is included so a second caller joins an open already
   * in flight instead of starting a second broker for the same server.
   */
  const cloudKey = cfg.cloudTarget && !cfg.hops?.length ? hopKey(cfg) : null
  if (cloudKey !== null && (pool.has(cloudKey) || connecting.has(cloudKey))) {
    return await acquireOne(cfg, null, allowPrompt)
  }

  /**
   * Cloud first, matching openChain.
   *
   * The two paths used to disagree - this one preferred the VPN, openChain
   * preferred the cloud target - so a server carrying both (a VPN can be
   * assigned to any server from the VPN panel, including a cloud one) behaved
   * one way for a terminal and the other for `Test connection`. Whichever rule
   * is right, they have to be the same rule.
   *
   * Cloud is the right one: the provider hands back either a loopback tunnel on
   * this machine or an address it resolved, and neither is reached over a VPN.
   * The VPN is not silently useful here, it is simply not in the path.
   */
  const dial = cfg.cloudTarget
    ? await cloudDial(cfg)
    : cfg.vpnProfileId
      ? await vpnDial(cfg)
      : null
  const effective = dial?.cfg ?? cfg

  const hops = effective.hops ?? []
  let parent: PooledConnection | null = null
  try {
    for (let i = 0; i < hops.length; i++) {
      onHop?.(i, hops.length)
      /**
       * ONE connection per bastion, shared by everything behind it.
       *
       * `acquireOne` keys each hop in its own right, so fifteen servers behind
       * one jump host authenticate to that jump host once and then ride
       * fifteen direct-tcpip channels on the single connection — OpenSSH's
       * ControlMaster, applied to the chain rather than only to the endpoint.
       * That is deliberately NOT one connection per target: `MaxStartups`
       * throttles and then refuses concurrent *handshakes*, which is exactly
       * what a sweep of an estate behind a shared bastion would produce, and
       * `MaxSessions` does not apply to forwarded channels at all
       * (sshd_config: it counts "shell, login or subsystem sessions", and 0
       * still permits forwarding). So the multiplexed shape is both the
       * cheaper one and the one that cannot trip a limit.
       *
       * `atHop` is what turns a failure here into something actionable: see
       * SshChainError. The hop walk is the only place that knows the index.
       */
      const at = i
      parent = await acquireOne(
        hops[at],
        parent,
        allowPrompt,
        true,
        // The hop BEFORE this one owns the forward being opened. The first hop
        // has none: it is dialled over a real socket.
        at > 0 ? { hop: hops[at - 1], index: at - 1, count: hops.length } : undefined
      ).catch((err) => {
        throw atHop(err, hops[at], at, hops.length)
      })
    }
    const conn = await acquireOne(effective, parent, allowPrompt, true,
      // A failure opening the forward from the LAST hop to the target is the
      // bastion failing to reach the target, not the target refusing us.
      hops.length > 0 ? { hop: hops[hops.length - 1], index: hops.length - 1, count: hops.length } : undefined
    )
    if (dial) {
      // Attach to whichever connection actually owns the socket. On a pool hit
      // the forward is redundant — the existing connection already has its own
      // — so release it immediately rather than leaking a listener per
      // acquire.
      if (conn.transportRelease) dial.release()
      else conn.transportRelease = dial.release
    }
    return conn
  } catch (err) {
    dial?.release()
    throw err
  }
}

/**
 * Have the cloud provider broker this connection, and return a config that
 * dials what it handed back.
 *
 * Deliberately the same shape as vpnDial below, because it is the same idea: an
 * outer transport that has to be brought up before the SSH dial and torn down
 * after the last user of it lets go. The difference is only who provides it.
 *
 * Everything cloud-specific stops here. What comes out is an ordinary SshHop -
 * an address, a username and a credential - so the chain walk, the pool, the
 * terminal, SFTP, the metrics sampler and the MCP tools below this line have no
 * idea a cloud was involved.
 */
/**
 * What the provider did, in order, for the connection log.
 *
 * Notes only - "Resolved the instance", "Opened an IAP tunnel". Never the
 * provider's own output, which carries account addresses and, in its debug
 * modes, bearer tokens. The debug log redacts every line it writes anyway;
 * this keeps the material out of it in the first place.
 */
function recordCloudLifecycle(provider: string, serverName: string | undefined, notes: string[]): void {
  debugRecord('cloud.prepare', { provider, server: serverName, steps: notes.join('; ') })
}

/**
 * A cloud target and a jump chain cannot both apply.
 *
 * The provider hands back either a loopback tunnel on THIS machine or an
 * address it resolved for us. Neither is reachable "through" a bastion, and
 * the rewrite would be nonsense in any case: the VPN path replaces the first
 * hop because a VPN carries the route to the bastion, whereas a cloud broker
 * produces the destination itself. Replacing hops[0] with it would dial the
 * target, then try to reach the real target through it.
 *
 * Refused rather than quietly ignored, because silently dropping a bastion is
 * how a connection ends up going somewhere the user did not intend.
 */
function assertNoJumpChain(cfg: { hops?: SshHop[] }): void {
  if (cfg.hops?.length) {
    throw new Error(
      'A cloud server cannot also be reached through jump hosts: the provider returns a ' +
        'local tunnel or an address of its own, which a bastion cannot carry. Remove the jump chain.'
    )
  }
}

async function cloudDial(
  cfg: SshHop & {
    serverId?: string
    hops?: SshHop[]
    cloudTarget?: CloudTarget
    serverName?: string
  }
): Promise<{ cfg: typeof cfg; release: () => void } | null> {
  const target = cfg.cloudTarget
  if (!target) return null
  assertNoJumpChain(cfg)

  const { brokerFor } = await import('./cloud/providers')
  const prepared = await brokerFor(target.type).prepare(target)
  recordCloudLifecycle(target.type, cfg.serverName, prepared.notes)

  // The target itself, never a hop: assertNoJumpChain above has established
  // there is no chain to rewrite.
  const next = { ...cfg, ...prepared.hop }

  return {
    cfg: next,
    release: () => {
      void prepared.release()
    }
  }
}

// Bring the profile up and open a forward to the first hop, returning a config
// that dials the loopback end of it.
async function vpnDial(
  cfg: SshHop & { serverId?: string; hops?: SshHop[]; vpnProfileId?: string; serverName?: string }
): Promise<{ cfg: SshHop & { serverId?: string; hops?: SshHop[] }; release: () => void } | null> {
  const { vpnOpenForward, vpnStart, vpnStatus } = await import('./vpn/manager')
  const vpnId = cfg.vpnProfileId as string

  const started = await vpnStart(vpnId)
  if (!started.ok) {
    throw new Error(started.error ?? 'The VPN for this server could not be started.')
  }

  /**
   * Started is not the same as carrying traffic.
   *
   * A Tailscale node that has not been authorised yet starts perfectly well —
   * the process is up, the engine is running, `vpnStart` reports success — and
   * routes nothing at all, because it is not on the tailnet. Forwarding
   * through it then produced a connection that sat there until the SSH
   * handshake deadline and failed with "Timed out", which says nothing about
   * the node, the tailnet or the authorisation waiting to be done. The user
   * sees a server that will not connect and a VPN that claims to be up.
   *
   * So the state is checked before anything is dialled, and the refusal names
   * the actual reason and where to fix it.
   */
  const vs = vpnStatus(vpnId)
  if (vs && vs.state !== 'connected') {
    if (vs.state === 'authenticating') {
      throw new Error(
        `${cfg.serverName ?? cfg.host} is reached through a VPN that has not been authorised yet. ` +
          'Open VPN and authorise the node — nothing can route through it until you do.'
      )
    }
    throw new Error(
      `${cfg.serverName ?? cfg.host} is reached through a VPN that is not connected ` +
        `(${vs.state}). ${vs.error ?? 'Open VPN to see why.'}`
    )
  }

  const first = cfg.hops?.[0] ?? cfg
  const consumer = {
    kind: 'server' as const,
    id: cfg.serverId ?? first.host,
    name: cfg.serverName ?? first.host
  }

  let fwd: { port: number; close: () => void }
  try {
    fwd = await vpnOpenForward(vpnId, first.host, first.port || 22, consumer)
  } catch (err) {
    // System mode routes for real, so there is nothing to forward. Register as
    // a dependent anyway: stopping the VPN still disconnects this session.
    if ((err as { code?: string }).code !== 'unsupported') throw err
    const { registerVpnConsumer } = await import('./vpn/dependencies')
    return { cfg, release: registerVpnConsumer(vpnId, consumer) }
  }

  const rewritten = {
    ...first,
    host: '127.0.0.1',
    port: fwd.port,
    // The host key still belongs to the server, not to the loopback port this
    // connection happens to be using. Without this the entry is written under
    // an address that is different every time, so the server is a stranger on
    // every connect.
    hostKeyId: first.hostKeyId ?? `${first.host}:${first.port || 22}`,
    // The VPN, NOT the forward's port.
    //
    // This used to be `fwd:${vpnId}:${fwd.port}`, and that port is freshly
    // allocated on every call -- so the pool key was different every time and
    // could never match. For any server reached over a VPN the pool therefore
    // never hit ONCE: every command opened a new forward, a new TCP connection
    // and a full new SSH authentication, while the previous connection sat in
    // the pool under its now-unreachable key until the idle timer reaped it
    // fifteen minutes later. A dozen commands in a row meant a dozen live
    // authenticated sessions to one host, which is what exhausts MaxSessions
    // and produces "Channel open failure: open failed".
    //
    // Dropping the port is safe because the forward's lifetime is already tied
    // to the CONNECTION rather than to the acquire: `conn.transportRelease` closes it
    // when the connection is destroyed, and a pool hit releases the redundant
    // one it just opened. The comment on hopKey feared reusing a connection
    // whose forward had closed; that cannot happen, because the forward outlives
    // exactly as long as the connection holding it does.
    poolTag: `fwd:${vpnId}`
  } as SshHop
  return {
    cfg: cfg.hops?.length
      ? { ...cfg, hops: [rewritten, ...cfg.hops.slice(1)] }
      : { ...cfg, ...rewritten },
    release: () => fwd.close()
  }
}

// How long an authenticated connection is kept after its last session closes.
// This is what decides how often a two-factor code has to be re-entered:
// while the master is alive, new sessions reuse it and skip authentication.
// 0 closes immediately; Infinity keeps it until the app exits.
let idleMs = 15 * 60_000

export function setPoolIdle(minutes: number): void {
  idleMs = minutes < 0 ? Infinity : minutes * 60_000
}

/**
 * A refused CHANNEL, as opposed to a command that ran and failed.
 *
 * sshd answers `Channel open failure: open failed` when it will not open
 * another channel on an existing connection -- most often because MaxSessions
 * (10 by default) is already used up, sometimes because the connection is
 * half-dead and only the server knows yet. Either way it is a fact about the
 * CONNECTION, and this app was reporting it as a fact about the command: the
 * exec came back as an ordinary failure and the connection went straight back
 * into the pool, so the next command drew the same bad connection and failed
 * identically.
 *
 * An agent firing commands in quick succession hits this and then keeps hitting
 * it: four failures in eighteen seconds against one host, with commands before
 * and after succeeding on the same host.
 */
export function isChannelOpenFailure(message: string | undefined): boolean {
  if (!message) return false
  return /channel open failure|open failed|administratively prohibited/i.test(message)
}

/**
 * Take a connection out of the pool so nothing else is handed it.
 *
 * The caller still has to `release()` its own reference; this only stops the
 * NEXT caller inheriting a connection already known to be bad.
 */
export function invalidate(conn: PooledConnection): void {
  if (pool.get(conn.key) === conn) pool.delete(conn.key)
}

/**
 * Does this pool key involve `serverId` at all — as the connection itself, or
 * as a bastion it was reached through?
 *
 * A chained key is `parent>self`. `hopKey` writes a server's own segment as
 * `srv:<id>`, optionally followed by `|vpn:…`, `|<poolTag>` and `|rev:…` — so
 * an exact match, or that same id followed by a `|`, is that server's segment.
 *
 * It used to ask only about the LAST segment, on the reasoning that the last
 * hop owns the socket. True, and not the question worth asking: a chain is
 * only as live as the bastion carrying it, so a jump host that was edited or
 * rebooted invalidates `srv:<bastion>>srv:<target>` as surely as it does the
 * direct connection to itself — and that key ends in the target, where the
 * old test never looked.
 */
export function keyOwnsServer(key: string, serverId: string): boolean {
  // EVERY segment, not just the last. A chained key is `parent>self`, so a
  // bastion whose own record changed -- or which went away with its sockets --
  // makes every chain THROUGH it stale, not merely the direct connection to
  // it. `srv:<bastion>>srv:<target>` has the bastion in a position the old
  // last-segment test could never see, so evicting a jump host left every
  // chain across it in the pool looking usable.
  return key
    .split('>')
    .some((seg) => seg === `srv:${serverId}` || seg.startsWith(`srv:${serverId}|`))
}

/**
 * Stop handing out the shared connection to a server, WITHOUT closing it.
 *
 * For a session recovering itself across a reboot. The pool is a
 * ControlMaster, so the reconnect after a drop is normally handed the very
 * socket the drop happened on — which is right when a channel closed under a
 * healthy connection and exactly wrong when the machine went away with it. A
 * server that closed cleanly self-evicts through the client's own `close`
 * event; one that was reset, fenced or powered off does not, and its entry sits
 * in the pool looking usable for as long as TCP takes to notice.
 *
 * NOT `poolClose`, and the difference is the whole reason this exists:
 * `poolClose` destroys the connection, which cuts every other terminal pane,
 * the SFTP browser and the metrics sampler riding on it — see the note on
 * `sshOpenFresh`, which refuses it for the same reason. Evicting only removes
 * it from the map: sessions already holding a reference keep theirs and it is
 * destroyed when the last of them lets go, while the next `acquire` misses and
 * authenticates afresh.
 */
export function poolEvictServer(serverId: string): number {
  let evicted = 0
  for (const [key] of [...pool]) {
    if (!keyOwnsServer(key, serverId)) continue
    pool.delete(key)
    evicted++
  }
  return evicted
}

export function release(conn: PooledConnection): void {
  conn.refs--
  if (conn.refs > 0) return
  if (idleMs === 0) {
    if (pool.get(conn.key) === conn) pool.delete(conn.key)
    destroy(conn)
    return
  }
  if (idleMs === Infinity) return
  conn.idle = setTimeout(() => {
    if (conn.refs > 0) return
    if (pool.get(conn.key) === conn) pool.delete(conn.key)
    destroy(conn)
  }, idleMs)
}

export interface PoolEntry {
  key: string
  host: string
  username: string
  sessions: number
}

export function poolList(): PoolEntry[] {
  return [...pool.values()].map((c) => ({
    key: c.key,
    host: c.host,
    username: c.username,
    sessions: c.refs
  }))
}

/**
 * Every authentication the pool is currently holding.
 *
 * Not `poolList()` with another column: this exists for callers that have to
 * PROVE something did not run over a shared connection, and handing them a
 * route key would let a reconnect satisfy the check by accident. See
 * `sshOpenFresh`.
 */
export function pooledConnectionIds(): string[] {
  return [...pool.values()].map((c) => c.id)
}

// Drops a shared connection now, forcing the next connect to authenticate.
export function poolClose(key: string): void {
  const conn = pool.get(key)
  if (!conn) return
  if (conn.idle) clearTimeout(conn.idle)
  pool.delete(key)
  destroy(conn)
}

export function poolDisposeAll(): void {
  for (const conn of [...pool.values()]) {
    if (conn.idle) clearTimeout(conn.idle)
    destroy(conn)
  }
  pool.clear()
}

export async function sshConnect(wc: WebContents, cfg: SshConnectConfig): Promise<void> {
  const { sessionId } = cfg
  sessions.set(sessionId, { conn: null, stream: null })

  try {
    status(wc, sessionId, 'connecting')
    const conn = await acquire(cfg, (i, count) =>
      status(wc, sessionId, 'hop', { hopIndex: i, hopCount: count })
    )
    const current = sessions.get(sessionId)
    if (!current) {
      // Closed while connecting.
      release(conn)
      return
    }
    current.conn = conn
    const target = conn.client

    status(wc, sessionId, 'authenticating', { hopCount: cfg.hops?.length ?? 0 })

    // A container shell is `exec` with a PTY rather than `shell`; everything
    // after this point — write, resize, close, the close reason — is identical,
    // which is the whole reason this is one code path and not a second
    // terminal.
    //
    // `initialCommand` is only ever produced by a validating builder in
    // shared/; see the field's own comment. Main does not re-derive it because
    // there is nothing to re-derive: it is a constant shape with one validated
    // identifier in it.
    const pty = { term: 'xterm-256color', cols: cfg.cols, rows: cfg.rows }
    type ShellCb = (err: Error | undefined, stream: ClientChannel) => void
    const open = (cb: ShellCb): void => {
      if (cfg.initialCommand) target.exec(cfg.initialCommand, { pty }, cb)
      else target.shell(pty, cb)
    }
    open((err, stream) => {
      if (err) {
        status(wc, sessionId, 'error', { message: err.message })
        cleanup(sessionId)
        return
      }
      const s = sessions.get(sessionId)
      if (!s) {
        stream.close()
        return
      }
      s.stream = stream
      status(wc, sessionId, 'ready')

      // Commands like `cat` on a large file arrive as hundreds of small
      // chunks. One IPC message each floods the renderer and stalls input, so
      // coalesce into at most one message per tick. A single keystroke echo
      // still goes out immediately — the timer only ever batches what arrives
      // within the same millisecond window.
      let pending: string[] = []
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      const flush = (): void => {
        flushTimer = null
        if (pending.length === 0) return
        const payload = pending.length === 1 ? pending[0] : pending.join('')
        pending = []
        send(wc, `ssh:data:${sessionId}`, payload)
      }
      const push = (d: Buffer): void => {
        pending.push(d.toString('utf8'))
        if (!flushTimer) flushTimer = setTimeout(flush, 0)
      }

      stream.on('data', push)
      stream.stderr.on('data', push)

      // 'exit' carries why the shell ended and always arrives before 'close'.
      // Worth forwarding: "signal HUP" is a server-side idle timeout, while
      // "exit 0" is someone typing `exit` — the same closed tab, very
      // different causes.
      let exit: SshCloseInfo = {}
      stream.on('exit', (code: number | null, signal?: string) => {
        exit = { code: code ?? undefined, signal: signal || undefined }
      })

      stream.on('close', () => {
        if (flushTimer) clearTimeout(flushTimer)
        flush()
        send(wc, `ssh:close:${sessionId}`, exit)
        cleanup(sessionId)
      })
    })
  } catch (err) {
    status(wc, sessionId, 'error', { message: err instanceof Error ? err.message : String(err) })
    cleanup(sessionId)
  }
}

export function sshWrite(sessionId: string, data: string): void {
  sessions.get(sessionId)?.stream?.write(data)
}

export function sshResize(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
}

export function sshClose(sessionId: string): void {
  cleanup(sessionId)
}

export interface ExecResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
  error?: string
  truncated: boolean
  /**
   * Bytes dropped by EXEC_OUTPUT_CAP, across both streams.
   *
   * `truncated` says that something went; this says how much. A caller that
   * persists a result needs the number, not the flag: "the output was longer
   * than this" is not a fact anyone can act on a month later, while "2.8 MB
   * elided" is. Counting it costs one addition per dropped chunk.
   */
  elided: number
}

const EXEC_OUTPUT_CAP = 200_000 // bytes per stream, enough for inspection output without unbounded memory use

// Non-interactive command execution over the same pooled connection the
// interactive terminal uses (ssh2's exec channel rather than shell), for the
// MCP bridge's execute_command tool. A single command in, buffered result
// out — never a persistent shell.
// Rejects if `p` has not settled in time.
//
// Used to bring connection setup inside the caller's timeout. `unref` so a
// pending guard never holds the process open — the answer is already decided by
// the time it fires.
//
// The race does not cancel `p`. A connection that authenticates after the
// deadline would be a live session nobody holds, so `onLate` is handed it to
// dispose of.
function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  message: string,
  onLate?: (late: T) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(message))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  p.then(
    (late) => {
      if (timedOut) onLate?.(late)
    },
    () => undefined
  )
  // race attaches handlers to `p`, so a late settle is not an unhandled
  // rejection.
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

export async function sshExec(
  cfg: SshHop & { serverId?: string; hops?: SshHop[] },
  command: string,
  timeoutMs = 30_000,
  // False for anything that fans out. See the note on sshExecStream: N unknown
  // hosts must not become N stacked trust dialogs.
  allowPrompt = true
): Promise<ExecResult> {
  let conn: PooledConnection | null = null
  try {
    // Inside the timeout, not before it. The timer used to be armed only after
    // this resolved, so TCP connect, every hop's forward, and an unknown-host
    // trust prompt were all outside the timeout the caller asked for — a
    // "30 second" exec could wait indefinitely on a host that accepted the
    // connection and then said nothing. The guarantee the signature offers is
    // now the one it gives.
    conn = await withDeadline(
      acquire(cfg, undefined, allowPrompt),
      timeoutMs,
      `Timed out after ${timeoutMs}ms connecting`,
      release
    )
    const first = await execOn(conn.client, command, timeoutMs)
    if (!isChannelOpenFailure(first.error)) return first

    /**
     * Retried exactly once, on a connection that is definitely new.
     *
     * SAFE TO RETRY, and only because of what this specific error means: the
     * channel was never opened, so the command did not run. A retry after a
     * failure that might have executed would be how an agent installs a package
     * twice; this one cannot have.
     *
     * The bad connection leaves the pool first, so the fresh `acquire` cannot
     * be handed it back.
     */
    invalidate(conn)
    release(conn)
    conn = await withDeadline(
      acquire(cfg, undefined, allowPrompt),
      timeoutMs,
      `Timed out after ${timeoutMs}ms connecting`,
      release
    )
    const second = await execOn(conn.client, command, timeoutMs)
    if (!isChannelOpenFailure(second.error)) return second
    // Twice on a connection that was new the second time is the server's
    // answer, not a stale socket. Say which, because "open failed" on its own
    // sends people to look at the network.
    return {
      ...second,
      error:
        `${second.error} — the server refused to open another session channel, twice, the second ` +
        'time on a brand new connection. That usually means its MaxSessions limit is reached: ' +
        'other sessions on this host have to end, or sshd needs a higher MaxSessions.'
    }
  } catch (err) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      truncated: false,
      elided: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (conn) release(conn)
  }
}

/**
 * One buffered command over one client that is already open.
 *
 * Split out of `sshExec` so the unpooled path below runs the SAME channel
 * handling. The output cap, the elision count and the command timeout are
 * safety properties, and a second copy of them written for the verification
 * path would be a second thing to drift.
 */
function execOn(client: Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    let settled = false
    const done = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      done({
        ok: false,
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        truncated: false,
        elided: 0,
        error: `Command timed out after ${timeoutMs}ms`
      })
    }, timeoutMs)

    // ssh2 THROWS `Not connected` synchronously rather than calling back with
    // an error when the client is already down, so a command run over a
    // connection that has closed rejected this promise instead of answering
    // it. Every caller here is written against "an ExecResult always comes
    // back", and the case that matters most is a confirmation whose session
    // died mid-check: it has to read as a failed verification rather than as
    // an exception on the way to deciding whether a key change is permanent.
    const start = (): void => {
      client.exec(command, (err, stream) => {
        if (err) {
          done({
            ok: false,
            stdout: '',
            stderr: '',
            code: null,
            signal: null,
            truncated: false,
            elided: 0,
            error: err.message
          })
          return
        }
        let stdout = ''
        let stderr = ''
        let truncated = false
        let elided = 0
        const append = (current: string, chunk: Buffer): string => {
          if (current.length >= EXEC_OUTPUT_CAP) {
            truncated = true
            // Counted rather than merely noted. A caller that writes this
            // result down has to be able to say how much went; see ExecResult.
            elided += chunk.length
            return current
          }
          return current + chunk.toString('utf8')
        }
        stream.on('data', (d: Buffer) => {
          stdout = append(stdout, d)
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr = append(stderr, d)
        })
        stream.on('close', (code: number | null, signal?: string) => {
          done({ ok: true, stdout, stderr, code: code ?? null, signal: signal ?? null, truncated, elided })
        })
      })
    }
    try {
      start()
    } catch (err) {
      done({
        ok: false,
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        truncated: false,
        elided: 0,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

/**
 * A connection that is nobody else's — roadmap item 23, rule 2.
 *
 * WHAT THIS IS FOR. Item 23 stages an `authorized_keys` change behind a
 * watchdog the host arms on itself, and refuses to make it permanent until a
 * SECOND, INDEPENDENT session has proved the host still lets us in. Every other
 * caller in this file is the opposite of independent by design: `sshExec`,
 * `sshExecStream` and the terminal all go through `acquire()`, which is a
 * ControlMaster — the second command reuses the first command's authentication
 * and never speaks to sshd's auth layer at all. Running the confirmation over
 * one of those would prove only that the session which wrote the file can still
 * write files, which is not a claim about who can log in.
 *
 * BYPASSED, NOT DROPPED, and the choice is deliberate. `poolClose()` exists and
 * would also force a new authentication — by tearing down the connection every
 * open terminal pane and the metrics sampler are riding on, at the exact moment
 * the operator is watching a key change. Waiting for the pool to go idle is not
 * available either: `release()` only arms the idle timer at zero references,
 * and `setPoolIdle(-1)` makes it Infinity so it is never armed at all. So this
 * goes around the pool instead, through `openChain()` — a new TCP connection,
 * the full handshake, the key presented to sshd again — and leaves whatever the
 * pool is holding untouched. Two live connections for a few seconds is the
 * cost, and it buys a fact nothing else here can produce.
 *
 * WHAT IT REPORTS, and why the caller is given evidence rather than a boolean.
 * `authenticatedAt` is when THIS handshake completed, so a caller can require
 * that it happened after the write it is confirming; `pooledConnectionIds` is
 * what the pool held while this ran, so a caller can require that it is not
 * among them. Neither is checked here — a transport that graded its own
 * independence would be marking its own homework, and the rule belongs with the
 * protocol it protects. See src/main/services/access.ts.
 */
export interface FreshSession {
  /** This authentication. Never a pooled id; see mintConnectionId. */
  connectionId: string
  /** Every authentication the pool held while this one was opened. */
  pooledConnectionIds: string[]
  /** When this connection's handshake completed, as observed here. */
  authenticatedAt: number
  exec: (command: string, timeoutMs?: number) => Promise<ExecResult>
  /** Ends this connection. Must be called; nothing else is holding it. */
  close: () => void
}

export async function sshOpenFresh(
  cfg: SshHop & { serverId?: string; hops?: SshHop[]; vpnProfileId?: string; serverName?: string },
  /**
   * PASS ONE if the person may be asked something, and do not rely on this
   * default.
   *
   * Thirty seconds is right for a connect nobody has to participate in and
   * wrong for one that can raise a verification-code dialog: the dialog itself
   * waits two minutes and the handshake underneath waits 135 seconds, extended
   * deliberately the moment a challenge arrives (see connectClient). An outer
   * flat limit shorter than either of those does not fail the connection
   * honestly — it cancels one the operator is in the middle of answering, and
   * the caller reports whatever a cancelled connect means to it.
   *
   * The access committer passes what is left of its rollback window; see
   * accessOpenBudgetMs.
   */
  timeoutMs = 30_000,
  now: () => number = Date.now
): Promise<FreshSession> {
  // Snapshotted on BOTH sides of the connect, and unioned. A pooled connection
  // opened while this one was being negotiated is still a connection this one
  // must not turn out to be, and taking only the "before" list would miss it.
  const before = pooledConnectionIds()
  const chain = await withDeadline(
    /**
     * PROMPTS, on purpose, and it is the only unpooled caller that does.
     *
     * An operator has just confirmed a key change on their own servers and is
     * watching it land; a second factor asked for here is the answer to that,
     * and refusing instead would make access commits impossible on precisely
     * the hosts most likely to require one. The usual worry does not apply
     * because this path is NOT exposed to the MCP bridge — see the note above
     * the access handlers in main — so there is no agent whose request could
     * turn into a dialog.
     *
     * Stated rather than taken from the default, because the default is the
     * other way round for every other caller of openChain.
     */
    openChain(cfg, undefined, true),
    timeoutMs,
    `Timed out after ${timeoutMs}ms opening an independent session`,
    closeChain
  )
  const authenticatedAt = now()
  const pooled = [...new Set([...before, ...pooledConnectionIds()])]
  let closed = false
  return {
    connectionId: mintConnectionId('fresh'),
    pooledConnectionIds: pooled,
    authenticatedAt,
    exec: (command, ms = timeoutMs) => execOn(chain.client, command, ms),
    close: () => {
      if (closed) return
      closed = true
      closeChain(chain)
    }
  }
}

// Every client in the chain, not just the last: a bastion opened for this one
// connection is this connection's to close, and leaving it up would be an
// authenticated session nothing is tracking.
function closeChain(chain: { clients: Client[]; close?: () => void }): void {
  for (const c of chain.clients) {
    try {
      c.end()
    } catch {
      /* already gone */
    }
  }
  try {
    chain.close?.()
  } catch {
    /* a VPN forward already closed must not break the teardown */
  }
}

/**
 * Run a command and stream its output until it is stopped.
 *
 * `sshExec` buffers and resolves; a following log never resolves, so this
 * hands back a stop function instead. The connection is acquired from the pool
 * like everything else, and released exactly once — a tail that leaks its
 * reference keeps an authenticated master alive for a pane the user closed,
 * which is invisible until an estate wonders why its sshd is busy.
 */
export async function sshExecStream(
  cfg: SshHop & { serverId?: string; hops?: SshHop[] },
  command: string,
  handlers: {
    onStdout: (chunk: string) => void
    onStderr: (chunk: string) => void
    onClose: (code: number | null) => void
    onError: (message: string) => void
  },
  // False for anything that fans out across several hosts at once.
  //
  // `metrics.ts` threads this through for the background sweep precisely so an
  // unattended sample cannot raise a trust-on-first-use dialog. Log tailing and
  // broadcast have the same problem for a different reason: the user IS present,
  // but a batch across fifteen hosts with unknown keys would raise fifteen
  // stacked modals, and a stack of identical dialogs is not a decision anyone
  // can reason about — it is the click-through this app's host verification
  // exists to avoid. An unknown host fails that host with a reason instead, and
  // the fix is to connect to it once directly.
  allowPrompt = true
): Promise<() => void> {
  const conn = await acquire(cfg, undefined, allowPrompt)
  let released = false
  const releaseOnce = (): void => {
    if (released) return
    released = true
    release(conn)
  }

  return await new Promise<() => void>((resolve, reject) => {
    conn.client.exec(command, (err, stream) => {
      if (err) {
        releaseOnce()
        reject(err)
        return
      }
      stream.on('data', (c: Buffer) => handlers.onStdout(c.toString('utf8')))
      stream.stderr.on('data', (c: Buffer) => handlers.onStderr(c.toString('utf8')))
      stream.on('close', (code: number | null) => {
        releaseOnce()
        handlers.onClose(code ?? null)
      })
      stream.on('error', (e: Error) => {
        releaseOnce()
        handlers.onError(e.message)
      })
      resolve(() => {
        // Signal first so the remote process actually dies rather than being
        // orphaned holding the file open; then close the channel regardless of
        // whether the server honoured the signal, and release either way.
        try {
          stream.signal('TERM')
        } catch {
          /* server may not support signals; close still ends the channel */
        }
        try {
          stream.close()
        } catch {
          /* already gone */
        }
        releaseOnce()
      })
    })
  })
}

export function sshDisposeAll(): void {
  for (const id of [...sessions.keys()]) cleanup(id)
  poolDisposeAll()
}

function cleanup(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  try {
    s.stream?.close()
  } catch {
    /* ignore */
  }
  // The connection itself is shared, so hand it back rather than closing it.
  if (s.conn) release(s.conn)
}

/**
 * Try a connection and throw it away.
 *
 * Add Server had no way to check a profile before saving it. The form has four
 * to six chances to be wrong, and the only feedback loop was: save, open a
 * session, and read a failure on a different screen — where, until recently,
 * four different causes shared one sentence. Worse, saving PERSISTS the profile
 * before it is known to work, so a first-run user ends up with a connection
 * list containing entries that have never connected.
 *
 * Deliberately NOT pooled. `acquire` puts the connection in the pool for reuse,
 * which is right for a session and wrong here: a test that left a live
 * connection behind would mean pressing Test twice created two, and a test of a
 * profile the user then edits would leave a pooled connection keyed to settings
 * that no longer exist. `openChain` gives the same dial, the same jump-host
 * chain and the same host-key verification with nothing retained.
 *
 * `allowPrompt` DEFAULTS TO FALSE, and that default is the whole point.
 *
 * This is not only the connection editor's Test button. `probeServer` on the
 * MCP bridge calls it for `test_connection`, so an agent could reach it — and a
 * first contact with an unknown host would then raise the trust dialog, with
 * answering it recording a trust decision as a side effect of something the
 * agent asked for. The same goes for a second factor: a code dialog out of an
 * agent's probe is attached to nothing the person did.
 *
 * The comment here used to say this already. It was not true, because there was
 * no parameter on `openChain` to pass — every caller took the default, which is
 * the opposite one. Now the default is the safe one and the caller with a person
 * in front of it, the `ssh:test` IPC handler, is the one that opts in.
 */
export async function sshTest(
  cfg: SshHop & { hops?: SshHop[]; vpnProfileId?: string; serverName?: string; serverId?: string },
  allowPrompt = false
): Promise<{ ok: boolean; error?: string }> {
  let chain: { clients: Client[]; close?: () => void } | null = null
  try {
    chain = await openChain(cfg, undefined, allowPrompt)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // Only a chain that opened reaches here with one; a chain that failed
    // part-way was already closed by openChainDirect.
    if (chain) closeChain(chain)
  }
}
