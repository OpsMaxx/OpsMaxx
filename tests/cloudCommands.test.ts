import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CloudError, type AwsTarget, type AzureTarget, type GcpTarget } from '../src/shared/cloud'
import {
  AWS_BOOTSTRAP_REGION,
  AWS_PROFILES_ARGS,
  AZURE_SUBSCRIPTIONS_ARGS,
  GCP_PROJECTS_ARGS,
  awsAuthStatusArgs,
  awsDescribeInstanceArgs,
  awsInstancesArgs,
  awsOpenTunnelArgs,
  awsRegionsArgs,
  awsSendPublicKeyArgs,
  azureResourceGroupsArgs,
  azureSshConfigArgs,
  azureVmsArgs,
  classifyCloudOutput,
  gcpDescribeInstanceArgs,
  gcpIapTunnelArgs,
  gcpInstancesArgs,
  gcpOsLoginAddKeyArgs,
  gcpZonesArgs,
  parseAwsAuthStatus,
  parseAwsInstanceAddresses,
  parseAwsInstances,
  parseAwsProfiles,
  parseAwsRegions,
  parseAwsVersion,
  parseAzVersion,
  parseAzureAuthStatus,
  parseAzureResourceGroups,
  parseAzureSubscriptions,
  parseAzureVms,
  parseGcloudVersion,
  parseGcpAuthStatus,
  parseGcpInstanceAddresses,
  parseGcpInstances,
  parseGcpOsLoginUsername,
  parseGcpProjects,
  parseGcpZones,
  parseIapTunnelPort
} from '../src/shared/cloudCommands'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', 'cloud', name), 'utf8')

const GCP: GcpTarget = {
  type: 'gcp',
  project: 'example-prod-security',
  zone: 'me-central2-c',
  instance: 'prod-web-01',
  transport: 'iap'
}

const AWS: AwsTarget = {
  type: 'aws',
  profile: 'production',
  region: 'me-central-1',
  instanceId: 'i-0123456789abcdef0',
  osUser: 'ubuntu',
  transport: 'auto'
}

