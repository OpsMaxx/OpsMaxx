import { useEffect, useState } from 'react'
import type { AutoStartSettings, AutoStartState } from '../../../../shared/autostart'
import { ACCESS_WRITE_OPT_IN_NOTE } from '../../../../shared/access'
import { UnlockVaultButton } from '../common/UnlockVaultButton'
import {
  Sliders,
  Palette,
  TerminalSquare,
  Server,
  KeyRound,
  Shield,
  FolderCog,
  Activity,
  Code2,
  Keyboard,
  Bell,
  Wrench,
  DatabaseBackup, Compass, Lock, LockOpen, Blocks } from 'lucide-react'
import { useApp } from '../../store/app'
import type { ThemeMode } from '../../store/app'
import { useNav, SETTINGS_SECTIONS, SETTINGS_SECTION_LABELS } from '../../store/nav'
import { isLoopbackHostKeyId } from '../../../../shared/ssh'
import type { SettingsSection } from '../../store/nav'
import { useVault } from '../../store/vault'
import { useVaultPrompt } from '../../store/vaultPrompt'
import { clsx, duration } from '../../lib/format'
import { JOB_DETACHED_SETTING_NOTE } from '../../../../shared/jobs'
import { bridgeOn } from '../../lib/bridge'
import { ShortcutManager } from './ShortcutManager'
import { BackupPanel } from './BackupPanel'
import { UpdatePanel } from './UpdatePanel'
import { useOnboarding } from '../../store/onboarding'
import { SshSessions } from './SshSessions'
import { WebhookAlertSettings } from './WebhookAlertSettings'
import { CredProxyPanel } from './CredProxyPanel'
import { alertCoverageText } from './alertCoverage'
import { MODULES, moduleEnabled } from '../../../../shared/modules'
import { TERMINAL_SCHEMES, parseTerminalScheme } from '../../../../shared/terminalTheme'
import { useFleetStatus } from '../../store/fleetStatus'
import { toast } from '../../store/toast'

// Keyed by the nav store's union rather than by a list that describes itself,
// so a page added here without being added there — and therefore unreachable
// from any `openSettings(...)` button — fails the build, and a page added to
// the union without a label here fails it too.
const SECTION_ICONS: Record<SettingsSection, React.JSX.Element> = {
  general: <Sliders size={16} />,
  appearance: <Palette size={16} />,
  terminal: <TerminalSquare size={16} />,
  connections: <Server size={16} />,
  ssh: <KeyRound size={16} />,
  security: <Shield size={16} />,
  sftp: <FolderCog size={16} />,
  monitoring: <Activity size={16} />,
  modules: <Blocks size={16} />,
  editor: <Code2 size={16} />,
  shortcuts: <Keyboard size={16} />,
  backup: <DatabaseBackup size={16} />,
  notifications: <Bell size={16} />,
  advanced: <Wrench size={16} />
}

// The label comes from nav.ts, which is where the palette reads it too.
const SECTION_META = Object.fromEntries(
  SETTINGS_SECTIONS.map((id) => [id, { label: SETTINGS_SECTION_LABELS[id], icon: SECTION_ICONS[id] }])
) as Record<SettingsSection, { label: string; icon: React.JSX.Element }>

const SECTIONS: SettingsSection[] = [
  'general',
  'appearance',
  'terminal',
  'connections',
  'ssh',
  'security',
  'sftp',
  'monitoring',
  'modules',
  'editor',
  'shortcuts',
  'backup',
  'notifications',
  'advanced'
]

/**
 * Every setting, by the words a person would type looking for it.
 *
 * Reported from the running app: "there is no background checking settings and
 * no way to search it in the monitoring settings panel". Half of that is a
 * search box that did not exist — fourteen sections, each of them long, and the
 * only way in was to guess which one owned what you wanted. The other half is
 * subtler and is why a search box alone would not have fixed it: the setting IS
 * there, and it is called "Check servers in the background". Somebody who calls
 * it "background checking" — which is what the rest of this app's own copy
 * calls it, see the auto-start description above — never types a string the
 * visible row contains.
 *
 * So `aliases` carries the words the copy does not: the phrases people actually
 * type, kept out of sight rather than pushed into a label somebody wrote
 * carefully. Rewording the row to satisfy a search box would be the tail
 * wagging the dog.
 *
 * `title` is the row's `.s-title` text VERBATIM, because that string is also
 * how a result finds its row again after jumping to the section — see the jump
 * effect in `Settings`. Change a label, change it here.
 *
 * This is a hand-kept list because there is no registry to drive it from:
 * SECTION_META keys the sections, and the rows themselves are literal JSX. It
 * covers what Settings renders, including the rows the sub-panels own; it is
 * not required to be exhaustive to be useful, and a missing entry costs a
 * search that finds nothing rather than a broken screen.
 */
interface SettingEntry {
  section: SettingsSection
  /** The row's `.s-title`, exactly. */
  title: string
  /** What the row is about, in roughly the row's own words. */
  desc: string
  /** What people type that the visible copy does not say. */
  aliases?: string
}

