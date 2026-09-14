import { describe, it, expect } from 'vitest'

import { isValidCloudTarget, type CloudTarget } from '../src/shared/cloud'
import {
  draftToTarget,
  emptyCloudDraft,
  targetToDraft
} from '../src/renderer/src/components/connections/CloudTargetFields'

// The form holds a flat draft - one account box, one location box, one instance
// box - because all three providers have that shape. draftToTarget is the one
// place it becomes the discriminated union the rest of the app stores, so it is
// the one place a field can be put on the wrong provider.

const TARGETS: CloudTarget[] = [
  {
    type: 'gcp',
    project: 'example-prod-security',
    zone: 'me-central2-c',
    instance: 'prod-web-01',
    transport: 'iap'
  },
  {
    type: 'aws',
    profile: 'production',
    region: 'me-central-1',
    instanceId: 'i-0123456789abcdef0',
    osUser: 'ubuntu',
    transport: 'eice'
  },
  {
    type: 'azure',
    subscription: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    resourceGroup: 'production-rg',
    vm: 'prod-server-01',
    authentication: 'entra'
  }
]

describe('the connection form draft', () => {
  it('survives a round trip through the saved shape', () => {
    // Opening a saved cloud server for editing and pressing Save unchanged must
    // produce the same record. A field dropped here is a connection that
    // silently repoints itself the first time someone edits its name.
    for (const target of TARGETS) {
      expect(draftToTarget(target.type, targetToDraft(target)), target.type).toEqual(target)
    }
  })

  it('produces a target that passes validation', () => {
    for (const target of TARGETS) {
      const round = draftToTarget(target.type, targetToDraft(target))
      expect(isValidCloudTarget(round), target.type).toBe(true)
    }
  })

  it('is incomplete until every identifier is filled in', () => {
    for (const provider of ['gcp', 'aws', 'azure'] as const) {
      expect(draftToTarget(provider, emptyCloudDraft), provider).toBe(null)
      expect(draftToTarget(provider, { ...emptyCloudDraft, account: 'x' }), provider).toBe(null)
      expect(
        draftToTarget(provider, { ...emptyCloudDraft, account: 'x', location: 'y' }),
        provider
      ).toBe(null)
    }
  })

  it('requires an OS user for AWS and asks for none elsewhere', () => {
    const filled = { account: 'production', location: 'me-central-1', instance: 'i-0123abcd' }
    // AWS logs in as a named account on the instance; the other two are told
    // who they are by the provider.
    expect(draftToTarget('aws', { ...emptyCloudDraft, ...filled, osUser: '' })).toBe(null)
    expect(
      draftToTarget('gcp', {
        ...emptyCloudDraft,
        account: 'example-prod',
        location: 'me-central2-c',
        instance: 'web-01',
        osUser: ''
      })
    ).not.toBe(null)
  })

  it('never carries one provider’s field onto another', () => {
    // The mistake a chain of ternaries makes: an instance id landing in a
    // project, or a region in a zone.
    const draft = { account: 'acct', location: 'loc', instance: 'inst', osUser: 'u', transport: 'auto' }
    const gcp = draftToTarget('gcp', draft)
    const aws = draftToTarget('aws', draft)
    const azure = draftToTarget('azure', draft)

    expect(gcp).toEqual({
      type: 'gcp',
      project: 'acct',
      zone: 'loc',
      instance: 'inst',
      transport: 'auto'
    })
    expect(aws).toEqual({
      type: 'aws',
      profile: 'acct',
      region: 'loc',
      instanceId: 'inst',
      osUser: 'u',
      transport: 'auto'
    })
    expect(azure).toEqual({
      type: 'azure',
      subscription: 'acct',
      resourceGroup: 'loc',
      vm: 'inst',
      authentication: 'entra'
    })
    // Azure takes no transport and AWS's osUser must not appear on the others.
    expect(Object.keys(azure ?? {})).not.toContain('transport')
    expect(Object.keys(gcp ?? {})).not.toContain('osUser')
  })

  it('trims what the user typed, so a stray space is not an invalid identifier', () => {
    const target = draftToTarget('gcp', {
      ...emptyCloudDraft,
      account: '  example-prod-security  ',
      location: ' me-central2-c ',
      instance: ' prod-web-01 '
    })
    expect(target).not.toBe(null)
    expect(isValidCloudTarget(target)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The command preview
// ---------------------------------------------------------------------------

describe('what the preview promises is what runs', () => {
  it('previews only commands built by the real builders', async () => {
    // The preview is assembled by calling the same builders the connection
    // calls. This asserts the property that makes that worth doing: the file
    // contains no hand-written command text that could drift from them.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(
        new URL('../src/renderer/src/components/connections/CloudTargetFields.tsx', import.meta.url)
      ),
      'utf8'
    )
    const preview = source.slice(source.indexOf('function previewCommands'))
    expect(preview.length, 'previewCommands not found').toBeGreaterThan(100)

    // A literal subcommand here would be a second description of the command.
    for (const invented of ['compute ssh', "'compute'", 'ec2-instance-connect ssh', 'az ssh vm']) {
      expect(preview.includes(invented), `preview hard-codes "${invented}"`).toBe(false)
    }
    // And it must actually call the builders.
    for (const builder of ['gcpIapTunnelArgs', 'awsSendPublicKeyArgs', 'azureSshConfigArgs']) {
      expect(preview.includes(builder), `preview does not use ${builder}`).toBe(true)
    }
  })

  it('does not show a gcloud compute ssh line OpsMaxx never runs', async () => {
    // The familiar one-liner is what the original design sketched, and it is
    // not what happens: the CLI brokers a tunnel and a credential, and ssh2
    // connects. Printing it would be a plausible lie in the one place someone
    // looks to find out what is really going on.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(
        new URL('../src/renderer/src/components/connections/CloudTargetFields.tsx', import.meta.url)
      ),
      'utf8'
    )
    expect(source.includes('tunnel-through-iap')).toBe(false)
  })
})
