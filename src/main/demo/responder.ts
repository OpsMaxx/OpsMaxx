import type { SshHop } from '../../shared/ssh'
import { FACTS_STATUS_MARKER } from '../../shared/hostFacts'
import { DOCKER_MARKERS, DOCKER_SEP } from '../../shared/docker'
import { POSTURE_STATUS_MARKER } from '../../shared/posture'
import { FILES, SERVERS, serverByHost, shellReply, type DemoServer } from './fixtures'
import type { Responder } from './fakeSsh'

/**
 * Answers the fake SSH connections with text in the exact shape each real
 * probe prints, so the app's own parsers turn it into what the screens show.
 * A probe this does not recognise answers nothing and is logged once, which
 * is how the next screen that needs one gets found.
 */

const started = Date.now()
const logged = new Set<string>()

/** A smooth, deterministic wander around `base`, so a series looks alive. */
function wander(base: number, seed: number, spread: number, lo = 0, hi = 100): number {
  const t = (Date.now() - started) / 1000
  const v =
    base +
    spread * Math.sin(t / 17 + seed) +
    (spread / 2) * Math.sin(t / 5.3 + seed * 2.1) +
    (spread / 4) * Math.sin(t / 1.7 + seed * 3.7)
  return Math.min(hi, Math.max(lo, v))
}

const seedOf = (srv: DemoServer): number => SERVERS.indexOf(srv) * 1.37 + 0.5

// Cumulative /proc/stat and /proc/net/dev counters per server, so every sample
// differs from the last by what the wander says happened in between.
const cpuTotals = new Map<string, { busy: number; idle: number; cores: { busy: number; idle: number }[] }>()
const netTotals = new Map<string, { rx: number; tx: number; at: number }>()

function cpuBlock(srv: DemoServer): string[] {
  const state = cpuTotals.get(srv.id) ?? {
    busy: 9_000_000,
    idle: 40_000_000,
    cores: Array.from({ length: srv.cores }, () => ({ busy: 2_000_000, idle: 9_000_000 }))
  }
  const line = (name: string, c: { busy: number; idle: number }): string =>
    `${name} ${Math.round(c.busy * 0.7)} 0 ${Math.round(c.busy * 0.3)} ${Math.round(c.idle)} 0 0 0 0 0 0`
  const snap = (): string[] => [line('cpu', state), ...state.cores.map((c, i) => line(`cpu${i}`, c))]
  const before = snap()
  const pct = wander(srv.cpu, seedOf(srv), Math.max(4, srv.cpu * 0.35), 1, 99) / 100
  const tick = 400 * srv.cores
  state.busy += tick * pct
  state.idle += tick * (1 - pct)
  state.cores.forEach((c, i) => {
    const p = Math.min(0.99, Math.max(0.01, pct + 0.12 * Math.sin(i * 1.9 + seedOf(srv))))
    c.busy += 400 * p
    c.idle += 400 * (1 - p)
  })
  cpuTotals.set(srv.id, state)
  return [...before, ...snap()]
}

