/**
 * Whether a URL from the renderer may be handed to the operating system.
 *
 * `setWindowOpenHandler` in main/index.ts turns every `window.open` into
 * `shell.openExternal`, and that call is an OS-level open: the platform picks a
 * handler by scheme and runs it. Unrestricted, `file:///` opens a local path and
 * Windows resolves a long tail of registered schemes — `ms-msdt:`, `search-ms:`
 * — that have been exploit primitives more than once.
 *
 * Everything this app actually opens is a web page or the contact address, so
 * the allowlist costs nothing and the default stops being "whatever string
 * reached the handler".
 *
 * Here, in shared, rather than inline in the handler, so it can be tested
 * without standing up a BrowserWindow — the handler itself is a closure created
 * inside `createWindow`, and an untested allowlist is the kind that grows a
 * scheme nobody argued for.
 */
const ALLOWED = new Set(['https:', 'http:', 'mailto:'])

export function mayOpenExternally(url: string): boolean {
  try {
    return ALLOWED.has(new URL(url).protocol)
  } catch {
    // Not a URL at all. Nothing in this app opens one of those.
    return false
  }
}
