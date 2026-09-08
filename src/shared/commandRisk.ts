// How dangerous a command reads, and nothing else.
//
// SPLIT OUT OF broadcast.ts, and the test that forced it is the one to read
// before merging this back: tests/jobsNotExposed.test.ts asserts the job engine
// is not in the agent-reachable import closure. The agent command gate needs
// this classifier -- one classifier, not two -- and importing it from
// broadcast.ts dragged the whole broadcast/job engine in behind it. The guard
// caught that, and its own message says to move the helper rather than the
// assertion. This is the helper moved.
//
// Nothing here may import the job engine, the broadcast runner, or anything
// that reaches them. It is rules and regexes.

export type BroadcastRisk = 'ordinary' | 'elevated' | 'destructive'

// Verbs that destroy state, stop machines, or overwrite devices. Matched on the
// command as written; this is a UX guard that decides how hard the user has to
// press, not a security boundary. Anyone typing here already has a shell on
// these hosts — the point is to make an accident require a deliberate act, not
// to stop an attacker.
// A verb only counts where a command can actually start: the beginning of the
// line, or after a pipe, semicolon, &&, || or newline — optionally behind sudo.
//
// Without this the classifier flags `grep reboot /var/log/syslog` as "stops the
// machine", which is worse than useless: a guard that cries wolf on a read-only
// grep is a guard people learn to click through, and it is then not there for
// the `reboot` that meant it.
//
// ---------------------------------------------------------------------------
// WHY sudo's OPTIONS ARE PARSED RATHER THAN SKIPPED
// ---------------------------------------------------------------------------
// The prefix used to be `(?:sudo\s+|doas\s+)?` — sudo with no flags at all. So
// `sudo -n reboot` matched no destructive rule and fell through to the blanket
// `runs as root` rule, which is `elevated`: ONE confirm click on one host,
// where a bare `reboot` demands a typed phrase. Strictly weaker confirmation
// for strictly more privilege, which is exactly backwards.
//
// And `-n` is not an exotic spelling. It is the only escalation that cannot
// prompt for a password, which is why SUDO_PROBE in docker.ts, the docker sudo
// failover and cron.ts all use it on channels with no tty. The spelling this
// app itself prefers was the spelling the guard missed.
//
// The widening has to stop EXACTLY at the command, because an option pattern
// that swallows arbitrary tokens reads `sudo -n cat reboot.txt` as "stops the
// machine" — the cry-wolf failure the anchor exists to prevent, reintroduced by
// the fix for the opposite failure. So this is sudo's real option grammar
// rather than a permissive `-\S+`:
//
//   * a bundle of boolean short flags                  -n   -nH   -E
//   * a short flag that TAKES a value, attached or separated, and only for the
//     letters that really take one                     -u root   -uroot
//   * a long flag, with `=value` or a separated value  --non-interactive
//                                                      --user=root  --user root
//   * `--`, end of options                             sudo -- reboot
//   * a VAR=value assignment, which sudo accepts ahead of the command
//
// The letter list is the whole point. `-u` takes a value, so `sudo -u root
// reboot` has to let `root` past; `-n` does not, so `sudo -n cat reboot.txt`
// must NOT let `cat` past. A naive `(?:-\S+\s+)*` gets the first case only by
// treating `root` as another flag, and having done that it has no way left to
// refuse the second.
//
// WHY "does this flag take a value" IS ASKED IN A LOOKAHEAD and the token is
// then consumed by a plain `-\S+`, rather than the flag being spelled out once
// and consumed in the same breath. Spelled inline as
// `-[A-Za-z]*[value-letter]\s*VALUE`, a token like `-uuuu` parses four ways,
// every one of them over the same characters, and a line of such flags
// multiplies out: `sudo -u -u -u …` did not finish on twenty flags, in a
// function that runs on every keystroke in the broadcast panel. A JavaScript
// lookahead is not re-entered once it has succeeded, so asking the question
// there and consuming the token unambiguously leaves at most one real choice
// per token — take the next word as a value, or do not — and the wrong branch
// dies at the next token instead of forking again.
/** A flag's value: quoted, because `-p 'password for %p: '` contains a space. */
const SUDO_VALUE = String.raw`(?:'[^']*'|"[^"]*"|\S+)`
/** Short options of sudo/doas that consume the next word. */
const SUDO_VALUE_SHORT = 'aCcDghpRrtTUu'
/** Long options of sudo/doas that consume the next word when not given `=`. */
const SUDO_VALUE_LONG =
  'auth-type|chdir|chroot|close-from|command-timeout|group|host|login-class|other-user|prompt|role|type|user'
