// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { ComposePanel } from '../src/renderer/src/components/docker/ComposePanel'
import type { ComposeConfigProbe, ComposeListProbe } from '../src/shared/compose'
import type { DockerContainer } from '../src/shared/docker'
import type { Server } from '../src/renderer/src/types'

// Rendered rather than read. The rule this panel has to keep is not visible in
// a source regex: a component can import COMPOSE_ENV_DISCLOSURE and never
// render it, and it can be handed an environment value and put it on screen
// without any single line looking wrong.

const SERVER: Server = {
  id: 'srv-edge',
  workspaceId: 'ws-default',
  folderId: null,
  name: 'edge-01',
  host: 'edge-01.example.internal',
  port: 22,
  username: 'ops',
  auth: 'key',
  status: 'online',
  tags: [],
  favorite: false,
  os: 'linux',
  route: [],
  vpnProfileId: null
}

const LIST: ComposeListProbe = {
  ok: true,
  composeVersion: '2.29.7',
  projectsFrom: 'compose-ls',
  projects: [
    {
      name: 'edge',
      status: 'running(1)',
      running: 1,
      stopped: 0,
      configFiles: ['/srv/edge/compose.yaml']
    }
  ],
  search: {
    files: [],
    truncated: false,
    bound: {
      roots: ['/srv', '/opt'],
      maxDepth: 4,
      maxResults: 200,
      pruned: ['node_modules'],
      fileNames: ['compose.yaml'],
      crossesFilesystems: false
    }
  }
}

const CONFIG: ComposeConfigProbe = {
  ok: true,
  config: {
    name: 'edge',
    namesOnly: false,
    volumes: [],
    networks: [],
    services: [
      {
        name: 'cache',
        image: 'redis:7.2-alpine',
        build: false,
        containerName: null,
        dependsOn: [],
        ports: [],
        profiles: [],
        environment: [
          { name: 'REDIS_PASSWORD', origin: 'interpolated', variable: 'REDIS_PASSWORD', set: true }
        ],
        envFiles: ['/srv/edge/.env'],
        restart: null,
        networkMode: null
      },
      {
        name: 'worker',
        image: 'busybox:1.36',
        build: false,
        containerName: null,
        dependsOn: [],
        ports: [],
        profiles: [],
        environment: [],
        envFiles: [],
        restart: null,
        networkMode: null
      }
    ]
  }
}

const RUNNING_CACHE: DockerContainer = {
  id: 'a'.repeat(64),
  shortId: 'a'.repeat(12),
  name: 'edge-cache-1',
  image: 'redis:7.2-alpine',
  state: 'running',
  status: 'Up 2 minutes',
  ports: '',
  createdAt: 'now',
  composeProject: 'edge',
  composeService: 'cache'
}

function panelBridge(over: Record<string, unknown> = {}) {
  return {
    compose: {
      list: vi.fn(async () => LIST),
      config: vi.fn(async () => CONFIG),
      envNames: vi.fn(async () => ({
        ok: true as const,
        files: [
          {
            path: '/srv/edge/.env',
            readable: true,
            names: [{ name: 'REDIS_PASSWORD', set: true }]
          }
        ]
      })),
      readFile: vi.fn(async () => ({
        ok: true,
        text: 'services:\n  cache:\n    image: redis:7.2-alpine\n'
      })),
      writeImageTag: vi.fn(async () => ({
        ok: true as const,
        plan: {
          ok: true as const,
          service: 'cache',
          line: 3,
          from: 'redis:7.2-alpine',
          to: 'redis:7.4-alpine',
          before: '    image: redis:7.2-alpine',
          after: '    image: redis:7.4-alpine'
        },
        backup: '/srv/edge/compose.yaml.opsmaxx-bak'
      })),
      ...over
    },
    jobs: { run: vi.fn(async () => ({})) }
  }
}

async function openProject(bridgeStub: Record<string, unknown>): Promise<void> {
  stubBridge(bridgeStub)
  render(<ComposePanel server={SERVER} cfg={{}} containers={[RUNNING_CACHE]} sudo={false} />)
  await userEvent.click(screen.getByText('Find compose files'))
  await waitFor(() => screen.getByText(/▸ edge/))
  await userEvent.click(screen.getByText(/▸ edge/))
  // `cache` appears twice once the project opens — once as a service row, once
  // as an environment row — so this waits for at least one rather than exactly
  // one.
  await waitFor(() => expect(screen.getAllByText('cache').length).toBeGreaterThan(0))
}

