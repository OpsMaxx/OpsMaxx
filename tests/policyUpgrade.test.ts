import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { listGroups, getGroup, resetPolicyCacheForTests } from '../src/main/services/policyStore'
import { evaluateCapability, evaluateVpnControl } from '../src/main/services/policyEngine'
import { AI_CAPABILITIES } from '../src/shared/mcp'

const FILE = join(app.getPath('userData'), 'opsmaxx-ai-policy.json')

// A policy file written before manageServers and vpnControl existed: every
// group is missing both keys, which is what every upgraded install looks like.
// This has now happened twice, so the fixture stays deliberately behind: it is
// the only thing standing between an added capability and an install where the
// feature is silently off with nothing in the UI saying why.
function writeLegacyPolicy(): void {
  const legacyCaps = {
    viewServer: 'allow',
    terminal: 'allow',
    readFiles: 'allow',
    writeFiles: 'allow',
    sftpDownload: 'allow',
    sftpUpload: 'allow',
    sshTunnel: 'allow',
    databaseAccess: 'allow',
    sudo: 'ask',
    serverMetrics: 'allow'
  }
  writeFileSync(
    FILE,
    JSON.stringify({
      version: 1,
      groups: [
        { id: 'grp-read-only', name: 'Read Only', builtIn: true, capabilities: { ...legacyCaps, writeFiles: 'deny', sudo: 'deny' }, filePolicies: [] },
        { id: 'grp-full', name: 'Full Access', builtIn: true, capabilities: { ...legacyCaps }, filePolicies: [] },
        { id: 'grp-custom', name: 'Logs Only', builtIn: false, capabilities: { ...legacyCaps }, filePolicies: [] }
      ],
      assignments: [],
      serverMeta: []
    })
  )
}

beforeEach(() => {
  resetPolicyCacheForTests()
  writeLegacyPolicy()
})

describe('upgrading a policy file written before a capability existed', () => {
  it('leaves no capability undefined on any group', () => {
    const missing: string[] = []
    for (const g of listGroups()) {
      for (const { id } of AI_CAPABILITIES) {
        if (g.capabilities[id] === undefined) missing.push(`${g.name}.${id}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('gives a built-in group what a fresh install would have given it', () => {
    // Full Access seeds manageServers at ALLOW since version 3, and ships with
    // Confirm risky actions off, so on that group allow means allow.
    expect(getGroup('grp-full')?.capabilities.manageServers).toBe('allow')
    expect(getGroup('grp-read-only')?.capabilities.manageServers).toBe('deny')
  })

  it('backfills vpnControl the same way, on a file that predates it', () => {
    // The on-disk fixture has no vpnControl key at all. Full Access seeds it at
    // ALLOW and Read Only at DENY, so an upgraded install matches a fresh one.
    expect(getGroup('grp-full')?.capabilities.vpnControl).toBe('allow')
    expect(getGroup('grp-read-only')?.capabilities.vpnControl).toBe('deny')
  })

  it('sets the Confirm risky actions switch the way a fresh install would', () => {
    // Off on Full Access, on everywhere else -- including the custom group,
    // which keeps every upgrade it had when the upgrades were hard-coded.
    expect(getGroup('grp-full')?.confirmRisky).toBe(false)
    expect(getGroup('grp-read-only')?.confirmRisky).toBe(true)
    expect(getGroup('grp-custom')?.confirmRisky).toBe(true)
  })

  it('backfills hostFacts to DENY on every group but Full Access', () => {
    // Roadmap item C. It returns how many unpatched security updates a host is
    // carrying and against which distribution, which is a vulnerability report
    // rather than a health check — so no narrower seeded group opts in, not
    // even at 'ask'. Full Access does, since version 3, because "Full Access"
    // has to mean full; an upgraded install matches a fresh one in that.
    for (const g of listGroups().filter((g) => g.id !== 'grp-full')) {
      expect(g.capabilities.hostFacts, g.name).toBe('deny')
    }
    expect(evaluateCapability(getGroup('grp-custom'), 'hostFacts').decision).toBe('deny')
    expect(evaluateCapability(getGroup('grp-full'), 'hostFacts').decision).toBe('allow')
  })

  it('backfills firewallRules to DENY on every group, built-in ones included', () => {
    // Roadmap item 31, and the second capability of which this is true — the
    // first being hostFacts, for the same reason one step further along. This
    // one is the list of addresses and ports the host accepts traffic on: the
    // map an attacker would otherwise have to assemble by scanning. No seeded
    // group opts in at 'ask' either, because there is nothing an 'ask' could
    // prompt — the collection happens on an unattended hourly sweep with
    // nobody at the screen, so anything short of 'allow' means "do not read
    // it", and an upgraded install has to match a fresh one in that.
    for (const g of listGroups()) {
      expect(g.capabilities.firewallRules, g.name).toBe('deny')
    }
    expect(evaluateCapability(getGroup('grp-full'), 'firewallRules').decision).toBe('deny')
  })

  it('denies a new capability on a custom group, which has no intent on record', () => {
    expect(getGroup('grp-custom')?.capabilities.manageServers).toBe('deny')
    // Especially this one: a group written before VPNs existed cannot have
    // meant to let an agent move the user's traffic.
    expect(getGroup('grp-custom')?.capabilities.vpnControl).toBe('deny')
  })

  it('does not disturb capabilities the file already set', () => {
    const readOnly = getGroup('grp-read-only')!
    expect(readOnly.capabilities.writeFiles).toBe('deny')
    expect(readOnly.capabilities.sudo).toBe('deny')
    expect(readOnly.capabilities.terminal).toBe('allow')
  })

  it('makes the backfilled capability actually usable', () => {
    // Before the backfill this evaluated to deny via the undefined guard, and
    // no amount of changing other settings could shift it.
    expect(evaluateCapability(getGroup('grp-full'), 'manageServers').decision).toBe('allow')
    expect(evaluateCapability(getGroup('grp-full'), 'vpnControl').decision).toBe('allow')
  })

  it('reaches the VPN rule, not just the capability lookup', () => {
    // evaluateVpnControl reads the capability through the same undefined guard,
    // so a missed backfill would surface here as a permanent deny on a group
    // the user believes is set to allow.
    expect(evaluateVpnControl(getGroup('grp-full'), 'start', false).decision).toBe('allow')
    expect(evaluateVpnControl(getGroup('grp-full'), 'stop', false).decision).toBe('allow')
    expect(evaluateVpnControl(getGroup('grp-custom'), 'stop', false).decision).toBe('deny')
  })
})
