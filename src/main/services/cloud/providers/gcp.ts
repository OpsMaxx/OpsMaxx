/**
 * Google Cloud.
 *
 * `gcloud` does the parts that are Google's: authentication, IAM, OS Login, and
 * - where the machine has no public address - the IAP tunnel. What comes back
 * is a local port and a POSIX username, and from there it is an ordinary SSH
 * connection.
 *
 * OS Login accepts plain SSH keys, so no certificate is needed here. We publish
 * an ephemeral public key with a short TTL, use it once, and let it expire.
 * Nothing is enrolled on the user's account permanently and nothing is stored.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SshHop } from '../../../../shared/ssh'
import {
  CloudError,
  assertValidCloudTarget,
  type CloudTarget,
  type GcpTarget
} from '../../../../shared/cloud'
import {
  AUTH_STATUS_ARGS,
  GCP_PROJECTS_ARGS,
  gcpDescribeInstanceArgs,
  gcpIapTunnelArgs,
  gcpInstancesArgs,
  gcpOsLoginAddKeyArgs,
  gcpOsLoginProfileArgs,
  gcpZonesArgs,
  classifyCloudOutput,
  parseGcpAuthStatus,
  parseGcpInstanceAddresses,
  parseGcpInstances,
  parseGcpOsLoginUsername,
  parseGcpProjects,
  parseGcpZones,
  parseIapTunnelPort,
  type CloudAccount,
  type CloudAuthStatus,
  type CloudInstance,
  type CloudLocation
} from '../../../../shared/cloudCommands'
import { detectProvider, type ProviderDetectionResult } from '../binaries'
import { cloudExec, cloudExecOrThrow } from '../cloudExec'
import { assertRunning, generateEphemeralKey } from './shared'
import type { CloudBroker, PreparedCloudConnection } from './types'

/**
 * How long the published key lives.
 *
 * Long enough to survive a slow handshake and an MFA prompt, short enough that
 * a key left behind by a crash is not a standing grant. OS Login removes it.
 */
const KEY_TTL_SECONDS = 300

/** How long to wait for gcloud to say which port it took. */
const TUNNEL_READY_MS = 45_000

export const gcpBroker: CloudBroker = {
  detect(force?: boolean): Promise<ProviderDetectionResult> {
    return detectProvider('gcp', force)
  },

  async authStatus(): Promise<CloudAuthStatus> {
    const res = await cloudExec('gcp', [...AUTH_STATUS_ARGS.gcp])
    if (!res.ok) return { authenticated: false, account: '' }
    return parseGcpAuthStatus(res.stdout)
  },

  async listAccounts(): Promise<CloudAccount[]> {
    return parseGcpProjects(await cloudExecOrThrow('gcp', [...GCP_PROJECTS_ARGS]))
  },

  async listLocations(account: string): Promise<CloudLocation[]> {
    return parseGcpZones(await cloudExecOrThrow('gcp', gcpZonesArgs(account)))
  },

  async listInstances(account: string, location: string): Promise<CloudInstance[]> {
    return parseGcpInstances(await cloudExecOrThrow('gcp', gcpInstancesArgs(account, location)))
  },

  async prepare(target: CloudTarget): Promise<PreparedCloudConnection> {
    assertValidCloudTarget(target)
    if (target.type !== 'gcp') throw new CloudError('unknown', 'Not a Google Cloud target.')
    return await prepareGcp(target)
  }
}