describe('what the panel shows about environment', () => {
  it('names a variable and marks it set, without its value anywhere on screen', async () => {
    await openProject(panelBridge())
    // Twice: once from the compose model, once from the .env summary. Both are
    // names with a set/empty marker and neither is a value.
    expect(screen.getAllByText(/REDIS_PASSWORD=\(set\)/).length).toBe(2)
    // The value never reached the renderer, so it cannot be here — but the
    // assertion is on the rendered DOM rather than on the bridge, because that
    // is where a future refactor would put it back.
    expect(document.body.textContent).not.toContain('hunter2')
  })

  it('says on screen that the withholding is deliberate', async () => {
    await openProject(panelBridge())
    expect(document.body.textContent).toContain('never their values')
    expect(document.body.textContent).toContain('open the file on the server')
  })

  it('does not claim a .env is empty when it could not be read', async () => {
    await openProject(
      panelBridge({
        envNames: vi.fn(async () => ({
          ok: true as const,
          files: [{ path: '/srv/edge/.env', readable: false, names: [] }]
        }))
      })
    )
    expect(screen.getByText(/could not be read/)).toBeTruthy()
  })
})

describe('declared against running', () => {
  it('says which declared service has no container at all', async () => {
    await openProject(panelBridge())
    // `cache` is running. `worker` is declared and has never been created,
    // which is the fact the container list above cannot state because there is
    // no container to list.
    expect(screen.getByText('never created')).toBeTruthy()
    expect(document.body.textContent).toContain('Declared but never created: worker')
  })

  it('does not present a names-only read as a project with no images', async () => {
    await openProject(
      panelBridge({
        config: vi.fn(async () => ({
          ok: true as const,
          config: {
            name: 'edge',
            namesOnly: true,
            volumes: [],
            networks: [],
            services: [
              {
                name: 'cache',
                image: null,
                build: false,
                containerName: null,
                dependsOn: [],
                ports: [],
                profiles: [],
                environment: [],
                envFiles: [],
                restart: null
              }
            ]
          }
        }))
      })
    )
    expect(document.body.textContent).toContain('unknown here rather than absent')
  })
})

describe('what the panel refuses', () => {
  it('offers exactly two verbs and no third', async () => {
    await openProject(panelBridge())
    // Asserted as the whole set rather than as an absence of the word "down".
    // An absence check passes the moment somebody spells the button
    // differently; this fails the moment another action button appears at all,
    // whatever it is called.
    //
    // The restart below is deliberately in this list and is NOT a third compose
    // verb: it runs `docker restart` against the named containers, on the
    // container path, for the reasons in `planComposeServiceRestart`. Any
    // FURTHER button, or a restart whose title stops naming its blast radius,
    // still fails here.
    //
    // Nor is the roll-back a new verb, and its title has to keep saying so: it
    // reads the backup beside the file, opens the SAME tag edit pre-filled with
    // the previous value, and writes nothing until that edit is confirmed. A
    // roll-back that wrote on click would be a second write path with its own
    // rules, and this assertion is where that would show up.
    const titled = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('title'))
      .filter((t): t is string => t !== null)
    expect(titled).toEqual([
      'docker compose pull for edge. Fetches images; nothing running changes.',
      'docker compose up -d for edge. Starts what is declared; removes nothing.',
      "Restart cache's container. Every connection they are serving is interrupted, and a change to the compose file is NOT applied by a restart.",
      "Change cache's image tag in the compose file. Nothing is pulled or restarted.",
      'Put cache back to the tag it had before OpsMaxx last edited this file. Opens the same edit, pre-filled — nothing is written until you confirm.',
      "Change worker's image tag in the compose file. Nothing is pulled or restarted.",
      'Put worker back to the tag it had before OpsMaxx last edited this file. Opens the same edit, pre-filled — nothing is written until you confirm.'
    ])
  })

  it('prints the reason where the button would have been', async () => {
    await openProject(panelBridge())
    expect(document.body.textContent).toContain('removes every container in the project')
  })
})

