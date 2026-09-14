/**
 * What we ask `gcloud`, `aws` and `az` to do, and how we read their answers.
 *
 * Builders return an argv ARRAY and never a string. There is no shell anywhere
 * on this path, so nothing here needs quoting - and nothing here may acquire
 * any, because a builder that returns a string is a builder someone will later
 * pass to a shell. Every interpolated value goes through `safeArgument` on the
 * way in, which is belt-and-braces over the validators in cloud.ts: by the time
 * a value reaches a builder it has already been checked, and the point of
 * checking again is that a builder added later inherits the guarantee instead
 * of depending on its author remembering.
 *
 * Parsers read machine-readable output only - `--format=json`, `--output json`.
 * Human-formatted tables are never parsed: their columns move between releases,
 * they truncate long values with no marker, and they localise. Where a CLI has
 * no JSON mode for something we need (the port `start-iap-tunnel` chose), the
 * parser is narrow, anchored, and tested against real captured output.
 *
 * Everything here is pure, which is the house split: builders and parsers in
 * shared/ and tested with no process, execution in main/.
 */

import {
  safeArgument,
  type AwsTarget,
  type AzureTarget,
  type CloudFault,
  type CloudProvider,
  type GcpTarget
} from './cloud'

// ---------------------------------------------------------------------------
// What discovery returns, normalised across three very different vocabularies
// ---------------------------------------------------------------------------

/** A GCP project, an AWS profile, or an Azure subscription. */
export interface CloudAccount {
  /** What the CLI needs back to address it. */
  id: string
  /** What a person calls it. Equal to `id` when the provider has no separate name. */
  name: string
}

/** A GCP zone, an AWS region, or an Azure resource group. */
export interface CloudLocation {
  id: string
  name: string
}

/** One machine, from whichever list the provider keeps them in. */
export interface CloudInstance {
  /** The identifier the connection profile stores. */
  id: string
  /** The display name, which for AWS is a tag and may be absent. */
  name: string
  /** The provider's own word for the state, shown as-is. */
  state: string
  /** Zone, region or resource group, depending on provider. */
  location: string
  /**
   * Whether it is running. Kept separate from `state` because the three
   * providers spell it differently ('RUNNING', 'running', 'VM running') and the
   * UI needs a boolean to grey a row out.
   */
  running: boolean
}

// ---------------------------------------------------------------------------
// Detection and authentication
// ---------------------------------------------------------------------------

/**
 * Ask the tool what version it is.
 *
 * Azure is the odd one: `az --version` prints a paragraph, so we ask for the
 * JSON form instead and read one field out of it.
 */
export const VERSION_ARGS = {
  gcp: ['--version'],
  aws: ['--version'],
  azure: ['version', '--output', 'json']
} as const

export const AUTH_STATUS_ARGS = {
  gcp: ['auth', 'list', '--format=json'],
  azure: ['account', 'show', '--output', 'json']
} as const

/**
 * Who AWS thinks we are, under a given profile.
 *
 * `sts get-caller-identity` is the right question rather than reading the
 * credentials file: it is the only one whose answer accounts for an expired SSO
 * session, an assumed role, and instance metadata, all of which look fine on
 * disk and fail at call time.
 */
