import { BrowserWindow, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'

/**
 * A message box the main process raises on its own — a host key to trust, a
 * certificate that changed — always as a sheet on a window.
 *
 * `dialog.showMessageBox` with no parent is APP-modal. On macOS that is an
 * NSAlert run with `runModal`, which spins its own event loop inside the main
 * thread until it is answered: a stack sample of a real session showed main
 * parked there, and while it was every IPC call, the CDP endpoint and the MCP
 * bridge stalled with it — every other terminal and the agent bridge froze
 * until one person clicked one button. With a parent window the same box is a
 * window-modal sheet, and the main loop keeps running underneath it.
 *
 * The window is brought forward first: these prompts can be started by
 * something the user is not looking at (an agent's connect over the bridge,
 * with the window hidden), and a sheet on a hidden window is a question nobody
 * can see. When there is no window at all, nothing is shown and the answer is
 * null — which every caller treats as the safe refusal, exactly as if Cancel
 * had been pressed, rather than blocking the process to ask.
 */
export async function askInWindow(options: MessageBoxOptions): Promise<MessageBoxReturnValue | null> {
  const win = promptWindow()
  if (!win) return null
  return dialog.showMessageBox(win, options)
}

function promptWindow(): BrowserWindow | null {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
  if (!win || win.isDestroyed()) return null
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  return win
}
