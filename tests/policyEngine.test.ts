import { describe, it, expect } from 'vitest'
import {
  resolveGroupId,
  evaluateCapability,
  evaluateCommand,
  evaluateFilePath,
  classifyCommand,
  extractPathAccesses,
  mostRestrictive,
  globToRegExp
} from '../src/main/services/policyEngine'
import type { AccessGroup, AiCapabilityPolicy, PolicyAssignment } from '../src/shared/mcp'

function group(overrides: Partial<AccessGroup['capabilities']> = {}, filePolicies: AccessGroup['filePolicies'] = []): AccessGroup {
  return {
    id: 'g1',
    name: 'Test Group',
    builtIn: false,
    capabilities: {
      viewServer: 'allow',
      terminal: 'allow',
      readFiles: 'allow',
      writeFiles: 'deny',
      containers: 'allow',
      containerControl: 'allow',
  ciRead: 'deny',
  ciTrigger: 'deny',
      fleetRead: 'allow',
      backupRead: 'allow',
      sftpDownload: 'allow',
      sftpUpload: 'deny',
      sshTunnel: 'deny',
      databaseAccess: 'allow',
      sudo: 'deny',
      serverMetrics: 'allow',
      // The three capabilities added after this fixture was written. Omitted,
      // every group built here fell through `evaluateCapability`'s
      // `?? 'deny'`, so nothing in this file exercised them under a group that
      // actually names them — and nothing exercised the fallback ON PURPOSE
      // either. Both are covered now: these three, and the test at the foot of
      // `evaluateCapability` for a group saved before a capability existed.
      hostFacts: 'allow',
      // Roadmap item 31, and denied here rather than allowed: it is the one
      // capability in the grid no MCP tool reads at all, so a fixture that
      // granted it would suggest the engine has something to hand an agent.
      // What it gates is whether OpsMaxx's own posture probe may collect a
      // host's firewall rule lines.
      firewallRules: 'deny',
      sudoersRead: 'deny',
      manageServers: 'deny',
      vpnControl: 'deny',
      ...overrides
    },
    filePolicies
  }
}

describe('evaluateCapability', () => {
  it('denies when no group is assigned (No AI Access)', () => {
    expect(evaluateCapability(null, 'terminal').decision).toBe('deny')
  })

  it('reflects ALLOW / ASK / DENY from the group', () => {
    const g = group({ terminal: 'allow', writeFiles: 'ask', sudo: 'deny' })
    expect(evaluateCapability(g, 'terminal').decision).toBe('allow')
    expect(evaluateCapability(g, 'writeFiles').decision).toBe('ask')
    expect(evaluateCapability(g, 'sudo').decision).toBe('deny')
  })

  it('denies a capability a group saved before it existed has no entry for', () => {
    // The upgrade path, and the reason `evaluateCapability` ends in `?? 'deny'`
    // rather than falling through: `undefined` reads as neither 'deny' nor
    // 'ask' at the call sites and would behave like ALLOW, so shipping a new
    // capability would silently widen what every group already saved permits.
    //
    // Asserted deliberately here because the fixture above used to leave three
    // real capabilities out, which meant this branch was reached by accident
    // and would have stopped being reached the moment somebody filled them in.
    const stale = group()
    delete (stale.capabilities as Partial<AiCapabilityPolicy>).vpnControl
    expect(evaluateCapability(stale, 'vpnControl').decision).toBe('deny')
  })
})

describe('read-only, read/write and sudo groups', () => {
  it('Read Only: terminal allowed, writes and sudo denied', () => {
    const readOnly = group({ terminal: 'allow', writeFiles: 'deny', sudo: 'deny' })
    expect(evaluateCommand(readOnly, 'ls -la').decision).toBe('allow')
    expect(evaluateFilePath(readOnly, '/tmp/x', 'write').decision).toBe('deny')
    expect(evaluateCommand(readOnly, 'sudo systemctl restart nginx').decision).toBe('deny')
  })

  it('Read & Write: writes require approval, sudo still denied', () => {
    const readWrite = group({ terminal: 'allow', writeFiles: 'ask', sudo: 'deny' })
    expect(evaluateFilePath(readWrite, '/tmp/x', 'write').decision).toBe('ask')
    expect(evaluateCommand(readWrite, 'sudo systemctl restart nginx').decision).toBe('deny')
  })

  it('Sudo Access: sudo commands require approval, never auto-allowed', () => {
    const sudoGroup = group({ terminal: 'allow', sudo: 'ask' })
    expect(evaluateCommand(sudoGroup, 'sudo systemctl restart nginx').decision).toBe('ask')
    expect(evaluateCommand(sudoGroup, 'systemctl status nginx').decision).toBe('allow')
  })

  it('a custom group behaves like any other — no hard-coded three tiers', () => {
    const logsOnly = group({ terminal: 'ask', readFiles: 'allow', writeFiles: 'deny' })
    expect(evaluateCommand(logsOnly, 'tail -f /var/log/syslog').decision).toBe('ask')
  })
})