// A value never starts with `-`. `sudo -n -u root reboot` has to read `-n` as
// the boolean it is rather than eating the next flag, and that `(?!-)` is also
// what stops a run of flags being ambiguous at every position.
//
// The last two alternatives are the ones that do the work: any other option
// token, and a `VAR=value` assignment, which sudo accepts before the command.
// `-\S+` is broad on purpose — it can only ever match something beginning with
// a dash, and no command this file grades begins with one, so it cannot swallow
// the verb. `--` falls out of it for free.
const SUDO_OPT = String.raw`(?:(?=-[A-Za-z]*[${SUDO_VALUE_SHORT}]\s)-\S+\s+(?!-)${SUDO_VALUE}|(?=--(?:${SUDO_VALUE_LONG})\s)--\S+\s+(?!-)${SUDO_VALUE}|-\S+|\w+=\S+)`
/** `sudo`/`doas` and everything up to, but not including, the command. */
const SUDO = String.raw`(?:sudo|doas)\s+(?:${SUDO_OPT}\s+)*`
/**
 * Where a command can start: line start or after `;`, `&`, `|`, `(` or a
 * newline, past any env assignments, past any sudo and its options.
 *
 * ONE definition, used by every rule below and imported by jobs.ts, because
 * two copies of a safety rule that no longer agree is worse than one copy that
 * is wrong — the wrong one is at least predictable. `restartsTheMachine()` kept
 * its own flagless copy and therefore missed `sudo -n reboot` long after this
 * one was fixed.
 */
export function commandStart(rest: string): RegExp {
  return new RegExp(String.raw`(^|[;&|(]|\n)\s*(?:\w+=\S+\s+)*(?:${SUDO})?${rest}`)
}

function atCommandStart(verbs: string): RegExp {
  return commandStart(String.raw`(?:${verbs})\b`)
}

// A flag argument, wherever it appears in a command's argument list rather than
// only immediately after the verb. `chmod 777 -R /srv` is the same command as
// `chmod -R 777 /srv`, and a guard that only reads the first token is a guard
// that misses whichever order the person happened to type.
function flagAnywhere(verb: string, flags: string): RegExp {
  return commandStart(String.raw`(?:${verb})(?:\s+[^\s;|&]+)*\s+(?:${flags})\b`)
}

const DESTRUCTIVE = [
  // Long options count: `rm --recursive --force /` is the same command, and
  // reading only the short flags made the most explicit spelling the one that
  // ran with no confirmation at all.
  {
    rx: commandStart(String.raw`rm\s+((-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force|--no-preserve-root)\s+)+`),
    why: 'deletes files recursively or forcibly'
  },
  // `find … -exec rm` and `… | xargs rm` are how a bulk delete is actually
  // typed. Neither puts `rm` at a command start, so the anchored rule above
  // reads both as ordinary.
  { rx: new RegExp(String.raw`-exec\s+(?:${SUDO})?rm\b`), why: 'deletes files through find -exec' },
  { rx: new RegExp(String.raw`\bxargs\s+(?:-\S+\s+)*(?:${SUDO})?rm\b`), why: 'deletes files through xargs' },
  { rx: commandStart(String.raw`find\s[^;|&]*\s-delete\b`), why: 'deletes every file find matches' },
  { rx: atCommandStart('mkfs(\\.\\w+)?|fdisk|parted|wipefs'), why: 'writes to a partition table or filesystem' },
  { rx: commandStart(String.raw`dd\s[^|;]*\bof=`), why: 'writes directly to a device or file with dd' },
  { rx: atCommandStart('shutdown|poweroff|halt|reboot'), why: 'stops or restarts the machine' },
  // systemd's own spellings of the same thing. `systemctl poweroff` puts
  // `systemctl` at the command start, so the verb rule above never sees it.
  {
    rx: commandStart(String.raw`systemctl\s+(poweroff|reboot|halt|kexec)\b`),
    why: 'stops or restarts the machine'
  },
  { rx: atCommandStart('userdel|groupdel'), why: 'removes an account' },
  { rx: /\bdrop\s+(database|table)\b/i, why: 'drops a database or table' },
  { rx: atCommandStart('truncate|shred'), why: 'destroys file contents' },
  { rx: flagAnywhere('chown', '-[a-zA-Z]*R[a-zA-Z]*|--recursive'), why: 'changes ownership recursively' },
  { rx: flagAnywhere('chmod', '-[a-zA-Z]*R[a-zA-Z]*|--recursive'), why: 'changes permissions recursively' },
  { rx: commandStart(String.raw`(kill|killall|pkill)\s+(-9|-KILL|-s\s*(9|KILL|SIGKILL))\b`), why: 'sends SIGKILL' },
  // `\b-F\b` never matched ` -F`: there is no word boundary between a space and
  // a dash, so the single most common way to flush a firewall read as ordinary.
  {
    rx: commandStart(String.raw`(iptables|ip6tables|nft|ufw)\b[^;|]*(\bflush\b|\s-F\b|\breset\b)`),
    why: 'clears firewall rules'
  },
  { rx: />\s*\/dev\/[sn][dv]/, why: 'redirects output onto a block device' },
  { rx: commandStart(String.raw`systemctl\s+(stop|disable|mask)\b`), why: 'stops or disables a service' },
  { rx: commandStart(String.raw`service\s+\S+\s+stop\b`), why: 'stops a service' },
  // One key away from `crontab -e`, and it takes the whole schedule with it.
  { rx: commandStart(String.raw`crontab\s+-[a-z]*r[a-z]*\b`), why: 'removes the crontab' },
  { rx: atCommandStart('lvremove|vgremove|pvremove'), why: 'removes a volume or volume group' },
  { rx: commandStart(String.raw`(zfs|zpool)\s+destroy\b`), why: 'destroys a dataset or pool' }
]

