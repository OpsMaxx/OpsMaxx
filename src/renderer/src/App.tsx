import { useEffect, useRef, useState } from 'react'
import { useApp } from './store/app'
import { RevokedScreen } from './components/addy/RevokedScreen'
import { AgentApprovalWatcher } from './components/sshAgent/AgentApprovalWatcher'
import { ConflictChooser } from './components/addy/ConflictChooser'
import type { AddyRevocation } from '../../preload'
import { startBackupRunWatch } from './store/backupRuns'
import { clsx } from './lib/format'
import { initPersistence } from './store/persist'
import { startVaultLockWatch } from './store/vault'
import { useHotkeys } from './hooks/useHotkeys'
import { TitleBar } from './components/layout/TitleBar'
import { ActivityBar } from './components/layout/ActivityBar'
import { Sidebar } from './components/layout/Sidebar'
import { StatusBar } from './components/layout/StatusBar'
import { WorkspacePanel } from './components/panel/WorkspacePanel'
import { FleetMonitor } from './components/monitor/FleetMonitor'
import { TunnelsView } from './components/tunnels/TunnelsView'
import { HttpView } from './components/http/HttpView'
import { DatabaseWorkspace } from './components/databases/DatabaseView'
import { AddDatabaseModal } from './components/databases/AddDatabaseModal'
import { AddApiModal } from './components/http/AddApiModal'
import { Settings } from './components/settings/Settings'
import { VaultView } from './components/vault/VaultView'
import { AiPanel } from './components/ai/AiPanel'
import { ApprovalWatcher } from './components/ai/ApprovalWatcher'
import { AgentConfigWatcher } from './components/ai/AgentConfigWatcher'
import { FleetWatcher } from './components/monitor/FleetWatcher'
import { VaultUnlockModal } from './components/vault/VaultUnlockModal'
import { VaultWaitingPrompt } from './components/vault/VaultWaitingPrompt'
import { OnboardingTour } from './components/onboarding/OnboardingTour'
import { SetupCard } from './components/onboarding/SetupCard'
import { FeatureTipCard } from './components/onboarding/FeatureTipCard'
import { CliPairingBanner } from './components/ai/CliPairingBanner'
import { CommandPalette } from './components/palette/CommandPalette'
import { AddServerModal } from './components/connections/AddServerModal'
import { RouteEditor } from './components/connections/RouteEditor'
import { SshConfigImport } from './components/connections/SshConfigImport'
import { ReportBugModal } from './components/common/ReportBugModal'
import { SshPrompt } from './components/connections/SshPrompt'
import { VpnPromptModal } from './components/vpn/VpnPromptModal'
import { WorkspaceManager } from './components/workspace/WorkspaceManager'
import { WorkspaceUnlock } from './components/workspace/WorkspaceUnlock'
import { Toasts } from './components/common/Toasts'

// The connections panel stays mounted whatever the active view is: unmounting
// it would tear down every live terminal, so switching to Databases and back
// would drop running processes. Other views are cheap and mount on demand.
//
// The HTTP client is the second exception, for the same reason wearing a
// different hat. It holds an embedded API client with every collection loaded
// and whatever the user has typed into a request — headers, a body, a URL
// half-edited — none of which is saved anywhere until it is sent. Unmounting
// on the way to Terminals and back threw all of it away, which is a large part
// of why the client read as unusable.
function MainArea(): React.JSX.Element {
  const activity = useApp((s) => s.activity)
  const onConnections = activity === 'connections'
  const onHttp = activity === 'http'
  // Not mounted until first visited: the API client is the largest thing in
  // the renderer, and someone who never opens it should not pay to build it.
  const httpVisited = useRef(false)
  if (onHttp) httpVisited.current = true

  return (
    <>
      <div className={clsx('main-host', !onConnections && 'hidden')} aria-hidden={!onConnections}>
        <WorkspacePanel />
      </div>
      {activity === 'monitor' && <FleetMonitor />}
      {activity === 'databases' && <DatabaseWorkspace />}
      {/* One view, three tabs: SSH tunnels, VPN and frp reverse proxies. They
          are all "make a remote thing reachable from here", and splitting them
          across two activity icons would only make the user guess which one
          holds the thing they set up yesterday — so TunnelsView keeps them
          behind a single icon and switches between them in place. */}
      {activity === 'tunnels' && <TunnelsView />}
      {httpVisited.current && (
        <div className={clsx('main-host', !onHttp && 'hidden')} aria-hidden={!onHttp}>
          <HttpView />
        </div>
      )}
      {activity === 'vault' && <VaultView />}
      {activity === 'ai' && <AiPanel />}
      {activity === 'settings' && <Settings />}
    </>
  )
}

