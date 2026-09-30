import { app, ipcMain } from 'electron'
import { sep } from 'node:path'
import { DATA_FILE_PATH } from '../services/store'
import { AUDIT_LOG_PATH } from '../services/auditLog'
import { setDemoConnector } from '../services/ssh'
import { setMcpConfig } from '../services/mcpAuth'
import type { DbInfo, DbQueryResult, DbTestResult } from '../../shared/db'
import type { HttpResult } from '../../shared/httpClient'
import { PostureReader } from '../services/posture'
import { parsePosture, POSTURE_COMMAND } from '../../shared/posture'
import { SERVERS } from './fixtures'
import { fakeClient } from './fakeSsh'
import { responder } from './responder'
import { raiseDemoApproval, seedDemoProfile } from './seed'

/**
 * The screenshot demo: invented servers, answered by a fake SSH layer, in a
 * profile of its own.
 *
 * Reached only from index.ts, behind `import.meta.env.DEV` (so a production
 * build does not contain this file) and behind portable.ts's `isDemo` (so a
 * dev run without OPSMAXX_DEMO_PROFILE never gets here, and userData has
 * already been moved off the real profile when it does).
 *
 * MUST be called before index.ts registers its IPC handlers: the fakes below
 * replace a handler at registration, the same way installIpcDebugTap wraps
 * every one.
 */
export function installDemo(): void {
  if (app.isPackaged) return
  const profile = app.getPath('userData')

  // THE CHECK THAT MATTERS. Every service resolves its file at import time, so
  // if anything evaluated before portable.ts's redirect -- a bundler chunk
  // split did exactly that once -- the seed, the fake SSH layer and the window
  // would all run against the real profile. Proven here, before anything is
  // written, rather than assumed from import order.
  for (const path of [DATA_FILE_PATH, AUDIT_LOG_PATH]) {
    if (!path.startsWith(profile + sep)) {
      console.error(`[demo] refusing to start: ${path} is outside the demo profile ${profile}`)
      app.exit(1)
      return
    }
  }
  console.warn(`[demo] synthetic-data profile at ${profile}`)

  setDemoConnector((hop) => fakeClient(hop, responder))

  // Off the default port, which an installed copy running beside this one
  // already holds; the AI panel otherwise shows a bridge that failed to start.
  setMcpConfig({ port: 5187 })

  // Features that do not ride SSH. Replaced at registration, so the rest of
  // index.ts is untouched and nothing here registers a channel of its own.
  const fakes: Record<string, (...args: unknown[]) => unknown> = {
    'db:test': (): DbTestResult => ({ ok: true, version: 'PostgreSQL 16.4 on x86_64-pc-linux-gnu' }),
    'db:info': (): DbInfo => ({
      ok: true,
      databases: ['orders', 'billing', 'analytics', 'postgres'],
      tables: ['customers', 'invoices', 'order_items', 'orders', 'payments', 'products', 'refunds', 'shipments']
    }),
    'db:query': (): DbQueryResult => demoQueryResult(),
    'http:request': (): HttpResult => demoHttpResult(),
    // "This machine" is a row in the posture and drift panels, and a real one
    // would read the Mac the demo runs on into a public screenshot. Posture is
    // read through the real reader from the synthetic collector output; drift
    // says it was not read.
    'fleet:posture-local': () =>
      new PostureReader({
        exec: async (_cfg: unknown, command: string) => ({
          ok: true,
          stdout: responder.exec({ host: '10.20.1.21', port: 22, username: 'deploy' } as never, command).stdout,
          stderr: '',
          code: 0,
          signal: null,
          truncated: false,
          elided: 0
        })
      } as never).read({}, { firewallRules: false }),
    // Posture is a background sweep an hour apart, so a fresh profile would
    // show every server as not checked yet. Answered from the same synthetic
    // collector output, through the real parser.
    'fleet:posture': (_e: unknown, serverId: unknown) => {
      const srv = SERVERS.find((x) => x.id === serverId)
      if (!srv) return {}
      const stdout = responder.exec({ host: srv.host, port: 22, username: srv.user } as never, POSTURE_COMMAND).stdout
      return { posture: parsePosture(stdout), at: Date.now() }
    },
    'fleet:drift-local': () => ({ ok: false, reason: 'unknown', detail: 'Not read in the demo profile.' })
  }
  const real = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...args: unknown[]) => unknown): void => {
    real(channel, (fakes[channel] ?? listener) as never)
  }) as typeof ipcMain.handle

  // Registered now, not after seeding: the window can open while the vault is
  // still being written, and a listener added after it would never fire.
  const outdir = process.env.OPSMAXX_DEMO_CAPTURE
  if (outdir) prepareForCapture(outdir)

  void app.whenReady().then(async () => {
    await seedDemoProfile()
    // Late enough for the renderer to be listening for approval events. The
    // capture raises its own, when it reaches that shot.
    if (!outdir) setTimeout(raiseDemoApproval, 6_000)
  })
}