/** The one finding the command gate is allowed to ignore, because a group that
 *  set sudo to `allow` has already had a human make that call. Exported so the
 *  gate matches on this constant rather than on a copy of the sentence. */
export const SUDO_REASON = 'runs as root'

const ELEVATED = [
  // Anchored to a command start rather than to position zero: `curl … | sudo
  // bash` is root, and reading only the first word said it was not.
  { rx: atCommandStart('sudo|doas'), why: SUDO_REASON },
  { rx: commandStart(String.raw`systemctl\s+(restart|reload)\b`), why: 'restarts a service' },
  { rx: commandStart(String.raw`service\s+\S+\s+(restart|reload)\b`), why: 'restarts a service' },
  {
    rx: commandStart(
      String.raw`(apt|apt-get|yum|dnf|apk|pacman)\s+(install|remove|purge|autoremove|upgrade|dist-upgrade|full-upgrade|update)\b`
    ),
    why: 'changes installed packages'
  },
  // The noun-verb spellings (`docker system prune`, `docker volume rm`) are the
  // common ones now, and the verb-only rule matched none of them.
  {
    rx: commandStart(
      String.raw`(docker|podman)\s+(?:(?:container|image|volume|network|system|compose)\s+)?(rm|rmi|stop|kill|prune|down)\b`
    ),
    why: 'removes or stops containers'
  },
  // A BUILD RUNS A DOCKERFILE, and a Dockerfile is a program: `RUN curl ... |
  // sh` is a normal line in one. It is not a read, it is not reversible in the
  // sense a `pull` is, and it executes code the operator has probably not
  // opened. `pull` is deliberately NOT here: it fetches bytes and runs none of
  // them.
  {
    rx: commandStart(String.raw`(docker|podman)\s+(?:compose\s+)?build\b`),
    why: 'runs a Dockerfile, which can execute anything its author wrote'
  }
]

export interface RiskAssessment {
  risk: BroadcastRisk
  reasons: string[]
}

/**
 * How dangerous the command reads.
 *
 * Text-based and therefore defeatable — `$(echo rm) -rf /` is not caught, and
 * is not meant to be. Someone constructing that is not making the mistake this
 * guards against. What it catches is the real accident: a correct, obvious,
 * destructive command aimed at more hosts than intended.
 */
export function assessCommand(command: string): RiskAssessment {
  const reasons: string[] = []
  let risk: BroadcastRisk = 'ordinary'

  for (const { rx, why } of DESTRUCTIVE) {
    if (rx.test(command)) {
      risk = 'destructive'
      reasons.push(why)
    }
  }
  if (risk !== 'destructive') {
    for (const { rx, why } of ELEVATED) {
      if (rx.test(command)) {
        risk = 'elevated'
        reasons.push(why)
      }
    }
  }
  return { risk, reasons }
}