describe('a group that granted sudo has already answered the elevated tier', () => {
  // The reported symptom: a session on Full Access, every capability ALLOW,
  // and `sudo docker build` still raised an approval card — which then
  // auto-denied at 01:32 because nobody was awake to answer it.
  // Full Access, as the reporter had it: writes allowed too, so a denial below
  // is the risk tier talking and not the write capability.
  const sudoAllowed = group({ terminal: 'allow', sudo: 'allow', writeFiles: 'allow' })
  const sudoAsked = group({ terminal: 'allow', sudo: 'ask', writeFiles: 'allow' })

  it.each([
    'sudo docker build -t app:1 .',
    'sudo systemctl restart nginx',
    'sudo apt-get install -y curl',
    'sudo docker compose build'
  ])('%s runs without a card when the group set sudo = allow', (cmd) => {
    expect(evaluateCommand(sudoAllowed, cmd).decision).toBe('allow')
  })

  it('a destructive command still asks — that tier is not waivable', () => {
    // A path the file rules have nothing to say about, so the card this raises
    // is the risk tier's own and not a path denial wearing its clothes.
    expect(evaluateCommand(sudoAllowed, 'sudo rm -rf /home/app/data').decision).toBe('ask')
    expect(evaluateCommand(sudoAllowed, 'sudo rm -rf /var/lib/postgresql').decision).not.toBe('allow')
  })

  // Never silent, whichever of the two stopped it: the path rules deny a raw
  // device outright, which is stricter than the card and not a waiver.
  it.each(['sudo mkfs.ext4 /dev/sda1', 'sudo dd if=/dev/zero of=/dev/sda'])(
    '%s is never allowed outright',
    (cmd) => {
      expect(evaluateCommand(sudoAllowed, cmd).decision).not.toBe('allow')
    }
  )

  it('waives nothing for a command that is not sudo', () => {
    expect(evaluateCommand(sudoAllowed, 'docker build -t app:1 .').decision).toBe('ask')
  })

  it('waives nothing when sudo is only asked for — the human has not answered yet', () => {
    expect(evaluateCommand(sudoAsked, 'sudo docker build -t app:1 .').decision).toBe('ask')
  })
})

describe('unrestricted shells are always denied', () => {
  const fullAccess = group({ terminal: 'allow', sudo: 'allow' })

  it.each(['sudo -i', 'sudo su', 'sudo su -', 'sudo bash', 'sudo /bin/sh', 'su -', 'su - root'])(
    '%s is denied even when sudo=allow',
    (cmd) => {
      const result = evaluateCommand(fullAccess, cmd)
      expect(result.decision).toBe('deny')
    }
  )

  it('an ordinary sudo command is not affected', () => {
    expect(classifyCommand('sudo systemctl restart nginx').isUnrestrictedShell).toBe(false)
    expect(classifyCommand('sudo systemctl restart nginx').isSudo).toBe(true)
  })
})

describe('file path rules', () => {
  it('sensitive paths deny even when writeFiles/readFiles is allowed', () => {
    const g = group(
      { readFiles: 'allow', writeFiles: 'allow' },
      [{ id: 'r1', pattern: '/etc/shadow', read: 'deny', write: 'deny' }]
    )
    expect(evaluateFilePath(g, '/etc/shadow', 'read').decision).toBe('deny')
  })

  it('the most specific matching pattern wins', () => {
    const g = group({ writeFiles: 'allow' }, [
      { id: 'r1', pattern: '/var/www/**', write: 'ask' },
      { id: 'r2', pattern: '/var/www/html/public/**', write: 'allow' }
    ])
    expect(evaluateFilePath(g, '/var/www/html/public/index.html', 'write').decision).toBe('allow')
    expect(evaluateFilePath(g, '/var/www/html/private/config.php', 'write').decision).toBe('ask')
  })

  it('unmatched paths fall back to the blanket capability', () => {
    const g = group({ readFiles: 'allow', writeFiles: 'deny' }, [])
    expect(evaluateFilePath(g, '/home/ubuntu/notes.txt', 'read').decision).toBe('allow')
    expect(evaluateFilePath(g, '/home/ubuntu/notes.txt', 'write').decision).toBe('deny')
  })

  it('globToRegExp matches nested paths under **', () => {
    const rx = globToRegExp('/root/.ssh/**')
    expect(rx.test('/root/.ssh/id_rsa')).toBe(true)
    expect(rx.test('/root/.ssh/keys/id_rsa')).toBe(true)
    expect(rx.test('/root/other')).toBe(false)
  })
})

