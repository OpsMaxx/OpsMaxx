/**
 * AWS EC2.
 *
 * The cleanest of the three, because EC2 Instance Connect was designed for
 * exactly this: `send-ssh-public-key` publishes a key the instance will accept
 * for sixty seconds, and that is the entire credential. Nothing is enrolled,
 * nothing is stored, no `.pem` is ever distributed, and a key left behind by a
 * crash has already expired by the time anyone could use it.
 *
 * Where the instance has no public address, `open-tunnel` provides the route
 * through an EC2 Instance Connect Endpoint.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'

import type { SshHop } from '../../../../shared/ssh'
import {
  CloudError,
  assertValidCloudTarget,
  type AwsTarget,
  type CloudTarget
} from '../../../../shared/cloud'
import {
  AWS_PROFILES_ARGS,
  awsAuthStatusArgs,
  awsDescribeInstanceArgs,
  awsInstancesArgs,
  awsOpenTunnelArgs,
  awsRegionsArgs,
  awsSendPublicKeyArgs,
  classifyCloudOutput,
  parseAwsAuthStatus,
  parseAwsInstanceAddresses,
  parseAwsInstances,
  parseAwsProfiles,
  parseAwsRegions,
  type CloudAccount,
  type CloudAuthStatus,
  type CloudInstance,
  type CloudLocation
} from '../../../../shared/cloudCommands'
import { detectProvider, type ProviderDetectionResult } from '../binaries'
import { cloudExec, cloudExecOrThrow } from '../cloudExec'
import { assertRunning, freeLocalPort, generateEphemeralKey } from './shared'
import type { CloudBroker, PreparedCloudConnection } from './types'

/**
 * How long to wait for the tunnel to start listening.
 *
 * `open-tunnel` prints nothing useful on success - it simply begins forwarding -
 * so readiness is established by connecting to the port rather than by reading
 * its output.
 */
const TUNNEL_READY_MS = 30_000

export const awsBroker: CloudBroker = {
  detect(force?: boolean): Promise<ProviderDetectionResult> {
    return detectProvider('aws', force)
  },

  async authStatus(account?: string): Promise<CloudAuthStatus> {
    // Without a profile there is no question to ask: AWS credentials are
    // per-profile, and "are you signed in" has no global answer.
    if (!account) return { authenticated: false, account: '' }
    const res = await cloudExec('aws', awsAuthStatusArgs(account))
    if (!res.ok) return { authenticated: false, account: '' }
    return parseAwsAuthStatus(res.stdout)
  },

  async listAccounts(): Promise<CloudAccount[]> {
    return parseAwsProfiles(await cloudExecOrThrow('aws', [...AWS_PROFILES_ARGS]))
  },

  async listLocations(account: string): Promise<CloudLocation[]> {
    return parseAwsRegions(await cloudExecOrThrow('aws', awsRegionsArgs(account)))
  },

  async listInstances(account: string, location: string): Promise<CloudInstance[]> {
    return parseAwsInstances(await cloudExecOrThrow('aws', awsInstancesArgs(account, location)))
  },

  async prepare(target: CloudTarget): Promise<PreparedCloudConnection> {
    assertValidCloudTarget(target)
    if (target.type !== 'aws') throw new CloudError('unknown', 'Not an AWS target.')
    return await prepareAws(target)
  }
}

async function prepareAws(target: AwsTarget): Promise<PreparedCloudConnection> {
  const notes: string[] = []
  const cleanups: (() => Promise<void>)[] = []
  const release = async (): Promise<void> => {
    for (const fn of cleanups.reverse()) {
      try {
        await fn()
      } catch {
        /* never throw while unwinding */
      }
    }
    cleanups.length = 0
  }

  try {
    const described = parseAwsInstanceAddresses(
      await cloudExecOrThrow('aws', awsDescribeInstanceArgs(target))
    )
    assertRunning(described.running, described.state)
    notes.push('Resolved the instance')

    const useEice =
      target.transport === 'eice' || (target.transport === 'auto' && !described.external)
    if (target.transport === 'ip' && !described.external && !described.internal) {
      throw new CloudError('network-unreachable', 'This instance has no address to dial.')
    }

    let host = described.external || described.internal
    let port = 22
    if (useEice) {
      const tunnel = await startEiceTunnel(target)
      cleanups.push(tunnel.stop)
      host = '127.0.0.1'
      port = tunnel.port
      notes.push('Opened an EC2 Instance Connect Endpoint tunnel')
    } else {
      notes.push('Connecting directly')
    }

    // Published LAST, so the sixty-second window starts as late as possible:
    // opening a tunnel first can take several of those seconds, and a window
    // that expires mid-handshake fails as an ordinary rejected credential.
    const key = generateEphemeralKey()
    await cloudExecOrThrow('aws', awsSendPublicKeyArgs(target, key.publicKey.trim()))
    notes.push('Published a 60-second key through EC2 Instance Connect')

    const hop: SshHop = {
      host,
      port,
      username: target.osUser,
      auth: 'key',
      privateKey: key.privateKey,
      // Under the instance id whichever route was taken, and for both of the
      // reasons the GCP broker sets out: a tunnel's loopback port never repeats,
      // and a public IPv4 address is reassigned when an instance is stopped and
      // started unless it carries an Elastic IP.
      hostKeyId: `aws:${target.region}/${target.instanceId}`
    }
    return { hop, release, notes }
  } catch (e) {
    await release()
    throw e
  }
}

interface Tunnel {
  port: number
  stop: () => Promise<void>
}

/**
 * Start `aws ec2-instance-connect open-tunnel` on a local port.
 *
 * Normally this command is used as an OpenSSH ProxyCommand, speaking the
 * tunnel over its own stdio. We ask for `--local-port` instead so that ssh2 can
 * dial it like any other address - which is what keeps the rest of OpsMaxx
 * (SFTP, metrics, Docker) working against an EICE instance rather than only a
 * terminal.
 */
async function startEiceTunnel(target: AwsTarget): Promise<Tunnel> {
  const detected = await detectProvider('aws')
  if (!detected.installed || !detected.executablePath) {
    throw new CloudError('cli-not-installed', detected.error, { provider: 'aws' })
  }

  const port = await freeLocalPort()
  const child: ChildProcess = spawn(detected.executablePath, awsOpenTunnelArgs(target, port), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env
  })

  const stop = async (): Promise<void> => {
    if (!child.killed) child.kill('SIGTERM')
  }

  let output = ''
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()))
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()))

  // Readiness is "the port answers", because the command prints nothing on
  // success. Polling is the honest way to know, and it also catches the case
  // where the process is alive but never managed to bind.
  const deadline = Date.now() + TUNNEL_READY_MS
  for (;;) {
    if (child.exitCode !== null) {
      throw new CloudError(
        classifyCloudOutput(output, 'aws') ?? 'tunnel-failed',
        `The tunnel exited with status ${String(child.exitCode)}.`,
        { provider: 'aws' }
      )
    }
    if (await portAnswers(port)) return { port, stop }
    if (Date.now() > deadline) {
      await stop()
      throw new CloudError('tunnel-failed', 'The tunnel did not start listening in time.', {
        provider: 'aws'
      })
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function portAnswers(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1000, () => done(false))
  })
}
