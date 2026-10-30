import { useCallback, useEffect, useState } from 'react'
import type { DebugStatus } from '../../../../shared/debug'
import type { AutoStartSettings, AutoStartState } from '../../../../shared/autostart'
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
import { useNav, openMonitor, SETTINGS_SECTIONS, SETTINGS_SECTION_LABEL_KEYS } from '../../store/nav'
import { isLoopbackHostKeyId } from '../../../../shared/ssh'
import type { SettingsSection } from '../../store/nav'
import { useVault } from '../../store/vault'
import { useVaultPrompt } from '../../store/vaultPrompt'
import { clsx, duration } from '../../lib/format'
import { bridgeOn, bridgeHas } from '../../lib/bridge'
import { ShortcutManager } from './ShortcutManager'
import { BackupPanel } from './BackupPanel'
import { AgentPanel } from '../sshAgent/AgentPanel'
import { BitwardenImport } from '../vault/BitwardenImport'
import { AddySetup } from '../addy/AddySetup'
import { UpdatePanel } from './UpdatePanel'
import { useOnboarding } from '../../store/onboarding'
import { SshSessions } from './SshSessions'
import { WebhookAlertSettings } from './WebhookAlertSettings'
import { CredProxyPanel } from './CredProxyPanel'
import { MachineGrants } from './MachineGrants'
import { alertCoverageText } from './alertCoverage'
import { MODULES, isPromotedModule, moduleEnabled, type ModuleDef } from '../../../../shared/modules'

/**
 * How the Modules page is divided.
 *
 * Three groups, and every module lands in exactly one -- asserted in
 * tests/settingsModuleGroups.test.ts, because a module that matched no group would
 * simply not render and would look like it had been removed from the product.
 *
 * The division is `surface` plus promotion, both of which already exist and are
 * already tested. Nothing new is invented here on purpose: a grouping this page
 * made up for itself would be a second opinion about what a module is, and the
 * first-run card would then be free to have a third.
 */
const MODULE_GROUPS: {
  id: string
  labelKey: MessageKey
  detailKey: MessageKey
  match: (m: ModuleDef) => boolean
}[] =
  [
    {
      id: 'promoted',
      labelKey: 'settingsPage.modules.groups.promoted.label',
      detailKey: 'settingsPage.modules.groups.promoted.detail',
      match: (m) => isPromotedModule(m.id)
    },
    {
      id: 'read',
      labelKey: 'settingsPage.modules.groups.read.label',
      // NOT "none of these can change a server", which is what this said first
      // and which is false. That sentence is the registry's CONTRACT for the
      // `read` surface, and repeating it here turned a design invariant into a
      // security claim shown to the user at the moment they decide — directly
      // above the Rules switch, which is the one member that does not satisfy
      // it. A rule runs a job on hosts, unattended (see the `rules` entry in
      // shared/modules.ts, and tests/monitorSurfaces.test.ts for why it is
      // nonetheless filed here). Naming the exception is the whole fix: a group
      // label may describe the group, but it may not make a promise on behalf of
      // a member that breaks it.
      detailKey: 'settingsPage.modules.groups.read.detail',
      match: (m) => m.surface === 'read' && !isPromotedModule(m.id)
    },
    {
      id: 'operate',
      labelKey: 'settingsPage.modules.groups.operate.label',
      detailKey: 'settingsPage.modules.groups.operate.detail',
      match: (m) => m.surface === 'operate'
    }
  ]
import { parseTerminalScheme } from '../../../../shared/terminalTheme'
import { SchemePicker } from './SchemePicker'
import { useFleetStatus } from '../../store/fleetStatus'
import { toast } from '../../store/toast'
import { Switch } from '../common/Switch'
import { useT, t as currentT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'
import {
  LOCALES,
  LOCALE_NAMES,
  PSEUDO_LOCALE,
  englishT,
  parseLanguagePref,
  type MessageKey
} from '../../../../shared/i18n'

// The OpsMaxx pair first, the classic pair after. Labelled rather than
// capitalised, because "OpsMaxx" is not what capitalising "opsmaxx" gives.
const THEME_OPTIONS: [ThemeMode, MessageKey][] = [
  ['opsmaxx', 'settingsPage.appearance.theme.opsmaxx'],
  ['opsmaxx-light', 'settingsPage.appearance.theme.opsmaxxLight'],
  ['dark', 'settingsPage.appearance.theme.classicDark'],
  ['light', 'settingsPage.appearance.theme.classicLight'],
  ['system', 'settingsPage.appearance.theme.system']
]

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
  SETTINGS_SECTIONS.map((id) => [id, { labelKey: SETTINGS_SECTION_LABEL_KEYS[id], icon: SECTION_ICONS[id] }])
) as Record<SettingsSection, { labelKey: MessageKey; icon: React.JSX.Element }>

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
 * `titleKey` is the key the row's `.s-title` renders, because that text is also
 * how a result finds its row again after jumping to the section — see the jump
 * effect in `Settings`. Index and row share one key, so no translation can
 * split them; a row in a sub-panel has its own key here and must read the same.
 *
 * This is a hand-kept list because there is no registry to drive it from:
 * SECTION_META keys the sections, and the rows themselves are literal JSX. It
 * covers what Settings renders, including the rows the sub-panels own; it is
 * not required to be exhaustive to be useful, and a missing entry costs a
 * search that finds nothing rather than a broken screen.
 */
interface SettingEntry {
  section: SettingsSection
  /** The key the row's `.s-title` renders, exactly. */
  titleKey: MessageKey
  /** What the row is about, in roughly the row's own words. */
  descKey: MessageKey
  /** What people type that the visible copy does not say. English in every
   *  language: technical terms get typed in English whatever the UI is in. */
  aliases?: string
}

