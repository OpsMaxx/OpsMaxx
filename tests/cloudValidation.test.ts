import { describe, it, expect } from 'vitest'

import {
  CLOUD_FAULTS,
  CLOUD_FAULT_HINT,
  CLOUD_FAULT_MESSAGE,
  CloudError,
  assertValidCloudTarget,
  cloudFaultSentence,
  isValidCloudTarget,
  safeArgument,
  validateCloudTarget,
  type AwsTarget,
  type AzureTarget,
  type CloudTarget,
  type GcpTarget
} from '../src/shared/cloud'

// These validators are the only thing between a caller - including an AI agent
// writing through the MCP bridge - and the argv of a real program on this
// machine. Argv arrays stop shell injection; they do not stop FLAG injection,
// and `gcloud --flags-file=FILE` reads an arbitrary local file. So the tests
// that matter here are the negative ones.

const GCP: GcpTarget = {
  type: 'gcp',
  project: 'test-prod-security',
  zone: 'me-central2-c',
  instance: 'test-prod-ddos-tests',
  transport: 'auto'
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

describe('valid targets are accepted', () => {
  it('accepts the documented example of each provider', () => {
    for (const target of [GCP, AWS, AZURE]) {
      expect(validateCloudTarget(target), `${target.type} should be valid`).toEqual([])
      expect(isValidCloudTarget(target)).toBe(true)
    }
  })

  it('accepts the shapes real accounts actually produce', () => {
    const cases: CloudTarget[] = [
      // Short-form EC2 instance ids predate the 17-character ones and are still
      // valid on long-lived accounts.
      { ...AWS, instanceId: 'i-0123abcd' },
      { ...AWS, osUser: 'ec2-user' },
      // Multi-part regions: us-gov-west-1, ap-southeast-3.
      { ...AWS, region: 'us-gov-west-1' },
      { ...AWS, transport: 'eice' },
      { ...GCP, transport: 'iap' },
      { ...GCP, zone: 'us-central1-a' },
      // A subscription given as a GUID rather than a display name.
      { ...AZURE, subscription: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
      { ...AZURE, resourceGroup: 'rg_with(parens).and-dashes' }
    ]
    for (const target of cases) {
      expect(validateCloudTarget(target), JSON.stringify(target)).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// Flag injection
// ---------------------------------------------------------------------------

// Every user-settable string field on every provider, so a field added later
// without a rule shows up as an untested key rather than silently unguarded.
const STRING_FIELDS: { target: CloudTarget; fields: string[] }[] = [
  { target: GCP, fields: ['project', 'zone', 'instance'] },
  { target: AWS, fields: ['profile', 'region', 'instanceId', 'osUser'] },
  { target: AZURE, fields: ['subscription', 'resourceGroup', 'vm'] }
]

// Payloads that are the actual attack, not merely malformed input.
const HOSTILE = [
  // Reads an arbitrary local file into gcloud's own argument parser.
  '--flags-file=/etc/passwd',
  // Would hand an option to OpenSSH if we ever invoked it.
  '-oProxyCommand=/bin/sh',
  '-o',
  // A bare leading dash is enough: the CLI reads it as an option, not a name.
  '-',
  '--project=other',
  // Impersonation, which changes WHICH identity the call is made as.
  '--impersonate-service-account=evil@example.iam.gserviceaccount.com'
]

describe('no field accepts a value that would be read as an option', () => {
  for (const { target, fields } of STRING_FIELDS) {
    for (const field of fields) {
      for (const payload of HOSTILE) {
        it(`${target.type}.${field} rejects ${payload}`, () => {
          const hostile = { ...target, [field]: payload }
          const problems = validateCloudTarget(hostile)
          expect(
            problems.map((p) => p.field),
            `${target.type}.${field} accepted ${payload}, which the CLI would read as an option`
          ).toContain(field)
        })
      }
    }
  }
})

describe('no field accepts a control character', () => {
  // Built at runtime rather than written as literals: a control byte in a
  // source file is invisible in review.
  const controls = [String.fromCharCode(0), String.fromCharCode(10), String.fromCharCode(0x7f)]

  for (const { target, fields } of STRING_FIELDS) {
    for (const field of fields) {
      it(`${target.type}.${field} rejects embedded control characters`, () => {
        for (const c of controls) {
          const hostile = { ...target, [field]: `valid${c}name` }
          expect(
            validateCloudTarget(hostile).map((p) => p.field),
            `${target.type}.${field} accepted charCode ${c.charCodeAt(0)}`
          ).toContain(field)
        }
      })
    }
  }
})

describe('missing and malformed fields', () => {
  it('reports every empty required field, not just the first', () => {
    const problems = validateCloudTarget({
      type: 'aws',
      profile: '',
      region: '',
      instanceId: '',
      osUser: '',
      transport: 'auto'
    })
    // An agent gets no form to walk through, so one-at-a-time costs it a turn
    // per field.
    expect(problems.map((p) => p.field).sort()).toEqual([
      'instanceId',
      'osUser',
      'profile',
      'region'
    ])
  })

  it('rejects an instance id that is not one', () => {
    for (const bad of ['i-xyz', 'i-0123456789abcdefg', 'prod-web-01', 'I-0123ABCD', 'i-']) {
      expect(validateCloudTarget({ ...AWS, instanceId: bad }), bad).not.toEqual([])
    }
  })

  it('rejects a GCP instance name that breaks RFC 1035', () => {
    for (const bad of ['0starts-with-digit', 'Uppercase', 'ends-with-dash-', 'a'.repeat(64)]) {
      expect(validateCloudTarget({ ...GCP, instance: bad }), bad).not.toEqual([])
    }
  })

  it('rejects an unknown transport or authentication', () => {
    expect(validateCloudTarget({ ...GCP, transport: 'sneaky' })).not.toEqual([])
    expect(validateCloudTarget({ ...AWS, transport: 'sneaky' })).not.toEqual([])
    expect(validateCloudTarget({ ...AZURE, authentication: 'sneaky' })).not.toEqual([])
    // Local-VM-user logins are the ordinary SSH connection type, not a cloud
    // one, so the value is refused rather than silently accepted and dropped.
    expect(validateCloudTarget({ ...AZURE, authentication: 'local' })).not.toEqual([])
  })

  it('rejects a target that is not one at all', () => {
    for (const bad of [null, undefined, 'gcp', 42, {}, { type: 'digitalocean' }]) {
      expect(validateCloudTarget(bad), String(bad)).not.toEqual([])
      expect(isValidCloudTarget(bad)).toBe(false)
    }
  })
})

describe('assertValidCloudTarget', () => {
  it('passes a good target through', () => {
    expect(() => assertValidCloudTarget(GCP)).not.toThrow()
  })

  it('throws a CloudError naming the fault, so callers need not guess', () => {
    try {
      assertValidCloudTarget({ ...GCP, instance: '--flags-file=/etc/passwd' })
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CloudError)
      expect((e as CloudError).fault).toBe('invalid-identifier')
    }
  })
})

describe('safeArgument', () => {
  it('returns a good value unchanged', () => {
    expect(safeArgument('prod-web-01', 'Instance')).toBe('prod-web-01')
  })

  it('refuses anything that reads as an option or carries a control byte', () => {
    for (const bad of ['-x', '--flags-file=/etc/passwd', '', `a${String.fromCharCode(0)}b`]) {
      expect(() => safeArgument(bad, 'Instance'), JSON.stringify(bad)).toThrow(CloudError)
    }
  })
})

// ---------------------------------------------------------------------------
// The fault vocabulary
// ---------------------------------------------------------------------------

describe('every fault can be explained', () => {
  it('has a message and a hint entry for each code', () => {
    expect(CLOUD_FAULTS.length, 'CLOUD_FAULTS is empty - nothing was checked').toBeGreaterThan(0)
    for (const fault of CLOUD_FAULTS) {
      expect(CLOUD_FAULT_MESSAGE[fault], `no message for ${fault}`).toBeTruthy()
      // A hint may be deliberately empty; it may not be missing.
      expect(typeof CLOUD_FAULT_HINT[fault], `no hint entry for ${fault}`).toBe('string')
    }
  })

  it('adds no message for a code that is not a fault', () => {
    const known = new Set<string>(CLOUD_FAULTS)
    expect(Object.keys(CLOUD_FAULT_MESSAGE).filter((k) => !known.has(k))).toEqual([])
    expect(Object.keys(CLOUD_FAULT_HINT).filter((k) => !known.has(k))).toEqual([])
  })

  it('never puts an identifier in the sentence an agent sees', () => {
    // The agent-facing sentence is built from the fault alone. Provider output
    // names projects, instances and signed-in accounts, which is exactly what
    // the MCP addressing model exists to withhold.
    for (const fault of CLOUD_FAULTS) {
      expect(cloudFaultSentence(fault)).toBe(CLOUD_FAULT_MESSAGE[fault])
    }
  })
})