const AZURE: AzureTarget = {
  type: 'azure',
  subscription: 'Production',
  resourceGroup: 'production-rg',
  vm: 'prod-server-01',
  authentication: 'entra'
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

describe('argv builders', () => {
  it('builds the IAP tunnel command, letting the OS pick the local port', () => {
    expect(gcpIapTunnelArgs(GCP)).toEqual([
      'compute',
      'start-iap-tunnel',
      'prod-web-01',
      '22',
      '--project',
      'example-prod-security',
      '--zone',
      'me-central2-c',
      '--local-host-port=localhost:0'
    ])
  })

  it('builds the EC2 Instance Connect key push', () => {
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample opsmaxx'
    expect(awsSendPublicKeyArgs(AWS, publicKey)).toEqual([
      'ec2-instance-connect',
      'send-ssh-public-key',
      '--instance-id',
      'i-0123456789abcdef0',
      '--instance-os-user',
      'ubuntu',
      '--ssh-public-key',
      publicKey,
      '--region',
      'me-central-1',
      '--profile',
      'production',
      '--output',
      'json'
    ])
  })

  it('builds the Azure ssh config request', () => {
    expect(azureSshConfigArgs(AZURE, '/tmp/x/config')).toEqual([
      'ssh',
      'config',
      '--file',
      '/tmp/x/config',
      '--resource-group',
      'production-rg',
      '--name',
      'prod-server-01',
      '--subscription',
      'Production',
      '--overwrite',
      '--yes'
    ])
  })

  it('asks every provider for machine-readable output', () => {
    const jsonish = (args: string[]): boolean =>
      args.some((a) => a === 'json' || a.endsWith('=json'))
    expect(jsonish(gcpInstancesArgs('example-prod-security', 'me-central2-c'))).toBe(true)
    expect(jsonish(gcpZonesArgs('example-prod-security'))).toBe(true)
    expect(jsonish(GCP_PROJECTS_ARGS as unknown as string[])).toBe(true)
    expect(jsonish(awsInstancesArgs('production', 'me-central-1'))).toBe(true)
    expect(jsonish(awsRegionsArgs('production'))).toBe(true)
    expect(jsonish(azureVmsArgs('Production', 'production-rg'))).toBe(true)
    expect(jsonish(azureResourceGroupsArgs('Production'))).toBe(true)
    expect(jsonish(AZURE_SUBSCRIPTIONS_ARGS as unknown as string[])).toBe(true)
    // The one exception, and it needs no JSON: a list of names with no
    // structure to lose.
    expect(AWS_PROFILES_ARGS).toEqual(['configure', 'list-profiles'])
  })

  it('bootstraps the region list from a region that exists everywhere', () => {
    expect(awsRegionsArgs('production')).toContain(AWS_BOOTSTRAP_REGION)
  })

  it('asks Azure for power state, or the list greys out nothing', () => {
    expect(azureVmsArgs('Production', 'production-rg')).toContain('--show-details')
  })

  it('bounds the OS Login key to a TTL, so nothing is left on the account', () => {
    const args = gcpOsLoginAddKeyArgs('example-prod-security', '/tmp/k.pub', 300)
    expect(args).toContain('--ttl=300s')
    expect(args).toContain('--key-file=/tmp/k.pub')
  })

  // The reason builders take an argv array at all.
  it('refuses to interpolate a value that would read as an option', () => {
    const builders: [string, () => unknown][] = [
      ['gcpIapTunnelArgs', () => gcpIapTunnelArgs({ ...GCP, instance: '--flags-file=/etc/passwd' })],
      ['gcpDescribeInstanceArgs', () => gcpDescribeInstanceArgs({ ...GCP, project: '-x' })],
      ['gcpZonesArgs', () => gcpZonesArgs('--flags-file=/etc/passwd')],
      ['gcpInstancesArgs', () => gcpInstancesArgs('ok-project', '-z')],
      ['awsInstancesArgs', () => awsInstancesArgs('-p', 'me-central-1')],
      ['awsRegionsArgs', () => awsRegionsArgs('-p')],
      ['awsAuthStatusArgs', () => awsAuthStatusArgs('-p')],
      ['awsSendPublicKeyArgs', () => awsSendPublicKeyArgs({ ...AWS, osUser: '-o' }, 'ssh-ed25519 AAAA')],
      ['awsOpenTunnelArgs', () => awsOpenTunnelArgs({ ...AWS, instanceId: '-i' }, 5000)],
      ['awsDescribeInstanceArgs', () => awsDescribeInstanceArgs({ ...AWS, region: '-r' })],
      ['azureVmsArgs', () => azureVmsArgs('Production', '-g')],
      ['azureResourceGroupsArgs', () => azureResourceGroupsArgs('-s')],
      ['azureSshConfigArgs', () => azureSshConfigArgs({ ...AZURE, vm: '-n' }, '/tmp/x')]
    ]
    for (const [name, build] of builders) {
      expect(build, `${name} must refuse an option-shaped value`).toThrow(CloudError)
    }
  })

  it('never emits an argument list containing a shell metacharacter it invented', () => {
    // Not a quoting test - there is no shell. This asserts the builders stay
    // argv-shaped: one concept per element, nothing concatenated together.
    const all = [
      ...gcpIapTunnelArgs(GCP),
      ...awsInstancesArgs('production', 'me-central-1'),
      ...azureVmsArgs('Production', 'production-rg')
    ]
    for (const arg of all) {
      expect(arg.includes(';'), arg).toBe(false)
      expect(arg.includes('&&'), arg).toBe(false)
      expect(arg.includes('|'), arg).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('version parsers', () => {
  it('reads each CLI version out of its own format', () => {
    expect(parseGcloudVersion('Google Cloud SDK 458.0.1\nbq 2.0.101\ncore 2024.01.12\n')).toBe(
      '458.0.1'
    )
    expect(parseAwsVersion('aws-cli/2.15.30 Python/3.11.6 Darwin/23.2.0 source/arm64')).toBe(
      '2.15.30'
    )
    expect(parseAzVersion(fixture('az-version.json'))).toBe('2.57.0')
  })

  it('returns something rather than throwing on unrecognised output', () => {
    expect(parseGcloudVersion('')).toBe('')
    expect(parseAzVersion('not json at all')).toBe('')
  })
})

describe('auth status parsers', () => {
  it('reports the active gcloud account, ignoring merely-present ones', () => {
    expect(parseGcpAuthStatus(fixture('gcp-auth-list.json'))).toEqual({
      authenticated: true,
      account: 'someone@example.com'
    })
  })

  it('treats a credentialed but inactive gcloud account as signed out', () => {
    const none = JSON.stringify([{ account: 'old@example.com', status: '' }])
    expect(parseGcpAuthStatus(none).authenticated).toBe(false)
  })

  it('treats a successful AWS caller identity as proof of live credentials', () => {
    expect(parseAwsAuthStatus(fixture('aws-sts-caller-identity.json'))).toEqual({
      authenticated: true,
      account: 'arn:aws:iam::123456789012:user/example-user'
    })
  })

  it('reports the Azure signed-in user', () => {
    expect(parseAzureAuthStatus(fixture('az-account-show.json'))).toEqual({
      authenticated: true,
      account: 'someone@example.com'
    })
  })

  it('treats a disabled Azure subscription as unusable', () => {
    const disabled = JSON.stringify({ name: 'Old', state: 'Disabled', user: { name: 'x@y.z' } })
    expect(parseAzureAuthStatus(disabled).authenticated).toBe(false)
  })

  it('reports signed out for empty or malformed output', () => {
    for (const text of ['', '[]', '{}', 'not json']) {
      expect(parseGcpAuthStatus(text).authenticated, text).toBe(false)
      expect(parseAwsAuthStatus(text).authenticated, text).toBe(false)
      expect(parseAzureAuthStatus(text).authenticated, text).toBe(false)
    }
  })
})

describe('discovery parsers', () => {
  it('lists GCP projects and drops ones being deleted', () => {
    const projects = parseGcpProjects(fixture('gcp-projects.json'))
    expect(projects.map((p) => p.id)).toEqual(['example-prod-security', 'example-staging'])
  })

  it('lists GCP zones and drops ones that are down', () => {
    expect(parseGcpZones(fixture('gcp-zones.json')).map((z) => z.id)).toEqual([
      'me-central2-c',
      'us-central1-a'
    ])
  })

  it('reads GCP instances, shortening the zone URL to its name', () => {
    const instances = parseGcpInstances(fixture('gcp-instances.json'))
    expect(instances).toEqual([
      {
        id: 'prod-web-01',
        name: 'prod-web-01',
        state: 'RUNNING',
        location: 'me-central2-c',
        running: true
      },
      {
        id: 'prod-worker-02',
        name: 'prod-worker-02',
        state: 'TERMINATED',
        location: 'me-central2-c',
        running: false
      }
    ])
  })

  it('reads AWS profiles from plain text', () => {
    expect(parseAwsProfiles('default\nproduction\n\nstaging\n').map((p) => p.id)).toEqual([
      'default',
      'production',
      'staging'
    ])
  })

  it('reads AWS regions', () => {
    expect(parseAwsRegions(fixture('aws-describe-regions.json')).map((r) => r.id)).toEqual([
      'me-central-1',
      'us-east-1'
    ])
  })

  it('flattens AWS reservations and falls back to the id when there is no Name tag', () => {
    const instances = parseAwsInstances(fixture('aws-describe-instances.json'))
    expect(instances).toEqual([
      {
        id: 'i-0123456789abcdef0',
        name: 'prod-api-01',
        state: 'running',
        location: 'me-central-1a',
        running: true
      },
      {
        id: 'i-000000001111aaaab',
        name: 'i-000000001111aaaab',
        state: 'stopped',
        location: 'me-central-1a',
        running: false
      }
    ])
  })

  it('lists Azure subscriptions by ID, displayed by name, dropping disabled ones', () => {
    const subs = parseAzureSubscriptions(fixture('az-account-list.json'))
    // The ID is a GUID on purpose: a display name may contain a space, and on
    // Windows these tools are reached through cmd.exe where a space is syntax.
    expect(subs.map((s) => s.id)).toEqual([
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    ])
    expect(subs.map((s) => s.name)).toEqual(['Production', 'Staging'])
  })

  it('lists Azure resource groups', () => {
    expect(parseAzureResourceGroups(fixture('az-group-list.json')).map((g) => g.id)).toEqual([
      'production-rg',
      'staging-rg'
    ])
  })

  it("reads Azure power state out of --show-details' wording", () => {
    const vms = parseAzureVms(fixture('az-vm-list.json'))
    expect(vms.map((v) => [v.id, v.running])).toEqual([
      ['prod-server-01', true],
      ['prod-server-02', false]
    ])
  })

  it('returns an empty list rather than throwing on junk', () => {
    for (const text of ['', 'not json', '{}', 'null']) {
      expect(parseGcpInstances(text), text).toEqual([])
      expect(parseAwsInstances(text), text).toEqual([])
      expect(parseAzureVms(text), text).toEqual([])
      expect(parseGcpProjects(text), text).toEqual([])
      expect(parseAzureSubscriptions(text), text).toEqual([])
    }
  })
})

describe('connection detail parsers', () => {
  it('reads the port gcloud chose for the tunnel', () => {
    const stderr =
      'Testing if tunnel connection works.\nListening on port [51234].\n'
    expect(parseIapTunnelPort(stderr)).toBe(51234)
  })

  it('returns null rather than a guess when the port line is absent', () => {
    // The caller fails with tunnel-failed instead of dialling a port it made up.
    for (const text of ['', 'Listening on port [].', 'Listening on port [99999999].', 'ERROR: ...']) {
      expect(parseIapTunnelPort(text), text).toBe(null)
    }
  })

  it('reads GCP instance addresses and state', () => {
    expect(parseGcpInstanceAddresses(fixture('gcp-instance-describe.json'))).toEqual({
      external: '203.0.113.10',
      internal: '10.20.0.4',
      state: 'RUNNING',
      running: true
    })
  })

  it('reads AWS instance addresses and state', () => {
    expect(parseAwsInstanceAddresses(fixture('aws-describe-instances.json'))).toEqual({
      external: '203.0.113.25',
      internal: '10.0.1.15',
      state: 'running',
      running: true
    })
  })

  it('reads the primary POSIX name OS Login assigned', () => {
    expect(parseGcpOsLoginUsername(fixture('gcp-oslogin-profile.json'))).toBe('someone_example_com')
  })

  it('survives an instance with no external address', () => {
    const priv = JSON.stringify({
      status: 'RUNNING',
      networkInterfaces: [{ networkIP: '10.0.0.9' }]
    })
    expect(parseGcpInstanceAddresses(priv)).toEqual({
      external: '',
      internal: '10.0.0.9',
      state: 'RUNNING',
      running: true
    })
  })
})

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classifying provider output', () => {
  const cases: [string, string][] = [
    // Expired must beat merely-absent: both mention credentials.
    ['auth-expired', 'Error loading SSO Token: Token for example has expired'],
    ['auth-expired', 'ExpiredToken: The security token included in the request is expired'],
    ['auth-expired', 'Reauthentication required. Please run: gcloud auth login'],
    ['auth-expired', 'AADSTS700082: The refresh token has expired due to inactivity.'],
    ['not-authenticated', 'You do not currently have an active account selected.'],
    ['not-authenticated', 'Unable to locate credentials. You can configure credentials by running "aws configure".'],
    ['not-authenticated', "Please run 'az login' to setup account."],
    ['iam-permission-denied', "PERMISSION_DENIED: Required 'compute.instances.get' permission"],
    ['iam-permission-denied', 'UnauthorizedOperation: You are not authorized to perform this operation.'],
    ['iam-permission-denied', 'AuthorizationFailed: The client does not have authorization'],
    ['instance-stopped', 'IncorrectInstanceState: The instance is not in a valid state for this operation'],
    ['resource-not-found', "InvalidInstanceID.NotFound: The instance ID 'i-0123456789abcdef0' does not exist"],
    ['resource-not-found', "ERROR: The resource 'projects/x/zones/y/instances/z' was not found"],
    ['tunnel-failed', "Error while connecting [4033: 'not authorized']."],
    ['network-unreachable', 'Could not connect to the endpoint URL: "https://ec2.me-central-1.amazonaws.com/"'],
    ['connection-timeout', 'ReadTimeout: Read timed out.'],
    ['ssh-permission-denied', 'Permission denied (publickey).']
  ]

  for (const [fault, text] of cases) {
    it(`reads "${text.slice(0, 48)}..." as ${fault}`, () => {
      expect(classifyCloudOutput(text)).toBe(fault)
    })
  }

  it('returns null when it recognises nothing, rather than guessing', () => {
    // The caller falls back to cli-failed and shows the provider's own text.
    expect(classifyCloudOutput('')).toBe(null)
    expect(classifyCloudOutput('Something entirely novel happened.')).toBe(null)
  })
})
