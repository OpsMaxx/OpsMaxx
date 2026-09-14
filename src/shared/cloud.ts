/**
 * Cloud-native SSH targets: what one is, and what counts as a valid one.
 *
 * OpsMaxx reaches a GCE, EC2 or Azure VM by asking the user's own `gcloud`,
 * `aws` or `az` to broker the connection — never by carrying it. The CLI mints
 * a short-lived credential and, where the machine has no reachable address,
 * opens a tunnel; the existing ssh2 stack then connects to what it handed back.
 * Cloud identity stays with the cloud provider, which is the whole point: an
 * org's MFA, SSO and conditional access apply because we never went around
 * them.
 *
 * ── Why the validators in this file are security code ────────────────────────
 *
 * Every field here ends up as an element of an argv array passed to a real
 * program on the user's machine. Argv arrays stop *shell* injection — there is
 * no shell — but they do not stop *flag* injection: a value that begins with
 * `-` is read by the CLI as an option rather than as the instance name it was
 * supposed to be. That is not theoretical. `gcloud --flags-file=FILE` reads an
 * arbitrary local file, and `--ssh-flag` would hand options to OpenSSH, where
 * `-o ProxyCommand=...` runs an arbitrary local command.
 *
 * Two things keep that shut, and both have to stay true:
 *
 *   1. We never invoke OpenSSH and never accept SSH arguments from anyone, so
 *      the ProxyCommand route does not exist to be defended. See the note on
 *      CloudTarget below about the field that is deliberately absent.
 *   2. Every identifier is matched against an anchored pattern that cannot
 *      begin with `-`, and the argv builders refuse to emit a value that has
 *      not passed. Fail closed, not "sanitise and hope".
 *
 * These records are also writable through the MCP bridge, which means an AI
 * agent can author them. So (2) is the only thing between an agent and the argv
 * of a local binary. Treat a change to a pattern in this file as a change to a
 * security boundary, and keep tests/cloudValidation.test.ts honest.
 */

// ---------------------------------------------------------------------------
// What a target is
// ---------------------------------------------------------------------------

export type CloudProvider = 'gcp' | 'aws' | 'azure'

/** How to reach the machine once the provider has said who we are. */
export type GcpTransport = 'auto' | 'direct' | 'iap'
export type AwsTransport = 'auto' | 'ip' | 'eice'
/**
 * Azure offers a choice of identity, not of route.
 *
 * Only Entra ID in V1, and the omission is deliberate rather than unfinished.
 * The alternative Azure offers is a "local VM user" - an account on the machine
 * with a key or password you already hold - and that is precisely what the
 * ordinary SSH connection type already does, better, with the vault behind it.
 * Offering it here would be a second, worse path to the same place.
 *
 * The field exists rather than being implied so a saved profile can grow
 * another identity source without a migration.
 */
export type AzureAuthentication = 'entra'

export interface GcpTarget {
  type: 'gcp'
  project: string
  zone: string
  instance: string
  transport: GcpTransport
}

export interface AwsTarget {
  type: 'aws'
  profile: string
  region: string
  instanceId: string
  osUser: string
  transport: AwsTransport
}

export interface AzureTarget {
  type: 'azure'
  subscription: string
  resourceGroup: string
  vm: string
  authentication: AzureAuthentication
}

/**
 * A saved cloud connection.
 *
 * Note what is NOT here: no access token, no refresh token, no key material,
 * and no free-form SSH argument string. The first three are the provider's to
 * hold — a copy in our store would be a second thing to leak and a second thing
 * to expire without telling anyone. The fourth was sketched in the original
 * design and is absent on purpose: a string forwarded to OpenSSH is
 * `-o ProxyCommand=` and therefore local code execution, and because we connect
 * with ssh2 rather than the `ssh` binary there is no place to put one anyway.
 * Port forwarding is served by the existing tunnel layer against the resulting
 * ssh2 client, which is strictly more capable and costs no new surface.
 */
export type CloudTarget = GcpTarget | AwsTarget | AzureTarget

