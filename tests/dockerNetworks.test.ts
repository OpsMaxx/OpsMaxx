import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  buildDockerNetworkCommand,
  buildDockerNetworkPreview,
  DOCKER_DEFAULT_NETWORKS,
  parseDockerNetworks,
  parseDockerNetworkUse,
  type DockerReclaimPreview
} from '../src/shared/docker'

// Item 42's networks row. The fixture is one real docker daemon carrying the
// three built-in networks, a compose project with one service running and one
// stopped, and two hand-made networks -- one of which the stopped container is
// also attached to.

const DIR = fileURLToPath(new URL('./fixtures/docker/networks', import.meta.url))
const read = (n: string): string => readFileSync(join(DIR, n), 'utf8')
const preview = (): DockerReclaimPreview =>
  buildDockerNetworkPreview(
    parseDockerNetworks(read('network-ls.txt')),
    parseDockerNetworkUse(read('ps-networks.txt'))
  )
const held = (name: string): string =>
  preview().withheld.find((w) => w.label === name)?.reason ?? ''

describe('the read', () => {
  it('asks ps for ALL containers, not the running ones', () => {
    // The whole module turns on this flag: a stopped container still holds its
    // networks and `docker ps` without `-a` does not show it.
    const cmd = buildDockerNetworkCommand()
    expect(cmd).toContain("ps -a --format '{{.ID}}|{{.Names}}|{{.State}}|{{.Networks}}'")
    expect(cmd).toContain("network ls --format '{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}'")
  })

  it('was captured with those formats', () => {
    expect(read('command.txt')).toContain('{{.ID}}|{{.Names}}|{{.State}}|{{.Networks}}')
    expect(read('command.txt')).toContain('{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}')
  })

  it('splits the comma-joined networks of one container', () => {
    const b = parseDockerNetworkUse(read('ps-networks.txt')).find((u) => u.name === 'spnet-b-1')!
    expect(b.state).toBe('exited')
    expect(b.networks).toEqual(['sp-orphan', 'spnet_back'])
  })

  it('reads every network the daemon listed', () => {
    expect(parseDockerNetworks(read('network-ls.txt')).map((n) => n.name)).toEqual([
      'bridge',
      'host',
      'none',
      'sp-orphan',
      'sp-orphan-labelled',
      'spnet_back',
      'spnet_front'
    ])
  })
})

describe('a network with no running containers is not an unused network', () => {
  // THE finding, measured end to end. `docker network inspect spnet_back`
  // reported zero attached containers while `spnet-b-1` sat stopped on it.
  // Removing it on that basis is not recoverable by recreating a network of the
  // same name -- the container is pinned to the network's ID, and
  // `docker compose start b` failed with "network c1fd84b264c9... not found".
  it('withholds the network whose only container is stopped', () => {
    expect(preview().items.some((i) => i.label === 'spnet_back')).toBe(false)
    expect(held('spnet_back')).toContain('stopped and still attached')
  })

  it('says plainly when the containers on a network are running', () => {
    expect(held('spnet_front')).toBe('1 container on it')
  })

  it('withholds a hand-made network a stopped container was connected to', () => {
    // Not a compose network, and not connected by whoever made it -- the point
    // is that the rule is about attachment, not about who created what.
    expect(held('sp-orphan')).toContain('stopped and still attached')
  })
})

describe('what may be offered', () => {
  it('offers exactly the one network nothing is attached to', () => {
    expect(preview().items.map((i) => i.label)).toEqual(['sp-orphan-labelled'])
  })

  it('sends the id and shows the name', () => {
    const one = preview().items[0]
    expect(one.id).toMatch(/^[0-9a-f]{12}$/)
    expect(one.label).toBe('sp-orphan-labelled')
  })

  it('claims no size for a network, rather than claiming zero', () => {
    // A network occupies no space docker will tell us about. `0 B` would read
    // as a measurement.
    expect(preview().items[0]).toMatchObject({ size: '', sizeBytes: null })
  })

  it('never offers one of docker’s own three', () => {
    for (const name of ['bridge', 'host', 'none']) {
      expect(DOCKER_DEFAULT_NETWORKS.has(name)).toBe(true)
      expect(preview().items.some((i) => i.label === name)).toBe(false)
      expect(held(name)).toContain('refuses to remove it')
    }
  })

  it('shows every network it will not offer rather than hiding it', () => {
    const shown = [...preview().items, ...preview().withheld].map((x) => x.label).sort()
    expect(shown).toEqual([
      'bridge',
      'host',
      'none',
      'sp-orphan',
      'sp-orphan-labelled',
      'spnet_back',
      'spnet_front'
    ])
  })
})
