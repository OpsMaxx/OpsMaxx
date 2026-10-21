// OSC 52: a program in the terminal asking to set the clipboard.
//
// This is how anything running on a REMOTE machine copies to the local one —
// tmux, Neovim, and Claude Code among them. Over SSH there is no other path:
// the program's own `pbcopy` or `xclip` lands on the server's clipboard, which
// nobody is looking at. xterm.js does not handle the sequence itself, so until
// this existed every such copy was dropped in silence, and "copy works in a
// normal shell but not in Claude" was the report.
//
// Write only. `Pd` of `?` asks the terminal to REPLY with the clipboard's
// contents, which would hand whatever the user last copied locally — a
// password, a token — to any program on any server they connect to. It is
// never answered, and neither kitty nor WezTerm answers it by default either.
// An empty `Pd` (clear the clipboard) is ignored too: a remote program has no
// business wiping something the user copied here.

/** Base64 characters, before decoding. Roughly 750 KB of text. */
export const OSC52_MAX_BASE64 = 1_000_000

/**
 * The text an OSC 52 payload asks to copy, or null for anything that is not a
 * plain, well-formed write.
 *
 * `data` is what xterm hands a handler registered for 52 — `Pc;Pd`, where `Pc`
 * names the selection (`c`, `p`, `s`, often empty) and is ignored: this
 * machine has one clipboard that matters.
 */
export function parseOsc52(data: string): string | null {
  const semi = data.indexOf(';')
  if (semi < 0) return null
  const pd = data.slice(semi + 1).replace(/\s+/g, '')
  if (pd === '' || pd === '?') return null
  if (pd.length > OSC52_MAX_BASE64) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pd) || pd.length % 4 === 1) return null
  try {
    const bin = atob(pd)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not base64 after all, or not UTF-8 text. Copying mojibake is worse than
    // copying nothing.
    return null
  }
}