export const CLOUD_PROVIDERS: CloudProvider[] = ['gcp', 'aws', 'azure']

/** What the provider is called on screen. */
export const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = {
  gcp: 'Google Cloud',
  aws: 'AWS',
  azure: 'Microsoft Azure'
}

/** The executable we look for, per provider. */
export const CLOUD_PROVIDER_BINARY: Record<CloudProvider, string> = {
  gcp: 'gcloud',
  aws: 'aws',
  azure: 'az'
}

/** What that CLI is called when we have to tell someone to go install it. */
export const CLOUD_PROVIDER_CLI_NAME: Record<CloudProvider, string> = {
  gcp: 'Google Cloud CLI',
  aws: 'AWS CLI',
  azure: 'Azure CLI'
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/**
 * Everything that can go wrong between "the user picked a provider" and "a
 * shell opened", as one vocabulary.
 *
 * The point of the list is that `SSH connection failed.` is never the answer.
 * A missing CLI, an expired SSO session and an IAM denial are three different
 * problems with three different next actions, and collapsing them wastes the
 * user's afternoon on the wrong one.
 */
export type CloudFault =
  | 'cli-not-installed'
  | 'cli-unsupported-version'
  | 'not-authenticated'
  | 'auth-expired'
  | 'resource-not-found'
  | 'instance-stopped'
  | 'iam-permission-denied'
  | 'ssh-permission-denied'
  | 'network-unreachable'
  | 'tunnel-failed'
  | 'host-key-error'
  | 'connection-timeout'
  /**
   * A field did not match its pattern, so nothing was run.
   *
   * Not in the original error list, and the most important one here: it is the
   * refusal that happens *before* a process starts. It reaches a person as a
   * form error, and an agent as a rejected write.
   */
  | 'invalid-identifier'
  /** The CLI ran and failed in a way none of the rules above recognised. */
  | 'cli-failed'
  | 'unknown'

/**
 * Every fault, as a value.
 *
 * A union type cannot be iterated at runtime, so the exhaustiveness test would
 * have nothing to check and would pass by doing nothing. This array is what it
 * checks against, and the `satisfies` keeps the two in step: drop a member and
 * the type errors, add one to the union without adding it here and the test
 * fails on the missing message.
 */
export const CLOUD_FAULTS = [
  'cli-not-installed',
  'cli-unsupported-version',
  'not-authenticated',
  'auth-expired',
  'resource-not-found',
  'instance-stopped',
  'iam-permission-denied',
  'ssh-permission-denied',
  'network-unreachable',
  'tunnel-failed',
  'host-key-error',
  'connection-timeout',
  'invalid-identifier',
  'cli-failed',
  'unknown'
] as const satisfies readonly CloudFault[]

/**
 * The sentence shown when nothing more specific is known. Complete by
 * construction: a test asserts every CloudFault has an entry, so adding a code
 * without a message fails CI instead of reaching a user as "undefined".
 *
 * These name no project, instance or account. The detail carries that, and the
 * detail is dropped on the way to an agent — see cloudFaultSentence.
 */
export const CLOUD_FAULT_MESSAGE: Record<CloudFault, string> = {
  'cli-not-installed': 'The command-line tool for this cloud provider was not found.',
  'cli-unsupported-version': 'The installed command-line tool is too old for OpsMaxx to use.',
  'not-authenticated': 'You are not signed in to this cloud provider.',
  'auth-expired': 'Your session with this cloud provider has expired.',
  'resource-not-found': 'That machine does not exist, or this account cannot see it.',
  'instance-stopped': 'That machine is not running.',
  'iam-permission-denied': 'The cloud provider denied this account access to that machine.',
  'ssh-permission-denied': 'The machine refused the login.',
  'network-unreachable': 'The machine could not be reached over the network.',
  'tunnel-failed': 'The tunnel to the machine could not be established.',
  'host-key-error': 'The machine presented a host key that did not match the one on record.',
  'connection-timeout': 'The machine did not respond in time.',
  'invalid-identifier': 'One of the cloud identifiers is not in a valid form, so nothing was run.',
  'cli-failed': 'The cloud provider tool reported an error.',
  unknown: 'OpsMaxx could not tell what went wrong.'
}

/**
 * One short instruction, because the UI turns most of these into a button.
 * Empty string means the message above already says it all.
 */
export const CLOUD_FAULT_HINT: Record<CloudFault, string> = {
  // Deliberately empty: which tool, and how it is installed, differs per
  // provider and per platform, and the caller already knows both. OpsMaxx never
  // installs one itself.
  'cli-not-installed': '',
  'cli-unsupported-version': 'Update the provider tool, then try again.',
  'not-authenticated': 'Sign in with the provider tool, then try again.',
  'auth-expired': 'Sign in again to refresh the session.',
  'resource-not-found': 'Check the identifiers, or pick the machine from the list.',
  'instance-stopped': 'Start the machine in the cloud console, then try again.',
  'iam-permission-denied': 'Ask whoever administers this cloud account for access.',
  'ssh-permission-denied': 'Check that this account is allowed to log in as that user.',
  'network-unreachable': 'Check that you are online, and whether this machine needs a tunnel.',
  'tunnel-failed': 'Check that this account may open a tunnel to that machine.',
  'host-key-error': '',
  'connection-timeout': 'Check whether the machine is running and reachable.',
  'invalid-identifier': 'Correct the highlighted field.',
  'cli-failed': 'Open the details to see what the provider tool reported.',
  unknown: ''
}

/** Full user-facing text: what happened, then what to do. */
export function describeCloudFault(fault: CloudFault, detail?: string): string {
  const parts = [CLOUD_FAULT_MESSAGE[fault]]
  if (detail) parts.push(detail)
  const hint = CLOUD_FAULT_HINT[fault]
  if (hint) parts.push(hint)
  return parts.join(' ')
}

/**
 * The sentence an AGENT is allowed to see.
 *
 * Built from the fault alone, never from the provider's own text. A CLI failure
 * names the project, the instance, the zone and frequently the signed-in
 * account — exactly the identifiers the MCP addressing model exists to
 * withhold, arriving in a string nobody thought to redact. The same reasoning
 * as agentFaultSentence in connectionError.ts, and for the same audience.
 */
export function cloudFaultSentence(fault: CloudFault): string {
  return CLOUD_FAULT_MESSAGE[fault]
}

export class CloudError extends Error {
  readonly fault: CloudFault
  readonly detail?: string
  /** Which provider's tool produced this, when one did. */
  readonly provider?: CloudProvider

  constructor(
    fault: CloudFault,
    detail?: string,
    options?: { cause?: unknown; provider?: CloudProvider }
  ) {
    super(detail ? `${CLOUD_FAULT_MESSAGE[fault]} ${detail}` : CLOUD_FAULT_MESSAGE[fault], options)
    this.name = 'CloudError'
    this.fault = fault
    this.detail = detail
    this.provider = options?.provider
  }
}

export function isCloudError(e: unknown): e is CloudError {
  return e instanceof CloudError
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * True when the string carries a character no identifier should contain.
 *
 * Written as a codepoint scan rather than a regex on purpose: a character class
 * of literal control bytes is invisible in a diff, and a reviewer cannot tell a
 * correct one from a subtly wrong one by looking.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The one rule that matters most, applied to every value regardless of which
 * pattern it also has to satisfy.
 *
 * A value beginning with `-` is not an identifier, it is an option. Every
 * pattern below already refuses one - each begins with a character class that
 * excludes `-` - but this is asserted separately and first because it is the
 * property the security argument rests on, and a future edit that loosens a
 * pattern should have to delete this line explicitly rather than widen a class
 * by accident.
 *
 * Control characters get the same treatment. No pattern admits one, but an
 * argument containing NUL truncates unpredictably once it crosses into a C
 * program, and a newline makes a mess of any log that records what we ran.
 */
function argumentIsSafe(value: string): boolean {
  if (value.length === 0) return false
  if (value.startsWith('-')) return false
  if (hasControlChar(value)) return false
  return true
}

/** A field, its pattern, and what to call it when it fails. */
interface FieldRule {
  label: string
  pattern: RegExp
  /** What a valid one looks like, shown to whoever has to fix it. */
  example: string
}

/**
 * Patterns are the providers' own documented naming rules, anchored, and
 * deliberately no looser. Where a provider permits a character we do not need
 * - most of them permit far more in a display name than in an identifier - the
 * narrower form wins, because the cost of refusing an exotic-but-legal name is
 * one support question and the cost of admitting a crafted one is arbitrary
 * local file access.
 */
const GCP_RULES = {
  // 6-30 characters, lowercase letter first, no trailing hyphen.
  project: {
    label: 'Project',
    pattern: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    example: 'my-project-id'
  },
  // Compute zones are a region plus a single-letter suffix: me-central2-c.
  zone: {
    label: 'Zone',
    pattern: /^[a-z][a-z0-9]*-[a-z0-9]+-[a-z]$/,
    example: 'me-central2-c'
  },
  // RFC 1035: lowercase letter first, alphanumeric last, up to 63 characters.
  instance: {
    label: 'Instance',
    pattern: /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/,
    example: 'prod-web-01'
  }
} satisfies Record<string, FieldRule>

const AWS_RULES = {
  // Profile names live in the user's own config file and permit a wide set;
  // the leading character is narrowed so one can never read as a flag.
  profile: {
    label: 'Profile',
    pattern: /^[A-Za-z0-9_+=,.@][A-Za-z0-9_+=,.@-]{0,63}$/,
    example: 'production'
  },
  region: {
    label: 'Region',
    pattern: /^[a-z]{2}(-[a-z]+)+-\d$/,
    example: 'me-central-1'
  },
  // Eight or seventeen lowercase hex digits after `i-`. Nothing else is an
  // instance id, so nothing else is accepted.
  instanceId: {
    label: 'Instance ID',
    pattern: /^i-([0-9a-f]{8}|[0-9a-f]{17})$/,
    example: 'i-0123456789abcdef0'
  },
  // A POSIX login name. `ubuntu`, `ec2-user`, `admin`.
  osUser: {
    label: 'OS user',
    pattern: /^[a-z_][a-z0-9_-]{0,31}$/,
    example: 'ubuntu'
  }
} satisfies Record<string, FieldRule>

const AZURE_RULES = {
  // Either a subscription GUID or its display name. Names may contain spaces,
  // which is why this is the loosest pattern here - but it still cannot begin
  // with a hyphen and still admits no control characters.
  subscription: {
    label: 'Subscription',
    pattern:
      /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79})$/,
    example: 'Production'
  },
  // 1-90 characters; letters, digits, underscore, parentheses, hyphen, period.
  // May not end with a period.
  resourceGroup: {
    label: 'Resource group',
    pattern: /^[A-Za-z0-9][A-Za-z0-9._()-]{0,88}[A-Za-z0-9_()-]$/,
    example: 'production-rg'
  },
  vm: {
    label: 'VM',
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9_-]$/,
    example: 'prod-server-01'
  }
} satisfies Record<string, FieldRule>