export default function App(): React.JSX.Element {
  useHotkeys()
  /**
   * Resolved before anything else renders.
   *
   * `undefined` means "not asked yet" and is deliberately distinct from `null`,
   * which means "asked, and this device is fine". Rendering the app while the
   * answer is unknown would show a sidebar full of server names for however
   * many milliseconds the IPC round trip takes, on precisely the machine that
   * is not supposed to see them again.
   */
  const [revocation, setRevocation] = useState<AddyRevocation | null | undefined>(undefined)
  useEffect(() => {
    const bridge = window.opsmaxx?.addy
    // No bridge at all (a build without one, or a test harness) is not a
    // revocation. Failing towards blocked here would brick every such build.
    if (!bridge) {
      setRevocation(null)
      return
    }
    // And listen, because a device can be removed while this window is open:
    // main wipes it there and then, and without this the app carries on
    // looking normal over a deleted estate until somebody relaunches — which
    // for a machine left running on a desk is never.
    const stop = bridge.onRevoked?.((t) => setRevocation(t as never))

    void bridge.revocation().then(
      (r) => setRevocation(r?.cleared ? null : r),
      () => setRevocation(null)
    )
    return stop
  }, [])
  const theme = useApp((s) => s.theme)
  const modal = useApp((s) => s.modal)
  const paletteOpen = useApp((s) => s.paletteOpen)

  useEffect(() => {
    void initPersistence()
  }, [])

  // App level, not inside the Vault view. Whatever is on screen when the vault
  // secures or locks, the decrypted entries this renderer is holding have to
  // go — see startVaultLockWatch for what leaving them behind meant.
  useEffect(() => startVaultLockWatch(), [])
  // App level, not panel level: a six-hourly backup almost never lands while
  // somebody is looking at the Backup page, and a run nobody heard about leaves
  // the warning up. See startBackupRunWatch.
  useEffect(() => startBackupRunWatch(), [])

  // Density is a root attribute so it can tighten every surface from CSS
  // rather than threading a prop through every component.
  const compact = useApp((s) => s.settings.compactDensity)
  useEffect(() => {
    document.documentElement.toggleAttribute('data-compact', compact)
  }, [compact])

  useEffect(() => {
    const apply = (mode: string): void => {
      const dark =
        mode === 'dark' ||
        (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    }
    apply(theme)
    window.opsmaxx?.theme.set(theme as 'dark' | 'light' | 'system')
  }, [theme])

  // Nothing at all rather than a flash of the app. The window is already
  // showing the shell's background at this point, and this resolves in one IPC
  // round trip.
  if (revocation === undefined) return <div className="app" />

  if (revocation) {
    return (
      <RevokedScreen
        state={revocation}
        onClear={async () => {
          await window.opsmaxx?.addy.clearRevocation()
          setRevocation(null)
        }}
      />
    )
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <ActivityBar />
        <Sidebar />
        <MainArea />
      </div>
      <StatusBar />

      {paletteOpen && <CommandPalette />}
      {modal === 'add-server' && <AddServerModal />}
      {modal === 'route-editor' && <RouteEditor />}
      {modal === 'workspaces' && <WorkspaceManager />}
      {modal === 'add-database' && <AddDatabaseModal />}
      {modal === 'add-api' && <AddApiModal />}
      {modal === 'import-ssh' && <SshConfigImport />}
      {modal === 'report-bug' && <ReportBugModal />}
      {/* Not a `modal` kind: the unlock prompt can appear over any view. */}
      <WorkspaceUnlock />
      {/* Can appear during any connection attempt, including SFTP and metrics. */}
      <SshPrompt />
      {/* Global, like SshPrompt: a VPN started from the Tunnels view can ask for
          an OTP long after the user has moved on to a terminal. */}
      <VpnPromptModal />
      {/* Surfaces an AI approval request no matter which tab is active. */}
      <ApprovalWatcher />
      {/* And an SSH agent signature request, for a stronger reason: the thing
          asking is almost never OpsMaxx. It is `git push` in a terminal, or
          ansible, or a script, so the user is looking at something else
          entirely. */}
      <AgentApprovalWatcher />
      {/* Two devices changed the same thing. Neither copy was thrown away and
          somebody has to choose, so it appears wherever they are. */}
      <ConflictChooser />
      <AgentConfigWatcher />
      <FleetWatcher />
      <VaultUnlockModal />
      {/* After FleetWatcher, and that order is load-bearing: this asks the
          sampler how many targets a shut vault is blocking, and FleetWatcher
          is what tells the sampler what to watch. Mount effects run in tree
          order, so the configure call is on its way before the question. */}
      <VaultWaitingPrompt />
      <SetupCard />
      <OnboardingTour />
      <FeatureTipCard />
      <CliPairingBanner />
      <Toasts />
    </div>
  )
}
