import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { assessCommand } from '../src/shared/commandRisk'
import { buildDockerBuildCommand, buildDockerPullCommand } from '../src/shared/docker'
import {
  buildComposeActionCommand,
  COMPOSE_FAILURE_HELP,
  COMPOSE_STEP_TIMEOUT_MS,
  COMPOSE_MARKERS,
  lintCompose,
  lintComposeConfig,
  parseComposeConfigOutput,
  type ComposeServiceDecl
} from '../src/shared/compose'

// Item 42's validation row. Every line below came off compose v5.1.4 refusing a
// real file -- one per way a compose file can be wrong -- and the finding is
// that NONE of them matched the failure pattern this module already had.

const DIR = fileURLToPath(new URL('./fixtures/compose/validate', import.meta.url))
const shot = (n: string): { out: string; code: number } => {
  const lines = readFileSync(join(DIR, `${n}.txt`), 'utf8').trim().split('\n')
  return {
    out: lines.slice(0, -1).join('\n'),
    code: Number(lines[lines.length - 1].replace('exit=', ''))
  }
}

/** The two blocks `parseComposeConfigProbe` reads, with compose's refusal in
 *  both: `config` and `config --services` fail the same way on a bad file. */
const wrap = (out: string): string =>
  `${COMPOSE_MARKERS.config}\n${out}\n${COMPOSE_MARKERS.services}\n${out}\n`
const probe = (n: string): ReturnType<typeof parseComposeConfigOutput> => {
  const s = shot(n)
  return parseComposeConfigOutput(wrap(s.out), s.code)
}