export interface FieldProblem {
  /** Which field, by its key on the target object. */
  field: string
  /** What to say about it. */
  why: string
}

function checkField(value: unknown, rule: FieldRule, field: string): FieldProblem | null {
  if (typeof value !== 'string' || value.length === 0) {
    return { field, why: `${rule.label} is required.` }
  }
  if (!argumentIsSafe(value)) {
    return { field, why: `${rule.label} may not start with "-" or contain control characters.` }
  }
  if (!rule.pattern.test(value)) {
    return { field, why: `${rule.label} is not in a valid form - for example, ${rule.example}.` }
  }
  return null
}

function checkChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  field: string
): FieldProblem | null {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return { field, why: `${label} must be one of: ${allowed.join(', ')}.` }
  }
  return null
}

export const GCP_TRANSPORTS: readonly GcpTransport[] = ['auto', 'direct', 'iap']
export const AWS_TRANSPORTS: readonly AwsTransport[] = ['auto', 'ip', 'eice']
export const AZURE_AUTHENTICATIONS: readonly AzureAuthentication[] = ['entra']

/**
 * Every problem with a target, not just the first.
 *
 * The connection form reports one field at a time, but a write arriving over
 * the MCP bridge has no form to walk the caller through - an agent told about
 * one bad field at a time burns a turn per field. So this returns them all and
 * lets each caller present as much as it has room for.
 */
