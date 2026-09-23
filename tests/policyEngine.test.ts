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
    'bash -c "echo sudo"',
    'echo "use sudo"',
    'man sudo',
    'find / -name sudo',
    'test -x /usr/bin/sudo',
    'cat /etc/sudoers.d/90-cloud-init-users',
    'watch -n 5 df -h',
    'flock /tmp/lock ls',
    'timeout 5 uptime',
    'if true; then echo ok; fi',
    '{ echo a; echo b; }',
    'script --help'
  ])('leaves %s alone', (cmd) => {
    expect(classifyCommand(cmd)).toEqual({ isSudo: false, isUnrestrictedShell: false, computedCommand: false })
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
    expect(classifyCommand(cmd)).toMatchObject(expected)
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

// Final-pass findings on the classifier: shell grammar, backslash quoting,
// systemd-run, more wrappers, eval, and a command word computed at run time.
describe('escalation behind grammar, quoting and more wrappers', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const withSudo = group({ terminal: 'allow', sudo: 'allow' })
  const shadowDenied = group({ terminal: 'allow', sudo: 'allow', readFiles: 'allow', writeFiles: 'allow' }, [
    { id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' },
    { id: 'ssh', pattern: '/root/.ssh/**', read: 'deny', write: 'deny' }
  ])

  it.each([
    'if true; then sudo reboot; fi',
    'while true; do sudo reboot; done',
    '{ sudo reboot; }',
    '(sudo reboot)',
    '! sudo reboot',
    '\\sudo reboot',
    'su\\do reboot',
    'systemd-run reboot',
    'systemd-run -p User=root reboot',
    'setsid sudo reboot',
    'unbuffer sudo reboot',
    'watch -n 1 sudo reboot',
    "watch 'sudo reboot'",
    'flock /tmp/l sudo reboot',
    "flock /tmp/l -c 'sudo reboot'",
    'chrt 10 sudo reboot',
    'taskset 0x3 sudo reboot',
    "script -q -c 'sudo reboot' /dev/null",
    'eval sudo reboot',
    'eval "sudo reboot"'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it.each(['systemd-run --pty bash', 'systemd-run', 'systemd-run -t', '{ sudo -i; }', 'eval sudo -i', '\\sudo -i'])(
    'refuses the escalation shell %s even with sudo=allow',
    (cmd) => {
      expect(evaluateCommand(withSudo, cmd).decision).toBe('deny')
    }
  )

  it.each(['su --help', 'pkexec --version', 'run0 --help', 'systemd-run --version'])(
    '%s asks the tool about itself and is not a root shell',
    (cmd) => {
      expect(classifyCommand(cmd).isUnrestrictedShell).toBe(false)
      expect(evaluateCommand(withSudo, cmd).decision).toBe('allow')
    }
  )

  // Cannot be named, so cannot be graded: asked about, not refused.
  it.each(['$(which sudo) reboot', '${SUDO:-sudo} reboot', '`which sudo` reboot', '$TOOL --run'])(
    'asks before running %s, whose command word is computed',
    (cmd) => {
      expect(classifyCommand(cmd).computedCommand).toBe(true)
      expect(evaluateCommand(group({ terminal: 'allow', sudo: 'allow' }), cmd).decision).toBe('ask')
    }
  )

  it('does not treat an argument that is a variable as a computed command', () => {
    expect(classifyCommand('echo $HOME').computedCommand).toBe(false)
    expect(evaluateCommand(noSudo, 'echo $HOME').decision).toBe('allow')
  })

  // The path rules read the same walk, so every one of these reaches them.
  it.each([
    "bash -c 'cat /etc/shadow'",
    'timeout 5 cat /etc/shadow',
    'echo $(cat /root/.ssh/id_rsa)',
    'pkexec cat /etc/shadow',
    'xargs cat /etc/shadow',
    'if true; then cat /etc/shadow; fi',
    '\\cat /etc/shadow',
    'flock /tmp/l cat /etc/shadow',
    "watch 'cat /etc/shadow'",
    'eval cat /etc/shadow',
    'systemd-run cat /etc/shadow'
  ])('applies the /etc/shadow and /root/.ssh rules to %s', (cmd) => {
    expect(evaluateCommand(shadowDenied, cmd).decision).toBe('deny')
  })

  // Decisions unchanged for commands with no absolute path, or an unrelated one.
  it.each([
    ['uptime', 'allow'],
    ['df -h', 'allow'],
    ['ls /tmp', 'allow'],
    ['cat /etc/hostname', 'allow'],
    ["sh -c 'ls /var/log'", 'allow'],
    ['timeout 5 cat /etc/os-release', 'allow'],
    ['echo $(date)', 'allow'],
    ['grep -r shadow /var/log/syslog', 'allow']
  ])('leaves %s at %s', (cmd, decision) => {
    expect(evaluateCommand(shadowDenied, cmd).decision).toBe(decision)
  })
})

// Security pass #2: the last forms that allowed, and the rule that ends the
// list -- a command word the walk cannot read literally asks, never allows.
describe('fail toward ask', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const withSudo = group({ terminal: 'allow', sudo: 'allow' })

  it.each([
    'case x in *) sudo reboot;; esac',
    'case $1 in a) ls;; b) sudo reboot;; esac',
    'f(){ sudo reboot; }; f',
    'f() { sudo reboot; }; f',
    'function f { sudo reboot; }; f',
    'function f() { sudo reboot; }',
    'coproc sudo reboot',
    'coproc x { sudo reboot; }',
    '~/bin/sudo reboot',
    '$HOME/bin/sudo reboot',
    '${HOME}/bin/sudo reboot',
    'runas /user:Administrator "cmd /c shutdown /r"',
    'runas /savecred /user:admin notepad.exe',
    'C:\\Windows\\System32\\runas.exe /user:admin whoami',
    'gsudo net stop spooler',
    'gsudo.exe whoami',
    'sudo.exe net stop spooler'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it.each([
    'gsudo',
    'gsudo cmd',
    'gsudo powershell -NoProfile',
    'runas /user:Administrator cmd',
    'runas /user:Administrator "powershell -NoExit"'
  ])('refuses the elevated shell %s even with sudo=allow', (cmd) => {
    expect(evaluateCommand(withSudo, cmd).decision).toBe('deny')
  })

  it.each(['gsudo -k', 'runas', 'runas /?', 'gsudo --help', 'gsudo cmd /c whoami'])('%s is not a shell', (cmd) => {
    expect(classifyCommand(cmd).isUnrestrictedShell).toBe(false)
  })

  // Nested deeper than the walk reads: not read, so not allowed.
  it.each([
    'eval eval eval eval sudo reboot',
    'sh -c "eval eval eval sudo reboot"',
    'eval eval eval eval eval ls'
  ])('asks rather than allows %s, nested past the walk', (cmd) => {
    expect(classifyCommand(cmd).computedCommand).toBe(true)
    expect(evaluateCommand(noSudo, cmd).decision).not.toBe('allow')
  })

  // Weird but harmless: the walk cannot name the command word, so it asks.
  it.each([
    '{sudo,reboot}',
    '{ls,-la}',
    '*',
    '/usr/bin/ec?o hi',
    '/usr/bin/[e]cho hi',
    'f(){echo hi;}',
    '=foo',
    '$(echo ls)'
  ])('asks before running %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('ask')
  })

  // Literal command words are untouched by the rule.
  it.each([
    '[ -f /etc/hosts ] && echo yes',
    '[[ -f /etc/hosts ]] && echo yes',
    '(( 1 + 1 ))',
    '(cd /tmp && ls)',
    '(ls)',
    'for f in a b c; do echo $f; done',
    'select x in a b; do echo $x; done',
    'case $x in a) echo a;; *) echo other;; esac',
    'f() { echo hi; }; f',
    '~/bin/tool --run',
    '$HOME/bin/tool --run',
    'x=1 y=2 env',
    'echo {a,b}',
    'ls *.log',
    'for ((i=0;i<3;i++)); do echo $i; done'
  ])('still allows %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('allow')
  })
})

// Security pass #3: POSIX quoting, spaced function definitions, and what
// cmd and PowerShell run.
describe('quoting, and the Windows shells', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const withSudo = group({ terminal: 'allow', sudo: 'allow' })

  it.each([
    `sh -c "sh -c \\"sh -c 'sudo reboot'\\""`,
    `sh -c 'echo '\\''hi'\\''; sudo reboot'`,
    'f ( ) { sudo reboot; }; f',
    'f () { sudo reboot; }; f',
    'cmd /c runas /user:admin cmd',
    'cmd.exe /c "runas /savecred /user:admin notepad"',
    'cmd /k sudo net stop spooler',
    'powershell -Command "runas /user:admin notepad"',
    'pwsh -c "gsudo whoami"',
    'powershell -Command "Start-Process notepad -Verb RunAs"',
    'Start-Process notepad -Verb RunAs',
    'Start-Process -FilePath notepad -Verb runas',
    'saps notepad -verb:RunAs',
    // Unbalanced, and still read far enough to find the sudo in it.
    "sh -c 'sudo reboot"
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it.each(['Start-Process powershell -Verb RunAs', 'cmd /c runas /user:admin cmd', 'powershell -c "gsudo"'])(
    'refuses the elevated shell %s even with sudo=allow',
    (cmd) => {
      expect(evaluateCommand(withSudo, cmd).decision).toBe('deny')
    }
  )

  it.each([
    'powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQA=',
    'powershell -enc ZQBjAGgAbwA=',
    'pwsh -e ZQBjAGgAbwA=',
    'echo "unterminated',
    'echo trailing\\'
  ])('asks before running %s, which cannot be read', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('ask')
  })

  it.each([
    'echo "a \\"quoted\\" word"',
    `echo 'it'\\''s fine'`,
    'echo \\$HOME',
    'cmd /c dir C:\\',
    'dir C:\\',
    'powershell -Command "Get-ChildItem C:\\\\"',
    'Start-Process notepad',
    'type C:\\Users\\me\\notes.txt'
  ])('still allows %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('allow')
  })

  // An escaped `;` is a character, not a separator: this prints "a;sudo
  // reboot" and runs no sudo. (The separate command-risk grader still reads
  // the word `reboot` and may ask; it never denies.)
  it('reads an escaped separator as a character', () => {
    const cmd = 'echo a\\;sudo reboot'
    expect(classifyCommand(cmd).isSudo).toBe(false)
    expect(evaluateCommand(noSudo, cmd).decision).not.toBe('deny')
  })
})

// Security pass #4: substitutions with parens of their own, process
// substitution, cmd's glued switches and carets, and PowerShell's implicit
// -Command and iex.
describe('substitutions, cmd and PowerShell, read whole', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const withSudo = group({ terminal: 'allow', sudo: 'allow' })
  const shadowDenied = group({ terminal: 'allow', sudo: 'allow', readFiles: 'allow', writeFiles: 'allow' }, [
    { id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }
  ])

  it.each([
    'echo $(case a in a) sudo reboot;; esac)',
    'echo $(case a in (a) sudo reboot;; esac)',
    'echo "$(ls (x); sudo reboot)"',
    'diff <(sudo cat /etc/shadow) /dev/null',
    'tee >(sudo tee /etc/x) < /dev/null',
    'echo $(( $(sudo reboot) + 1 ))',
    'cmd /cRUNAS /user:admin notepad',
    'cmd /c ru^nas /user:admin notepad',
    'cmd /c^ runas /user:admin notepad',
    'cmd /c "r^unas /user:admin notepad"',
    'powershell Start-Process cmd -Verb RunAs',
    'powershell "Start-Process notepad -Verb RunAs"',
    'powershell -NoProfile -ExecutionPolicy Bypass Start-Process notepad -Verb RunAs',
    'pwsh -WindowStyle Hidden "gsudo whoami"',
    'iex "Start-Process notepad -Verb RunAs"',
    'Invoke-Expression "runas /user:admin notepad"'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  // Four levels deep -- a substitution, eval, a substitution, eval -- so past
  // what the walk reads: asked about, never allowed.
  it('does not allow the reviewer\'s four-deep eval and substitution nest', () => {
    const cmd = 'echo $(eval "echo \\$(eval \\"sudo reboot\\")")'
    expect(evaluateCommand(noSudo, cmd).decision).not.toBe('allow')
  })

  // Single quotes expand nothing: this prints the text and runs no sudo.
  it('does not read a substitution inside single quotes as a run', () => {
    expect(classifyCommand("echo '$(sudo id)'").isSudo).toBe(false)
  })

  it.each(['echo $(ls (x); cat /etc/shadow)', 'cat <(cat /etc/shadow)', 'diff <(cat /etc/shadow) /dev/null'])(
    'applies the /etc/shadow rule inside %s',
    (cmd) => {
      expect(evaluateCommand(shadowDenied, cmd).decision).toBe('deny')
    }
  )

  it.each(['powershell Start-Process powershell -Verb RunAs', 'cmd /cRUNAS /user:admin cmd'])(
    'refuses the elevated shell %s even with sudo=allow',
    (cmd) => {
      expect(evaluateCommand(withSudo, cmd).decision).toBe('deny')
    }
  )

  it.each([
    'echo $(unclosed',
    'cat <(ls',
    'cmd /c echo %PATH%',
    'cmd /c di^r',
    'iex $payload'
  ])('asks before running %s, which cannot be read', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('ask')
  })

  it.each([
    "echo '<(x)'",
    'echo "<(not a substitution)"',
    'echo $(( 1 + 2 ))',
    'echo $(case a in a) echo hi;; esac)',
    'diff <(ls /tmp) <(ls /var)',
    'cmd /c dir',
    'cmd /cdir',
    'powershell Get-ChildItem',
    'powershell -NoProfile "Get-Date"',
    'iex "Get-Date"'
  ])('still allows %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('allow')
  })
})

// Security pass #5: backquote bodies, and cmd / PowerShell failing toward ask.
describe('backquotes, and Windows failing toward ask', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const shadowDenied = group({ terminal: 'allow', sudo: 'allow', readFiles: 'allow', writeFiles: 'allow' }, [
    { id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }
  ])

  it.each([
    'echo `echo \\`sudo reboot\\``',
    'echo `echo \\$(eval "sudo reboot")`',
    'echo "`echo \\"$(sudo reboot)\\"`"',
    'cmd /r runas /user:admin notepad',
    'cmd /C/Crunas /user:admin notepad',
    'cmd.exe/c runas /user:admin notepad',
    'C:\\Windows\\System32\\cmd.exe/c runas /user:admin notepad',
    'powershell -Command "Invoke-Command { runas /user:admin notepad }"',
    'icm -ScriptBlock { runas /user:admin notepad }',
    'Start-Job { Start-Process notepad -Verb RunAs }',
    '& { runas /user:admin notepad }',
    '. runas /user:admin notepad'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it("applies the /etc/shadow rule inside a backquoted sh -c with the '\\\\'' idiom", () => {
    const cmd = "echo `sh -c 'eval '\\\\''cat /etc/shadow'\\\\'''`"
    expect(evaluateCommand(shadowDenied, cmd).decision).toBe('deny')
  })

  // Not parsed; asked about.
  it.each([
    'cmd /c set X=runas& %X% /user:a cmd',
    'cmd /c "set X=runas& %X% /user:a cmd"',
    'cmd /v:on /c "set X=runas&& !X! /user:a cmd"',
    'cmd /c echo !X!',
    '%COMSPEC% /c whoami',
    'cmd /c echo 50%',
    'Invoke-Command -ScriptBlock $block'
  ])('asks before running %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('ask')
  })

  it.each([
    'echo `date`',
    'echo `echo hello`',
    'cmd /c dir',
    'cmd /c echo hello',
    'cmd.exe /c ver',
    'powershell -Command "Invoke-Command { Get-Date }"',
    'Get-Process | ForEach-Object { $_.Name }',
    '. ./env.sh',
    '. venv/bin/activate',
    'source ~/.bashrc'
  ])('still allows %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('allow')
  })
})