describe('the search bounds are on screen', () => {
  it('says where it looked, so an empty answer can be read', async () => {
    await openProject(panelBridge())
    expect(document.body.textContent).toContain('Looked in /srv, /opt')
    expect(document.body.textContent).toContain('4 levels')
    expect(document.body.textContent).toContain('on this filesystem only')
  })

  it('says when the cap cut the list off', async () => {
    await openProject(
      panelBridge({
        list: vi.fn(async () => ({
          ...LIST,
          search: { ...LIST.ok ? LIST.search! : null!, truncated: true }
        }))
      })
    )
    expect(document.body.textContent).toContain('prefix rather than an inventory')
  })
})

describe('pull and up go through the job engine', () => {
  it('runs a job rather than a compose command of its own', async () => {
    const stub = panelBridge()
    await openProject(stub)
    await userEvent.click(screen.getByTitle(/docker compose pull/))
    const run = (stub.jobs as { run: ReturnType<typeof vi.fn> }).run
    await waitFor(() => expect(run).toHaveBeenCalled())
    const req = run.mock.calls[0][0] as {
      spec: { steps: { command: string }[]; title: string }
      approval: unknown
    }
    expect(req.spec.steps[0].command).toBe(
      "docker compose --project-name 'edge' -f '/srv/edge/compose.yaml' pull"
    )
    // The approval record the runner re-checks. A job launched without one is
    // a job started on a confirmation nobody wrote down.
    expect(req.approval).toBeTruthy()
  })
})