const SETTING_INDEX: SettingEntry[] = [
  // General
  {
    section: 'general',
    titleKey: 'settingsPage.walkthrough.title',
    descKey: 'settingsPage.walkthrough.sub',
    aliases: 'tour onboarding guide intro help getting started'
  },
  {
    section: 'general',
    titleKey: 'settings.updatePanel.auto.checkLabel',
    descKey: 'settingsPage.index.checkUpdates.desc',
    aliases: 'auto update upgrade version release'
  },
  {
    section: 'general',
    titleKey: 'settings.updatePanel.auto.downloadLabel',
    descKey: 'settingsPage.index.downloadUpdates.desc',
    aliases: 'auto update upgrade download'
  },
  { section: 'general', titleKey: 'settings.updatePanel.auto.installLabel', descKey: 'settingsPage.index.installOnQuit.desc', aliases: 'update upgrade restart' },
  { section: 'general', titleKey: 'settings.updatePanel.channel.title', descKey: 'settingsPage.index.channel.desc', aliases: 'beta stable release channel update' },
  // Appearance
  { section: 'appearance', titleKey: 'settingsPage.appearance.theme.title', descKey: 'settingsPage.appearance.theme.desc', aliases: 'opsmaxx dark light system colour color' },
  {
    section: 'appearance',
    titleKey: 'settingsPage.autoStart.title',
    descKey: 'settingsPage.index.autoStart.desc',
    aliases: 'autostart auto start login item startup boot'
  },
  {
    section: 'appearance',
    titleKey: 'settingsPage.autoStart.hidden.title',
    descKey: 'settingsPage.index.startHidden.desc',
    aliases: 'autostart hidden headless tray dock'
  },
  {
    section: 'appearance',
    titleKey: 'settingsPage.security.accessWrite.title',
    descKey: 'settingsPage.index.accessWrite.desc',
    aliases: 'access write authorized keys revoke'
  },
  {
    section: 'appearance',
    titleKey: 'settingsPage.vault.touchId.title',
    descKey: 'settingsPage.index.touchId.desc',
    aliases: 'biometrics touchid fingerprint face id unlock'
  },
  {
    section: 'appearance',
    titleKey: 'settings.language.title',
    descKey: 'settingsPage.index.language.desc',
    aliases: 'language locale translation chinese french spanish german 中文 français español deutsch'
  },
  { section: 'appearance', titleKey: 'settingsPage.appearance.compact.title', descKey: 'settingsPage.index.compact.desc', aliases: 'dense spacing compact size' },
  // Terminal
  {
    section: 'terminal',
    titleKey: 'settingsPage.terminal.scheme.title',
    descKey: 'settingsPage.index.colourScheme.desc',
    aliases: 'color colours palette theme solarized dracula nord gruvbox one dark iterm'
  },
  {
    section: 'terminal',
    titleKey: 'settingsPage.terminal.shellIntegration.title',
    descKey: 'settingsPage.index.shellIntegration.desc',
    aliases: 'osc 133 prompt marks shell integration zsh bash fish exit status'
  },
  {
    section: 'terminal',
    titleKey: 'settingsPage.terminal.clickToMove.title',
    descKey: 'settingsPage.index.clickToMove.desc',
    aliases: 'mouse click cursor position move caret cmux'
  },
  { section: 'terminal', titleKey: 'settingsPage.terminal.fontFamily.title', descKey: 'settingsPage.terminal.fontFamily.desc', aliases: 'typeface monospace' },
  { section: 'terminal', titleKey: 'settingsPage.terminal.fontSize.title', descKey: 'settingsPage.index.fontSize.desc', aliases: 'zoom bigger smaller text size' },
  { section: 'terminal', titleKey: 'settingsPage.terminal.cursorBlink.title', descKey: 'settingsPage.terminal.cursorBlink.desc', aliases: 'caret' },
  {
    section: 'terminal',
    titleKey: 'settingsPage.terminal.localTarget.title',
    descKey: 'settingsPage.index.localTarget.desc',
    // What someone types when they want this off: the words they know the
    // feature by, not the words the row happens to use.
    aliases: 'local terminal this machine localhost kill switch disable local shell docker kubernetes files own computer'
  },
  // Shortcuts
  {
    section: 'shortcuts',
    titleKey: 'settingsPage.shortcuts.hiddenWorkspaces.title',
    descKey: 'settingsPage.index.hiddenWorkspaces.desc',
    aliases: 'keyboard shortcut workspace switch'
  },
  // Editor
  { section: 'editor', titleKey: 'settingsPage.editor.external.title', descKey: 'settingsPage.index.externalEditor.desc', aliases: 'vscode vim editor open with' },
  { section: 'editor', titleKey: 'settingsPage.editor.openExternally.title', descKey: 'settingsPage.index.openExternally.desc', aliases: 'editor default double click' },
  // Monitoring — the reported one, and its neighbours.
  {
    section: 'monitoring',
    titleKey: 'settingsPage.monitoring.alerts.title',
    descKey: 'settingsPage.index.alerts.desc',
    aliases: 'notifications alarms warnings turn off alerts'
  },
  {
    section: 'monitoring',
    titleKey: 'settingsPage.monitoring.threshold.title',
    descKey: 'settingsPage.index.threshold.desc',
    aliases: 'percent percentage cpu memory limit'
  },
  {
    section: 'monitoring',
    titleKey: 'settingsPage.monitoring.background.title',
    descKey: 'settingsPage.index.background.desc',
    // The reported miss. "Background checking" is this app's own name for it
    // everywhere except the row itself.
    aliases:
      'background checking background checks background check checking servers polling poll sampler sampling fleet monitor while closed'
  },
  {
    section: 'monitoring',
    titleKey: 'settingsPage.monitoring.howOften.title',
    descKey: 'settingsPage.index.howOften.desc',
    aliases: 'interval frequency cadence background checking schedule poll'
  },
  { section: 'monitoring', titleKey: 'settings.webhooks.title', descKey: 'settingsPage.index.webhook.desc', aliases: 'slack discord http post integration' },
  { section: 'monitoring', titleKey: 'settings.webhooks.url.title', descKey: 'settingsPage.index.webhookUrl.desc', aliases: 'slack discord endpoint url' },
  { section: 'monitoring', titleKey: 'settings.webhooks.test.title', descKey: 'settingsPage.index.webhookTest.desc', aliases: 'webhook test try' },
  { section: 'monitoring', titleKey: 'settings.webhooks.resolved.title', descKey: 'settingsPage.index.webhookRecover.desc', aliases: 'webhook recovery resolved clear' },
  { section: 'monitoring', titleKey: 'settingsPage.monitoring.strip.title', descKey: 'settingsPage.index.strip.desc', aliases: 'strip docked graphs charts' },
  // SSH
  {
    section: 'ssh',
    titleKey: 'settings.sshSessions.keep.title',
    descKey: 'settingsPage.index.keepAuth.desc',
    aliases: 'reuse multiplexing idle timeout 2fa two factor re-auth'
  },
  { section: 'ssh', titleKey: 'settings.sshSessions.shared.title', descKey: 'settingsPage.index.sharedConnections.desc', aliases: 'sessions open connections multiplex' },
  {
    section: 'ssh',
    titleKey: 'settingsPage.ssh.jobsDetached.title',
    descKey: 'settingsPage.index.jobsDetached.desc',
    aliases: 'detached nohup background jobs apt dpkg'
  },
  // Security
  // `titleKey` must be the key the rendered `.s-title` uses — the contract at
  // the top of this list. `lock` stays in the aliases: it is what people will
  // search for, and it is still what the control eventually leads to.
  { section: 'monitoring', titleKey: 'settingsPage.monitoring.dbSize.title', descKey: 'settingsPage.index.dbSize.desc', aliases: 'database size sampler growth disk history' },
  { section: 'security', titleKey: 'settingsPage.vault.autoLock.title', descKey: 'settingsPage.index.autoLock.desc', aliases: 'vault auto lock secure timeout idle' },
  { section: 'security', titleKey: 'settingsPage.knownHosts.title', descKey: 'settingsPage.index.knownHosts.desc', aliases: 'known hosts fingerprint host key mismatch' },
  { section: 'security', titleKey: 'settingsPage.index.keychain.title', descKey: 'settingsPage.index.keychain.desc', aliases: 'keychain secrets password storage' },
  { section: 'security', titleKey: 'settingsPage.index.autoLockWorkspaces.title', descKey: 'settingsPage.index.autoLockWorkspaces.desc', aliases: 'workspace lock idle' },
  { section: 'security', titleKey: 'settingsPage.index.confirmDestructive.title', descKey: 'settingsPage.index.confirmDestructive.desc', aliases: 'confirmation dangerous guard' },
  { section: 'security', titleKey: 'settingsPage.credProxy.heading', descKey: 'settingsPage.index.credProxy.desc', aliases: 'proxy token api key injection' },
  // Backup
  { section: 'backup', titleKey: 'settingsPage.backup.heading', descKey: 'settingsPage.backup.sub', aliases: 'export import archive restore snapshot' },
  // Modules
  { section: 'modules', titleKey: 'settingsPage.modules.heading', descKey: 'settingsPage.index.modules.desc', aliases: 'features enable disable subsystem' },
  // Advanced
  {
    section: 'advanced',
    titleKey: 'settingsPage.debug.title',
    descKey: 'settingsPage.index.debug.desc',
    aliases: 'debug log logging trace verbose bug report troubleshoot diagnose capture record'
  },
  {
    section: 'advanced',
    titleKey: 'settingsPage.diagnostics.title',
    descKey: 'settingsPage.index.diagnostics.desc',
    aliases: 'bug report diagnostics support logs crash troubleshoot issue version paste'
  }
]