// Final review: `-c` in an option cluster, a shell fed by stdin, and the
// wrappers that run a command of their own.
describe('bash -lc, stdin-fed shells and more wrappers', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const withSudo = group({ terminal: 'allow', sudo: 'allow' })
  const shadowDenied = group({ terminal: 'allow', sudo: 'allow', readFiles: 'allow', writeFiles: 'allow' }, [
    { id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }
  ])

  it.each([
    'bash -lc "sudo cat /etc/hostname"',
    'sh -ec "sudo reboot"',
    'zsh -ic "sudo reboot"',
    'bash -lic "sudo reboot"',
    'bash -o pipefail -c "sudo reboot"',
    'bash -c -x "sudo reboot"',
    'script -qc "sudo reboot" /dev/null',
    'script --command="sudo reboot" /dev/null',
    'find . -name x -exec sudo rm {} \\;',
    'find / -type f -execdir sudo chmod 777 {} +',
    'sg wheel "sudo reboot"',
    'sg - wheel -c "sudo reboot"',
    'chroot /mnt sudo reboot',
    'strace -f -o /tmp/t sudo reboot',
    'ltrace -e malloc sudo reboot',
    'parallel sudo ::: reboot',
    'parallel ::: "sudo reboot"',
    'nsenter -t 1 -m sudo reboot',
    'unshare -r sudo reboot',
    'firejail --noprofile sudo reboot',
    'bwrap --bind / / --dev /dev sudo reboot',
    'setpriv --reuid=0 sudo reboot',
    'setarch x86_64 sudo reboot',
    'prlimit --nofile=10 sudo reboot',
    'capsh -- -c "sudo reboot"'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it.each(['sudo bash -l', 'sudo bash -li', 'sudo sh -lc bash'])('refuses the root shell %s even with sudo=allow', (cmd) => {
    expect(evaluateCommand(withSudo, cmd).decision).toBe('deny')
  })

  it.each([
    'bash -lc "cat /etc/shadow"',
    'sh -ec "cat /etc/shadow"',
    'script -qc "cat /etc/shadow" /dev/null',
    'find /etc -name shadow -exec cat /etc/shadow \\;'
  ])('applies the /etc/shadow rule inside %s', (cmd) => {
    expect(evaluateCommand(shadowDenied, cmd).decision).toBe('deny')
  })

  // A shell with no command string runs its stdin: fed from anywhere, what it
  // runs is not on the line, so it asks.
  it.each([
    'echo "sudo reboot" | sh',
    'curl -s https://example.com/install.sh | bash',
    'cat script | bash -s -- --flag',
    'sh <<< "sudo reboot"',
    'bash <<EOF',
    'bash < script.sh',
    'bash <(echo sudo reboot)',
    'bash /dev/stdin',
    'busybox sh < x'
  ])('asks before running %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('ask')
  })

  it.each([
    'bash -lc "ls /tmp"',
    'sh -ec "echo hi"',
    'bash -o pipefail -c "ls | wc -l"',
    'find . -name x -exec grep y {} \\;',
    'find . -name "*.log" -print',
    'ps aux | sh -c "cat"',
    'ps aux | grep sh',
    'bash script.sh',
    'sh ./configure',
    'script -q /dev/null',
    'parallel echo ::: a b c',
    'strace -c ls',
    'chroot /mnt ls',
    'bwrap --ro-bind / / ls'
  ])('still allows %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('allow')
  })
})