export function awsAuthStatusArgs(profile: string): string[] {
  return [
    'sts',
    'get-caller-identity',
    '--output',
    'json',
    '--profile',
    safeArgument(profile, 'Profile')
  ]
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const GCP_PROJECTS_ARGS = ['projects', 'list', '--format=json']

export function gcpZonesArgs(project: string): string[] {
  return [
    'compute',
    'zones',
    'list',
    '--project',
    safeArgument(project, 'Project'),
    '--format=json'
  ]
}

export function gcpInstancesArgs(project: string, zone: string): string[] {
  return [
    'compute',
    'instances',
    'list',
    '--project',
    safeArgument(project, 'Project'),
    '--zones',
    safeArgument(zone, 'Zone'),
    '--format=json'
  ]
}

/** Profiles come from the user's own config file; the CLI lists them for us. */
export const AWS_PROFILES_ARGS = ['configure', 'list-profiles']

/**
 * The region list has to be requested FROM a region, which is a chicken-and-egg
 * the API does not solve for us. `us-east-1` is the bootstrap: it is the one
 * region that exists in every commercial partition, and it is used only to ask
 * the question, never to address anything.
 */
export const AWS_BOOTSTRAP_REGION = 'us-east-1'

export function awsRegionsArgs(profile: string): string[] {
  return [
    'ec2',
    'describe-regions',
    '--output',
    'json',
    '--profile',
    safeArgument(profile, 'Profile'),
    '--region',
    AWS_BOOTSTRAP_REGION
  ]
}

export function awsInstancesArgs(profile: string, region: string): string[] {
  return [
    'ec2',
    'describe-instances',
    '--output',
    'json',
    '--profile',
    safeArgument(profile, 'Profile'),
    '--region',
    safeArgument(region, 'Region')
  ]
}

export const AZURE_SUBSCRIPTIONS_ARGS = ['account', 'list', '--output', 'json']

export function azureResourceGroupsArgs(subscription: string): string[] {
  return [
    'group',
    'list',
    '--subscription',
    safeArgument(subscription, 'Subscription'),
    '--output',
    'json'
  ]
}

/**
 * `--show-details` is what adds the power state. Without it every VM comes back
 * with no indication of whether it is running, and the list greys out nothing.
 * It costs an extra call per VM on Azure's side, which is why it is not the
 * default and why we ask for it explicitly.
 */
export function azureVmsArgs(subscription: string, resourceGroup: string): string[] {
  return [
    'vm',
    'list',
    '--subscription',
    safeArgument(subscription, 'Subscription'),
    '--resource-group',
    safeArgument(resourceGroup, 'Resource group'),
    '--show-details',
    '--output',
    'json'
  ]
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/**
 * Open an IAP tunnel to port 22 and let the OS choose the local port.
 *
 * `--local-host-port=localhost:0` means "any free port"; gcloud prints which
 * one it took, and `parseIapTunnelPort` below reads it back. Asking for a fixed
 * port instead would race every other tunnel on the machine.
 */
export function gcpIapTunnelArgs(target: GcpTarget): string[] {
  return [
    'compute',
    'start-iap-tunnel',
    safeArgument(target.instance, 'Instance'),
    '22',
    '--project',
    safeArgument(target.project, 'Project'),
    '--zone',
    safeArgument(target.zone, 'Zone'),
    '--local-host-port=localhost:0'
  ]
}

export function gcpDescribeInstanceArgs(target: GcpTarget): string[] {
  return [
    'compute',
    'instances',
    'describe',
    safeArgument(target.instance, 'Instance'),
    '--project',
    safeArgument(target.project, 'Project'),
    '--zone',
    safeArgument(target.zone, 'Zone'),
    '--format=json'
  ]
}

/**
 * Publish our ephemeral public key for this identity.
 *
 * The TTL is short by design: the key exists to authenticate one connection,
 * and OS Login keeps it no longer than it takes to make it. Nothing is written
 * to the user's account permanently, which is the difference between this and
 * asking someone to paste a key into the console.
 */
export function gcpOsLoginAddKeyArgs(project: string, publicKeyPath: string, ttlSeconds: number): string[] {
  return [
    'compute',
    'os-login',
    'ssh-keys',
    'add',
    `--key-file=${safeArgument(publicKeyPath, 'Key file')}`,
    `--ttl=${Math.max(1, Math.floor(ttlSeconds))}s`,
    '--project',
    safeArgument(project, 'Project'),
    '--format=json'
  ]
}

/** Who OS Login says we are on the far side - the POSIX name to log in as. */
export function gcpOsLoginProfileArgs(project: string): string[] {
  return [
    'compute',
    'os-login',
    'describe-profile',
    '--project',
    safeArgument(project, 'Project'),
    '--format=json'
  ]
}

/**
 * Push a public key that the instance will accept for the next 60 seconds.
 *
 * This is the whole reason the AWS path needs no stored key material: the
 * window is long enough for one connection and closes on its own, so there is
 * no `.pem` to distribute, rotate or leak.
 */
export function awsSendPublicKeyArgs(target: AwsTarget, publicKey: string): string[] {
  return [
    'ec2-instance-connect',
    'send-ssh-public-key',
    '--instance-id',
    safeArgument(target.instanceId, 'Instance ID'),
    '--instance-os-user',
    safeArgument(target.osUser, 'OS user'),
    '--ssh-public-key',
    // Not run through safeArgument: this is key material we generated this
    // second, it is never an identifier, and an OpenSSH public key legitimately
    // contains characters the identifier rules forbid. It also cannot begin
    // with `-`, because it begins with its algorithm name.
    publicKey,
    '--region',
    safeArgument(target.region, 'Region'),
    '--profile',
    safeArgument(target.profile, 'Profile'),
    '--output',
    'json'
  ]
}

export function awsOpenTunnelArgs(target: AwsTarget, localPort: number): string[] {
  return [
    'ec2-instance-connect',
    'open-tunnel',
    '--instance-id',
    safeArgument(target.instanceId, 'Instance ID'),
    '--local-port',
    String(Math.floor(localPort)),
    '--region',
    safeArgument(target.region, 'Region'),
    '--profile',
    safeArgument(target.profile, 'Profile')
  ]
}

export function awsDescribeInstanceArgs(target: AwsTarget): string[] {
  return [
    'ec2',
    'describe-instances',
    '--instance-ids',
    safeArgument(target.instanceId, 'Instance ID'),
    '--region',
    safeArgument(target.region, 'Region'),
    '--profile',
    safeArgument(target.profile, 'Profile'),
    '--output',
    'json'
  ]
}

/**
 * Have Azure write an SSH config, a short-lived Entra certificate and its key.
 *
 * We ask for files rather than for a session because the certificate is the
 * thing we actually need: ssh2 connects, not `az`. `--overwrite` because the
 * destination is a fresh temp directory we made a moment ago, so there is
 * nothing of anyone's to overwrite.
 */
export function azureSshConfigArgs(target: AzureTarget, configPath: string): string[] {
  return [
    'ssh',
    'config',
    '--file',
    safeArgument(configPath, 'Config file'),
    '--resource-group',
    safeArgument(target.resourceGroup, 'Resource group'),
    '--name',
    safeArgument(target.vm, 'VM'),
    '--subscription',
    safeArgument(target.subscription, 'Subscription'),
    '--overwrite',
    '--yes'
  ]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse JSON that came from another program.
 *
 * Provider output is untrusted input in the ordinary sense - it crosses a
 * process boundary and its shape is a contract we do not control. Every reader
 * below therefore treats every field as optional and returns something usable
 * rather than throwing, because the alternative is a panel that shows a stack
 * trace when a provider renames a key in a point release.
 */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The last path segment of a GCE resource URL, which is how zones arrive. */
function lastSegment(value: string): string {
  const parts = value.split('/')
  return parts[parts.length - 1] ?? ''
}

// --- Versions --------------------------------------------------------------

/**
 * `gcloud --version` prints several lines; the first names the SDK.
 * Example: `Google Cloud SDK 458.0.1`.
 */
export function parseGcloudVersion(stdout: string): string {
  const m = /Google Cloud SDK (\S+)/.exec(stdout)
  if (m) return m[1]
  return stdout.split(/\r?\n/)[0]?.trim() ?? ''
}

/** `aws --version` prints one line: `aws-cli/2.15.30 Python/3.11.6 ...`. */
export function parseAwsVersion(stdout: string): string {
  const m = /aws-cli\/(\S+)/.exec(stdout)
  return m ? m[1] : (stdout.split(/\r?\n/)[0]?.trim() ?? '')
}

/** `az version --output json` answers `{"azure-cli": "2.57.0", ...}`. */
export function parseAzVersion(stdout: string): string {
  const root = asRecord(readJson(stdout))
  return asString(root['azure-cli'])
}

// --- Authentication --------------------------------------------------------

export interface CloudAuthStatus {
  authenticated: boolean
  /** The signed-in identity, shown to the user so they can tell which one. */
  account: string
}

const NO_AUTH: CloudAuthStatus = { authenticated: false, account: '' }

/**
 * `gcloud auth list --format=json` returns every credentialed account, with the
 * current one marked ACTIVE. An account that is merely present is not one we
 * are signed in as, which is why the status is checked rather than the length.
 */
export function parseGcpAuthStatus(stdout: string): CloudAuthStatus {
  const accounts = asArray(readJson(stdout)).map(asRecord)
  const active = accounts.find((a) => asString(a.status).toUpperCase() === 'ACTIVE')
  if (!active) return NO_AUTH
  const account = asString(active.account)
  return account ? { authenticated: true, account } : NO_AUTH
}

/**
 * `aws sts get-caller-identity` succeeding IS the authentication check; if it
 * returns an ARN, the credentials in that profile are live right now.
 */
export function parseAwsAuthStatus(stdout: string): CloudAuthStatus {
  const root = asRecord(readJson(stdout))
  const arn = asString(root.Arn)
  if (!arn) return NO_AUTH
  return { authenticated: true, account: arn }
}

/**
 * `az account show` describes the active subscription and the user on it. A
 * subscription in any state but Enabled is reported as not usable, because a
 * disabled one fails at connect time with a far less obvious message.
 */
export function parseAzureAuthStatus(stdout: string): CloudAuthStatus {
  const root = asRecord(readJson(stdout))
  if (Object.keys(root).length === 0) return NO_AUTH
  const state = asString(root.state)
  if (state && state.toLowerCase() !== 'enabled') return NO_AUTH
  const user = asRecord(root.user)
  const account = asString(user.name) || asString(root.name)
  return account ? { authenticated: true, account } : NO_AUTH
}

// --- Accounts and locations ------------------------------------------------

/** `gcloud projects list`: `[{projectId, name, lifecycleState}]`. */
export function parseGcpProjects(stdout: string): CloudAccount[] {
  return asArray(readJson(stdout))
    .map(asRecord)
    // A project being deleted still appears in the list and cannot be used.
    .filter((p) => {
      const state = asString(p.lifecycleState)
      return state === '' || state.toUpperCase() === 'ACTIVE'
    })
    .map((p) => ({ id: asString(p.projectId), name: asString(p.name) || asString(p.projectId) }))
    .filter((p) => p.id !== '')
}

/** `gcloud compute zones list`: `[{name, status, region}]`. */
export function parseGcpZones(stdout: string): CloudLocation[] {
  return asArray(readJson(stdout))
    .map(asRecord)
    .filter((z) => {
      const status = asString(z.status)
      return status === '' || status.toUpperCase() === 'UP'
    })
    .map((z) => ({ id: asString(z.name), name: asString(z.name) }))
    .filter((z) => z.id !== '')
}

/**
 * `aws configure list-profiles` is plain text, one name per line - the single
 * place a provider gives us no JSON. It needs none: the whole answer is a list
 * of names with no structure to lose.
 */
export function parseAwsProfiles(stdout: string): CloudAccount[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((name) => ({ id: name, name }))
}

/** `aws ec2 describe-regions`: `{Regions: [{RegionName}]}`. */
export function parseAwsRegions(stdout: string): CloudLocation[] {
  return asArray(asRecord(readJson(stdout)).Regions)
    .map(asRecord)
    .map((r) => ({ id: asString(r.RegionName), name: asString(r.RegionName) }))
    .filter((r) => r.id !== '')
}

/** `az account list`: `[{id, name, state}]`. */
export function parseAzureSubscriptions(stdout: string): CloudAccount[] {
  return asArray(readJson(stdout))
    .map(asRecord)
    .filter((s) => {
      const state = asString(s.state)
      return state === '' || state.toLowerCase() === 'enabled'
    })
    // Addressed by ID, displayed by name. `az` accepts either, but a display
    // name may contain spaces - and on Windows the provider CLI is a `.cmd`
    // that has to be reached through cmd.exe, where a space is syntax. A GUID
    // never is. Names also change; the ID does not.
    .map((s) => ({ id: asString(s.id) || asString(s.name), name: asString(s.name) || asString(s.id) }))
    .filter((s) => s.id !== '')
}

/** `az group list`: `[{name, location}]`. */
export function parseAzureResourceGroups(stdout: string): CloudLocation[] {
  return asArray(readJson(stdout))
    .map(asRecord)
    .map((g) => ({ id: asString(g.name), name: asString(g.name) }))
    .filter((g) => g.id !== '')
}

// --- Instances -------------------------------------------------------------

export function parseGcpInstances(stdout: string): CloudInstance[] {
  return asArray(readJson(stdout))
    .map(asRecord)
    .map((i) => {
      const status = asString(i.status)
      return {
        id: asString(i.name),
        name: asString(i.name),
        state: status,
        location: lastSegment(asString(i.zone)),
        running: status.toUpperCase() === 'RUNNING'
      }
    })
    .filter((i) => i.id !== '')
}

export function parseAwsInstances(stdout: string): CloudInstance[] {
  const reservations = asArray(asRecord(readJson(stdout)).Reservations).map(asRecord)
  const out: CloudInstance[] = []
  for (const reservation of reservations) {
    for (const raw of asArray(reservation.Instances)) {
      const i = asRecord(raw)
      const id = asString(i.InstanceId)
      if (id === '') continue
      const state = asString(asRecord(i.State).Name)
      // The display name is a tag, and an instance need not carry one. Falling
      // back to the id keeps every row addressable rather than blank.
      const nameTag = asArray(i.Tags)
        .map(asRecord)
        .find((t) => asString(t.Key) === 'Name')
      out.push({
        id,
        name: asString(nameTag?.Value) || id,
        state,
        location: asString(asRecord(i.Placement).AvailabilityZone),
        running: state.toLowerCase() === 'running'
      })
    }
  }
  return out
}

export function parseAzureVms(stdout: string): CloudInstance[] {
  return asArray(readJson(stdout))
    .map(asRecord)
    .map((v) => {
      // With --show-details this reads 'VM running' / 'VM deallocated'.
      const power = asString(v.powerState)
      return {
        id: asString(v.name),
        name: asString(v.name),
        state: power,
        location: asString(v.resourceGroup),
        running: power.toLowerCase().includes('running')
      }
    })
    .filter((v) => v.id !== '')
}

// --- Connection details ----------------------------------------------------

/**
 * The local port gcloud chose for an IAP tunnel.
 *
 * The one place here that reads human output, because gcloud offers no JSON for
 * a long-running tunnel - it logs progress to stderr and stays up. The pattern
 * is anchored on gcloud's own wording and tested against real captured output;
 * a miss returns null and the caller fails with `tunnel-failed` rather than
 * connecting to a port it guessed.
 */
export function parseIapTunnelPort(text: string): number | null {
  const m = /Listening on port \[(\d{1,5})\]/.exec(text)
  if (!m) return null
  const port = Number(m[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

export interface InstanceAddresses {
  /** Reachable from outside the VPC, when the machine has one at all. */
  external: string
  /** Reachable from inside it, or through a tunnel. */
  internal: string
  state: string
  running: boolean
}

export function parseGcpInstanceAddresses(stdout: string): InstanceAddresses {
  const root = asRecord(readJson(stdout))
  const status = asString(root.status)
  const nic = asArray(root.networkInterfaces).map(asRecord)[0] ?? {}
  const access = asArray(nic.accessConfigs).map(asRecord)[0] ?? {}
  return {
    external: asString(access.natIP),
    internal: asString(nic.networkIP),
    state: status,
    running: status.toUpperCase() === 'RUNNING'
  }
}

export function parseAwsInstanceAddresses(stdout: string): InstanceAddresses {
  const reservation = asArray(asRecord(readJson(stdout)).Reservations).map(asRecord)[0] ?? {}
  const instance = asArray(reservation.Instances).map(asRecord)[0] ?? {}
  const state = asString(asRecord(instance.State).Name)
  return {
    external: asString(instance.PublicIpAddress),
    internal: asString(instance.PrivateIpAddress),
    state,
    running: state.toLowerCase() === 'running'
  }
}

/** The POSIX name OS Login assigned this identity on the far side. */
export function parseGcpOsLoginUsername(stdout: string): string {
  const root = asRecord(readJson(stdout))
  const posix = asArray(root.posixAccounts).map(asRecord)
  const primary = posix.find((p) => p.primary === true) ?? posix[0]
  return asString(primary?.username)
}

// ---------------------------------------------------------------------------
// Classifying failure
// ---------------------------------------------------------------------------

/**
 * Provider stderr is not a user interface, but it is the only place the cause
 * appears. Each rule turns a known line into a fault so the user gets a
 * sentence and a button instead of the raw text.
 *
 * Ordered, first match wins, specific before general - the same discipline as
 * PATTERNS in connectionError.ts and for the same reason: an expired SSO
 * session and an absent one both contain the word "credentials", and they send
 * the user to different places.
 *
 * These rules are best-effort by nature. A miss returns null and the caller
 * falls back to `cli-failed`, which still shows the provider's own text in the
 * details - a wrong-but-confident classification would be worse than an honest
 * "it said this".
 */
const CLOUD_RULES: { re: RegExp; fault: CloudFault; providers?: CloudProvider[] }[] = [
  // --- Expired, before merely absent. Both mention credentials. ---
  {
    re: /reauthentication (is )?required|invalid_grant|credentials are no longer valid|have expired/i,
    fault: 'auth-expired'
  },
  {
    re: /ExpiredToken|token (has )?expired|security token included in the request is expired|sso session .* (has )?expired|Error loading SSO Token/i,
    fault: 'auth-expired'
  },
  { re: /AADSTS700082|AADSTS50173|refresh token has expired/i, fault: 'auth-expired' },

  // --- Signed out entirely ---
  {
    re: /do not currently have an active account|gcloud auth login|You must log in|Please run ['"]?az login|az login --|Unable to locate credentials|could not be found in shared credentials|No subscription found/i,
    fault: 'not-authenticated'
  },

  // --- Authorised as someone, but not for this ---
  {
    re: /PERMISSION_DENIED|UnauthorizedOperation|AccessDenied(Exception)?|AuthorizationFailed|is not authorized to perform|does not have permission|Required .* permission|insufficient (permission|privileges)/i,
    fault: 'iam-permission-denied'
  },

  // --- The machine is off ---
  {
    re: /IncorrectInstanceState|instance is not in a valid state|is not running|instance state.*stopped|VM (is )?deallocated/i,
    fault: 'instance-stopped'
  },

  // --- No such machine, or none this account can see ---
  {
    re: /InvalidInstanceID\.NotFound|ResourceNotFound|NOT_FOUND|was not found|could not be found|does not exist|Could not fetch resource/i,
    fault: 'resource-not-found'
  },

  // --- The tunnel specifically ---
  {
    re: /start-iap-tunnel|open-tunnel|failed to connect to backend|Error while connecting \[|websocket|tunnel .*(failed|closed)/i,
    fault: 'tunnel-failed'
  },

  // --- Ordinary network trouble ---
  {
    re: /Network is unreachable|Could not connect to the endpoint URL|EndpointConnectionError|getaddrinfo|ENOTFOUND|EHOSTUNREACH|ECONNREFUSED/i,
    fault: 'network-unreachable'
  },
  { re: /timed out|ETIMEDOUT|ReadTimeout|ConnectTimeout/i, fault: 'connection-timeout' },

  // --- The far end refused the login itself ---
  { re: /Permission denied \(publickey|Authentication failed|denied by the server/i, fault: 'ssh-permission-denied' },
  { re: /host key|REMOTE HOST IDENTIFICATION HAS CHANGED/i, fault: 'host-key-error' }
]

/**
 * Best-effort fault for a chunk of provider output.
 *
 * `provider` narrows the rules that carry a provider list. Most do not: the
 * three CLIs borrow each other's vocabulary often enough that a shared rule is
 * usually right, and a rule that is only ever true of one of them says so.
 */
export function classifyCloudOutput(text: string, provider?: CloudProvider): CloudFault | null {
  if (!text) return null
  for (const rule of CLOUD_RULES) {
    if (rule.providers && provider && !rule.providers.includes(provider)) continue
    if (rule.re.test(text)) return rule.fault
  }
  return null
}
