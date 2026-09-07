import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { parseK8sHelmList, buildK8sHelmListCommand } from '../src/shared/kubernetes'

// Item 39's helm row: "the parse is unproven".
//
// It was. `parseK8sHelmList` has shipped without a single fixture, and the
// fixtures here are the real output of helm v3.16.2 against a k3s v1.31.5
// cluster with two releases installed into two namespaces.

const DIR = fileURLToPath(new URL('./fixtures/k8s/helm', import.meta.url))
const fixture = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const section = (body: string): string => `===SHELLPILOT-HELM===\n${body}`

describe('the helm parse, against helm', () => {
  it('reads two real releases, every field', () => {
    const r = parseK8sHelmList(section(fixture('list-two.json')), 0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.releases).toHaveLength(2)
    expect(r.releases[0]).toEqual({
      name: 'cache',
      namespace: 'kube-system',
      revision: '1',
      status: 'deployed',
      chart: 'demo-0.1.0',
      appVersion: '1.16.0',
      updated: '2026-09-05 17:32:20.786000301 +0000 UTC'
    })
  })

  // The field most likely to have been wrong, and the reason a fixture was
  // worth taking: helm emits the revision as a STRING. The parser's `str()`
  // returns '' for anything else, so a numeric revision would have vanished
  // silently -- a release showing a blank revision, with nothing to say why.
  it('gets the revision, which helm sends as a string and not a number', () => {
    const raw = JSON.parse(fixture('list-two.json')) as { revision: unknown }[]
    expect(typeof raw[0].revision).toBe('string')
    const r = parseK8sHelmList(section(fixture('list-two.json')), 0)
    expect(r.ok && r.releases.every((x) => x.revision !== '')).toBe(true)
  })

  it('maps app_version onto appVersion, which is the one renamed field', () => {
    const raw = JSON.parse(fixture('list-two.json')) as Record<string, unknown>[]
    expect('app_version' in raw[0]).toBe(true)
    expect('appVersion' in raw[0]).toBe(false)
    const r = parseK8sHelmList(section(fixture('list-two.json')), 0)
    expect(r.ok && r.releases[0].appVersion).toBe('1.16.0')
  })

  it('reads a real empty list as ok-and-empty, not as a failure', () => {
    // `[]` is helm saying "no releases here", which is a different answer from
    // helm not being installed.
    const r = parseK8sHelmList(section(fixture('list-empty.json')), 0)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.releases).toEqual([])
  })
})

describe('the answers that are not releases', () => {
  it('tells a missing helm from an empty cluster, and says which', () => {
    const r = parseK8sHelmList(section('sh: helm: not found'), 127)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('not-installed')
    // The distinction that matters: releases installed from elsewhere are
    // still there.
    expect(r.detail).toContain('not a statement about the cluster')
  })

  it('does not read an error as an empty release list', () => {
    const r = parseK8sHelmList(section('Error: Kubernetes cluster unreachable'), 1)
    expect(r.ok).toBe(false)
  })

  it('says failed when helm returned nothing at all', () => {
    const r = parseK8sHelmList(section(''), 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('failed')
  })

  it('asks for JSON across all namespaces, or the parse has nothing to read', () => {
    // The LONG spellings, which is what the builder uses and what helm 3.16.2
    // was confirmed to accept -- the fixtures above were taken with exactly
    // these flags.
    const cmd = buildK8sHelmListCommand()
    expect(cmd).toContain('--output json')
    expect(cmd).toContain('--all-namespaces')
  })
})