/**
 * Get the window into a clean, fixed state and hand it to the capture.
 *
 * The first-run setup and walkthrough are marked seen and the feature tip
 * cards hidden, then the page is reloaded once so it starts without them.
 */
function prepareForCapture(outdir: string): void {
  app.on('browser-window-created', (_e, win) => {
    // Exactly the site's 99:50 frame, so the whole window is the shot and
    // nothing has to be cropped away.
    win.setContentSize(1600, 808)
    let reloaded = false
    win.webContents.on('did-finish-load', () => {
      const wc = win.webContents
      // A fresh profile is always "not backed up" by the time the walk ends,
      // however the seed dates it, and a red warning in every shot says
      // nothing about the feature on screen.
      void wc.insertCSS('.tip-card, .toasts, .backup-warn { display: none !important; }')
      // At the frame's 1600x808 the activity rail runs out of height and drops
      // its last label; 0.9 lays the app out at about 1780x900 instead.
      wc.setZoomFactor(0.9)
      if (!reloaded) {
        reloaded = true
        void wc
          .executeJavaScript(
            `localStorage.setItem('opsmaxx.onboarding.seen','1'); localStorage.setItem('opsmaxx.onboarding.setup','1'); localStorage.setItem('opsmaxx.vault.bioOfferDismissed','1')`
          )
          .then(() => wc.reload())
        return
      }
      setTimeout(() => {
        void import('./capture').then(async ({ runCapture }) => {
          const { SHOTS } = await import('./shots')
          await runCapture(outdir, SHOTS, '.app')
        })
      }, 6_000)
    })
  })
}

function demoQueryResult(): DbQueryResult {
  const rows: unknown[][] = [
    [48213, 'Northwind Traders', 'paid', 1284.5, '2026-09-30 13:58:12'],
    [48212, 'Contoso Ltd', 'paid', 342.0, '2026-09-30 13:57:40'],
    [48211, 'Fabrikam Inc', 'pending', 89.99, '2026-09-30 13:55:03'],
    [48210, 'Tailspin Toys', 'paid', 2210.75, '2026-09-30 13:51:47'],
    [48209, 'Wide World Importers', 'refunded', 145.2, '2026-09-30 13:49:30'],
    [48208, 'Litware Inc', 'paid', 612.0, '2026-09-30 13:44:19'],
    [48207, 'Adventure Works', 'paid', 77.5, '2026-09-30 13:40:02'],
    [48206, 'Proseware Inc', 'pending', 1030.0, '2026-09-30 13:37:55'],
    [48205, 'Northwind Traders', 'paid', 455.25, '2026-09-30 13:31:28'],
    [48204, 'Blue Yonder Airlines', 'paid', 3190.0, '2026-09-30 13:26:11']
  ]
  return {
    ok: true,
    kind: 'rows',
    columns: ['id', 'customer', 'status', 'total', 'created_at'],
    rows,
    rowCount: rows.length,
    elapsedMs: 14
  }
}

function demoHttpResult(): HttpResult {
  const body = JSON.stringify(
    {
      status: 'ok',
      version: '2.14.0',
      region: 'eu-west-1',
      uptime_s: 183_422,
      checks: { database: 'ok', cache: 'ok', queue: { status: 'ok', depth: 12 } },
      build: { commit: 'a1f9c3e', built_at: '2026-09-27T09:12:40Z' }
    },
    null,
    2
  )
  const bytes = new TextEncoder().encode(body)
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
      server: 'caddy',
      'x-request-id': '01J8ZK4W7Q3M2V9D6R5T0YXBNC'
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    durationMs: 87,
    truncated: false,
    timings: { dns: 3, connect: 11, tls: 24, ttfb: 71, download: 2 }
  }
}
