// Minimal stand-in for the `electron` module so the main-process services
// under test can run outside a real Electron process. userData resolves to a
// fresh temp directory per test file, the same way portable.ts redirects it
// to a folder beside the executable — the services under test never know the
// difference, which is exactly the property portable mode relies on.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userDataDir = mkdtempSync(join(tmpdir(), 'opsmaxx-test-'))

export const app = {
  getPath: (_name: string): string => userDataDir,
  // clientConfig.ts derives the bridge script path from this; outside a
  // packaged build it is the project root, exactly as in `electron-vite dev`.
  getAppPath: (): string => process.cwd(),
  // Two consumers, neither of which asserts on the value: the updater reports
  // the running version, and shellDiscovery.ts stamps it into
  // TERM_PROGRAM_VERSION for every local shell. Any well-formed semver does.
  //
  // It is deliberately a literal and not package.json's version, so a release
  // bump never has to touch a test. That does mean it drifts from the real
  // version — it already has — which is harmless precisely because nothing
  // compares the two.
  getVersion: (): string => '0.6.2',
  isPackaged: false
}

// The updater opens the releases page here when a platform cannot self-install.
export const shell = {
  openExternal: async (_url: string): Promise<void> => undefined
}

// A no-op "encryption" so secrets.ts can be exercised without a real OS
// keychain. Good enough for tests that only check the shape of the flow.
export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8')
}

export const dialog = {
  showMessageBox: async () => ({ response: 1 }),
  // Overridden per test by debugBundle.test.ts. Cancelled by default, because a
  // test that forgot to say where the file goes should not write one.
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({
    canceled: true
  })
}

// debugLog.ts installs a tap over `handle`, so the mock has to be a real,
// reassignable object rather than a frozen stub. `handle` and `on` record what
// was registered so tests/ipcDebugTap.test.ts can invoke a channel by name.
export const ipcMain = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  },
  on(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.listeners.set(channel, fn)
  }
}

// One open, focused window, as the running app has. Main-process prompts
// (promptWindow.ts) are raised as a sheet on it, and with no window they are
// not raised at all — so a test that answers a host-key dialog needs one to
// exist. Tests of the no-window path spy getFocusedWindow/getAllWindows.
export const mainWindowStub = {
  isDestroyed: (): boolean => false,
  isMinimized: (): boolean => false,
  isVisible: (): boolean => true,
  restore: (): void => undefined,
  show: (): void => undefined,
  focus: (): void => undefined,
  webContents: { send: (): void => undefined }
}
export const BrowserWindow = {
  getFocusedWindow: (): typeof mainWindowStub | null => mainWindowStub,
  getAllWindows: (): (typeof mainWindowStub)[] => [mainWindowStub]
}