export function validateCloudTarget(target: unknown): FieldProblem[] {
  if (typeof target !== 'object' || target === null) {
    return [{ field: 'type', why: 'No cloud target was supplied.' }]
  }
  const t = target as Partial<CloudTarget> & { type?: unknown }
  const problems: FieldProblem[] = []
  const push = (p: FieldProblem | null): void => {
    if (p) problems.push(p)
  }

  switch (t.type) {
    case 'gcp': {
      const g = t as Partial<GcpTarget>
      push(checkField(g.project, GCP_RULES.project, 'project'))
      push(checkField(g.zone, GCP_RULES.zone, 'zone'))
      push(checkField(g.instance, GCP_RULES.instance, 'instance'))
      push(checkChoice(g.transport, GCP_TRANSPORTS, 'Transport', 'transport'))
      return problems
    }
    case 'aws': {
      const a = t as Partial<AwsTarget>
      push(checkField(a.profile, AWS_RULES.profile, 'profile'))
      push(checkField(a.region, AWS_RULES.region, 'region'))
      push(checkField(a.instanceId, AWS_RULES.instanceId, 'instanceId'))
      push(checkField(a.osUser, AWS_RULES.osUser, 'osUser'))
      push(checkChoice(a.transport, AWS_TRANSPORTS, 'Transport', 'transport'))
      return problems
    }
    case 'azure': {
      const z = t as Partial<AzureTarget>
      push(checkField(z.subscription, AZURE_RULES.subscription, 'subscription'))
      push(checkField(z.resourceGroup, AZURE_RULES.resourceGroup, 'resourceGroup'))
      push(checkField(z.vm, AZURE_RULES.vm, 'vm'))
      push(checkChoice(z.authentication, AZURE_AUTHENTICATIONS, 'Authentication', 'authentication'))
      return problems
    }
    default:
      return [{ field: 'type', why: `Unknown cloud provider: ${String(t.type)}.` }]
  }
}