/**
 * Every word of the query has to appear somewhere in the entry.
 *
 * Deliberately not fuzzy. A typo-tolerant matcher is a pile of scoring nobody
 * can predict, and the failure it prevents ("bakcground") is rarer than the one
 * it causes: a query that quietly matches something else. Token containment
 * means "background checks" finds the row whose aliases say "background
 * checks", and "check servers" finds the row whose title says both words.
 *
 * The English title is in the haystack in every language, beside the
 * translated one, for the same reason the aliases are English.
 */
function settingMatches(entry: SettingEntry, query: string): boolean {
  const hay = [
    currentT(entry.titleKey),
    currentT(entry.descKey),
    englishT(entry.titleKey),
    entry.aliases ?? '',
    currentT(SECTION_META[entry.section].labelKey)
  ]
    .join(' ')
    .toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every((w) => hay.includes(w))
}

/** Matching entries, each with its title in the current language. */
export function searchSettings(query: string): (SettingEntry & { title: string })[] {
  if (!query.trim()) return []
  return SETTING_INDEX.filter((e) => settingMatches(e, query)).map((e) => ({
    ...e,
    title: currentT(e.titleKey)
  }))
}

/**
 * A toggle backed by real, persisted state. The only kind this panel has.
 *
 * There used to be a second one, `Toggle`, which held its value in local
 * `useState` and reached nothing — placeholder UI from the original mock that
 * five settings were still wired to years later. It looked identical to this
 * one, so the only way to discover a setting did nothing was to set it, close
 * the pane and watch it snap back. That is what issue #35 reported about the
 * terminal's font family. Every control in here now writes to the store; a new
 * one that does not is a bug, not a placeholder.
 */
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
      <Switch checked={checked} label={label} onChange={onChange} />
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
  const t = useT()
  const [state, setState] = useState<AutoStartState | null>(null)

  useEffect(() => {
    void window.opsmaxx!.autoStart.get().then(setState)
  }, [])

  if (!state) return null

  if (!state.supported) {
    return (
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settingsPage.autoStart.title')}</div>
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
        label={t('settingsPage.autoStart.title')}
        desc={t('settingsPage.autoStart.desc')}
        checked={state.openAtLogin}
        onChange={(v) => set({ openAtLogin: v })}
      />
      {state.openAtLogin && state.hiddenSupported && (
        <SettingSwitch
          label={t('settingsPage.autoStart.hidden.title')}
          desc={t('settingsPage.autoStart.hidden.desc')}
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
  const t = useT()
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
        <span className="grow">{t('settingsPage.sampler.vaultLocked')}</span>
        <UnlockVaultButton reason={t('settingsPage.sampler.unlockReason')} />
      </div>
    )
  }
  if (status.idleReason === 'no-targets') {
    return (
      <div className="s-desc warn">{t('settingsPage.sampler.noTargets')}</div>
    )
  }
  // Enabled, targets, vault open — and still not looping. Said plainly,
  // because the alternative is a settings screen that affirms everything is
  // fine while nothing has been sampled for hours.
  if (!status.running) {
    // No longer "turn this off and on again". That was a workaround for a
    // missing wire — unlocking the vault did not re-arm the sampler — and
    // telling someone to power-cycle a feature is an admission, not an
    // instruction. Unlock now resumes checking on its own, so reaching this
    // state means something genuinely unexpected and the honest thing is to
    // say so rather than to prescribe a ritual.
    return (
      <div className="s-desc danger">
        {status.lastSweepAt
          ? t('settingsPage.sampler.stalledSince', { duration: duration(status.lastSweepAt) })
          : t('settingsPage.sampler.stalledNever')}
      </div>
    )
  }

  const count = status.targetCount
  return (
    <div className="s-desc ok">
      {status.lastSweepAt
        ? t('settingsPage.sampler.running', {
            count,
            ago: duration(status.lastSweepAt),
            took: sweepDuration(status.lastSweepMs)
          })
        : t('settingsPage.sampler.runningFirst', { count })}
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
  const t = useT()
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
          <div className="s-title">{t('settingsPage.knownHosts.title')}</div>
          <div className="s-desc">
            {hosts.length
              ? t('settingsPage.knownHosts.descSome')
              : t('settingsPage.knownHosts.descNone')}
          </div>
        </div>
        <button className="btn sm" onClick={load}>
          {t('common.refresh')}
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
              {t('settingsPage.knownHosts.stale.title', { count: stale.length })}
            </div>
            <div className="s-desc">
              <Trans i18nKey="settingsPage.knownHosts.stale.desc" components={{ br: <br /> }} />
            </div>
          </div>
          <button
            className="btn sm danger"
            onClick={async () => {
              for (const h of stale) await window.opsmaxx?.knownHosts.forget(h.id)
              toast(t('settingsPage.knownHosts.stale.removedToast', { count: stale.length }), 'ok')
              load()
            }}
          >
            {t('settingsPage.knownHosts.stale.remove', { count: stale.length })}
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
              toast(t('settingsPage.knownHosts.forgotToast', { host: h.id }), 'ok')
              load()
            }}
          >
            {t('settingsPage.knownHosts.forget')}
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
  const t = useT()
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
    await useVaultPrompt.getState().request(t('settingsPage.vault.unlockReason'))
    void refresh()
  }

  return (
    <div className="setting-row">
      <div className="s-info">
        <div className="s-title">
          {unlocked ? <LockOpen size={13} /> : <Lock size={13} />}{' '}
          {exists === null
            ? t('settingsPage.vault.checking')
            : !exists
              ? t('settingsPage.vault.none')
              : unlocked
                ? t('settingsPage.vault.unlocked')
                : t('settingsPage.vault.locked')}
        </div>
        <div className="s-desc">
          {exists === null
            ? t('settingsPage.vault.checkingDesc')
            : !exists
            ? t('settingsPage.vault.noneDesc')
            : unlocked
              ? t('settingsPage.vault.unlockedDesc')
              : t('settingsPage.vault.lockedDesc')}
        </div>
      </div>
      {exists === null ? null : !exists ? (
        <button className="btn sm" onClick={() => setActivity('vault')}>
          {t('settingsPage.vault.setUp')}
        </button>
      ) : unlocked ? (
        <button className="btn sm" onClick={() => void useVault.getState().lock()}>
          <Lock size={13} /> {t('settingsPage.vault.lockNow')}
        </button>
      ) : (
        <button className="btn sm primary" onClick={() => void unlock()}>
          <LockOpen size={13} /> {t('settingsPage.vault.unlock')}
        </button>
      )}
    </div>
  )
}

