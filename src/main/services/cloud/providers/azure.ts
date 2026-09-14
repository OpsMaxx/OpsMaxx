/**
 * Microsoft Azure.
 *
 * The only one of the three that needs a certificate. `az ssh config` asks
 * Entra ID for a short-lived SSH certificate, writes it beside a freshly
 * generated private key, and emits an OpenSSH config block naming both. We read
 * that block, hand the certificate and key to the SSH layer, and delete the
 * directory when the connection ends.
 *
 * ssh2 cannot present a certificate unaided; see services/cloud/certKey.ts and
 * patches/ssh2+1.17.0.patch. This is the provider that forced both.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { SshHop } from '../../../../shared/ssh'
import { parseSshConfig, type SshConfigHost } from '../../../../shared/sshconfig'
import {
  CloudError,
  assertValidCloudTarget,
  type AzureTarget,
  type CloudTarget
} from '../../../../shared/cloud'
import {
  AUTH_STATUS_ARGS,
  AZURE_SUBSCRIPTIONS_ARGS,
  azureResourceGroupsArgs,
  azureSshConfigArgs,
  azureVmsArgs,
  parseAzureAuthStatus,
  parseAzureResourceGroups,
  parseAzureSubscriptions,
  parseAzureVms,
  type CloudAccount,
  type CloudAuthStatus,
  type CloudInstance,
  type CloudLocation
} from '../../../../shared/cloudCommands'
import { detectProvider, type ProviderDetectionResult } from '../binaries'
import { cloudExec, cloudExecOrThrow } from '../cloudExec'
import { assertRunning } from './shared'
import type { CloudBroker, PreparedCloudConnection } from './types'

export const azureBroker: CloudBroker = {
  detect(force?: boolean): Promise<ProviderDetectionResult> {
    return detectProvider('azure', force)
  },

  async authStatus(): Promise<CloudAuthStatus> {
    const res = await cloudExec('azure', [...AUTH_STATUS_ARGS.azure])
    if (!res.ok) return { authenticated: false, account: '' }
    return parseAzureAuthStatus(res.stdout)
  },

  async listAccounts(): Promise<CloudAccount[]> {
    return parseAzureSubscriptions(await cloudExecOrThrow('azure', [...AZURE_SUBSCRIPTIONS_ARGS]))
  },

  async listLocations(account: string): Promise<CloudLocation[]> {
    return parseAzureResourceGroups(
      await cloudExecOrThrow('azure', azureResourceGroupsArgs(account))
    )
  },

  async listInstances(account: string, location: string): Promise<CloudInstance[]> {
    return parseAzureVms(await cloudExecOrThrow('azure', azureVmsArgs(account, location)))
  },

  async prepare(target: CloudTarget): Promise<PreparedCloudConnection> {
    assertValidCloudTarget(target)
    if (target.type !== 'azure') throw new CloudError('unknown', 'Not an Azure target.')
    return await prepareAzure(target)
  }
}

async function prepareAzure(target: AzureTarget): Promise<PreparedCloudConnection> {
  const notes: string[] = []

  // Everything Azure writes lands here, and all of it is credential material:
  // a private key and a certificate. 0700 by mkdtemp, and removed on release
  // whether the connection succeeded or not.
  const dir = mkdtempSync(join(tmpdir(), 'opsmaxx-azure-'))
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* never throw while unwinding */
    }
  }

  try {
    const vms = parseAzureVms(
      await cloudExecOrThrow('azure', azureVmsArgs(target.subscription, target.resourceGroup))
    )
    const vm = vms.find((v) => v.name === target.vm)
    if (!vm) {
      throw new CloudError('resource-not-found', 'That VM is not in this resource group.')
    }
    assertRunning(vm.running, vm.state)
    notes.push('Resolved the VM')

    const configPath = join(dir, 'config')
    await cloudExecOrThrow('azure', azureSshConfigArgs(target, configPath))
    notes.push('Obtained a Microsoft Entra ID certificate')

    const entry = readAzureConfig(configPath)
    const certificate = readRelative(dir, entry.certificateFile, 'certificate')
    const privateKey = readRelative(dir, entry.identityFile, 'private key')

    const hop: SshHop = {
      host: entry.hostName,
      port: entry.port,
      username: entry.user,
      auth: 'certificate',
      certificate,
      privateKey,
      hostKeyId: `azure:${target.subscription}/${target.resourceGroup}/${target.vm}`
    }
    return { hop, release, notes }
  } catch (e) {
    await release()
    throw e
  }
}

interface AzureSshEntry {
  hostName: string
  user: string
  port: number
  identityFile: string
  certificateFile: string
}

/**
 * Read what `az ssh config` wrote.
 *
 * Parsed with the same OpenSSH config parser the `~/.ssh/config` importer uses
 * rather than a bespoke reader: it already handles `Key=value`, quoting and
 * continuation, and this file is the same format.
 *
 * `CertificateFile` is not one of the directives that parser promotes to a
 * field, so it comes back in `extras` - which is exactly what `extras` is for.
 */
function readAzureConfig(path: string): AzureSshEntry {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new CloudError('cli-failed', 'The Azure CLI did not write an SSH configuration.')
  }

  const hosts = parseSshConfig(text)
  const entry = hosts.find((h) => h.hostName && identityOf(h) && certificateOf(h))
  if (!entry) {
    throw new CloudError(
      'cli-failed',
      'The Azure CLI wrote a configuration with no certificate in it.'
    )
  }

  return {
    hostName: entry.hostName,
    user: entry.user,
    port: entry.port || 22,
    identityFile: identityOf(entry),
    certificateFile: certificateOf(entry)
  }
}

function identityOf(h: SshConfigHost): string {
  return h.identityFile ?? h.extras.IdentityFile ?? ''
}

function certificateOf(h: SshConfigHost): string {
  return h.extras.CertificateFile ?? h.extras.certificatefile ?? ''
}

/**
 * Read a file Azure named, refusing to leave the directory it wrote.
 *
 * The paths come out of a file another program produced, which makes them
 * untrusted input in the ordinary sense. Confining them to the temporary
 * directory means a malformed or hostile config cannot turn into a read of
 * an arbitrary file on this machine.
 */
function readRelative(dir: string, named: string, what: string): string {
  if (!named) throw new CloudError('cli-failed', `The Azure CLI named no ${what}.`)
  const resolved = resolve(isAbsolute(named) ? named : join(dir, named))
  // `startsWith` is not containment: /tmp/az-ab is a prefix of /tmp/az-abc.
  // Compare the relative path instead, which is what actually answers "is this
  // inside".
  const rel = relative(resolve(dir), resolved)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new CloudError('cli-failed', `The Azure CLI named a ${what} outside its own directory.`)
  }
  try {
    return readFileSync(resolved, 'utf8')
  } catch {
    throw new CloudError('cli-failed', `The ${what} the Azure CLI named could not be read.`)
  }
}