const SETTING_INDEX: SettingEntry[] = [
  // General
  {
    section: 'general',
    title: 'Show the walkthrough',
    desc: 'A short tour of what is here and where it lives.',
    aliases: 'tour onboarding guide intro help getting started'
  },
  {
    section: 'general',
    title: 'Check for updates automatically',
    desc: 'Look for a newer OpsMaxx on a schedule.',
    aliases: 'auto update upgrade version release'
  },
  {
    section: 'general',
    title: 'Download updates automatically',
    desc: 'Fetch an update in the background once one is found.',
    aliases: 'auto update upgrade download'
  },
  { section: 'general', title: 'Install on quit', desc: 'Apply a downloaded update when you quit.', aliases: 'update upgrade restart' },
  { section: 'general', title: 'Channel', desc: 'Which release channel updates come from.', aliases: 'beta stable release channel update' },
  // Appearance
  { section: 'appearance', title: 'Theme', desc: 'Dark is the primary OpsMaxx experience.', aliases: 'dark light system colour color' },
  {
    section: 'appearance',
    title: 'Start when I log in',
    desc: 'Launch OpsMaxx with your machine, so background checking and alerts run from login.',
    aliases: 'autostart auto start login item startup boot'
  },
  {
    section: 'appearance',
    title: 'Start in the background',
    desc: 'Launch without opening a window. Checks still run and alerts still fire.',
    aliases: 'autostart hidden headless tray dock'
  },
  {
    section: 'appearance',
    title: 'Allow adding and revoking keys on servers',
    desc: 'Whether OpsMaxx may write authorized_keys on your machines.',
    aliases: 'access write authorized keys revoke'
  },
  {
    section: 'appearance',
    title: 'Ask for Touch ID when the vault is locked',
    desc: 'Raise the fingerprint prompt when you open a locked vault.',
    aliases: 'biometrics touchid fingerprint face id unlock'
  },
  { section: 'appearance', title: 'Compact density', desc: 'Tighter rows and padding across trees, lists and the docked monitor.', aliases: 'dense spacing compact size' },
  // Terminal
  {
    section: 'terminal',
    title: 'Colour scheme',
    desc: 'The sixteen ANSI colours the terminal draws with.',
    aliases: 'color colours palette theme solarized dracula nord gruvbox one dark iterm'
  },
  {
    section: 'terminal',
    title: 'Shell integration',
    desc: 'Local shells report where each prompt begins and how each command exited.',
    aliases: 'osc 133 prompt marks shell integration zsh bash fish exit status'
  },
  {
    section: 'terminal',
    title: 'Click to move the cursor',
    desc: 'Click inside the line you are typing to move the shell cursor there.',
    aliases: 'mouse click cursor position move caret cmux'
  },
  { section: 'terminal', title: 'Font family', desc: 'Monospace font used in the terminal.', aliases: 'typeface monospace' },
  { section: 'terminal', title: 'Font size', desc: 'Terminal text size. Also Ctrl + / Ctrl - / Ctrl 0.', aliases: 'zoom bigger smaller text size' },
  { section: 'terminal', title: 'Cursor blink', desc: 'Blink the terminal cursor.', aliases: 'caret' },
  { section: 'terminal', title: 'Copy on select', desc: 'Automatically copy selected text.', aliases: 'clipboard selection' },
  { section: 'terminal', title: 'Scroll to bottom on output', desc: 'Follow new output automatically.', aliases: 'autoscroll follow tail' },
  {
    section: 'terminal',
    title: 'Allow this machine as a target',
    desc: 'Whether a shell and the panels may run against this computer.',
    // What someone types when they want this off: the words they know the
    // feature by, not the words the row happens to use.
    aliases: 'local terminal this machine localhost kill switch disable local shell docker kubernetes files own computer'
  },
  // Shortcuts
  {
    section: 'shortcuts',
    title: 'Include hidden workspaces in Ctrl+1…9',
    desc: 'Whether hidden workspaces take their place in the switching numbers.',
    aliases: 'keyboard shortcut workspace switch'
  },
  // Editor
  { section: 'editor', title: 'External editor command', desc: 'Run to open a remote file — code, subl, nvim, and so on.', aliases: 'vscode vim editor open with' },
  { section: 'editor', title: 'Open files externally by default', desc: 'Double-clicking a file uses the external editor instead of the inline one.', aliases: 'editor default double click' },
  // Monitoring — the reported one, and its neighbours.
  {
    section: 'monitoring',
    title: 'Alerts',
    desc: 'The master switch for CPU, memory, disk, inode, load and failed-unit alerts, and for webhook delivery.',
    aliases: 'notifications alarms warnings turn off alerts'
  },
  {
    section: 'monitoring',
    title: 'Alert threshold',
    desc: 'The percentage at which CPU and memory alert. Disk and inodes are fixed at 85%, load at 2 per core.',
    aliases: 'percent percentage cpu memory limit'
  },
  {
    section: 'monitoring',
    title: 'Check servers in the background',
    desc: 'Sample every server in this workspace on a schedule, even when the monitor is not open, so failures and resource alerts are noticed while you are elsewhere.',
    // The reported miss. "Background checking" is this app's own name for it
    // everywhere except the row itself.
    aliases:
      'background checking background checks background check checking servers polling poll sampler sampling fleet monitor while closed'
  },
  {
    section: 'monitoring',
    title: 'How often',
    desc: 'How long between background checking passes.',
    aliases: 'interval frequency cadence background checking schedule poll'
  },
  { section: 'monitoring', title: 'Send alerts to a webhook', desc: 'Post every alert to a URL — Slack, Discord, or your own endpoint.', aliases: 'slack discord http post integration' },
  { section: 'monitoring', title: 'Webhook URL', desc: 'Where alerts are posted.', aliases: 'slack discord endpoint url' },
  { section: 'monitoring', title: 'Test delivery', desc: 'Send one webhook now to prove the URL works.', aliases: 'webhook test try' },
  { section: 'monitoring', title: 'Also send when it recovers', desc: 'Post a second webhook when the condition clears.', aliases: 'webhook recovery resolved clear' },
  { section: 'monitoring', title: 'Show monitor under the terminal', desc: 'Live CPU, memory, disk and network docked below the session.', aliases: 'strip docked graphs charts' },
  // SSH
  {
    section: 'ssh',
    title: 'Keep authenticated connection',
    desc: 'How long an authenticated SSH connection is reused before re-authenticating.',
    aliases: 'reuse multiplexing idle timeout 2fa two factor re-auth'
  },
  { section: 'ssh', title: 'Shared connections', desc: 'The SSH connections currently held open.', aliases: 'sessions open connections multiplex' },
  {
    section: 'ssh',
    title: 'Let jobs keep running when the connection drops',
    desc: 'Whether a long job survives a dropped connection instead of dying with it.',
    aliases: 'detached nohup background jobs apt dpkg'
  },
  // Security
  { section: 'security', title: 'Lock after inactivity', desc: 'How long the vault stays unlocked without use.', aliases: 'vault auto lock timeout idle' },
  { section: 'security', title: 'Trusted SSH host keys', desc: 'The host keys this machine has accepted.', aliases: 'known hosts fingerprint host key mismatch' },
  { section: 'security', title: 'Store credentials in OS keychain', desc: 'Use the platform secure store — never plaintext.', aliases: 'keychain secrets password storage' },
  { section: 'security', title: 'Auto-lock workspaces', desc: 'Lock password-protected workspaces after inactivity.', aliases: 'workspace lock idle' },
  { section: 'security', title: 'Confirm destructive commands', desc: 'Require confirmation for rm, systemctl stop, etc.', aliases: 'confirmation dangerous guard' },
  { section: 'security', title: 'API credential proxy', desc: 'A local proxy that injects vault credentials into outbound API calls.', aliases: 'proxy token api key injection' },
  // Backup
  { section: 'backup', title: 'Backup & Restore', desc: 'Export an encrypted copy of everything, or restore from one.', aliases: 'export import archive restore snapshot' },
  // Modules
  { section: 'modules', title: 'Modules', desc: 'Which subsystems are switched on for this workspace.', aliases: 'features enable disable subsystem' }
]