/**
 * What to paste into a bug report.
 *
 * The text is assembled in main (services/diagnostics.ts) and shown here in
 * full, because there is nothing in it to withhold: versions, inventory COUNTS,
 * and feature state as on/off. No server, workspace or database names, no
 * hostnames or addresses, no usernames, no paths, nothing from the vault, and no
 * output from any remote host. That is what makes a preview the right control —
 * the user reads exactly what they are about to post, rather than trusting a
 * promise about a file they cannot see.
 *
 * This panel passes no crash block, so that list is exact here. The crash screen
 * does pass one, and an error message it did not author can carry a hostname no
 * redaction rule can recognise — so it shows its own preview for the same
 * reason, and says what the cleaning does and does not cover.
 *
 * Nothing is written to disk, and there is deliberately no Save button: a
 * persistent copy of this would be a file with its own permissions, lifetime and
 * retention questions, in exchange for a paragraph of text the clipboard already
 * carries.
 */
/**
 * The recording's status, its size, and the button that deletes it.
 *
 * NOT the way anybody starts one. That is the bug icon in the left rail, which
 * is on screen in every view and whose dialog has a Start recording button in
 * step 1 — see ReportBugModal.tsx for why it has to be there and not here.
 * Reporting a bug that began with "first find Settings → Advanced" is the
 * failure this whole feature was built against, and a recording that could only
 * be started from this page would have reinstated it one screen later.
 *
 * What this page is for is the question you come looking for an answer to: is
 * it still running, how big has it got, and how do I get rid of it. The switch
 * stays because a thing that can be turned on has to be turnable off from the
 * place that lists what is on.
 *
 * The description says what is recorded in the same words the dialog does. It
 * cannot promise what the panel below promises: that payload is versions and
 * counts, this one is error text, and an error names what it failed to reach.
 * See src/main/services/debugLog.ts.
 */