describe('the image tag edit', () => {
  it('sends the line the operator was shown, so the server can refuse a stale edit', async () => {
    const stub = panelBridge()
    await openProject(stub)
    await userEvent.click(screen.getByTitle(/Change cache's image tag/))
    const input = screen.getByDisplayValue('redis:7.2-alpine')
    await userEvent.clear(input)
    await userEvent.type(input, 'redis:7.4-alpine')
    await userEvent.click(screen.getByText('Write the file'))
    const write = (stub.compose as { writeImageTag: ReturnType<typeof vi.fn> }).writeImageTag
    await waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0][1]).toEqual({
      path: '/srv/edge/compose.yaml',
      service: 'cache',
      image: 'redis:7.4-alpine',
      expect: { line: 3, before: '    image: redis:7.2-alpine' }
    })
  })

  it('will not offer to write a reference it cannot prove is one', async () => {
    await openProject(panelBridge())
    await userEvent.click(screen.getByTitle(/Change cache's image tag/))
    const input = screen.getByDisplayValue('redis:7.2-alpine')
    await userEvent.clear(input)
    await userEvent.type(input, '../etc/passwd')
    expect(screen.getByText('Write the file').hasAttribute('disabled')).toBe(true)
  })

  it('says the new image is not running yet', async () => {
    const stub = panelBridge()
    await openProject(stub)
    await userEvent.click(screen.getByTitle(/Change cache's image tag/))
    const input = screen.getByDisplayValue('redis:7.2-alpine')
    await userEvent.clear(input)
    await userEvent.type(input, 'redis:7.4-alpine')
    await userEvent.click(screen.getByText('Write the file'))
    await waitFor(() =>
      expect(document.body.textContent).toContain('Nothing is running the new image')
    )
  })
})

// THE PANEL USED TO ANSWER ITS OWN CONFIRMATION. It read the phrase the plan
// asked for straight off the plan, stamped `confirmedAt: Date.now()` and ran.
// Harmless exactly while the plan says `none`, which is a plain pull on one
// server -- and not the case with the sudo toggle on.
async function openWithSudo(bridgeStub: Record<string, unknown>): Promise<void> {
  stubBridge(bridgeStub)
  render(<ComposePanel server={SERVER} cfg={{}} containers={[RUNNING_CACHE]} sudo={true} />)
  await userEvent.click(screen.getByText('Find compose files'))
  await waitFor(() => screen.getByText(/▸ edge/))
}

describe('a compose job that needs confirming is confirmed by a person', () => {
  it('does not run an elevated job on a confirmation it wrote itself', async () => {
    const stub = panelBridge()
    await openWithSudo(stub)
    await userEvent.click(screen.getByTitle(/docker compose up -d/))
    const run = (stub.jobs as { run: ReturnType<typeof vi.fn> }).run
    // The dialog is up and the job has not started.
    await waitFor(() => screen.getByText('Run'))
    expect(run).not.toHaveBeenCalled()
    // It says why it is asking, and shows the command it would run.
    expect(document.body.textContent).toContain('runs as root')
    expect(document.body.textContent).toContain('up -d')
  })

  it('runs it once the person answers, carrying an approval the engine re-checks', async () => {
    const stub = panelBridge()
    await openWithSudo(stub)
    await userEvent.click(screen.getByTitle(/docker compose up -d/))
    await waitFor(() => screen.getByText('Run'))
    await userEvent.click(screen.getByText('Run'))
    const run = (stub.jobs as { run: ReturnType<typeof vi.fn> }).run
    await waitFor(() => expect(run).toHaveBeenCalled())
    const req = run.mock.calls[0][0] as { approval: unknown; spec: { steps: { command: string }[] } }
    expect(req.approval).toBeTruthy()
    expect(req.spec.steps[0].command).toContain('up -d')
  })

  it('runs nothing at all when the person says no', async () => {
    const stub = panelBridge()
    await openWithSudo(stub)
    await userEvent.click(screen.getByTitle(/docker compose up -d/))
    await waitFor(() => screen.getByText('Cancel'))
    await userEvent.click(screen.getByText('Cancel'))
    expect((stub.jobs as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Item 42: pulling one service instead of twelve
// ---------------------------------------------------------------------------
//
// `buildComposeActionCommand` has accepted and validated a `services` list
// since it was written, and the panel never passed one -- so `pull` on a
// twelve-service project pulled twelve images to update one. The same shape as
// the job engine with no composer and the log tail with no caller.

describe('pulling only the services that were picked', () => {
  it('names them in the command, instead of the whole project', async () => {
    const stub = panelBridge()
    await openProject(stub)
    await userEvent.click(screen.getByLabelText('Include cache'))
    await userEvent.click(screen.getByTitle(/docker compose pull/))
    const run = (stub.jobs as { run: ReturnType<typeof vi.fn> }).run
    await waitFor(() => expect(run).toHaveBeenCalled())
    const cmd = (run.mock.calls[0][0] as { spec: { steps: { command: string }[] } }).spec.steps[0]
      .command
    expect(cmd).toMatch(/pull 'cache'$/)
  })

  it('still means the whole project when nothing is picked', async () => {
    // Which is what compose itself means by no argument.
    const stub = panelBridge()
    await openProject(stub)
    await userEvent.click(screen.getByTitle(/docker compose pull/))
    const run = (stub.jobs as { run: ReturnType<typeof vi.fn> }).run
    await waitFor(() => expect(run).toHaveBeenCalled())
    const cmd = (run.mock.calls[0][0] as { spec: { steps: { command: string }[] } }).spec.steps[0]
      .command
    expect(cmd).toMatch(/pull$/)
  })

  it('forgets the picks when the project is collapsed', async () => {
    // A selection carried across would name another project's services.
    const stub = panelBridge()
    await openProject(stub)
    await userEvent.click(screen.getByLabelText('Include cache'))
    await userEvent.click(screen.getByText(/▾ edge/))
    await userEvent.click(screen.getByText(/▸ edge/))
    await waitFor(() => screen.getByLabelText('Include cache'))
    expect((screen.getByLabelText('Include cache') as HTMLInputElement).checked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Item 42: rendering what the parser already knows
// ---------------------------------------------------------------------------
//
// `depends_on`, `restart:`, ports and profiles have been parsed since the
// parser was written and none of them reached the screen. These are the answers
// to "why did that not start" and "why did that not come back after the
// reboot", and the panel was showing a name, a state and an image.

/** Opens the project with a single, hand-built service. Not `openProject`,
 *  which waits for the fixture's own `cache` row. */
async function openWithService(decl: Record<string, unknown>): Promise<void> {
  const probe = {
    ok: true,
    config: { name: 'edge', namesOnly: false, volumes: [], networks: [], services: [decl] }
  }
  stubBridge(panelBridge({ config: vi.fn(async () => probe) }))
  render(<ComposePanel server={SERVER} cfg={{}} containers={[]} sudo={false} />)
  await userEvent.click(screen.getByText('Find compose files'))
  await waitFor(() => screen.getByText(/▸ edge/))
  await userEvent.click(screen.getByText(/▸ edge/))
  await waitFor(() => expect(screen.getAllByText(decl.name as string).length).toBeGreaterThan(0))
}

describe('what the compose file actually says', () => {
  it('warns that a service with no restart policy will not come back', async () => {
    // compose defaults to `no`, so a service without one does not restart
    // after a reboot. The absence is the finding, not a blank cell.
    await openProject(panelBridge())
    expect(document.body.textContent).toContain('restart: no (default)')
  })

  it('shows what a service waits for', async () => {
    await openWithService({
      name: 'web',
      image: 'nginx:1.27',
      build: false,
      containerName: null,
      dependsOn: ['cache'],
      ports: ['8080:80'],
      profiles: [],
      environment: [],
      envFiles: [],
      restart: 'unless-stopped'
    })
    expect(document.body.textContent).toContain('after cache')
    expect(document.body.textContent).toContain('8080:80')
    expect(document.body.textContent).toContain('restart: unless-stopped')
  })

  it('says a profiled service is not started by a plain up', async () => {
    // The commonest reason a declared service is "missing".
    await openWithService({
      name: 'debug',
      image: 'busybox',
      build: false,
      containerName: null,
      dependsOn: [],
      ports: [],
      profiles: ['tools'],
      environment: [],
      envFiles: [],
      restart: 'no'
    })
    expect(document.body.textContent).toContain('not started by a plain up')
  })
})

// ---------------------------------------------------------------------------
// Restarting one service. Item 42's row, and everything asserted here was
// measured against a real compose project first -- see planComposeServiceRestart.
// ---------------------------------------------------------------------------

const SECOND_CACHE: DockerContainer = { ...RUNNING_CACHE, name: 'edge-cache-2' }

async function openWith(containers: DockerContainer[], over: Record<string, unknown> = {}) {
  const b = { ...panelBridge(), docker: { act: vi.fn(async () => ({ ok: true })) }, ...over }
  stubBridge(b)
  render(<ComposePanel server={SERVER} cfg={{}} containers={containers} sudo={false} />)
  await userEvent.click(screen.getByText('Find compose files'))
  await waitFor(() => screen.getByText(/▸ edge/))
  await userEvent.click(screen.getByText(/▸ edge/))
  await waitFor(() => expect(screen.getAllByText('cache').length).toBeGreaterThan(0))
  return b
}

describe('restarting one compose service', () => {
  it('offers no restart for a service that has no container', async () => {
    await openWith([RUNNING_CACHE])
    // `worker` is declared and has never been created. `restart` does not
    // create a container, so there is no button rather than a button that
    // cannot work.
    expect(screen.queryByTitle(/^Restart worker/)).toBeNull()
    expect(screen.getByTitle(/^Restart cache/)).toBeTruthy()
  })

  it('names the containers, and says the file is not applied by a restart', async () => {
    await openWith([RUNNING_CACHE])
    await userEvent.click(screen.getByTitle(/^Restart cache/))
    await waitFor(() => screen.getByText('Restart cache'))
    expect(screen.getByText('edge-cache-1')).toBeTruthy()
    expect(screen.getByText(/not applied by a restart/)).toBeTruthy()
    expect(screen.getByText(/`up` is what applies the file/)).toBeTruthy()
  })

  it('makes two replicas a typed phrase, and shows both names', async () => {
    await openWith([RUNNING_CACHE, SECOND_CACHE])
    await userEvent.click(screen.getByTitle(/^Restart cache/))
    await waitFor(() => screen.getByText(/This restarts 2 containers/))
    expect(screen.getByText(/edge-cache-1\s*\n?\s*edge-cache-2/)).toBeTruthy()
    expect(screen.getByPlaceholderText('Type RESTART to confirm')).toBeTruthy()
  })

  it('will not run the two-replica restart until the phrase is typed', async () => {
    const b = await openWith([RUNNING_CACHE, SECOND_CACHE])
    await userEvent.click(screen.getByTitle(/^Restart cache/))
    await waitFor(() => screen.getByPlaceholderText('Type RESTART to confirm'))
    const go = screen.getByText('Restart', { selector: 'button' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    await userEvent.type(screen.getByPlaceholderText('Type RESTART to confirm'), 'RESTART')
    await waitFor(() =>
      expect((screen.getByText('Restart', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    await userEvent.click(screen.getByText('Restart', { selector: 'button' }))
    await waitFor(() =>
      expect((b.docker.act as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    )
    // BOTH names, not just the one the row is keyed on. `docker compose
    // restart cache` would restart both containers, and a panel that sent one
    // while saying "This restarts 2 containers" would be lying in the
    // direction that leaves half the service on the old process.
    expect((b.docker.act as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual([
      'edge-cache-1',
      'edge-cache-2'
    ])
  })

  it('sends the container names to the container path, never a compose verb', async () => {
    const b = await openWith([RUNNING_CACHE])
    await userEvent.click(screen.getByTitle(/^Restart cache/))
    await waitFor(() => screen.getByText('Restart cache'))
    await userEvent.click(screen.getByText('Restart', { selector: 'button' }))
    await waitFor(() => expect((b.docker.act as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1))
    const call = (b.docker.act as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1]).toBe('restart')
    expect(call[2]).toEqual(['edge-cache-1'])
    // The compose bridge is not how a restart happens.
    expect(Object.keys(b.compose)).not.toContain('restart')
  })
})

// ---------------------------------------------------------------------------
// The lint, on screen. Item 42's validation row.
// ---------------------------------------------------------------------------

const FLOATING_CONFIG: ComposeConfigProbe = {
  ok: true,
  config: {
    name: 'edge',
    namesOnly: false,
    volumes: [],
    networks: [],
    services: [
      {
        name: 'cache',
        image: 'redis:latest',
        build: false,
        containerName: null,
        dependsOn: [],
        ports: ['8080:80'],
        profiles: [],
        environment: [],
        envFiles: [],
        restart: null,
        networkMode: 'host'
      }
    ]
  }
}

describe('what the lint puts on screen', () => {
  it('says what a moving tag will do', async () => {
    await openProject(panelBridge({ config: vi.fn(async () => FLOATING_CONFIG) }))
    await waitFor(() =>
      expect(document.body.textContent).toContain('can change what is running without any change to this file')
    )
  })

  it('says the host-network ports do nothing', async () => {
    await openProject(panelBridge({ config: vi.fn(async () => FLOATING_CONFIG) }))
    await waitFor(() => expect(document.body.textContent).toContain('ignores the mappings'))
  })

  // The table already carries a warn chip per service. A second sentence each
  // would be twelve paragraphs on a twelve-service project saying what twelve
  // chips say.
  it('does not repeat the restart chip as a sentence', async () => {
    await openProject(panelBridge({ config: vi.fn(async () => FLOATING_CONFIG) }))
    await waitFor(() => expect(document.body.textContent).toContain('restart: no (default)'))
    expect(document.body.textContent).not.toContain('does not come back after a reboot')
  })

  it('shows compose’s own line when compose refused the file', async () => {
    // Not via openProject: a refused config renders no service rows, which is
    // the state under test.
    stubBridge(
      panelBridge({
        config: vi.fn(async () => ({
          ok: false as const,
          reason: 'invalid-project' as const,
          detail: 'service "web" depends on undefined service "nope": invalid compose project'
        }))
      })
    )
    render(<ComposePanel server={SERVER} cfg={{}} containers={[RUNNING_CACHE]} sudo={false} />)
    await userEvent.click(screen.getByText('Find compose files'))
    await waitFor(() => screen.getByText(/▸ edge/))
    await userEvent.click(screen.getByText(/▸ edge/))
    await waitFor(() =>
      expect(document.body.textContent).toContain('depends on undefined service "nope"')
    )
    expect(document.body.textContent).toContain('read the file and refused it')
  })
})

const BUILT_CONFIG: ComposeConfigProbe = {
  ok: true,
  config: {
    name: 'edge',
    namesOnly: false,
    volumes: [],
    networks: [],
    services: [
      {
        name: 'cache',
        image: null,
        build: true,
        containerName: null,
        dependsOn: [],
        ports: [],
        profiles: [],
        environment: [],
        envFiles: [],
        restart: 'always',
        networkMode: null
      }
    ]
  }
}

describe('the build button', () => {
  it('is not offered for a project of pulled images', async () => {
    // A build button on a project that builds nothing is a button that does
    // nothing, and one that runs a Dockerfile is not offered on the chance it
    // applies.
    await openProject(panelBridge())
    expect(screen.queryByTitle(/compose build/)).toBeNull()
  })

  it('appears once the file declares something built from source', async () => {
    await openProject(panelBridge({ config: vi.fn(async () => BUILT_CONFIG) }))
    await waitFor(() => expect(screen.getByTitle(/compose build --pull/)).toBeTruthy())
  })

  it('says it runs Dockerfiles and changes nothing running', async () => {
    await openProject(panelBridge({ config: vi.fn(async () => BUILT_CONFIG) }))
    const title = screen.getByTitle(/compose build --pull/).getAttribute('title')!
    expect(title).toContain('Runs its Dockerfiles')
    expect(title).toContain('nothing running changes')
  })
})
