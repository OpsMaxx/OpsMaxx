import { randomUUID } from 'node:crypto'
import { loadData, saveData } from '../services/store'
import { createGroup, saveGroup, listGroups } from '../services/policyStore'
import { wsLockSet } from '../services/wslock'
import { vaultCreate, vaultSave, vaultStatus } from '../services/vault'
import { recordAudit } from '../services/auditLog'
import { requestApproval } from '../services/approvals'
import { createSession, listSessions } from '../services/mcpAuth'
import type { AccessGroup, AiCapability, AuditEntry } from '../../shared/mcp'
import type { VaultEntry } from '../../shared/vault'
import {
  DEMO_PASSWORD,
  GROUP_NAMES,
  SERVERS,
  WORKSPACES,
  WS_ACME,
  WS_GLOBEX,
  type DemoServer
} from './fixtures'

/**
 * Fill an empty demo profile, through the same service functions the app
 * uses, so nothing here re-implements a file format: the data blob is saved
 * by the store, the lock by wslock, the vault by the vault, and every audit
 * row goes through recordAudit so the hash chain and its head are genuine.
 *
 * Only ever called on a fresh profile. `npm run demo` wipes it first.
 */
export async function seedDemoProfile(): Promise<void> {
  if (loadData() !== null) return

  const groups = (['db', 'prod', 'jump', 'staging'] as const).map((g) => ({
    id: `mg-demo-${g}`,
    workspaceId: WS_ACME,
    name: GROUP_NAMES[g],
    collapsed: false,
    serverIds: SERVERS.filter((x) => x.group === g).map((x) => x.id)
  }))
  const folders = (['db', 'prod', 'jump', 'staging'] as const).map((g) => ({
    id: `fld-demo-${g}`,
    workspaceId: WS_ACME,
    name: GROUP_NAMES[g],
    parentId: null,
    kind: 'server'
  }))
  const server = (x: DemoServer): Record<string, unknown> => ({
    id: x.id,
    workspaceId: WS_ACME,
    folderId: `fld-demo-${x.group}`,
    name: x.name,
    host: x.host,
    port: 22,
    username: x.user,
    auth: 'agent',
    status: 'online',
    tags: [x.group === 'prod' ? 'production' : x.group],
    favorite: x.name === 'api-01' || x.name === 'pg-primary',
    os: x.os,
    route: [],
    vpnProfileId: null,
    // `demo: false` is what makes these real servers to the renderer: the
    // terminal, SFTP and metrics then take their real paths, and those paths
    // reach the demo only through ssh.ts's connector.
    demo: false
  })

  saveData({
    version: 2,
    theme: 'opsmaxx',
    themeRevision: 1,
    workspaces: WORKSPACES,
    activeWorkspaceId: WS_ACME,
    monitorGroups: groups,
    folders,
    servers: SERVERS.map(server),
    vpns: [],
    tunnels: [],
    databases: [
      {
        id: 'db-demo-orders',
        workspaceId: WS_ACME,
        name: 'orders (primary)',
        kind: 'postgres',
        host: '10.20.0.11',
        port: 5432,
        username: 'app_readonly',
        database: 'orders',
        ssl: true,
        uri: false,
        folderId: null,
        sshServerId: null,
        vpnProfileId: null
      }
    ],
    settings: {
      // A fresh profile has never been backed up, so the status bar would warn
      // about it in every shot; this one says it was, a minute ago.
      backupDirty: false,
      lastBackupAt: new Date(Date.now() - 60_000).toISOString(),
      lastBackupTo: '~/Backups/opsmaxx-acme.opsmaxx-backup',
      modules: {
        docker: true,
        kubernetes: true,
        posture: true,
        drift: true,
        inventory: true,
        capacity: true,
        fleetSearch: true
      }
    },
    tabs: [],
    activeTabId: null,
    panes: [],
    recentServerIds: ['srv-demo-api1', 'srv-demo-pg1']
  })

  await wsLockSet(WS_GLOBEX, DEMO_PASSWORD)
  seedPolicy()
  await seedVault()
  seedSessions()
  seedAudit()
}

function seedPolicy(): void {
  if (listGroups().some((g) => g.name === 'Contractors')) return
  const g = createGroup('Contractors')
  const caps: Partial<Record<AiCapability, 'allow' | 'ask' | 'deny'>> = {
    viewServer: 'allow',
    serverMetrics: 'allow',
    hostFacts: 'allow',
    fleetRead: 'allow',
    readFiles: 'allow',
    containers: 'allow',
    terminal: 'ask',
    writeFiles: 'ask',
    sftpDownload: 'ask',
    containerControl: 'ask',
    databaseAccess: 'ask',
    sftpUpload: 'deny',
    sudo: 'deny',
    sshTunnel: 'deny',
    manageServers: 'deny',
    vpnControl: 'deny',
    firewallRules: 'deny',
    sudoersRead: 'deny'
  }
  const next: AccessGroup = {
    ...g,
    capabilities: { ...g.capabilities, ...caps },
    filePolicies: [
      { id: randomUUID(), pattern: '/etc/**', read: 'allow', write: 'deny' },
      { id: randomUUID(), pattern: '/home/deploy/app/**', read: 'allow', write: 'ask' }
    ]
  }
  saveGroup(next)
}

