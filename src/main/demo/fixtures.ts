/**
 * The invented estate the screenshot demo shows.
 *
 * THIS REPO IS PUBLIC, and so is every screenshot taken from it. Every name
 * here is made up, every address is RFC 1918 (10.20.x.x, 10.30.x.x) or the
 * documentation range 203.0.113.0/24, and every domain is example.com. Nothing
 * here may be copied from a real host.
 */

export interface DemoServer {
  id: string
  name: string
  host: string
  user: string
  os: string
  group: 'db' | 'prod' | 'jump' | 'staging'
  /** Resting load the random walk wanders around. */
  cpu: number
  mem: number
  memGb: number
  disk: number
  diskGb: number
  cores: number
  /** Network, bytes per second. */
  rx: number
  tx: number
  services: string[]
  ports: number[]
  distro: 'ubuntu' | 'debian' | 'rocky'
  pending: number
  security: number
  reboot?: boolean
}

export const WS_ACME = 'ws-demo-acme'
export const WS_GLOBEX = 'ws-demo-globex'
export const WS_PERSONAL = 'ws-default'

export const WORKSPACES = [
  { id: WS_ACME, name: 'Acme Corp · production', color: 'green', hidden: false, locked: false, hasPassword: false },
  { id: WS_GLOBEX, name: 'Globex · staging', color: 'purple', hidden: false, locked: true, hasPassword: true },
  { id: WS_PERSONAL, name: 'Personal', color: 'cyan', hidden: false, locked: false, hasPassword: false }
]

/** Password for the locked workspace and the vault. Invented, and printed in the docs. */
export const DEMO_PASSWORD = 'demo-password'

const s = (
  id: string,
  name: string,
  host: string,
  group: DemoServer['group'],
  load: Partial<DemoServer>
): DemoServer => ({
  id: `srv-demo-${id}`,
  name,
  host,
  group,
  user: 'deploy',
  os: 'Linux',
  cpu: 12,
  mem: 45,
  memGb: 16,
  disk: 40,
  diskGb: 100,
  cores: 4,
  rx: 80_000,
  tx: 40_000,
  services: ['ssh', 'cron', 'node-exporter'],
  ports: [22, 9100],
  distro: 'ubuntu',
  pending: 3,
  security: 0,
  ...load
})

// Built by a function marked pure, so a production build -- where nothing uses
// this module -- can drop it: Rollup cannot otherwise prove the `s(...)` calls
// have no side effects, and kept the whole list in the shipped bundle.
export const SERVERS: DemoServer[] = /* @__PURE__ */ buildServers()

function buildServers(): DemoServer[] {
  return [
  s('api1', 'api-01', '10.20.1.21', 'prod', { cpu: 41, mem: 62, disk: 38, services: ['ssh', 'docker', 'nginx', 'node-exporter'], ports: [22, 80, 443, 9100] }),
  s('api2', 'api-02', '10.20.1.22', 'prod', { cpu: 37, mem: 59, disk: 37, services: ['ssh', 'docker', 'nginx', 'node-exporter'], ports: [22, 80, 443, 9100] }),
  s('edge', 'web-edge', '203.0.113.10', 'prod', { cpu: 22, mem: 34, memGb: 8, disk: 29, diskGb: 60, cores: 2, rx: 5_200_000, tx: 7_800_000, services: ['ssh', 'nginx', 'certbot.timer', 'node-exporter'], ports: [22, 80, 443, 9100] }),
  s('work', 'worker-01', '10.20.1.23', 'prod', { cpu: 63, mem: 48, cores: 8, services: ['ssh', 'docker', 'node-exporter'], ports: [22, 9100], distro: 'debian' }),
  s('pay', 'payments-api', '10.20.1.24', 'prod', { cpu: 15, mem: 41, memGb: 8, disk: 25, diskGb: 50, cores: 2, services: ['ssh', 'docker', 'node-exporter'], ports: [22, 8443, 9100], distro: 'rocky', pending: 2 }),
  s('k8s', 'k8s-control', '10.20.1.30', 'prod', { cpu: 29, mem: 66, disk: 44, cores: 4, services: ['ssh', 'k3s', 'node-exporter'], ports: [22, 6443, 9100] }),
  s('pg1', 'pg-primary', '10.20.0.11', 'db', { cpu: 34, mem: 71, memGb: 64, disk: 68, diskGb: 500, cores: 16, rx: 2_400_000, tx: 1_900_000, services: ['ssh', 'postgresql', 'pgbouncer', 'node-exporter'], ports: [22, 5432, 6432, 9100], pending: 5, security: 2 }),
  s('pg2', 'pg-replica', '10.20.0.12', 'db', { cpu: 18, mem: 64, memGb: 64, disk: 66, diskGb: 500, cores: 16, rx: 1_900_000, tx: 300_000, services: ['ssh', 'postgresql', 'node-exporter'], ports: [22, 5432, 9100] }),
  s('redis', 'redis-cache', '10.20.0.14', 'db', { cpu: 9, mem: 58, memGb: 32, disk: 22, diskGb: 80, cores: 8, rx: 3_100_000, tx: 3_400_000, services: ['ssh', 'redis-server', 'node-exporter'], ports: [22, 6379, 9100], distro: 'debian' }),
  s('mongo', 'events-store', '10.20.0.13', 'db', { cpu: 27, mem: 77, memGb: 32, disk: 81, diskGb: 250, cores: 8, rx: 900_000, tx: 700_000, services: ['ssh', 'mongod', 'node-exporter'], ports: [22, 27017, 9100], pending: 11, security: 4, reboot: true }),
  s('bas1', 'bastion-eu', '203.0.113.20', 'jump', { cpu: 2, mem: 18, memGb: 2, disk: 14, diskGb: 20, cores: 1, rx: 40_000, tx: 30_000 }),
  s('bas2', 'bastion-us', '203.0.113.30', 'jump', { cpu: 3, mem: 21, memGb: 2, disk: 15, diskGb: 20, cores: 1, rx: 35_000, tx: 28_000 }),
  s('vpn', 'vpn-gateway', '10.20.9.10', 'jump', { cpu: 6, mem: 27, memGb: 4, disk: 19, diskGb: 20, cores: 2, rx: 1_200_000, tx: 1_100_000, services: ['ssh', 'wg-quick@wg0', 'node-exporter'], ports: [22, 51820, 9100], distro: 'debian' }),
  s('stg1', 'staging-api', '10.30.1.10', 'staging', { cpu: 8, mem: 39, services: ['ssh', 'docker', 'nginx'], ports: [22, 80, 443] }),
  s('stg2', 'ci-runner', '10.30.1.12', 'staging', { cpu: 72, mem: 81, cores: 8, disk: 88, diskGb: 200, services: ['ssh', 'docker', 'gitlab-runner'], ports: [22], pending: 7, security: 1 })
  ]
}