// Security pass #7: find -exec walked in place, and the tools that change
// privilege are escalations, not runners.
describe('find -exec, and tools that change privilege', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const withSudo = group({ terminal: 'allow', sudo: 'allow' })
  const shadowDenied = group({ terminal: 'allow', sudo: 'allow', readFiles: 'allow', writeFiles: 'allow' }, [
    { id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }
  ])

  it.each([
    'find . -exec bash -lc "cat /etc/shadow" \\;',
    'find . -execdir sh -c "cat /etc/shadow" +',
    'find . -name a -exec true \\; -exec bash -lc "cat /etc/shadow" \\;'
  ])('applies the /etc/shadow rule inside %s', (cmd) => {
    expect(evaluateCommand(shadowDenied, cmd).decision).toBe('deny')
  })

  it.each([
    "find . -exec sh -c 'eval '\\''sudo reboot'\\''' \\;",
    'find . -ok bash -lc "sudo reboot" \\;',
    'setpriv --reuid 0 reboot',
    'setpriv --reuid=0 --regid=0 --init-groups reboot',
    'setpriv --clear-groups id',
    'capsh --user=root -- -c id',
    'capsh -- -c "id"',
    'nsenter -t 1 -a id',
    'nsenter --target 1 --mount --pid reboot'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it.each(['setpriv --reuid 0 bash', 'capsh --', 'nsenter -t 1 -a', 'nsenter -t 1 -m bash'])(
    'refuses the root shell %s even with sudo=allow',
    (cmd) => {
      expect(evaluateCommand(withSudo, cmd).decision).toBe('deny')
    }
  )

  // Root only inside a new user namespace, and everyday rootless tooling.
  it.each(['unshare -r id', 'unshare --map-root-user id', 'unshare -Ur whoami'])('asks before running %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('ask')
  })

  it.each([
    'unshare --help',
    'unshare -n ping -c 1 127.0.0.1',
    'setpriv --dump',
    'setpriv --no-new-privs ls',
    'nsenter --help',
    'capsh --print',
    'find . -name "*.c" -exec wc -l {} +',
    'find . -type f -exec grep -l TODO {} \\;',
    'chroot /mnt ls',
    'strace -f ls',
    'firejail ls',
    'prlimit --nofile=10 ls'
  ])('still allows %s', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('allow')
  })
})