async function prepareGcp(target: GcpTarget): Promise<PreparedCloudConnection> {
  const notes: string[] = []
  const cleanups: (() => Promise<void>)[] = []
  const release = async (): Promise<void> => {
    // Reverse order, and never throw: this runs while unwinding a failure as
    // often as after a clean close.
    for (const fn of cleanups.reverse()) {
      try {
        await fn()
      } catch {
        /* a release that throws would replace a useful error with a useless one */
      }
    }
    cleanups.length = 0
  }

  try {
    const described = parseGcpInstanceAddresses(
      await cloudExecOrThrow('gcp', gcpDescribeInstanceArgs(target))
    )
    assertRunning(described.running, described.state)
    notes.push('Resolved the instance')

    // 'auto' means: tunnel when there is no public address to dial, which is
    // the case that actually needs one.
    const useIap = target.transport === 'iap' || (target.transport === 'auto' && !described.external)
    if (target.transport === 'direct' && !described.external) {
      throw new CloudError(
        'network-unreachable',
        'This instance has no external address, so a direct connection cannot reach it. Use IAP.'
      )
    }

    const key = generateEphemeralKey()
    await cloudExecOrThrow(
      'gcp',
      gcpOsLoginAddKeyArgs(target.project, writeTempPublicKey(key.publicKey), KEY_TTL_SECONDS)
    )
    notes.push('Published a temporary key to OS Login')

    const username = parseGcpOsLoginUsername(
      await cloudExecOrThrow('gcp', gcpOsLoginProfileArgs(target.project))
    )
    if (!username) {
      throw new CloudError(
        'iam-permission-denied',
        'OS Login did not return a login name for this account.'
      )
    }

    let host = described.external
    let port = 22
    if (useIap) {
      const tunnel = await startIapTunnel(target)
      cleanups.push(tunnel.stop)
      host = '127.0.0.1'
      port = tunnel.port
      notes.push('Opened an IAP tunnel')
    } else {
      notes.push('Connecting directly')
    }

    const hop: SshHop = {
      host,
      port,
      username,
      auth: 'key',
      privateKey: key.privateKey,
      /**
       * File the host key under the INSTANCE, whichever route was taken.
       *
       * For a tunnel this is the familiar reason: a loopback port that differs
       * every time is an identity that can never match twice, and a later
       * unrelated service on that port would inherit the trust.
       *
       * For a direct connection it matters just as much, which the first
       * version of this missed. A GCE instance's external address is not
       * stable - it changes when the machine is stopped and started - so a key
       * filed under the address means every restart looks like a brand new
       * host and asks to be trusted again, while the old entry lingers. Under
       * the instance name, the answer is remembered once, and a genuinely
       * changed key is reported as changed instead of being waved through as
       * unknown.
       */
      hostKeyId: `gcp:${target.project}/${target.zone}/${target.instance}`
    }
    return { hop, release, notes }
  } catch (e) {
    await release()
    throw e
  }
}

/**
 * OS Login takes the key as a file path, not as the key itself.
 *
 * gcloud offers no way to pass the material inline, so it has to be written
 * somewhere first. 0600, in a directory only this user can read, swept up
 * shortly after - the public half is not a secret, but leaving a file per
 * connection behind in the temp directory is its own small mess.
 */
function writeTempPublicKey(publicKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'opsmaxx-gcp-'))
  const path = join(dir, 'id.pub')
  writeFileSync(path, `${publicKey}\n`, { mode: 0o600 })
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 60_000).unref()
  return path
}

interface Tunnel {
  port: number
  stop: () => Promise<void>
}

/**
 * Start `gcloud compute start-iap-tunnel` and wait for it to name its port.
 *
 * Long-running, and deliberately NOT put under the VPN supervisor: that exists
 * to keep an engine alive across crashes with backoff and restart policy, and
 * this process must do the opposite - die with the connection it serves. A
 * restart would silently rebind a different port that nothing is dialling.
 */
async function startIapTunnel(target: GcpTarget): Promise<Tunnel> {
  const detected = await detectProvider('gcp')
  if (!detected.installed || !detected.executablePath) {
    throw new CloudError('cli-not-installed', detected.error, { provider: 'gcp' })
  }

  const child: ChildProcess = spawn(detected.executablePath, gcpIapTunnelArgs(target), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env
  })

  const stop = async (): Promise<void> => {
    if (!child.killed) child.kill('SIGTERM')
  }

  return await new Promise<Tunnel>((resolve, reject) => {
    let output = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        void stop()
        reject(new CloudError('tunnel-failed', 'The tunnel did not become ready in time.'))
      })
    }, TUNNEL_READY_MS)

    const onText = (chunk: Buffer): void => {
      output += chunk.toString()
      const port = parseIapTunnelPort(output)
      if (port !== null) finish(() => resolve({ port, stop }))
    }
    // gcloud logs progress to stderr; stdout is watched too rather than
    // assuming which stream a future version picks.
    child.stderr?.on('data', onText)
    child.stdout?.on('data', onText)

    child.on('error', (e) =>
      finish(() => reject(new CloudError('tunnel-failed', e.message, { provider: 'gcp' })))
    )
    child.on('exit', (code) =>
      finish(() => {
        // The tunnel's own output is the only account of why, and it is the
        // richest signal we get - classified rather than shown raw.
        const fault = classifyCloudOutput(output, 'gcp') ?? 'tunnel-failed'
        reject(
          new CloudError(fault, `The tunnel exited with status ${String(code)}.`, {
            provider: 'gcp'
          })
        )
      })
    )
  })
}