function metricsText(srv: DemoServer): string {
  const seed = seedOf(srv)
  const memTotalKb = srv.memGb * 1024 * 1024
  const memPct = wander(srv.mem, seed + 1, 3, 5, 97) / 100
  const availKb = Math.round(memTotalKb * (1 - memPct))
  const diskKb = srv.diskGb * 1024 * 1024
  const diskPct = wander(srv.disk, seed + 2, 0.3, 1, 99)
  const usedKb = Math.round((diskKb * diskPct) / 100)
  const net = netTotals.get(srv.id) ?? { rx: 8e9, tx: 5e9, at: Date.now() - 2000 }
  const dt = Math.max(0.5, (Date.now() - net.at) / 1000)
  net.rx += wander(srv.rx, seed + 3, srv.rx * 0.4, srv.rx * 0.1, srv.rx * 3) * dt
  net.tx += wander(srv.tx, seed + 4, srv.tx * 0.4, srv.tx * 0.1, srv.tx * 3) * dt
  net.at = Date.now()
  netTotals.set(srv.id, net)
  const load = ((srv.cpu / 100) * srv.cores).toFixed(2)
  const svcs = srv.services.map((u) =>
    u.includes('.') ? `${u} loaded active waiting ${u}` : `${u}.service loaded active running ${u}`
  )
  const ports = srv.ports.map(
    (p) => `tcp LISTEN 0 4096 0.0.0.0:${p} 0.0.0.0:* users:(("${p === 22 ? 'sshd' : 'svc'}",pid=${800 + p},fd=3))`
  )
  const section = (name: string, lines: string[]): string => `__${name}__\n${lines.join('\n')}`
  return [
    section('CPU', cpuBlock(srv)),
    section('MEM', [
      `MemTotal: ${memTotalKb} kB`,
      `MemFree: ${Math.round(availKb * 0.4)} kB`,
      `MemAvailable: ${availKb} kB`,
      `Buffers: ${Math.round(memTotalKb * 0.03)} kB`,
      `Cached: ${Math.round(availKb * 0.5)} kB`,
      'SReclaimable: 204800 kB'
    ]),
    section('DISK', [`/dev/nvme0n1p1 ${diskKb} ${usedKb} ${diskKb - usedKb} ${Math.round(diskPct)}% /`]),
    section('INODE', [`/dev/nvme0n1p1 6553600 ${Math.round(6553600 * 0.18)} ${Math.round(6553600 * 0.82)} 18% /`]),
    section('MOUNTS', [
      'Filesystem Type 1024-blocks Used Available Capacity Mounted on',
      `/dev/nvme0n1p1 ext4 ${diskKb} ${usedKb} ${diskKb - usedKb} ${Math.round(diskPct)}% /`
    ]),
    section('MOUNTINODES', [
      'Filesystem Type Inodes IUsed IFree IUse% Mounted on',
      '/dev/nvme0n1p1 ext4 6553600 1179648 5373952 18% /'
    ]),
    section('LOAD', [`${load} ${load} ${load} 2/318 41277`]),
    section('NET', [
      'Inter-|   Receive                            |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      `  eth0: ${Math.round(net.rx)} 9000000 0 0 0 0 0 0 ${Math.round(net.tx)} 7000000 0 0 0 0 0 0`,
      '    lo: 1000000 10000 0 0 0 0 0 0 1000000 10000 0 0 0 0 0 0'
    ]),
    section('PHYS', ['eth0']),
    section('UP', [`${3_550_000 + SERVERS.indexOf(srv) * 86_400}.42 9000000.11`]),
    section('HOST', [srv.name]),
    section('KERN', [srv.distro === 'rocky' ? '5.14.0-427.el9.x86_64' : '6.8.0-45-generic']),
    section('CORES', [String(srv.cores)]),
    section('SVC', svcs),
    section('PORTS', ['src:ss', ...ports])
  ].join('\n')
}

function factsText(srv: DemoServer): string {
  const distro = {
    ubuntu: ['ubuntu', '24.04', 'Ubuntu 24.04.1 LTS', 'apt'],
    debian: ['debian', '12', 'Debian GNU/Linux 12 (bookworm)', 'apt'],
    rocky: ['rocky', '9.4', 'Rocky Linux 9.4 (Blue Onyx)', 'dnf']
  }[srv.distro]
  const values: Record<string, string> = {
    'os-id': `ID=${distro[0]}`,
    'os-version': `VERSION_ID="${distro[1]}"`,
    'os-pretty': `PRETTY_NAME="${distro[2]}"`,
    arch: 'x86_64',
    'cpu-model': ' AMD EPYC 7763 64-Core Processor',
    pkg: distro[3],
    pending: String(srv.pending),
    security: String(srv.security),
    reboot: srv.reboot ? 'yes' : 'no',
    virt: 'kvm',
    'meta-at': String(Math.floor(Date.now() / 1000) - 3_600)
  }
  if (srv.reboot) values['reboot-pkgs'] = 'linux-image-6.8.0-47-generic '
  return [
    ...Object.entries(values).map(([k, v]) => `V ${k} ${v}`),
    FACTS_STATUS_MARKER,
    'os-release ok - /etc/os-release',
    'architecture ok -',
    'cpu ok -',
    'virtualisation ok -',
    'package-manager ok -',
    `updates ok - ${distro[3] === 'apt' ? 'apt-check' : 'dnf check-update'}`,
    `security-updates ok - ${distro[3] === 'apt' ? 'apt-check' : 'dnf updateinfo'}`,
    `reboot-required ok - ${srv.reboot ? 'the reboot-required flag file is present' : 'no reboot-required flag'}`,
    'package-metadata ok - /var/lib/apt/periodic/update-success-stamp'
  ].join('\n')
}