export const GROUP_NAMES: Record<DemoServer['group'], string> = {
  db: 'Databases',
  prod: 'Production',
  jump: 'Jump servers',
  staging: 'Staging'
}

export function serverByHost(host: string): DemoServer {
  return SERVERS.find((x) => x.host === host) ?? SERVERS[4]
}

/** What SFTP lists, keyed by directory. */
export const FILES: Record<string, { name: string; dir?: boolean; size?: number; ageDays?: number }[]> = {
  '/home/deploy': [
    { name: 'app', dir: true, ageDays: 2 },
    { name: 'backups', dir: true, ageDays: 1 },
    { name: 'logs', dir: true, ageDays: 0.1 },
    { name: '.ssh', dir: true, ageDays: 40 },
    { name: '.bashrc', size: 3_771, ageDays: 120 },
    { name: 'docker-compose.yml', size: 2_184, ageDays: 6 },
    { name: 'deploy.sh', size: 1_402, ageDays: 6 },
    { name: 'README.md', size: 846, ageDays: 30 }
  ],
  '/home/deploy/app': [
    { name: 'releases', dir: true, ageDays: 2 },
    { name: 'shared', dir: true, ageDays: 60 },
    { name: '.env.example', size: 612, ageDays: 14 },
    { name: 'Caddyfile', size: 418, ageDays: 9 },
    { name: 'healthcheck.sh', size: 297, ageDays: 9 }
  ],
  '/home/deploy/logs': [
    { name: 'api.log', size: 18_400_000, ageDays: 0.01 },
    { name: 'api.log.1.gz', size: 2_900_000, ageDays: 1 },
    { name: 'worker.log', size: 6_200_000, ageDays: 0.02 }
  ]
}

/** Canned answers for the demo terminal. Keys are the whole command line. */
export function shellReply(server: DemoServer, line: string): string {
  const up = `up 41 days,  3:12,  2 users,  load average: ${(server.cpu / 25).toFixed(2)}, ${(server.cpu / 28).toFixed(2)}, ${(server.cpu / 30).toFixed(2)}`
  const replies: Record<string, string> = {
    '': '',
    whoami: server.user,
    hostname: server.name,
    pwd: '/home/deploy',
    uptime: ` 14:07:31 ${up}`,
    ls: 'app  backups  docker-compose.yml  deploy.sh  logs  README.md',
    'df -h': [
      'Filesystem      Size  Used Avail Use% Mounted on',
      `/dev/nvme0n1p1  ${server.diskGb}G  ${Math.round((server.diskGb * server.disk) / 100)}G  ${Math.round((server.diskGb * (100 - server.disk)) / 100)}G  ${server.disk}% /`,
      'tmpfs           7.8G     0  7.8G   0% /dev/shm',
      '/dev/nvme1n1   1.0T  412G  612G  41% /srv/data'
    ].join('\n'),
    'systemctl status nginx --no-pager': [
      '\x1b[32m●\x1b[0m nginx.service - A high performance web server and a reverse proxy server',
      '     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; preset: enabled)',
      '     Active: \x1b[32mactive (running)\x1b[0m since Mon 2026-08-19 10:55:02 UTC; 41 days ago',
      '       Docs: man:nginx(8)',
      '   Main PID: 1123 (nginx)',
      '      Tasks: 5 (limit: 19089)',
      '     Memory: 14.2M (peak: 22.7M)',
      '        CPU: 3min 41.002s',
      '     CGroup: /system.slice/nginx.service',
      '             ├─1123 "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;"',
      '             ├─1124 "nginx: worker process"',
      '             └─1125 "nginx: worker process"'
    ].join('\n'),
    'docker ps': [
      'CONTAINER ID   IMAGE                          STATUS                  PORTS                    NAMES',
      '4f1c2a9e8b7d   registry.example.com/api:2.14  Up 2 days (healthy)     127.0.0.1:8080->8080/tcp api',
      '9b3e71d0c2aa   redis:7.2-alpine               Up 2 days               6379/tcp                 cache',
      'c07d5e3f11b2   caddy:2.8                      Up 9 days               0.0.0.0:443->443/tcp     edge'
    ].join('\n')
  }
  return replies[line] ?? `bash: ${line.split(' ')[0]}: command not found`
}