async function seedVault(): Promise<void> {
  if (vaultStatus().exists) return
  await vaultCreate(DEMO_PASSWORD)
  const now = new Date().toISOString()
  const entry = (name: string, kind: VaultEntry['kind'], url: string, username: string, tags: string[]): VaultEntry => ({
    id: randomUUID(),
    name,
    kind,
    workspaceId: WS_ACME,
    url,
    username,
    password: randomUUID(),
    notes: '',
    tags,
    fields: [],
    createdAt: now,
    updatedAt: now
  })
  vaultSave([
    entry('deploy key (production)', 'sshkey', '', 'deploy', ['ssh', 'production']),
    entry('Postgres · app_readonly', 'login', 'postgres://10.20.0.11:5432/orders', 'app_readonly', ['database']),
    entry('Grafana', 'login', 'https://grafana.example.com', 'ops@example.com', ['monitoring']),
    entry('Registry token', 'key', 'https://registry.example.com', 'ci-bot', ['ci']),
    entry('Cloudflare API', 'key', 'https://api.cloudflare.com', 'ops@example.com', ['dns']),
    entry('WireGuard · eu-west', 'vpn', '203.0.113.20:51820', '', ['vpn']),
    entry('On-call runbook', 'note', '', '', ['runbook'])
  ])
}

const AGENTS = ['Claude Code (CLI)', 'Codex (CLI)', 'Gemini CLI']

/** One real paired session per agent, so the audit log and the approval dialog
 *  name sessions OpsMaxx has a record of. */
function seedSessions(): void {
  for (const agentName of AGENTS) {
    createSession({
      agentName,
      workspaces: [{ id: WS_ACME, name: 'Acme Corp · production' }],
      groupId: null,
      groupName: '',
      ttlMinutes: null,
      mode: 'auto'
    })
  }
}

const sessionOf = (agentName: string): string =>
  listSessions().find((x) => x.agentName === agentName)?.id ?? 'unknown'

function seedAudit(): void {
  // Oldest first, chained one to the next by recordAudit, which is what makes
  // the integrity badge read OK. The timestamp is set rather than left as
  // "now": it is part of the row the chain hashes, not something it orders by,
  // and eight rows in one millisecond do not read as an afternoon's work.
  const start = Date.now() - 58 * 60_000
  const minutes = [0, 6, 13, 21, 29, 37, 46, 53]
  const rows: [string, string, string, AiCapability, AuditEntry['approval'], AuditEntry['result'], number?][] = [
    ['Claude Code (CLI)', 'api-01', 'get_server_metrics', 'serverMetrics', 'not-required', 'success'],
    ['Claude Code (CLI)', 'api-01', 'read /var/log/nginx/error.log', 'readFiles', 'not-required', 'success'],
    ['Codex (CLI)', 'pg-primary', "psql -c 'select count(*) from pg_stat_activity'", 'databaseAccess', 'approved', 'success', 0],
    ['Claude Code (CLI)', 'web-edge', 'write /etc/nginx/sites-enabled/app.conf (612 bytes)', 'writeFiles', 'approved', 'success'],
    ['Gemini CLI', 'payments-api', 'sudo systemctl restart payments', 'sudo', 'denied', 'denied'],
    ['Claude Code (CLI)', 'worker-01', 'docker logs --tail 200 worker', 'containers', 'not-required', 'success', 0],
    ['Codex (CLI)', 'ci-runner', 'df -h /var/lib/docker', 'terminal', 'approved-for-session', 'success', 0],
    ['Claude Code (CLI)', 'k8s-control', 'kubectl rollout status deploy/api -n acme', 'containers', 'not-required', 'success', 0]
  ]
  rows.forEach(([agent, serverName, action, capability, approval, result, exitCode], i) => {
    recordAudit({
      timestamp: new Date(start + minutes[i] * 60_000).toISOString(),
      agentName: agent,
      sessionId: sessionOf(agent),
      workspaceId: WS_ACME,
      workspaceName: 'Acme Corp · production',
      serverId: SERVERS.find((x) => x.name === serverName)?.id ?? null,
      serverName,
      action,
      capability,
      approval,
      result,
      ...(exitCode === undefined ? {} : { exitCode }),
      mode: 'auto'
    } as Parameters<typeof recordAudit>[0])
  })
}

/** One pending request, so the approval dialog is real and its buttons work. */
export function raiseDemoApproval(): void {
  void requestApproval({
    sessionId: sessionOf('Claude Code (CLI)'),
    agentName: 'Claude Code (CLI)',
    workspaceId: WS_ACME,
    workspaceName: 'Acme Corp · production',
    serverId: 'srv-demo-api1',
    serverName: 'api-01',
    capability: 'sudo',
    action: 'sudo systemctl restart nginx',
    risk: 'high',
    riskReason: 'Restarts a service that is serving production traffic.',
    policyReason: 'sudo is set to ASK for this workspace.',
    toolName: 'execute_command',
    intent: 'Pick up the new TLS certificate that certbot renewed an hour ago.'
  }).catch(() => undefined)
}