const CONTAINERS = [
  ['4f1c2a9e8b7d0a11', 'api', 'registry.example.com/acme/api:2.14.0', 'running', 'Up 2 days (healthy)', '127.0.0.1:8080->8080/tcp', 'acme', 'api'],
  ['9b3e71d0c2aa0b22', 'worker', 'registry.example.com/acme/api:2.14.0', 'running', 'Up 2 days', '', 'acme', 'worker'],
  ['c07d5e3f11b20c33', 'edge', 'caddy:2.8', 'running', 'Up 9 days', '0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp', 'acme', 'edge'],
  ['2d8a61f09e4c0d44', 'cache', 'redis:7.2-alpine', 'running', 'Up 9 days', '6379/tcp', 'acme', 'cache'],
  ['7e5b90c4a1d30e55', 'metrics', 'prom/node-exporter:v1.8.2', 'running', 'Up 30 days', '0.0.0.0:9100->9100/tcp', '', ''],
  ['a1f4c7d2e9b80f66', 'migrate', 'registry.example.com/acme/api:2.14.0', 'exited', 'Exited (0) 2 days ago', '', 'acme', 'migrate']
]

function dockerText(): string {
  const created = '2026-09-27 09:14:02 +0000 UTC'
  return [
    '27.3.1',
    DOCKER_MARKERS.compose,
    ...CONTAINERS.map((c) => [c[0], c[6], c[7]].join(DOCKER_SEP)),
    DOCKER_MARKERS.ps,
    ...CONTAINERS.map((c) => [c[0], c[1], c[2], c[3], c[4], c[5], created].join(DOCKER_SEP))
  ].join('\n')
}

function k8sReadText(): string {
  const pods: [string, string, string, string, number, string][] = [
    ['acme', 'api-7c9f6d8b54-2xkqp', 'true,true', 'Running', 0, 'k8s-node-1'],
    ['acme', 'api-7c9f6d8b54-9hdtw', 'true,true', 'Running', 0, 'k8s-node-2'],
    ['acme', 'api-7c9f6d8b54-qm4zl', 'true,true', 'Running', 1, 'k8s-node-3'],
    ['acme', 'worker-5d8b7f9c6-kl2vn', 'true', 'Running', 0, 'k8s-node-1'],
    ['acme', 'worker-5d8b7f9c6-x7wpr', 'true', 'Running', 0, 'k8s-node-2'],
    ['acme', 'scheduler-0', 'true', 'Running', 0, 'k8s-node-3'],
    ['acme', 'redis-0', 'true', 'Running', 0, 'k8s-node-1'],
    ['acme', 'reports-6b4d9c7f8d-zt5kq', 'false', 'Running', 7, 'k8s-node-2'],
    ['ingress', 'ingress-nginx-controller-6d9f5b8c7-bn2kx', 'true', 'Running', 0, 'k8s-node-1'],
    ['monitoring', 'prometheus-0', 'true,true', 'Running', 0, 'k8s-node-3'],
    ['monitoring', 'grafana-7f6d8c9b5-hv3ms', 'true', 'Running', 0, 'k8s-node-2'],
    ['kube-system', 'coredns-ccb96694c-lllqm', 'true', 'Running', 0, 'k8s-node-1'],
    ['kube-system', 'metrics-server-5985cbc9d7-8zqpl', 'true', 'Running', 0, 'k8s-node-3']
  ]
  const row = ([ns, name, ready, phase, restarts, node]: (typeof pods)[number]): string => {
    const n = ready.split(',').length
    const wait = name.startsWith('reports') ? 'CrashLoopBackOff' : '<none>'
    return [ns, name, ready, phase, Array(n).fill('app').join(','), wait, '<none>', Array(n).fill(restarts).join(','), node, '2026-09-27T09:14:02Z'].join('   ')
  }
  return [
    '{"clientVersion":{"gitVersion":"v1.31.2+k3s1"}}',
    '===OPSMAXX-CTX===',
    '*         acme-prod     acme-prod     acme-admin   acme',
    '          acme-staging  acme-staging  acme-admin   acme',
    '===OPSMAXX-NS===',
    ...['acme', 'ingress', 'kube-system', 'monitoring'],
    '===OPSMAXX-PODS-ALL===',
    ...pods.map(row),
    '===OPSMAXX-PODS-NS===',
    ...pods.filter((x) => x[0] === 'acme').map(row)
  ].join('\n')
}