function DebugPanel(): React.JSX.Element {
  const t = useT()
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const [status, setStatus] = useState<DebugStatus | null>(null)

  const refresh = useCallback((): void => {
    const api = window.opsmaxx?.debug
    if (!bridgeHas(api as Record<string, unknown> | undefined, 'status')) return
    void api
      ?.status()
      .then(setStatus)
      .catch(() => {
        /* nothing to show; the size line stays hidden */
      })
  }, [])

  useEffect(refresh, [refresh, settings.debugLogEnabled])

  const kb = status === null ? 0 : Math.round(status.bytes / 1024)

  return (
    <>
      <SettingSwitch
        label={t('settingsPage.debug.title')}
        desc={t('settingsPage.debug.desc')}
        checked={settings.debugLogEnabled === true}
        onChange={(v) => setSettings({ debugLogEnabled: v })}
      />
      {status !== null && status.bytes > 0 && (
        <div className="setting-row">
          <div className="s-info">
            <div className="s-title">{t('settingsPage.debug.traceTitle')}</div>
            <div className="s-desc">
              {status.events > 0
                ? t(
                    status.truncated
                      ? 'settingsPage.debug.traceEventsSizeCapped'
                      : 'settingsPage.debug.traceEventsSize',
                    { events: status.events, kb }
                  )
                : t(status.truncated ? 'settingsPage.debug.traceSizeCapped' : 'settingsPage.debug.traceSize', {
                    kb
                  })}
            </div>
          </div>
          <button
            className="btn sm"
            onClick={() => {
              const api = window.opsmaxx?.debug
              if (!bridgeHas(api as Record<string, unknown> | undefined, 'delete')) return
              void api?.delete().then(refresh)
              toast(t('settingsPage.debug.deletedToast'))
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      )}
    </>
  )
}

function DiagnosticsPanel(): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    const api = window.opsmaxx?.diagnostics
    if (!bridgeHas(api as Record<string, unknown> | undefined, 'text')) return
    let live = true
    void api
      ?.text()
      .then((report) => {
        if (live) setText(report)
      })
      .catch(() => {
        /* nothing to show; the Copy button stays disabled */
      })
    return () => {
      live = false
    }
  }, [])

  return (
    <>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settingsPage.diagnostics.title')}</div>
          <div className="s-desc">{t('settingsPage.diagnostics.desc')}</div>
        </div>
        <button
          className="btn sm"
          disabled={text === null}
          onClick={() => {
            if (text === null) return
            window.opsmaxx?.clipboard.write(text)
            toast(t('settingsPage.diagnostics.copiedToast'))
          }}
        >
          {t('common.copy')}
        </button>
      </div>
      <pre className="paste-preview">{text ?? t('settingsPage.diagnostics.collecting')}</pre>
    </>
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
  const t = useT()

  // The search box, and the row a result asked for.
  //
  // Reported from the running app: "there is no background checking settings
  // and no way to search it in the monitoring settings panel". See
  // SETTING_INDEX for why both halves of that are true.
  const [query, setQuery] = useState('')
  const [jumpTo, setJumpTo] = useState<MessageKey | null>(null)
  const results = searchSettings(query)

  // Landing on the section is most of the answer; landing on the ROW is the
  // rest of it, and Monitoring is long enough that the difference matters —
  // this is the page whose bottom half was unreachable at all until the scroll
  // fix, and the reported setting sits below the fold on a short window.
  //
  // Found by title text rather than by threading a ref through forty rows in
  // six components, only one of which this change is allowed to touch. The
  // trade is that a renamed label silently stops jumping — which is why
  // SETTING_INDEX says, at its `titleKey` field, that the two are the same key.
  useEffect(() => {
    if (!jumpTo) return undefined
    const wanted = t(jumpTo)
    const title = [...document.querySelectorAll('.settings-content .s-title')].find(
      (el) => el.textContent?.trim() === wanted
    )
    const row = title?.closest('.setting-row')
    if (!row) return undefined
    row.classList.add('setting-hit')
    // Absent in jsdom, and a missing scroll is not worth an exception in a
    // renderer.
    row.scrollIntoView?.({ block: 'center' })
    const timer = setTimeout(() => row.classList.remove('setting-hit'), 2600)
    return () => {
      clearTimeout(timer)
      row.classList.remove('setting-hit')
    }
  }, [jumpTo, section, t])

  return (
    <div className="main">
      <div className="settings">
        <nav className="settings-nav">
          <input
            className="input settings-search"
            type="search"
            placeholder={t('settingsPage.search.label')}
            aria-label={t('settingsPage.search.label')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() !== '' && (
            <div className="settings-results" role="listbox" aria-label={t('settingsPage.search.results')}>
              {results.length === 0 ? (
                // Said, rather than an empty box that looks broken.
                <div className="field-hint" style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
                  {t('settingsPage.search.noMatch')}
                </div>
              ) : (
                results.map((e) => (
                  <button
                    key={`${e.section}:${e.titleKey}`}
                    className="nav-item result"
                    role="option"
                    onClick={() => {
                      setSection(e.section)
                      setJumpTo(e.titleKey)
                      // Clearing it puts the section list back, which is where
                      // the user now is. A result list left standing over the
                      // page they just jumped to is a second thing to dismiss.
                      setQuery('')
                    }}
                  >
                    <span className="result-title">{e.title}</span>
                    <span className="result-section">{t(SECTION_META[e.section].labelKey)}</span>
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
              {t(SECTION_META[id].labelKey)}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'general' && <UpdatePanel />}

          {section === 'general' && (
            <div className="settings-section">
              <h2>{t('settingsPage.walkthrough.heading')}</h2>
              <div className="sub">{t('settingsPage.walkthrough.sub')}</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.walkthrough.title')}</div>
                  <div className="s-desc">{t('settingsPage.walkthrough.desc')}</div>
                </div>
                <button className="btn sm" onClick={() => startTour()}>
                  <Compass size={13} /> {t('settingsPage.walkthrough.start')}
                </button>
              </div>
            </div>
          )}

          {section === 'appearance' && (
            <div className="settings-section">
              <h2>{t('settingsPage.appearance.heading')}</h2>
              <div className="sub">{t('settingsPage.appearance.sub')}</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.appearance.theme.title')}</div>
                  <div className="s-desc">{t('settingsPage.appearance.theme.desc')}</div>
                </div>
                <div className="segment">
                  {THEME_OPTIONS.map(([mode, labelKey]) => (
                    <button
                      key={mode}
                      className={clsx('seg-btn', theme === mode && 'active')}
                      onClick={() => setTheme(mode)}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settings.language.title')}</div>
                  <div className="s-desc">{t('settings.language.desc')}</div>
                </div>
                <select
                  className="select"
                  style={{ width: 220 }}
                  value={parseLanguagePref(settings.language)}
                  onChange={(e) => setSettings({ language: parseLanguagePref(e.target.value) })}
                >
                  <option value="system">{t('settings.language.system')}</option>
                  {/* Each in its own language, never translated: someone who
                      cannot read the current one is looking for theirs. */}
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_NAMES[l]}
                    </option>
                  ))}
                  {import.meta.env.DEV && <option value={PSEUDO_LOCALE}>{LOCALE_NAMES[PSEUDO_LOCALE]}</option>}
                </select>
              </div>
              <AutoStartSetting />
              <SettingSwitch
                label={t('settingsPage.appearance.compact.title')}
                desc={t('settingsPage.appearance.compact.desc')}
                checked={settings.compactDensity}
                onChange={(v) => setSettings({ compactDensity: v })}
              />
            </div>
          )}

          {section === 'terminal' && (
            <div className="settings-section">
              <h2>{t('settingsPage.terminal.heading')}</h2>
              <div className="sub">{t('settingsPage.terminal.sub')}</div>
              <SettingSwitch
                label={t('settingsPage.terminal.closeOnExit.title')}
                desc={t('settingsPage.terminal.closeOnExit.desc')}
                checked={settings.closeTabOnShellExit !== false}
                onChange={(v) => setSettings({ closeTabOnShellExit: v })}
              />
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.terminal.fontFamily.title')}</div>
                  <div className="s-desc">{t('settingsPage.terminal.fontFamily.desc')}</div>
                </div>
                <select
                  className="select"
                  style={{ width: 220 }}
                  value={settings.terminalFontFamily}
                  onChange={(e) => setSettings({ terminalFontFamily: e.target.value })}
                >
                  <option value="">{t('settingsPage.terminal.fontFamily.appDefault')}</option>
                  <option value="JetBrains Mono">JetBrains Mono</option>
                  <option value="SF Mono">SF Mono</option>
                  <option value="Cascadia Code">Cascadia Code</option>
                  <option value="Menlo">Menlo</option>
                </select>
              </div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.terminal.fontSize.title')}</div>
                  <div className="s-desc">
                    <Trans i18nKey="settingsPage.terminal.fontSize.desc" components={{ b: <b /> }} />
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
                    {t('common.reset')}
                  </button>
                </div>
              </div>
              <div className="setting-row wrap">
                <div className="s-info">
                  <div className="s-title" id="terminal-scheme-title">
                    {t('settingsPage.terminal.scheme.title')}
                  </div>
                  <div className="s-desc">{t('settingsPage.terminal.scheme.desc')}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
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
                        toast(t('settingsPage.terminal.scheme.added', { name: parsed.scheme.name }), 'ok')
                      })()
                    }}
                  >
                    {t('settingsPage.terminal.scheme.import')}
                  </button>
                </div>
                <SchemePicker
                  value={settings.terminalScheme}
                  custom={settings.terminalCustomSchemes}
                  onChange={(id) => setSettings({ terminalScheme: id })}
                  labelledBy="terminal-scheme-title"
                />
              </div>
              <SettingSwitch
                label={t('settingsPage.terminal.cursorBlink.title')}
                desc={t('settingsPage.terminal.cursorBlink.desc')}
                checked={settings.terminalCursorBlink !== false}
                onChange={(v) => setSettings({ terminalCursorBlink: v })}
              />
              <SettingSwitch
                label={t('settingsPage.terminal.osc52.title')}
                desc={t('settingsPage.terminal.osc52.desc')}
                checked={settings.terminalOsc52 !== false}
                onChange={(v) => setSettings({ terminalOsc52: v })}
              />
              <SettingSwitch
                label={t('settingsPage.terminal.shellIntegration.title')}
                desc={t('settingsPage.terminal.shellIntegration.desc')}
                checked={settings.shellIntegration === true}
                onChange={(v) => setSettings({ shellIntegration: v })}
              />
              <SettingSwitch
                label={t('settingsPage.terminal.clickToMove.title')}
                desc={t('settingsPage.terminal.clickToMove.desc')}
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
                label={t('settingsPage.terminal.localTarget.title')}
                desc={t('settingsPage.terminal.localTarget.desc')}
                checked={settings.localTerminalEnabled !== false}
                onChange={(v) => setSettings({ localTerminalEnabled: v })}
              />
            </div>
          )}

          {section === 'shortcuts' && (
            <div className="settings-section">
              <h2>{t('settingsPage.shortcuts.heading')}</h2>
              <div className="sub">{t('settingsPage.shortcuts.sub')}</div>
              <SettingSwitch
                label={t('settingsPage.shortcuts.hiddenWorkspaces.title')}
                desc={t('settingsPage.shortcuts.hiddenWorkspaces.desc')}
                checked={settings.switchHiddenWorkspaces}
                onChange={(v) => setSettings({ switchHiddenWorkspaces: v })}
              />
              <ShortcutManager />
            </div>
          )}

          {section === 'editor' && (
            <div className="settings-section">
              <h2>{t('settingsPage.editor.heading')}</h2>
              <div className="sub">{t('settingsPage.editor.sub')}</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.editor.external.title')}</div>
                  <div className="s-desc">
                    <Trans i18nKey="settingsPage.editor.external.desc" components={{ code: <code /> }} />
                  </div>
                </div>
                <input
                  className="input"
                  style={{ width: 180 }}
                  placeholder={t('settingsPage.editor.external.placeholder')}
                  value={settings.externalEditorCommand}
                  onChange={(e) => setSettings({ externalEditorCommand: e.target.value })}
                />
              </div>
              <SettingSwitch
                label={t('settingsPage.editor.openExternally.title')}
                desc={t('settingsPage.editor.openExternally.desc')}
                checked={settings.openFilesExternally}
                onChange={(v) => setSettings({ openFilesExternally: v })}
              />
            </div>
          )}

          {section === 'modules' && (
            <>
              <h2>{t('settingsPage.modules.heading')}</h2>
              <p className="muted">{t('settingsPage.modules.intro')}</p>
              {/* A module added by an update is off until you switch it on,
                  even though a new install would have it on. An upgrade is not
                  consent — see backfillModules. */}
              <p className="muted">{t('settingsPage.modules.addedByUpdate')}</p>
              {/* Grouped by what a module DOES to a server, which is the one
                  division this registry already commits to: `surface` is
                  load-bearing, and "nothing on a read surface may write to a
                  server" is the contract it exists to hold. Twenty-one switches in
                  one undifferentiated list made the two halves look like the same
                  kind of decision, and they are not — one adds a panel, the other
                  adds a way to change somebody's infrastructure.
                  A third group is broken out first: the four modules that have
                  their own icon in the activity bar, because switching one off here
                  makes a rail icon disappear, which is a bigger visible change than
                  any other row on this page and should not be buried among them. */}
              {MODULE_GROUPS.map((g) => {
                const rows = MODULES.filter(g.match)
                if (rows.length === 0) return null
                return (
                  <div key={g.id} className="settings-group">
                    <h3 className="settings-group-title">{t(g.labelKey)}</h3>
                    <p className="muted settings-group-detail">{t(g.detailKey)}</p>
                    {rows.map((m) => (
                      <div className="setting-row" key={m.id}>
                        <div className="s-info">
                          <div className="s-title">{t(m.labelKey)}</div>
                          <div className="s-desc">{t(m.detailKey)}</div>
                        </div>
                        <Switch
                          checked={moduleEnabled(settings.modules, m.id)}
                          label={t(m.labelKey)}
                          onChange={(v) =>
                            setSettings({ modules: { ...settings.modules, [m.id]: v } })
                          }
                        />
                      </div>
                    ))}
                  </div>
                )
              })}
            </>
          )}

          {section === 'monitoring' && (
            <div className="settings-section">
              <h2>{t('settingsPage.monitoring.heading')}</h2>
              <div className="sub">{t('settingsPage.monitoring.sub')}</div>
              {/* The settings KEY stays `resourceAlertsEnabled` so saved settings
                  still load, but the label was only ever half true: this switch
                  gates checkUnitAlerts as well as checkResourceAlerts, and every
                  webhook is posted from inside one of the two. */}
              <SettingSwitch
                label={t('settingsPage.monitoring.alerts.title')}
                desc={t('settingsPage.monitoring.alerts.desc')}
                checked={settings.resourceAlertsEnabled}
                onChange={(v) => setSettings({ resourceAlertsEnabled: v })}
              />
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.monitoring.threshold.title')}</div>
                  <div className="s-desc">
                    <Trans
                      i18nKey="settingsPage.monitoring.threshold.desc"
                      components={{ strong: <strong /> }}
                    />{' '}
                    {alertCoverageText(fleetStatus?.running, settings.fleetSamplingEnabled)}
                  </div>
                </div>
                <div className="segment">
                  {[70, 80, 90, 95].map((pct) => (
                    <button
                      key={pct}
                      className={clsx('seg-btn', settings.resourceAlertThreshold === pct && 'active')}
                      disabled={!settings.resourceAlertsEnabled}
                      onClick={() => setSettings({ resourceAlertThreshold: pct })}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>
              {/* Not SettingSwitch: this row needs the sampler's real state
                  under the description, and the switch component owns its own
                  desc. Same markup, so it stays visually identical. */}
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.monitoring.background.title')}</div>
                  <div className="s-desc">{t('settingsPage.monitoring.background.desc')}</div>
                  {/* Stated before the switch is touched rather than after,
                      because this is the cost of turning it on and the whole
                      point is that it used to happen invisibly. */}
                  <div className="s-desc">
                    <Trans
                      i18nKey="settingsPage.monitoring.background.keepAlive"
                      components={{ strong: <strong /> }}
                    />
                  </div>
                  <FleetSamplerLine />
                </div>
                <Switch
                  checked={settings.fleetSamplingEnabled}
                  label={t('settingsPage.monitoring.background.title')}
                  onChange={(v) => setSettings({ fleetSamplingEnabled: v })}
                />
              </div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.monitoring.howOften.title')}</div>
                  <div className="s-desc">{t('settingsPage.monitoring.howOften.desc')}</div>
                </div>
                <div className="segment">
                  {[
                    { ms: 60_000, min: 1 },
                    { ms: 120_000, min: 2 },
                    { ms: 300_000, min: 5 },
                    { ms: 900_000, min: 15 }
                  ].map((o) => (
                    <button
                      key={o.ms}
                      className={clsx('seg-btn', settings.fleetSamplingIntervalMs === o.ms && 'active')}
                      disabled={!settings.fleetSamplingEnabled}
                      onClick={() => setSettings({ fleetSamplingIntervalMs: o.ms })}
                    >
                      {t('settingsPage.monitoring.howOften.minutes', { n: o.min })}
                    </button>
                  ))}
                </div>
              </div>
              <SettingSwitch
                label={t('settingsPage.monitoring.dbSize.title')}
                desc={t('settingsPage.monitoring.dbSize.desc')}
                checked={settings.dbSizeSamplingEnabled}
                onChange={(v) => setSettings({ dbSizeSamplingEnabled: v })}
              />
              <WebhookAlertSettings />
              <SettingSwitch
                label={t('settingsPage.monitoring.strip.title')}
                desc={t('settingsPage.monitoring.strip.desc')}
                checked={settings.showMonitorStrip}
                onChange={(v) => setSettings({ showMonitorStrip: v })}
              />
            </div>
          )}

          {section === 'ssh' && (
            <div className="settings-section">
              <h2>{t('settingsPage.ssh.heading')}</h2>
              <div className="sub">{t('settingsPage.ssh.sub')}</div>
              <SshSessions />
              {/* Spelled out rather than summarised, because it is the one
                  setting here that decides whether OpsMaxx writes anything
                  to your machines. An operator is owed the exact list, and the
                  honest description of what turning it OFF costs — which is not
                  "less is written", it is "a long command dies with the
                  connection, and apt and dpkg do not survive that". */}
              <SettingSwitch
                label={t('settingsPage.ssh.jobsDetached.title')}
                desc={t('shared.jobs.detachedSettingNote')}
                checked={settings.jobsDetached !== false}
                onChange={(v) => setSettings({ jobsDetached: v })}
              />

              <h3>{t('settingsPage.ssh.agent.heading')}</h3>
              <div className="sub">{t('settingsPage.ssh.agent.sub')}</div>
              <AgentPanel />
            </div>
          )}

          {section === 'backup' && (
            <div className="settings-section">
              <h2>{t('settingsPage.backup.heading')}</h2>
              <div className="sub">{t('settingsPage.backup.sub')}</div>
              <BackupPanel />
            </div>
          )}

          {section === 'security' && (
            <div className="settings-section">
              <h2>{t('settingsPage.vault.heading')}</h2>
              <div className="sub">{t('settingsPage.vault.sub')}</div>
              <VaultState />
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.vault.autoLock.title')}</div>
                  <div className="s-desc">{t('settingsPage.vault.autoLock.desc')}</div>
                </div>
                <select
                  className="input"
                  style={{ maxWidth: 160 }}
                  value={settings.vaultAutoLockMinutes}
                  onChange={(e) => setSettings({ vaultAutoLockMinutes: Number(e.target.value) })}
                >
                  {[5, 15, 30].map((m) => (
                    <option key={m} value={m}>
                      {t('settingsPage.vault.autoLock.minutes', { count: m })}
                    </option>
                  ))}
                  <option value={60}>{t('settingsPage.vault.autoLock.oneHour')}</option>
                  <option value={0}>{t('common.never')}</option>
                </select>
              </div>
              <SettingSwitch
                label={t('settingsPage.vault.touchId.title')}
                desc={t('settingsPage.vault.touchId.desc')}
                checked={settings.vaultAutoBiometricPrompt}
                onChange={(v) => setSettings({ vaultAutoBiometricPrompt: v })}
              />
            </div>
          )}

          {/* Filed directly under the vault, because this is the list of what
              the vault is NOT protecting, and the two are only meaningful
              next to each other. */}
          {section === 'security' && (
            <div className="settings-section">
              <h2>{t('settingsPage.machineGrants.heading')}</h2>
              <div className="sub">{t('settingsPage.machineGrants.sub')}</div>
              <MachineGrants />
            </div>
          )}

          {section === 'security' && (
            <div className="settings-section">
              <h2>{t('settingsPage.security.heading')}</h2>
              <div className="sub">{t('settingsPage.security.sub')}</div>
              {/* Filed here rather than under Appearance, where it was. This
                  grants permission to rewrite authorized_keys on servers, and
                  a reader looking for it went to Security, found nothing, and
                  concluded the feature did not exist — which is exactly what
                  the screen that refuses without naming it also told them. */}
              <SettingSwitch
                label={t('settingsPage.security.accessWrite.title')}
                desc={t('shared.access.write.optInNote')}
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
                  <div className="s-title">{t('settingsPage.security.credentialStorage.title')}</div>
                  <div className="s-desc">{t('settingsPage.security.credentialStorage.desc')}</div>
                </div>
                <span className="pill ok">{t('settingsPage.security.credentialStorage.alwaysOn')}</span>
              </div>
            </div>
          )}

          {/* Roadmap item 7. It sits under Security rather than Connections
              because what it configures is where a stored credential is
              allowed to go, which is the same question the vault above
              answers for SSH. */}
          {section === 'security' && (
            <div className="settings-section">
              <h2>{t('settingsPage.credProxy.heading')}</h2>
              <div className="sub">{t('settingsPage.credProxy.sub')}</div>
              <CredProxyPanel />

              {/* The feature's one name. This heading said "addy" — the relay's
                  name — so the same feature was Sync on the rail, Sync &
                  devices on its page and addy here. */}
              <h3>{t('settingsPage.sync.heading')}</h3>
              <div className="sub">
                {t('settingsPage.sync.sub')}
                {moduleEnabled(settings.modules, 'addy') && (
                  <>
                    {' '}
                    <button className="linklike" onClick={() => openMonitor('addy')}>
                      {t('settingsPage.sync.open')}
                    </button>
                  </>
                )}
              </div>
              {/* Guards itself now. Unguarded, this was a second door to
                  minting an account on a machine that already has one — and
                  `createAccount` overwrites the account and the enrolment
                  file, so it silently took the device off the first one. */}
              <AddySetup />

              <h3>{t('settingsPage.import.heading')}</h3>
              <BitwardenImport />
            </div>
          )}

          {section === 'advanced' && (
            <div className="settings-section">
              <h2>{t('settingsPage.advanced.heading')}</h2>
              <div className="sub">{t('settingsPage.advanced.sub')}</div>
              <DebugPanel />
              <DiagnosticsPanel />
            </div>
          )}

          {/* The pages that render real content, and therefore must not also get
              the "Reset <section>" placeholder below.

              `modules` was missing from this list while rendering a full panel
              above, so that page showed its modules AND a stray Reset row whose
              button toasts "nothing to reset". `advanced` joins it now that it
              has content of its own. */}
          {![
            'general',
            'appearance',
            'terminal',
            'shortcuts',
            'security',
            'editor',
            'backup',
            'ssh',
            'monitoring',
            'modules',
            'advanced'
          ].includes(section) && (
            <div className="settings-section">
              <h2>{t(SECTION_META[section].labelKey)}</h2>
              <div className="sub">{t('settingsPage.placeholder.sub', { section })}</div>
              <div className="setting-row">
                <div className="s-info">
                  <div className="s-title">{t('settingsPage.placeholder.resetTitle', { section })}</div>
                  <div className="s-desc">{t('settingsPage.placeholder.resetDesc')}</div>
                </div>
                <button
                  className="btn sm"
                  onClick={() =>
                    toast(t('settingsPage.placeholder.nothingToReset', { section: t(SECTION_META[section].labelKey) }))
                  }
                >
                  {t('common.reset')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