/**
 * Every word of the query has to appear somewhere in the entry.
 *
 * Deliberately not fuzzy. A typo-tolerant matcher is a pile of scoring nobody
 * can predict, and the failure it prevents ("bakcground") is rarer than the one
 * it causes: a query that quietly matches something else. Token containment
 * means "background checks" finds the row whose aliases say "background
 * checks", and "check servers" finds the row whose title says both words.
 */
function settingMatches(entry: SettingEntry, query: string): boolean {
  const hay = `${entry.title} ${entry.desc} ${entry.aliases ?? ''} ${SECTION_META[entry.section].label}`.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every((w) => hay.includes(w))
}

export function searchSettings(query: string): SettingEntry[] {
  if (!query.trim()) return []
  return SETTING_INDEX.filter((e) => settingMatches(e, query))
}

// A toggle backed by real, persisted state — unlike `Toggle` below, which is
// still placeholder UI holding its value in local state.
function SettingSwitch({
  label,
  desc,
  checked,
  onChange
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{label}</div>
        <div className="s-desc">{desc}</div>
      </div>
      <span className={clsx('switch', checked && 'on')} onClick={() => onChange(!checked)} />
    </div>
  )
}

/**
 * Starting with the machine.
 *
 * This pairs with background checking rather than being a cosmetic preference:
 * the fleet poll runs from the app root, so an OpsMaxx that starts at login
 * is a fleet watched from login. Without it, "background checking" only means
 * background of whenever somebody last opened the app.
 *
 * Reads its own state from the OS rather than from our settings file, because
 * the login item is the OS's record and a user can remove it from System
 * Settings without telling us. A stored boolean would then be a claim that
 * disagreed with the machine.
 */
function AutoStartSetting(): React.JSX.Element | null {
  const [state, setState] = useState<AutoStartState | null>(null)

  useEffect(() => {
    void window.opsmaxx!.autoStart.get().then(setState)
  }, [])

  if (!state) return null

  if (!state.supported) {
    return (
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">Start when I log in</div>
          <div className="s-desc">{state.reason}</div>
        </div>
      </div>
    )
  }

  const set = (next: Partial<AutoStartSettings>): void => {
    void window.opsmaxx!.autoStart
      .set({ openAtLogin: state.openAtLogin, openAsHidden: state.openAsHidden, ...next })
      .then(setState)
  }

  return (
    <>
      <SettingSwitch
        label="Start when I log in"
        desc="Launch OpsMaxx with your machine, so background checking and alerts run from login rather than from whenever you next open the app."
        checked={state.openAtLogin}
        onChange={(v) => set({ openAtLogin: v })}
      />
      {state.openAtLogin && state.hiddenSupported && (
        <SettingSwitch
          label="Start in the background"
          desc="Launch without opening a window. Checks still run and alerts still fire — OpsMaxx is waiting in the Dock rather than in front of you."
          checked={state.openAsHidden}
          onChange={(v) => set({ openAsHidden: v })}
        />
      )}
    </>
  )
}

// What the background sampler is actually doing.
//
// The switch above reports intent, and intent is not the interesting part: a
// locked vault, a workspace with nothing to sample, and a loop that has stopped
// all present as a switch in the "on" position and a screen that looks exactly
// like a healthy one. fleet.status() is the only thing that can tell them
// apart, and until this it was wired through IPC and read by nobody.
function FleetSamplerLine(): React.JSX.Element | null {
  const status = useFleetStatus((s) => s.status)

  // 'disabled' is the one idle reason the switch already explains.
  if (!status || status.idleReason === 'disabled') return null

  if (status.idleReason === 'vault-locked') {
    return (
      // The unlock is attached to the sentence that names it. Telling somebody
      // to go and unlock the vault means: find the vault, work out what a
      // vault is, unlock it, come back — for a state this screen can resolve
      // in one press, with Touch ID where the machine has it.
      <div className="panel-note is-watch">
        <span className="grow">Paused — the vault is locked, so nothing is being checked.</span>
        <UnlockVaultButton reason="Background checking needs the credentials in your vault." />
      </div>
    )
  }
  if (status.idleReason === 'no-targets') {
    return (
      <div className="s-desc warn">
        Nothing to check — this workspace has no servers that can be sampled.
      </div>
    )
  }
  // Enabled, targets, vault open — and still not looping. Said plainly,
  // because the alternative is a settings screen that affirms everything is
  // fine while nothing has been sampled for hours.
  if (!status.running) {
    const since = status.lastSweepAt
      ? `nothing has been checked for ${duration(status.lastSweepAt)}`
      : 'no pass has ever run'
    // No longer "turn this off and on again". That was a workaround for a
    // missing wire — unlocking the vault did not re-arm the sampler — and
    // telling someone to power-cycle a feature is an admission, not an
    // instruction. Unlock now resumes checking on its own, so reaching this
    // state means something genuinely unexpected and the honest thing is to
    // say so rather than to prescribe a ritual.
    return (
      <div className="s-desc danger">
        {`Switched on, but nothing is scheduled — ${since}. This should not happen; ` +
          'switching it off and on will restart it, and it is worth reporting.'}
      </div>
    )
  }

  const servers = `${status.targetCount} server${status.targetCount === 1 ? '' : 's'}`
  return (
    <div className="s-desc ok">
      {status.lastSweepAt
        ? `Running · ${servers} · last pass ${duration(status.lastSweepAt)} ago, took ${sweepDuration(status.lastSweepMs)}`
        : `Running · ${servers} · first pass has not finished yet`}
    </div>
  )
}

function sweepDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)}s`
}

// Real data: the SSH host keys trusted on first use. Forgetting one is how a
// user recovers after a server is legitimately rebuilt with a new key.
function KnownHosts(): React.JSX.Element {
  const [hosts, setHosts] = useState<{ id: string; fingerprint: string; addedAt: string }[]>([])

  const load = (): void => {
    void window.opsmaxx?.knownHosts.list().then((h) => setHosts(h ?? []))
  }
  useEffect(load, [])

  // Listed below as well, so the button never removes anything the user cannot
  // already see and check first.
  const stale = hosts.filter((h) => isLoopbackHostKeyId(h.id))

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">Trusted SSH host keys</div>
          <div className="s-desc">
            {hosts.length
              ? 'Connections are refused if a server presents a different key than the one saved here.'
              : 'No servers trusted yet — the first connection to a server will ask.'}
          </div>
        </div>
        <button className="btn sm" onClick={load}>
          Refresh
        </button>
      </div>

      {/* Wreckage from the bug fixed in 0.36.2, and the reason this control
          exists: a user who connected through a tunnel a dozen times has a
          dozen of these and, before now, no way to remove them but one at a
          time -- without knowing which ones were junk. */}
      {stale.length > 0 && (
        <div className="setting-row">
          <div className="s-info">
            <div className="s-title warn">
              {stale.length === 1
                ? '1 entry is saved against a loopback address'
                : `${stale.length} entries are saved against loopback addresses`}
            </div>
            <div className="s-desc">
              Before 0.36.2, a server reached through a VPN or tunnel had its host key saved under
              the temporary local address the connection borrowed — a different one every time. That
              is why those servers kept asking to be trusted again. The entries name no particular
              machine, so an unrelated local service on the same port would inherit the trust.
              <br />
              If you deliberately trust an SSH server running on this machine, its entry looks the
              same — remove that one individually instead.
            </div>
          </div>
          <button
            className="btn sm danger"
            onClick={async () => {
              for (const h of stale) await window.opsmaxx?.knownHosts.forget(h.id)
              toast(
                stale.length === 1
                  ? 'Removed 1 stale entry.'
                  : `Removed ${stale.length} stale entries.`,
                'ok'
              )
              load()
            }}
          >
            Remove {stale.length === 1 ? 'it' : `all ${stale.length}`}
          </button>
        </div>
      )}
      {hosts.map((h) => (
        <div className="setting-row" key={h.id}>
          <div className="s-info">
            <div className="s-title mono">{h.id}</div>
            <div className="s-desc mono" style={{ fontSize: 11 }}>
              {h.fingerprint}
            </div>
          </div>
          <button
            className="btn sm danger"
            onClick={async () => {
              await window.opsmaxx?.knownHosts.forget(h.id)
              toast(`Forgot the saved key for ${h.id}. The next connection to it will ask again.`, 'ok')
              load()
            }}
          >
            Forget
          </button>
        </div>
      ))}
    </div>
  )
}

// The auto-lock control below is about a vault that may not exist yet, or may
// be locked right now — and "the vault is locked" is only useful next to the
// thing that unlocks it. Everywhere else in the app an operation that needs a
// credential raises the unlock prompt itself; this is the one place the state
// is the subject rather than a side effect, so it says so and offers the same
// prompt rather than sending the user off to find the Vault view.
function VaultState(): React.JSX.Element {
  const exists = useVault((s) => s.exists)
  const unlocked = useVault((s) => s.unlocked)
  const refresh = useVault((s) => s.refresh)
  const setActivity = useApp((s) => s.setActivity)

  useEffect(() => {
    void refresh()
    // The vault can lock itself on the inactivity timer configured just below
    // this row, and a row that goes on saying "unlocked" after that is worse
    // than no row at all.
    const off = bridgeOn('vault.onAutoLocked', window.opsmaxx?.vault?.onAutoLocked, () => void refresh())
    return () => off()
  }, [refresh])

  const unlock = async (): Promise<void> => {
    await useVaultPrompt.getState().request('Unlocking makes your saved credentials usable again.')
    void refresh()
  }

  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">
          {unlocked ? <LockOpen size={13} /> : <Lock size={13} />}{' '}
          {exists === null
            ? 'Checking for a vault…'
            : !exists
              ? 'No vault on this computer yet'
              : unlocked
                ? 'Vault unlocked'
                : 'Vault locked'}
        </div>
        <div className="s-desc">
          {exists === null
            ? 'Reading this machine\u2019s keychain. Nothing is decided until it answers.'
            : !exists
            ? 'A vault holds one copy of each credential and travels inside an encrypted backup. Without one, every server keeps its own.'
            : unlocked
              ? 'Anything that needs a saved credential can use it until the timer below runs out.'
              : 'Anything that needs a saved credential will ask you to unlock first.'}
        </div>
      </div>
      {exists === null ? null : !exists ? (
        <button className="btn sm" onClick={() => setActivity('vault')}>
          Set up a vault
        </button>
      ) : unlocked ? (
        <button className="btn sm" onClick={() => void useVault.getState().lock()}>
          <Lock size={13} /> Lock now
        </button>
      ) : (
        <button className="btn sm primary" onClick={() => void unlock()}>
          <LockOpen size={13} /> Unlock vault
        </button>
      )}
    </div>
  )
}

function Toggle({ label, desc, initial = false }: { label: string; desc: string; initial?: boolean }): React.JSX.Element {
  const [on, setOn] = useState(initial)
  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">{label}</div>
        <div className="s-desc">{desc}</div>
      </div>
      <span className={clsx('switch', on && 'on')} onClick={() => setOn((v) => !v)} />
    </div>
  )
}

export function Settings(): React.JSX.Element {
  // Held in the nav store so an error raised anywhere in the app can send the
  // user to the page that resolves it — a host-key mismatch to Security, a
  // too-old build to General — rather than to Settings in general.
  const section = useNav((s) => s.settingsSection)
  const setSection = useNav((s) => s.setSettingsSection)
  const startTour = useOnboarding((s) => s.start)
  // Same source the sampler line below and the status-bar chip read, so none
  // of the three can disagree about whether background checking is happening.
  // The poll itself lives in FleetWatcher at the app root: it has to run
  // whether or not this pane is open, since the chip is the whole point.
  const fleetStatus = useFleetStatus((s) => s.status)
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const zoomTerminal = useApp((s) => s.zoomTerminal)

  // The search box, and the row a result asked for.
  //
  // Reported from the running app: "there is no background checking settings
  // and no way to search it in the monitoring settings panel". See
  // SETTING_INDEX for why both halves of that are true.
  const [query, setQuery] = useState('')
  const [jumpTo, setJumpTo] = useState<string | null>(null)
  const results = searchSettings(query)

  // Landing on the section is most of the answer; landing on the ROW is the
  // rest of it, and Monitoring is long enough that the difference matters —
  // this is the page whose bottom half was unreachable at all until the scroll
  // fix, and the reported setting sits below the fold on a short window.
  //
  // Found by title text rather than by threading a ref through forty rows in
  // six components, only one of which this change is allowed to touch. The
  // trade is that a renamed label silently stops jumping — which is why
  // SETTING_INDEX says, at its `title` field, that the two are the same string.
  useEffect(() => {
    if (!jumpTo) return undefined
    const title = [...document.querySelectorAll('.settings-content .s-title')].find(
      (el) => el.textContent?.trim() === jumpTo
    )
    const row = title?.closest('.setting-row')
    if (!row) return undefined
    row.classList.add('setting-hit')
    // Absent in jsdom, and a missing scroll is not worth an exception in a
    // renderer.
    row.scrollIntoView?.({ block: 'center' })
    const t = setTimeout(() => row.classList.remove('setting-hit'), 2600)
    return () => {
      clearTimeout(t)
      row.classList.remove('setting-hit')
    }
  }, [jumpTo, section])

  return (
    <div className="main">
      <div className="settings">
        <nav className="settings-nav">
          <input
            className="input settings-search"
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() !== '' && (
            <div className="settings-results" role="listbox" aria-label="Search results">
              {results.length === 0 ? (
                // Said, rather than an empty box that looks broken.
                <div className="field-hint" style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
                  No setting matches that. Try a word from what it does — “webhook”, “vault”,
                  “background”.
                </div>
              ) : (
                results.map((e) => (
                  <button
                    key={`${e.section}:${e.title}`}
                    className="nav-item result"
                    role="option"
                    onClick={() => {
                      setSection(e.section)
                      setJumpTo(e.title)
                      // Clearing it puts the section list back, which is where
                      // the user now is. A result list left standing over the
                      // page they just jumped to is a second thing to dismiss.
                      setQuery('')
                    }}
                  >
                    <span className="result-title">{e.title}</span>
                    <span className="result-section">{SECTION_META[e.section].label}</span>
                  </button>
                ))
              )}
            </div>
          )}
          {SECTIONS.map((id) => (
            <button
              key={id}
              className={clsx('nav-item', section === id && 'active')}
              onClick={() => setSection(id)}
            >
              {SECTION_META[id].icon}
              {SECTION_META[id].label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'general' && <UpdatePanel />}

          {section === 'general' && (
            <div className="settings-section">
              <h2>Walkthrough</h2>
              <div className="sub">A short tour of what is here and where it lives.</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Show the walkthrough</div>
                  <div className="s-desc">
                    Runs once on a first launch. Reopen it here whenever you want — it switches to
                    each feature as it describes it, so nothing is hidden while you read.
                  </div>
                </div>
                <button className="btn sm" onClick={() => startTour()}>
                  <Compass size={13} /> Start walkthrough
                </button>
              </div>
            </div>
          )}

          {section === 'appearance' && (
            <div className="settings-section">
              <h2>Appearance</h2>
              <div className="sub">Theme and visual density.</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Theme</div>
                  <div className="s-desc">Dark is the primary OpsMaxx experience.</div>
                </div>
                <div className="segment">
                  {(['dark', 'light', 'system'] as ThemeMode[]).map((t) => (
                    <button
                      key={t}
                      className={clsx('seg-btn', theme === t && 'active')}
                      onClick={() => setTheme(t)}
                      style={{ textTransform: 'capitalize' }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <AutoStartSetting />
              <SettingSwitch
                label="Compact density"
                desc="Tighter rows and padding across trees, lists and the docked monitor. Font sizes are unchanged."
                checked={settings.compactDensity}
                onChange={(v) => setSettings({ compactDensity: v })}
              />
              <Toggle label="Show status bar" desc="Display the bottom status bar." initial />
              <Toggle label="Animated transitions" desc="Subtle motion on menus and modals." initial />
            </div>
          )}

          {section === 'terminal' && (
            <div className="settings-section">
              <h2>Terminal</h2>
              <div className="sub">Font, cursor and scrollback behaviour.</div>
              <SettingSwitch
                label="Close the pane when the shell exits"
                desc="Typing exit ends the session, so the pane goes with it — the same as every other terminal. A shell that stopped for a reason keeps its pane and says why, whatever this is set to."
                checked={settings.closeTabOnShellExit !== false}
                onChange={(v) => setSettings({ closeTabOnShellExit: v })}
              />
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Font family</div>
                  <div className="s-desc">Monospace font used in the terminal.</div>
                </div>
                <select className="select" style={{ width: 220 }}>
                  <option>JetBrains Mono</option>
                  <option>SF Mono</option>
                  <option>Cascadia Code</option>
                  <option>Menlo</option>
                </select>
              </div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Font size</div>
                  <div className="s-desc">
                    Applies to open terminals immediately. Also <b>Ctrl +</b> / <b>Ctrl -</b> /{' '}
                    <b>Ctrl 0</b>, or Ctrl+scroll inside a terminal.
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={() => zoomTerminal(-1)}>
                    −
                  </button>
                  <span className="mono" style={{ width: 34, textAlign: 'center' }}>
                    {settings.terminalFontSize}
                  </span>
                  <button className="btn sm" onClick={() => zoomTerminal(1)}>
                    +
                  </button>
                  <button className="btn sm" onClick={() => zoomTerminal('reset')}>
                    Reset
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Colour scheme</div>
                  <div className="s-desc">
                    Applies to open terminals immediately. A scheme without its own background keeps
                    the app&apos;s, so it follows light and dark.
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <select
                    className="input"
                    value={settings.terminalScheme}
                    onChange={(e) => setSettings({ terminalScheme: e.target.value })}
                  >
                    <option value="">App palette</option>
                    {TERMINAL_SCHEMES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                    {settings.terminalCustomSchemes.length > 0 && (
                      <optgroup label="Imported">
                        {settings.terminalCustomSchemes.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <button
                    className="btn sm"
                    onClick={() => {
                      void (async () => {
                        const text = await window.opsmaxx?.dialog.openScheme()
                        // Cancelled, or unreadable. Neither is worth a toast:
                        // the user either chose nothing or already knows.
                        if (!text) return
                        const parsed = parseTerminalScheme(text)
                        if (!parsed.ok) {
                          toast(parsed.error, 'error')
                          return
                        }
                        // Re-importing the same file replaces rather than
                        // duplicates: the id is derived from the name, and two
                        // rows reading "Campbell" would be unusable.
                        const rest = settings.terminalCustomSchemes.filter(
                          (s) => s.id !== parsed.scheme.id
                        )
                        setSettings({
                          terminalCustomSchemes: [...rest, parsed.scheme],
                          terminalScheme: parsed.scheme.id
                        })
                        toast(`${parsed.scheme.name} added`, 'ok')
                      })()
                    }}
                  >
                    Import a file
                  </button>
                </div>
              </div>
              <Toggle label="Cursor blink" desc="Blink the terminal cursor." initial />
              <Toggle label="Copy on select" desc="Automatically copy selected text." />
              <Toggle label="Scroll to bottom on output" desc="Follow new output automatically." initial />
              <SettingSwitch
                label="Shell integration"
                desc="Start local shells so they report where each prompt begins and what each command exited with. Uses the shell's own startup options for the session OpsMaxx starts — your shell config files are never modified, and turning this off restores the previous behaviour exactly. zsh and bash get prompt and command marks; fish gets command marks only; a login bash and PowerShell are not supported."
                checked={settings.shellIntegration === true}
                onChange={(v) => setSettings({ shellIntegration: v })}
              />
              <SettingSwitch
                label="Click to move the cursor"
                desc="Click inside the line you are typing to put the shell cursor there. Needs shell integration, so it does nothing in a session without it, and stays out of the way while a command is running or a full-screen program is open."
                checked={settings.terminalClickToMove === true}
                onChange={(v) => setSettings({ terminalClickToMove: v })}
              />
              {/* The switch main already enforced and nothing could reach.
                  services/localGate.ts kept its own copy of this flag and
                  documented a user toggle for it, but no code ever wrote the
                  setting — so the kill switch existed and could not be pulled.

                  The copy says "this machine" rather than "local terminal"
                  deliberately: it gates every local target, not only the shell.
                  Turning it off also refuses the Docker, Kubernetes, Compose,
                  cron, host-facts, Files and metrics panels' "This machine"
                  option, and ends any local Files session already open. */}
              <SettingSwitch
                label="Allow this machine as a target"
                desc="Open a shell on this computer, and offer it alongside your servers in the Docker, Kubernetes, cron, Files and monitoring panels. When off, every one of those refuses locally and open local file sessions are closed. Never available to the AI bridge either way."
                checked={settings.localTerminalEnabled !== false}
                onChange={(v) => setSettings({ localTerminalEnabled: v })}
              />
            </div>
          )}

          {section === 'shortcuts' && (
            <div className="settings-section">
              <h2>Keyboard Shortcuts</h2>
              <div className="sub">Record a combination by clicking a shortcut. Conflicts are highlighted.</div>
              <SettingSwitch
                label="Include hidden workspaces in Ctrl+1…9"
                desc="When on, hidden workspaces take their place in the numbering and can be switched to by shortcut. When off, they are skipped and the numbers close up around them."
                checked={settings.switchHiddenWorkspaces}
                onChange={(v) => setSettings({ switchHiddenWorkspaces: v })}
              />
              <ShortcutManager />
            </div>
          )}

          {section === 'editor' && (
            <div className="settings-section">
              <h2>Editor</h2>
              <div className="sub">How remote files open from the Files view.</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">External editor command</div>
                  <div className="s-desc">
                    Run to open a remote file — <code>code</code> for VS Code, <code>subl</code>,{' '}
                    <code>nvim</code>, and so on. Leave empty to use the system default for the file
                    type. Saving in the editor uploads the file back automatically.
                  </div>
                </div>
                <input
                  className="input"
                  style={{ width: 180 }}
                  placeholder="system default"
                  value={settings.externalEditorCommand}
                  onChange={(e) => setSettings({ externalEditorCommand: e.target.value })}
                />
              </div>
              <SettingSwitch
                label="Open files externally by default"
                desc="Double-clicking a file in the Files view uses the external editor instead of the built-in inline editor."
                checked={settings.openFilesExternally}
                onChange={(v) => setSettings({ openFilesExternally: v })}
              />
            </div>
          )}

          {section === 'modules' && (
            <>
              <h2>Modules</h2>
              <p className="muted">
                Features that ship with OpsMaxx but stay off until you turn them on. Everything
                here is first-party code in the same repo, reviewed the same way — this is about not
                carrying what you do not use, not about running anyone else&rsquo;s code.
              </p>
              {/* A module added by an update is off until you switch it on,
                  even though a new install would have it on. An upgrade is not
                  consent — see backfillModules. */}
              <p className="muted">
                A module added by an update stays off on an existing install until you enable it
                here.
              </p>
              {MODULES.map((m) => (
                <div className="setting-row" key={m.id}>
                  <div className="s-info">
                    <div className="s-title">{m.label}</div>
                    <div className="s-desc">{m.detail}</div>
                  </div>
                  <span
                    className={clsx('switch', moduleEnabled(settings.modules, m.id) && 'on')}
                    onClick={() =>
                      setSettings({
                        modules: { ...settings.modules, [m.id]: !moduleEnabled(settings.modules, m.id) }
                      })
                    }
                  />
                </div>
              ))}
            </>
          )}

          {section === 'monitoring' && (
            <div className="settings-section">
              <h2>Monitoring</h2>
              <div className="sub">
                Alerts, background checking, webhook delivery, and the monitor strip.
              </div>
              {/* The settings KEY stays `resourceAlertsEnabled` so saved settings
                  still load, but the label was only ever half true: this switch
                  gates checkUnitAlerts as well as checkResourceAlerts, and every
                  webhook is posted from inside one of the two. */}
              <SettingSwitch
                label="Alerts"
                desc="The master switch. Covers CPU and memory at or above the threshold, a root filesystem more than 85% full by blocks OR by inodes, a load average at or above 2 per core, and systemd units that have failed — and, since every webhook is sent from an alert, webhook delivery too. CPU, memory and load repeat once a minute while the condition lasts; a full disk or inode table repeats every six hours, or sooner if it gets 5 points worse. They clear themselves on recovery: a filesystem as soon as it is back to 85% or below, CPU and memory once they are 5 points under the threshold, so a server sitting exactly on the line does not flicker on and off. A server that crosses the same line five times in six hours is announced once more and then held quiet until it has gone six hours without crossing again. Anything the server could not measure — no inode accounting, no /proc/loadavg, no df — raises nothing and clears nothing, because a reading nobody could take is not a reading of zero. Switching this off also takes down any alerts already showing."
                checked={settings.resourceAlertsEnabled}
                onChange={(v) => setSettings({ resourceAlertsEnabled: v })}
              />
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Alert threshold</div>
                  <div className="s-desc">
                    The same figure applies to CPU and to memory. Disk has its own, fixed at{' '}
                    <strong>85%</strong>: a root filesystem past that alerts, which is the same
                    85% at which the Fleet Monitor lists the server as needing attention and turns
                    its disk bar red. Inodes use the same 85% and load its own fixed{' '}
                    <strong>2 per core</strong>. Only the root filesystem is measured, for blocks
                    and for inodes alike — a server that has filled /var and has room on / raises
                    nothing here.{' '}
                    {alertCoverageText(fleetStatus?.running, settings.fleetSamplingEnabled)}
                  </div>
                </div>
                <div className="segment">
                  {[70, 80, 90, 95].map((t) => (
                    <button
                      key={t}
                      className={clsx('seg-btn', settings.resourceAlertThreshold === t && 'active')}
                      disabled={!settings.resourceAlertsEnabled}
                      onClick={() => setSettings({ resourceAlertThreshold: t })}
                    >
                      {t}%
                    </button>
                  ))}
                </div>
              </div>
              {/* Not SettingSwitch: this row needs the sampler's real state
                  under the description, and the switch component owns its own
                  desc. Same markup, so it stays visually identical. */}
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Check servers in the background</div>
                  <div className="s-desc">
                    Sample every server in this workspace on a schedule, even when the monitor is
                    not open, so failures and resource alerts are noticed while you are elsewhere.
                    Opens one SSH exec channel per server per pass, separately from the monitor, so
                    it is real load on the estate rather than a reuse of what is already sampled.
                    Needs the vault unlocked; while it is locked, checking pauses rather than
                    failing.
                  </div>
                  {/* Stated before the switch is touched rather than after,
                      because this is the cost of turning it on and the whole
                      point is that it used to happen invisibly. */}
                  <div className="s-desc">
                    While this is on, each checked server&rsquo;s connection is held open and never
                    goes idle, so <strong>Keep authenticated connection</strong> under SSH sessions
                    stops applying to them at any setting. On a server with two-factor
                    authentication that means no new code is requested until you turn this off or
                    quit.
                  </div>
                  <FleetSamplerLine />
                </div>
                <span
                  className={clsx('switch', settings.fleetSamplingEnabled && 'on')}
                  onClick={() => setSettings({ fleetSamplingEnabled: !settings.fleetSamplingEnabled })}
                />
              </div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">How often</div>
                  <div className="s-desc">
                    Measured from the end of one pass to the start of the next, so a slow estate
                    slows the cadence instead of overlapping checks.
                  </div>
                </div>
                <div className="segment">
                  {[
                    { ms: 60_000, label: '1 min' },
                    { ms: 120_000, label: '2 min' },
                    { ms: 300_000, label: '5 min' },
                    { ms: 900_000, label: '15 min' }
                  ].map((o) => (
                    <button
                      key={o.ms}
                      className={clsx('seg-btn', settings.fleetSamplingIntervalMs === o.ms && 'active')}
                      disabled={!settings.fleetSamplingEnabled}
                      onClick={() => setSettings({ fleetSamplingIntervalMs: o.ms })}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <WebhookAlertSettings />
              <SettingSwitch
                label="Show monitor under the terminal"
                desc="Live CPU, memory, disk and network docked below the session. Sampling only runs for the visible tab."
                checked={settings.showMonitorStrip}
                onChange={(v) => setSettings({ showMonitorStrip: v })}
              />
            </div>
          )}

          {section === 'ssh' && (
            <div className="settings-section">
              <h2>SSH</h2>
              <div className="sub">Connection reuse and re-authentication policy.</div>
              <SshSessions />
              {/* Spelled out rather than summarised, because it is the one
                  setting here that decides whether OpsMaxx writes anything
                  to your machines. An operator is owed the exact list, and the
                  honest description of what turning it OFF costs — which is not
                  "less is written", it is "a long command dies with the
                  connection, and apt and dpkg do not survive that". */}
              <SettingSwitch
                label="Let jobs keep running when the connection drops"
                desc={JOB_DETACHED_SETTING_NOTE}
                checked={settings.jobsDetached !== false}
                onChange={(v) => setSettings({ jobsDetached: v })}
              />
            </div>
          )}

          {section === 'backup' && (
            <div className="settings-section">
              <h2>Backup &amp; Restore</h2>
              <div className="sub">Export an encrypted copy of everything, or restore from one.</div>
              <BackupPanel />
            </div>
          )}

          {section === 'security' && (
            <div className="settings-section">
              <h2>Vault</h2>
              <div className="sub">The encrypted store for passwords, SSH keys and API keys.</div>
              <VaultState />
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Lock after inactivity</div>
                  <div className="s-desc">
                    While the vault is unlocked its key is in memory and its entries are on screen.
                    Locking clears both. The timer counts vault inactivity, not time since you
                    started the app.
                  </div>
                </div>
                <select
                  className="input"
                  style={{ maxWidth: 160 }}
                  value={settings.vaultAutoLockMinutes}
                  onChange={(e) => setSettings({ vaultAutoLockMinutes: Number(e.target.value) })}
                >
                  <option value={5}>5 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={60}>1 hour</option>
                  <option value={0}>Never</option>
                </select>
              </div>
              <SettingSwitch
                label="Ask for Touch ID when the vault is locked"
                desc="Whenever the vault has to be unlocked — opening the Vault, or anything that needs a stored credential — raise the fingerprint prompt without waiting for a click. Cancel it and the master password field is right there. Does nothing unless you have already set up biometric unlock."
                checked={settings.vaultAutoBiometricPrompt}
                onChange={(v) => setSettings({ vaultAutoBiometricPrompt: v })}
              />
            </div>
          )}

          {section === 'security' && (
            <div className="settings-section">
              <h2>Security</h2>
              <div className="sub">Credential storage and workspace locking.</div>
              {/* Filed here rather than under Appearance, where it was. This
                  grants permission to rewrite authorized_keys on servers, and
                  a reader looking for it went to Security, found nothing, and
                  concluded the feature did not exist — which is exactly what
                  the screen that refuses without naming it also told them. */}
              <SettingSwitch
                label="Allow adding and revoking keys on servers"
                desc={ACCESS_WRITE_OPT_IN_NOTE}
                checked={settings.accessWriteEnabled}
                onChange={(v) => setSettings({ accessWriteEnabled: v })}
              />
              <KnownHosts />
              {/* Credential storage is not a choice, so it is not a switch.
                  A switch here read as a guarantee the user could withdraw --
                  and the three rows that used to sit below this one (keychain,
                  auto-lock, confirm-destructive) were all painted: they held
                  their state in a local `useState` and persisted nothing. A
                  security control that cannot be turned off is worse than
                  absent, because the user believes they turned it off. */}
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Credential storage</div>
                  <div className="s-desc">
                    Passwords and key passphrases go to the vault, or to this platform's secure
                    store when no vault is set up. Neither path writes plaintext to disk, and
                    there is no setting that changes it.
                  </div>
                </div>
                <span className="pill ok">Always on</span>
              </div>
            </div>
          )}

          {/* Roadmap item 7. It sits under Security rather than Connections
              because what it configures is where a stored credential is
              allowed to go, which is the same question the vault above
              answers for SSH. */}
          {section === 'security' && (
            <div className="settings-section">
              <h2>API credential proxy</h2>
              <div className="sub">
                Let a script or an agent call a third-party API without ever holding the key.
              </div>
              <CredProxyPanel />
            </div>
          )}

          {![
            'general',
            'appearance',
            'terminal',
            'shortcuts',
            'security',
            'editor',
            'backup',
            'ssh',
            'monitoring'
          ].includes(section) && (
            <div className="settings-section">
              <h2>{SECTION_META[section].label}</h2>
              <div className="sub">Configure {section} preferences for this workspace.</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">Reset {section}</div>
                  <div className="s-desc">Restore defaults for this section.</div>
                </div>
                <button
                  className="btn sm"
                  onClick={() => toast(`Nothing to reset — ${SECTION_META[section].label} has no saved settings yet.`)}
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