describe('inheritance and server-specific overrides', () => {
  it('a server with no assignment falls back to the workspace default', () => {
    const assignments: PolicyAssignment[] = [
      { id: 'a1', scope: { level: 'workspace', workspaceId: 'ws-prod' }, groupId: 'grp-read-only' }
    ]
    expect(resolveGroupId(assignments, 'srv-1', 'ws-prod')).toBe('grp-read-only')
  })

  it('a server-specific override wins over the workspace default', () => {
    const assignments: PolicyAssignment[] = [
      { id: 'a1', scope: { level: 'workspace', workspaceId: 'ws-prod' }, groupId: 'grp-read-only' },
      { id: 'a2', scope: { level: 'server', serverId: 'srv-test' }, groupId: 'grp-read-write' }
    ]
    expect(resolveGroupId(assignments, 'srv-test', 'ws-prod')).toBe('grp-read-write')
    expect(resolveGroupId(assignments, 'srv-other', 'ws-prod')).toBe('grp-read-only')
  })

  it('a workspace with no assignment at all defaults to No AI Access', () => {
    expect(resolveGroupId([], 'srv-1', 'ws-unconfigured')).toBeNull()
  })
})

describe('mostRestrictive', () => {
  it('deny beats ask beats allow, in either order', () => {
    expect(mostRestrictive({ decision: 'allow', reason: 'a' }, { decision: 'deny', reason: 'b' }).decision).toBe('deny')
    expect(mostRestrictive({ decision: 'deny', reason: 'a' }, { decision: 'allow', reason: 'b' }).decision).toBe('deny')
    expect(mostRestrictive({ decision: 'ask', reason: 'a' }, { decision: 'allow', reason: 'b' }).decision).toBe('ask')
    expect(mostRestrictive({ decision: 'allow', reason: 'a' }, { decision: 'allow', reason: 'b' }).decision).toBe('allow')
  })
})

