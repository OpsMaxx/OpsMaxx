import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { COMPOSE_FAILURE_HELP, parseComposeConfigOutput } from '../src/shared/compose'
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


// ---------------------------------------------------------------- compose

describe('podman delegates compose, and what it delegates to leaks', () => {
  const out = fx('compose-provider.txt')

  // MEASURED on podman 5.8.4 + podman-compose 1.6.0. `podman compose` is not an
  // implementation; it looks up an external provider and runs that.
  it('prints a provider banner on every command, ANSI-wrapped', () => {
    expect(out).toContain('Executing external compose provider "/usr/bin/podman-compose"')
    // `--no-ansi` does not remove it -- measured.
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\u001b\[4m/)
  })

  // THE finding, and it is a credential one. `shared/compose.ts` exists because
  // `docker compose config` resolves `${SECRET}` out of `.env` and prints it;
  // the whole module is built on `--no-interpolate --no-env-resolution` making
  // that impossible. podman-compose REJECTS BOTH FLAGS -- exit 2, a usage
  // error -- and plain `config` printed the password.
  it('rejects the two flags that stop a compose read printing passwords', () => {
    expect(out).toContain('usage: podman-compose')
    expect(out).toContain('EXIT=2')
  })

  it('prints a .env password in plaintext without them', () => {
    // The dummy value written into the throwaway project for this measurement.
    expect(out).toContain('SECRET: hunter2')
  })

  // So the project is refused, and refused on the BANNER -- not on a failure.
  // podman prints it on successful commands too, and a `config` that leaked a
  // password would otherwise be read as a project this build can show.
  it('refuses a host whose compose provider is podman-compose', () => {
    const leaked = out.slice(out.indexOf('### podman compose config, plain'), out.indexOf('### podman compose config with'))
    const p = parseComposeConfigOutput(leaked, 0)
    expect(p.ok).toBe(false)
    if (p.ok) return
    expect(p.reason).toBe('compose-provider-unsupported')
    // The ANSI escapes are stripped rather than rendered into the panel.
    // eslint-disable-next-line no-control-regex
    expect(p.detail).not.toMatch(/\u001b/)
    expect(p.detail).toContain('external compose provider')
  })

  it('says why in the operator’s terms, naming the measurement', () => {
    const help = COMPOSE_FAILURE_HELP['compose-provider-unsupported']
    expect(help).toContain('--no-interpolate --no-env-resolution')
    expect(help).toContain('plaintext')
    expect(help).toContain('podman-compose')
  })

  // No provider AT ALL is compose being absent, which is a different fact and
  // a different sentence. Exit 125, and no banner.
  it('separates no provider installed from a provider it will not drive', () => {
    const none = out.slice(out.indexOf('### no provider at all'))
    expect(none).toContain('looking up compose provider failed')
    expect(none).not.toContain('Executing external compose provider')
    const p = parseComposeConfigOutput(none, 125)
    expect(p.ok).toBe(false)
    expect(p.ok === false && p.reason).not.toBe('compose-provider-unsupported')
  })
})

describe('rootless podman', () => {
  // Measured as the `podman` user: storage moves to $HOME and
  // `Host.Security.Rootless` is true, but the `system df` TABLE IS UNCHANGED --
  // which is the only thing this build reads.
  it('reports the same table shape as rootful', () => {
    const p = parseDockerDiskOutput(fx('system-df-rootless.txt'), 0)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.rows.map((r) => r.type)).toEqual(['Images', 'Containers', 'Local Volumes'])
    expect(p.rows.find((r) => r.type === 'Images')?.sizeBytes).toBe(4_660_000)
  })
})