// Security pass #8: every find action group is walked, including after a `;`
// the shell split on, and unshare -r gets a reason of its own.
describe('every find action group', () => {
  const noSudo = group({ terminal: 'allow', sudo: 'deny' })
  const shadowDenied = group({ terminal: 'allow', sudo: 'allow', readFiles: 'allow', writeFiles: 'allow' }, [
    { id: 'shadow', pattern: '/etc/shadow', read: 'deny', write: 'deny' }
  ])

  it('applies the /etc/shadow rule to a later group after an unescaped ;', () => {
    expect(evaluateCommand(shadowDenied, 'find . -exec echo {} ; -exec cat /etc/shadow ;').decision).toBe('deny')
  })

  it.each([
    'find . -exec echo {} ; -exec sh -c "sudo reboot" ;',
    'find . -exec ls ; -execdir bash -lc "sudo reboot" ;',
    'find . -exec echo {} \\; -exec sh -c "sudo reboot" \\;',
    'find . -exec echo {} + -ok sudo reboot \\;'
  ])('denies %s under sudo=deny', (cmd) => {
    expect(evaluateCommand(noSudo, cmd).decision).toBe('deny')
  })

  it('asks about unshare -r for what it is, not as an unreadable command', () => {
    const d = evaluateCommand(noSudo, 'unshare --map-root-user id')
    expect(d.decision).toBe('ask')
    expect(d.reason).toMatch(/root inside a new user namespace/)
    expect(d.reason).not.toMatch(/computed/)
  })
})