// classifyCommand used to look at the START of the string only, so with
// sudo=deny and terminal=allow every one of these ran with no prompt -- and
// the escalation shells ran under a policy that says they never run at all.
describe('escalation anywhere in the command', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const withSudo = group({ terminal: 'allow', sudo: 'allow' })

  it.each([
    '/usr/bin/sudo reboot',
    'env sudo reboot',
    'env -i PATH=/usr/bin sudo reboot',
    'command sudo systemctl stop nginx',
    'exec sudo reboot',
    'builtin exec sudo reboot',
    'nohup sudo reboot',
    'time sudo reboot',
    'nice -n 5 sudo reboot',
    'ionice -c 3 sudo reboot',
    'stdbuf -oL sudo reboot',
    'timeout 10 sudo reboot',
    'timeout -s KILL 10 sudo reboot',
    'xargs sudo rm',
    'busybox su -c reboot',
    'FOO=1 sudo reboot',
    'true; sudo reboot',
    'true && sudo reboot',
    'false || sudo reboot',
    'ls | sudo tee /etc/x',
    'sleep 1 & sudo reboot',
    'echo x\nsudo reboot',
    'echo $(sudo cat /etc/shadow)',
    'echo `sudo id`',
    'bash -c "sudo reboot"',
    "sh -c 'pkexec rm -rf /var/lib'",
    "env -S 'sudo reboot'",
    'pkexec rm -rf /var/lib',
    'su -c "rm -rf /var/lib"',
    'su root -c id',
    'doas reboot',
    './sudo reboot',
    'run0 systemctl stop nginx',
    'runuser -u postgres -- psql',
    'runuser -u postgres psql',
    'sudoedit /etc/hosts',
    'machinectl shell root@ /bin/true -c id'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it.each([
    '/usr/bin/sudo -i',
    'env sudo -i',
    'command sudo -s',
    '/usr/bin/sudo bash',
    'sudo -u root -i',
    'sudo -iu root',
    'sudo --login',
    'true; sudo -i',
    'bash -c "sudo -i"',
    'echo $(sudo -i)',
    'pkexec',
    'pkexec bash',
    'pkexec /bin/sh',
    'su',
    'su root',
    'su -l root',
    'su -c bash',
    'su root -c "bash"',
    'busybox su',
    'doas -s',
    'doas bash',
    'run0',
    'runuser -l root',
    'runuser -u root bash',
    'sudo su',
    'sudo env bash',
    'sudo sh -c bash',
    "env sudo bash -c 'zsh'",
    'machinectl shell',
    'machinectl shell root@'
  ])('refuses the escalation shell %s even with sudo=allow', (cmd) => {
    expect(classifyCommand(cmd).isUnrestrictedShell).toBe(true)
    expect(evaluateCommand(withSudo, cmd).decision).toBe('deny')
  })

  // A name in ARGUMENT position is text, not a run. Over-blocking these would
  // put a sudo=deny group in front of an agent reading its own auth log.
  it.each([
    'ls',
    'echo sudo',
    'grep sudo /var/log/auth.log',
    'ls su',
    'cat sudoers.txt',
    'command -v sudo',
    'which sudo pkexec',
    'journalctl -t sudo',
    'systemctl status sudo',
    'echo "run sudo later"',
    'cmd 2>&1 | grep su',
    'bash -c "echo sudo"'
  ])('leaves %s alone', (cmd) => {
    expect(classifyCommand(cmd)).toEqual({ isSudo: false, isUnrestrictedShell: false })
    expect(evaluateCommand(noSudo, cmd).decision).toBe('allow')
  })

  // Tighter only: everything the start-of-string tests caught, still caught.
  it.each([
    ['sudo systemctl restart nginx', { isSudo: true, isUnrestrictedShell: false }],
    ['doas reboot', { isSudo: true, isUnrestrictedShell: false }],
    ['sudo -i', { isSudo: true, isUnrestrictedShell: true }],
    ['sudo su -', { isSudo: true, isUnrestrictedShell: true }],
    ['sudo /bin/sh', { isSudo: true, isUnrestrictedShell: true }],
    ['su -', { isSudo: true, isUnrestrictedShell: true }],
    ['su - root', { isSudo: true, isUnrestrictedShell: true }]
  ])('still classifies %s as before, or stricter', (cmd, expected) => {
    expect(classifyCommand(cmd)).toEqual(expected)
  })
})

// Path rules read only the outer command line, so a file the group denies was
// reachable by wrapping the read in a shell string or a substitution. They now
// walk the same nested strings the escalation check walks.
describe('path rules inside nested command lines', () => {
  const shadowDenied = group({ terminal: 'allow', sudo: 'allow', readFiles: 'allow', writeFiles: 'allow' }, [
    { id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }
  ])

  it.each([
    'cat /etc/shadow',
    "sh -c 'cat /etc/shadow'",
    'bash -c "cat /etc/shadow"',
    'sudo sh -c "cat /etc/shadow"',
    "su -c 'cat /etc/shadow'",
    'echo $(cat /etc/shadow)',
    'echo `cat /etc/shadow`',
    "env -S 'cat /etc/shadow'",
    'timeout 5 cat /etc/shadow',
    'pkexec cat /etc/shadow',
    'busybox cat /etc/shadow',
    'exec cat /etc/shadow',
    'xargs -n 1 cat /etc/shadow',
    `sh -c "bash -c 'cat /etc/shadow'"`,
    "sh -c 'echo x > /etc/shadow'",
    "true; sh -c 'tail -n 1 /etc/shadow'"
  ])('denies %s like a direct read', (cmd) => {
    expect(evaluateCommand(shadowDenied, cmd).decision).toBe('deny')
  })

  it.each([
    "sh -c 'ls /tmp'",
    "sh -c 'cat /etc/hostname'",
    'bash -c "echo /etc/shadow"',
    'echo $(date)',
    // (`sudo sh -c ...` itself is a refused shell form, whatever it runs.)
    "su -c 'ls /tmp'"
  ])('leaves %s alone under an unrelated rule', (cmd) => {
    expect(evaluateCommand(shadowDenied, cmd).decision).toBe('allow')
  })

  it('reports a nested path once, with its mode', () => {
    expect(extractPathAccesses("sudo sh -c 'cat /etc/shadow'")).toEqual([{ path: '/etc/shadow', mode: 'read' }])
  })
})
