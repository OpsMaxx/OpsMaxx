import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildDockerDiskCommand,
  buildDockerDiskDetailCommand,
  buildDockerReclaimPreview,
  parseDockerDiskDetailOutput,
  parseDockerDiskOutput
} from '../src/shared/docker'

// The roadmap's podman row: "stated proof gap — recorded fixtures for
// rm/rmi/volume rm, system df -v, podman-compose".
//
// MEASURED on podman 5.8.4 in a container on the test host, against the
// commands `shared/docker.ts` already builds. That module was written
// anticipating podman -- it avoids `--format` because the two engines disagree
// about field names, and it resolves the `podman` binary as a fallback -- so
// what these fixtures establish is whether that anticipation actually holds.
//
// It mostly did. One thing did not, and it is recorded below.

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/docker/podman/${n}`, import.meta.url)), 'utf8')

describe('`podman system df`, through the docker parser', () => {
  const p = parseDockerDiskOutput(fx('system-df.txt'), 0)

  it('parses every column podman writes', () => {
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const images = p.rows.find((r) => r.type === 'Images')!
    expect(images.total).toBe(2)
    expect(images.active).toBe(1)
    expect(images.sizeBytes).toBe(12_360_000)
    expect(images.reclaimablePercent).toBe(62)
  })

  // Docker emits a fourth row; podman does not. The parser reads a LIST rather
  // than a fixed set, so its absence is simply three rows.
  it('does not require the Build Cache row docker has and podman lacks', () => {
    expect(fx('system-df.txt')).not.toContain('Build Cache')
    expect(p.ok && p.rows.map((r) => r.type)).toEqual(['Images', 'Containers', 'Local Volumes'])
  })

  it('reads `Local Volumes`, the one type name with a space in it', () => {
    expect(p.ok && p.rows.some((r) => r.type === 'Local Volumes')).toBe(true)
  })
})

describe('`podman system df -v`, through the docker parser', () => {
  const p = parseDockerDiskDetailOutput(fx('system-df-v.txt'), 0)

  it('parses images, containers and volumes off podman’s three sections', () => {
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.disk.images.map((i) => i.repository)).toContain('docker.io/library/busybox')
    expect(p.disk.containers.map((c) => c.name).sort()).toEqual([
      'spcreated',
      'spdead',
      'spkeep',
      'sppaused'
    ])
    expect(p.disk.volumes[0]).toMatchObject({ name: 'spvol', links: 1 })
  })

  // THE FINDING, and a bug this fixed. Docker's `system df -v` STATUS column
  // says `Up 2 hours` and `Exited (0) 3 minutes ago`; podman's says the bare
  // state -- `running`, `exited`, `created`. Two of those matched the existing
  // branches by luck, because the word is the same either way. `running`
  // matched nothing, so EVERY RUNNING CONTAINER ON A PODMAN HOST read as
  // `unknown`.
  it('reads podman’s bare status words as states', () => {
    expect(fx('system-df-v.txt')).toMatch(/\s+running\s+spkeep/)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const byName = new Map(p.disk.containers.map((c) => [c.name, c.state]))
    expect(byName.get('spkeep')).toBe('running')
    expect(byName.get('spdead')).toBe('exited')
    expect(byName.get('spcreated')).toBe('created')
  })

  // WHAT THE BUG WAS NOT. The reclaim preview never offered those containers
  // even while their state was unreadable -- it withheld them as "its state
  // could not be read". So this was a wrong LABEL, not an unsafe action, and
  // the design's refuse-what-you-cannot-read default is what made the
  // difference. Worth pinning: the safety must not depend on the parse.
  it('withholds a container whose state cannot be read, whatever the reason', () => {
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const unreadable = buildDockerReclaimPreview({
      ...p.disk,
      containers: p.disk.containers.map((c) =>
        c.state === 'running' ? { ...c, state: 'unknown' } : c
      )
    })
    // `items` is the offered list; there is no per-kind property, and asserting
    // on one that does not exist is an assertion that always passes -- which is
    // what the first version of this test did, and what type-checking the tests
    // caught.
    // The two running ones are withheld either way. What changes is the REASON,
    // and the stopped ones stay offered -- withholding everything would be a
    // different bug.
    const offered = unreadable.items.filter((i) => i.kind === 'container').map((i) => i.label)
    expect(offered).not.toContain('spkeep')
    expect(offered).not.toContain('sppaused')
    expect(offered.sort()).toEqual(['spcreated', 'spdead'])
    expect(
      unreadable.withheld.filter((w) => /could not be read/.test(w.reason)).map((w) => w.label).sort()
    ).toEqual(['sppaused', 'spkeep'].sort())

    // With the fix, the same two are withheld for the RIGHT reason -- AND are
    // absent from the offered list.
    //
    // TWO INDEPENDENT GUARDS keep them out, which was established by mutation:
    // removing the running-state branch's `continue` alone changes nothing,
    // because `running` is not in RECLAIMABLE_CONTAINER_STATES either and the
    // next check catches it. Removing BOTH offers a running container. Neither
    // is dead; they are defence in depth, and this test fails if both go.
    const before = buildDockerReclaimPreview(p.disk)
    const beforeOffered = before.items.filter((i) => i.kind === 'container').map((i) => i.label)
    expect(beforeOffered.sort()).toEqual(['spcreated', 'spdead'])
    expect(beforeOffered).not.toContain('spkeep')
    expect(beforeOffered).not.toContain('sppaused')
    expect(
      before.withheld.filter((w) => w.kind === 'container').map((w) => w.reason)
    ).toEqual(['it is running', 'it is running'])
  })

  // Rule 1 of the reclaim selection: a volume with LINKS > 0 is never offered.
  // Measured why it matters here: `podman volume rm` on an in-use volume fails
  // with a different exit code from docker's (2 against 1) and different
  // wording, and the preview means that path is never reached.
  it('never offers podman’s in-use volume, so the exit-code difference cannot bite', () => {
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const prev = buildDockerReclaimPreview(p.disk)
    expect(prev.items.filter((i) => i.kind === 'volume')).toEqual([])
    expect(prev.withheld.some((w) => w.kind === 'volume')).toBe(true)
    expect(fx('removals.txt')).toContain('volrm exit=2')
    expect(fx('removals.txt')).toContain('volume is being used')
  })

  // busybox has four containers on it and is withheld; alpine has none and is
  // offered. Asserting BOTH is the point -- a preview that withheld everything
  // would pass a one-sided check and be useless.
  it('withholds an image containers reference and offers one nothing does', () => {
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const prev = buildDockerReclaimPreview(p.disk)
    expect(prev.withheld.some((w) => w.kind === 'image' && /still reference/.test(w.reason))).toBe(
      true
    )
    const offeredImages = prev.items.filter((i) => i.kind === 'image').map((i) => i.label)
    expect(offeredImages.join(' ')).toContain('alpine')
    expect(offeredImages.join(' ')).not.toContain('busybox')
  })
})

describe('what podman’s removals actually print', () => {
  const out = fx('removals.txt')

  it('untags and deletes on rmi, exactly as docker reports it', () => {
    expect(out).toContain('Untagged: docker.io/library/alpine:3.19')
    expect(out).toContain('Deleted: ')
    expect(out).toContain('rmi exit=0')
  })

  it('echoes the container it removed', () => {
    expect(out).toContain('rm exit=0')
  })
})

describe('the commands work on both engines', () => {
  // The module resolves `podman` when docker is absent, which is what let these
  // fixtures be produced by the real builders rather than by hand.
  it('falls back to the podman binary', () => {
    expect(buildDockerDiskCommand()).toContain('podman')
    expect(buildDockerDiskDetailCommand()).toContain('podman')
  })

  // A template naming a field the other engine lacks fails outright, which
  // would turn "your disk is full" into "this host is broken".
  it('asks for the plain table rather than a Go template', () => {
    expect(buildDockerDiskCommand()).not.toContain('--format')
  })
})