describe('compose refusing a file is compose answering', () => {
  // The defect the row names. All four of these fell through to "docker compose
  // config returned nothing this parser could read" -- a sentence about this
  // program, printed instead of the sentence compose wrote about the file.
  const cases: [string, string][] = [
    ['depends-on-undefined', 'depends on undefined service "nope"'],
    ['bad-yaml', 'found unexpected end of stream'],
    ['unknown-key', "additional properties 'imagz' not allowed"],
    ['no-image', 'has neither an image nor a build context'],
    ['dependency-cycle', 'dependency cycle detected: web -> web'],
    // Contains the words "not found" and still is not a missing binary: the
    // file compose could not find is the operator's, named in the line.
    ['missing-env-file', 'not found']
  ]

  for (const [file, line] of cases) {
    it(`surfaces compose's own line for ${file}`, () => {
      const r = probe(file)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toBe('invalid-project')
      expect(r.detail).toContain(line)
      expect(r.detail).not.toContain('this parser could read')
    })
  }

  it('says the file was read and refused, not that the read failed', () => {
    // `unknown` says "compose returned an error that could not be classified",
    // which is this program shrugging. `invalid-project` says compose read the
    // file and named the problem, which is what happened.
    expect(COMPOSE_FAILURE_HELP['invalid-project']).toContain('read the file and refused it')
    expect(COMPOSE_FAILURE_HELP['invalid-project']).toContain('verbatim')
  })

  it('still classifies a daemon failure as a daemon failure', () => {
    // The validator pattern must not swallow everything: a socket refusal is
    // not an invalid project.
    const r = parseComposeConfigOutput(
      wrap('permission denied while trying to connect to the Docker daemon socket'),
      1
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('permission-denied')
  })
})

describe('files compose accepts and an operator still needs told about', () => {
  const svc = (over: Partial<ComposeServiceDecl>): ComposeServiceDecl => ({
    name: 'web',
    image: 'nginx:1.27',
    build: false,
    containerName: null,
    dependsOn: [],
    ports: [],
    profiles: [],
    environment: [],
    envFiles: [],
    restart: 'always',
    networkMode: null,
    ...over
  })

  it('says what a moving tag will do, not that it is wrong', () => {
    const f = lintCompose([svc({ image: 'nginx:latest' })])
    expect(f.map((x) => x.rule)).toEqual(['floating-tag'])
    expect(f[0].because).toContain('can change what is running without any change to this file')
  })

  it('catches the untagged reference, which also means latest', () => {
    expect(lintCompose([svc({ image: 'nginx' })])[0].because).toContain('which means `latest`')
  })

  it('does not read a registry port as a tag', () => {
    // `registry:5000/app` has a colon that is a PORT, and no tag at all -- so
    // the finding is the untagged one, worded as such. Reading `5000` as the
    // tag would instead report a pinned image on every private registry.
    const f = lintCompose([svc({ image: 'registry:5000/app' })])
    expect(f.map((x) => x.rule)).toEqual(['floating-tag'])
    expect(f[0].because).toContain('has no tag on registry:5000/app')
  })

  it('leaves a pinned image on a port-bearing registry alone', () => {
    expect(lintCompose([svc({ image: 'registry:5000/app:1.2.3' })])).toEqual([])
  })

  it('leaves a pinned tag alone', () => {
    expect(lintCompose([svc({ image: 'nginx:1.27.3' })])).toEqual([])
  })

  it('says an absent restart policy means it does not come back', () => {
    // Compose's default is `no`. Absent is not "fine": nothing else on the
    // panel says the container will not survive a reboot.
    for (const restart of [null, '', 'no']) {
      const f = lintCompose([svc({ restart })])
      expect(f.map((x) => x.rule)).toEqual(['no-restart'])
      expect(f[0].because).toContain('does not come back after a reboot')
    }
  })

  // Measured: compose ACCEPTS this file and exits 0. The mappings do nothing.
  it('catches ports declared on a service that is on the host network', () => {
    expect(shot('host-network-ports').code).toBe(0)
    const f = lintCompose([svc({ networkMode: 'host', ports: ['8080:80'] })])
    expect(f.map((x) => x.rule)).toEqual(['host-network-ports'])
    expect(f[0].because).toContain('ignores the mappings')
    expect(f[0].because).toContain('8080:80')
  })

  it('does not fire on host networking with no ports declared', () => {
    expect(lintCompose([svc({ networkMode: 'host' })])).toEqual([])
  })

  // A names-only model has every field empty because NOTHING WAS READ. Linting
  // it would say each service has no tag and no restart policy, confidently,
  // about a file this never saw.
  it('refuses to lint a model the engine would only give names for', () => {
    const bare = {
      name: 'edge',
      namesOnly: true,
      volumes: [],
      networks: [],
      services: [svc({ image: null, restart: null })]
    }
    expect(lintComposeConfig(bare)).toEqual([])
    // ...and the same services WOULD produce findings if the model were real,
    // which is what makes the guard the thing doing the work.
    expect(lintComposeConfig({ ...bare, namesOnly: false }).length).toBeGreaterThan(0)
  })

  it('does not repeat what compose already refused', () => {
    // An undefined `depends_on` target, an unknown key and a service with
    // neither image nor build never reach the lint: compose rejects the file,
    // and a second opinion on a settled question is noise.
    expect(probe('depends-on-undefined').ok).toBe(false)
    expect(lintCompose([svc({ dependsOn: ['nope'] })])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Item 42's build row. `pull` fetches bytes; `build` runs a program.
// ---------------------------------------------------------------------------

describe('building is not pulling', () => {
  const ref = { name: 'edge', files: ['/srv/edge/compose.yaml'] }

  it('builds `build --pull`, so a build cannot reuse a stale base image', () => {
    // A build that reuses a cached base is a build that does not contain the
    // security update somebody just asked for.
    const cmd = buildComposeActionCommand('build', ref)
    expect(cmd).toContain('compose')
    expect(cmd).toContain('build --pull')
  })

  it('passes no build args at all', () => {
    // A build arg is free text that reaches a `RUN` line, and nothing here can
    // show an operator what that will do.
    expect(buildComposeActionCommand('build', ref)).not.toContain('--build-arg')
  })

  it('still refuses to put --build on up', () => {
    // Building and starting are separate decisions. Folding one into the other
    // runs a Dockerfile behind a button labelled start.
    expect(buildComposeActionCommand('up', ref)).not.toContain('--build')
  })

  it('scopes a build to the services that were picked', () => {
    expect(buildComposeActionCommand('build', ref, { services: ['web'] })).toMatch(/build --pull ['"]?web/)
  })

  it('refuses a service name it cannot prove safe', () => {
    expect(() => buildComposeActionCommand('build', ref, { services: ['web; rm -rf /'] })).toThrow(
      /invalid service name/
    )
  })

  // The row asked whether a build needs an ELEVATED rule. It does: a Dockerfile
  // is a program, and `RUN curl ... | sh` is an ordinary line in one.
  it('grades a build as elevated, and says why in the operator’s words', () => {
    const a = assessCommand('docker compose build --pull web')
    expect(a.risk).toBe('elevated')
    expect(a.reasons.join(' ')).toContain('runs a Dockerfile')
  })

  it('grades a plain build the same way', () => {
    expect(assessCommand('docker build -t app:1 .').risk).toBe('elevated')
    expect(assessCommand('podman build .').risk).toBe('elevated')
  })

  // `pull` fetches bytes and runs none of them. Grading it elevated would put a
  // confirmation on the safest thing on the panel and teach people to click
  // through the ones that matter.
  it('does not grade a pull as elevated', () => {
    expect(assessCommand('docker compose pull web').risk).toBe('ordinary')
    expect(assessCommand('docker pull nginx:1.27').risk).toBe('ordinary')
  })

  it('gives a build its own budget, because a build is not a fetch', () => {
    expect(COMPOSE_STEP_TIMEOUT_MS.build).toBeGreaterThan(COMPOSE_STEP_TIMEOUT_MS.pull)
  })
})

describe('the standalone pull and build builders', () => {
  it('pulls exactly the reference it was given', () => {
    expect(buildDockerPullCommand('nginx:1.27.3')).toContain('pull nginx:1.27.3')
  })

  it('refuses a reference it cannot prove safe', () => {
    for (const bad of ['nginx; rm -rf /', '../etc/passwd', '$(id)', '']) {
      expect(() => buildDockerPullCommand(bad)).toThrow(/invalid image reference/)
    }
  })

  it('always builds with --pull, so a stale base layer cannot survive', () => {
    const cmd = buildDockerBuildCommand({ context: '/srv/app', tag: 'app:1.2.3' })
    expect(cmd).toContain('build --pull -t app:1.2.3 /srv/app')
  })

  it('takes no build args', () => {
    expect(buildDockerBuildCommand({ context: '/srv/app', tag: 'app:1' })).not.toContain('--build-arg')
  })

  it('refuses a context that is not a plain path', () => {
    // `docker build https://github.com/x/y.git` is a real form that fetches and
    // builds code off the internet. Not something to accept from a text box.
    for (const bad of ['https://github.com/x/y.git', '/srv/../etc', '/srv/app; id', '']) {
      expect(() => buildDockerBuildCommand({ context: bad, tag: 'app:1' })).toThrow(/invalid context/)
    }
  })

  it('refuses a tag it cannot prove safe', () => {
    expect(() => buildDockerBuildCommand({ context: '/srv/app', tag: 'app:1 && id' })).toThrow(
      /invalid tag/
    )
  })

  it('accepts a relative context, which is what a compose project uses', () => {
    expect(buildDockerBuildCommand({ context: 'services/api', tag: 'api:1' })).toContain('services/api')
  })
})