function k8sOverviewText(): string {
  const at = '2026-09-27T09:14:02Z'
  return [
    '===OPSMAXX-DEPLOY===',
    `acme   api        3   3   3   3   RollingUpdate   ${at}`,
    `acme   worker     2   2   2   2   RollingUpdate   ${at}`,
    `acme   reports    1   <none>   1   <none>   RollingUpdate   ${at}`,
    `ingress   ingress-nginx-controller   1   1   1   1   RollingUpdate   ${at}`,
    `monitoring   grafana   1   1   1   1   RollingUpdate   ${at}`,
    '===OPSMAXX-STS===',
    `acme   scheduler   1   1   1   1   RollingUpdate   ${at}`,
    `acme   redis       1   1   1   1   RollingUpdate   ${at}`,
    `monitoring   prometheus   1   1   1   1   RollingUpdate   ${at}`,
    '===OPSMAXX-DS===',
    `kube-system   svclb-ingress   3   3   3   3   RollingUpdate   ${at}`,
    '===OPSMAXX-NODES===',
    'k8s-node-1   Ready   control-plane,master   41d   v1.31.2+k3s1',
    'k8s-node-2   Ready   <none>   41d   v1.31.2+k3s1',
    'k8s-node-3   Ready   <none>   39d   v1.31.2+k3s1',
    '===OPSMAXX-SRVVER===',
    '{"serverVersion":{"gitVersion":"v1.31.2+k3s1"}}',
    '===OPSMAXX-PDBS===',
    '===OPSMAXX-EVENTS===',
    '2026-09-30T13:52:10Z   <none>   Warning   BackOff   Pod   reports-6b4d9c7f8d-zt5kq   acme   41   Back-off restarting failed container reports in pod reports-6b4d9c7f8d-zt5kq',
    '2026-09-30T13:40:02Z   <none>   Normal   ScalingReplicaSet   Deployment   api   acme   1   Scaled up replica set api-7c9f6d8b54 to 3'
  ].join('\n')
}

function postureText(srv: DemoServer): string {
  const weak = srv.group === 'staging'
  return [
    'V fw-tool ufw',
    `V fw-active ${weak ? 'inactive' : 'active'}`,
    'V fw-policy-in deny',
    'V fw-policy-out allow',
    `V fw-rules ${weak ? 0 : 6}`,
    'V mac-system apparmor',
    'V mac-enabled yes',
    `V mac-mode ${weak ? 'permissive' : 'enforcing'}`,
    'V mac-profiles 38',
    'V mac-complain 2',
    'V sshd-src effective',
    `D PermitRootLogin ${weak ? 'yes' : 'no'}`,
    `D PasswordAuthentication ${weak ? 'yes' : 'no'}`,
    'D PubkeyAuthentication yes',
    'D X11Forwarding no',
    'D MaxAuthTries 3',
    'D PermitEmptyPasswords no',
    'V fail-tool journal',
    'V fail-window last 24 hours',
    `V fail-count ${srv.host.startsWith('203.') ? 1_284 : 12}`,
    'V fail-users 9',
    'V oom-tool journal',
    'V oom-window last 24 hours',
    `V oom-count ${srv.name === 'ci-runner' ? 3 : 0}`,
    'V oom-procs 1',
    'V err-tool journal',
    'V err-window last hour',
    `V err-count ${Math.round(srv.cpu / 6)}`,
    POSTURE_STATUS_MARKER,
    'firewall ok - ufw status verbose',
    'mandatory-access ok - aa-status',
    'sshd-hardening ok root sshd -T',
    'failed-logins ok - journalctl -u ssh',
    'oom-kills ok - journalctl -k',
    'error-rate ok - journalctl -p err',
    'certificates absent - no certificates found'
  ].join('\n')
}

export const responder: Responder = {
  exec(hop: SshHop, command: string) {
    const srv = serverByHost(hop.host)
    if (command.includes('echo __CPU__')) return { stdout: metricsText(srv), code: 0 }
    if (command.includes(FACTS_STATUS_MARKER)) return { stdout: factsText(srv), code: 0 }
    if (command.includes(DOCKER_MARKERS.ps)) return { stdout: dockerText(), code: 0 }
    if (command.includes('===OPSMAXX-CTX===')) return { stdout: k8sReadText(), code: 0 }
    if (command.includes('===OPSMAXX-DEPLOY===')) return { stdout: k8sOverviewText(), code: 0 }
    if (command.includes(POSTURE_STATUS_MARKER)) return { stdout: postureText(srv), code: 0 }
    const head = command.replace(/\s+/g, ' ').slice(0, 160)
    if (!logged.has(head)) {
      logged.add(head)
      console.warn(`[demo] no canned answer for: ${head}`)
    }
    return { stdout: '', code: 0 }
  },
  shell: (hop, line) => shellReply(serverByHost(hop.host), line),
  files: (_hop, path) => FILES[path.replace(/\/+$/, '') || '/'] ?? null,
  home: () => '/home/deploy',
  prompt: (hop, cwd) => {
    const srv = serverByHost(hop.host)
    const where = cwd === '/home/deploy' ? '~' : cwd
    return `\x1b[1;32m${srv.user}@${srv.name}\x1b[0m:\x1b[1;34m${where}\x1b[0m$ `
  }
}