export function isValidCloudTarget(target: unknown): target is CloudTarget {
  return validateCloudTarget(target).length === 0
}

/**
 * Throw unless the target is valid.
 *
 * Every path that is about to spawn something calls this, including the ones
 * whose caller has already validated. Revalidating costs a few regex tests and
 * removes the need to reason about whether some future caller forgot.
 */
export function assertValidCloudTarget(target: unknown): asserts target is CloudTarget {
  const problems = validateCloudTarget(target)
  if (problems.length > 0) {
    throw new CloudError('invalid-identifier', problems.map((p) => p.why).join(' '))
  }
}

/**
 * The last gate before a value becomes an argv element.
 *
 * The builders in cloudCommands.ts run every interpolated value through this.
 * By then it has already passed validateCloudTarget, so this should be
 * unreachable - which is exactly why it is here. A future builder that
 * interpolates something new (a discovered region, a filter expression) gets
 * the check for free rather than getting it only if its author remembered.
 */
export function safeArgument(value: string, what: string): string {
  if (!argumentIsSafe(value)) {
    throw new CloudError('invalid-identifier', `${what} is not a valid command argument.`)
  }
  return value
}

/** How a cloud server is described in a list, under its name. */
export function cloudTargetSubtitle(target: CloudTarget): string {
  switch (target.type) {
    case 'gcp':
      return `${CLOUD_PROVIDER_LABEL.gcp} - ${target.zone}`
    case 'aws':
      return `${CLOUD_PROVIDER_LABEL.aws} - ${target.region}`
    case 'azure':
      return `${CLOUD_PROVIDER_LABEL.azure} - ${target.resourceGroup}`
  }
}
