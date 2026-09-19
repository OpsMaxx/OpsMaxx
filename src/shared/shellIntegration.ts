// Shell integration: the OSC 133 marks, the OSC 7 cwd report, and the snippets
// that emit them.
//
// ── OSC 7, and why the Files pane needs it ─────────────────────────────────
//
//   ESC ] 7 ; file://<host>/<abs path> BEL
//
// A shell's working directory lives inside the shell process. A terminal is
// handed bytes, not state, so the ONLY way it learns that the user typed `cd`
// is if the shell says so — and no shell says so by default. zsh, bash and
// fish all have to be asked, which is what the snippets below now do, once per
// prompt (zsh/bash) or on every change to $PWD (fish).
//
// This is what "Follow terminal" in the Files pane rides on. Before it existed
// the renderer registered an OSC 7 handler (useTerminalSession) and nothing in
// the app ever emitted the sequence, so the feature could only work for someone
// whose own dotfiles happened to emit it. The host field is left empty: the
// renderer's parser ignores it, and a path is the only thing being reported.
//
// What it cannot do, in plain terms:
//   - a shell nothing can be injected into (cmd, PowerShell, a login bash,
//     anything not zsh/bash/fish) reports no directory, ever;
//   - the injection only happens when the "Shell integration" setting is on;
//   - a remote shell is not spawned by this app at all — see
//     REMOTE_CWD_BOOTSTRAP below.
// In each case the Files pane must say following is unavailable rather than
// show a link button that does nothing.
//
// OSC 133 is the de-facto contract between a shell and its terminal about where
// a prompt begins, where the editable input starts, and what a command exited
// with. Without it a terminal is looking at an undifferentiated grid of cells:
// it cannot tell a prompt from output, and it cannot know which column the
// user's typing actually begins at.
//
//   133;A  prompt start
//   133;B  prompt end / input start   <- the one everything here exists for
//   133;C  command about to run
//   133;D;<exit>  command finished
//
// ── Injected, not installed ────────────────────────────────────────────────
//
// These are handed to the shell at spawn time through its own args and env,
// which the app already owns per shell (shared/local.ts). They are NOT written
// into the user's rc files. Writing there would need consent, marker-delimited
// idempotent rewrites, a backup and an uninstall path — roughly six times the
// code, for the strictly worse property of modifying terminals this app does
// not own. Turning the setting off is enough to undo all of this.
//
// A remote SSH session gets no OSC 133 and degrades to silence. A remote host
// that already emits OSC 133 from its own dotfiles works for free, because the
// renderer parses the marks wherever they come from. Its cwd is a separate
// story: REMOTE_CWD_BOOTSTRAP at the bottom of this file is typed INTO the
// remote shell, because there is no spawn here to attach anything to.
//
// ── Why the bodies are constants ───────────────────────────────────────────
//
// Everything below is a compile-time constant, and `snippetFor` takes a closed
// union. No hostname, cwd, server name or peer name can reach this text, which
// matters because it is code a shell will execute. Dynamic values travel as env
// vars or as argv elements — node-pty takes an args ARRAY, so a path passed as
// `--init-file <path>` is never shell-parsed.
//
// Note what is deliberately absent: `633;E`, the command line itself. localPty
// promises nothing typed into the shell is recorded, and a snippet that reports
// command text is a keylogger with a friendly name.

import type { LocalShellKind } from './local'

/** BEL-terminated rather than ST: shorter, and universally accepted. */
const OSC = (body: string): string => `\\033]${body}\\007`

/**
 * zsh, via `precmd`/`preexec` hooks and a PS1 suffix.
 *
 * `__om_status=$?` has to be the first line of precmd or the exit code it
 * reports is precmd's own. The PS1 suffix is wrapped in `%{...%}` so zsh knows
 * the sequence occupies no columns — without it every prompt is mis-measured
 * and the line wraps early.
 */
const ZSH = `
# OpsMaxx shell integration (OSC 133). Injected per session; not installed.
#
# ZDOTDIR points here, which means zsh reads THIS file instead of the user's
# ~/.zshrc — so the first thing it must do is read theirs, and restore ZDOTDIR
# so anything in it that references ZDOTDIR still resolves to their directory.
if [ -n "$OPSMAXX_USER_ZDOTDIR" ]; then
  ZDOTDIR="$OPSMAXX_USER_ZDOTDIR"
  [ -f "$OPSMAXX_USER_ZDOTDIR/.zshrc" ] && . "$OPSMAXX_USER_ZDOTDIR/.zshrc"
fi
__om_status=0
__om_precmd() {
  __om_status=$?
  printf '${OSC('133;D;%s')}' "$__om_status"
  printf '${OSC('133;A')}'
  printf '${OSC('7;file://%s')}' "$PWD"
}
__om_preexec() { printf '${OSC('133;C')}' }
# Appended rather than assigned: another framework's hooks must survive.
precmd_functions+=(__om_precmd)
preexec_functions+=(__om_preexec)
PS1="$PS1"$'%{${OSC('133;B')}%}'
`

/**
 * bash, via `PROMPT_COMMAND`, `PS0` and a PS1 suffix.
 *
 * PS0 is printed after the command is read and before it runs, which is exactly
 * the 133;C moment and has no equivalent in a hook. `\\[` and `\\]` are bash's
 * zero-width markers, the counterpart of zsh's `%{ %}`.
 */
const BASH = `
# OpsMaxx shell integration (OSC 133). Injected per session; not installed.
#
# --init-file makes bash read THIS file instead of ~/.bashrc, so it has to read
# theirs first or an interactive shell loses its own configuration entirely.
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
__om_status=0
__om_precmd() {
  __om_status=$?
  printf '${OSC('133;D;%s')}' "$__om_status"
  printf '${OSC('133;A')}'
  printf '${OSC('7;file://%s')}' "$PWD"
}
# Prepended, keeping anything already there — a bare assignment would silently
# disable another tool's prompt hook.
PROMPT_COMMAND="__om_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS0='\\e]133;C\\a'
PS1="$PS1"'\\[\\e]133;B\\a\\]'
`

/**
 * fish: the command marks and the cwd report, but not the prompt marks.
 *
 * NOT the prompt marks, and this is a real limitation rather than an oversight.
 * Everything fish loads from `vendor_conf.d` or `conf.d` runs BEFORE
 * `config.fish`, so a `fish_prompt` wrapper installed from here is defined and
 * then immediately replaced by the user's own definition — which both removes
 * our A/B marks and, if the copy-and-wrap had already happened, can recurse.
 * There is no post-config hook to install it from instead.
 *
 * So fish gets `133;C` and `133;D` from its own preexec/postexec events, which
 * are reliable and give command boundaries and exit status. It does not get
 * `133;B`, and click-to-move therefore stays off in fish — which the guard in
 * clickToMove already handles, because no input mark means no movement.
 *
 * OSC 7 is unaffected by any of that: it hangs off `--on-variable PWD`, not off
 * the prompt, so the Files pane can follow a fish shell even though the
 * terminal cannot know where its prompt ends.
 */
const FISH = `
# OpsMaxx shell integration (OSC 133 + OSC 7). Injected per session; not installed.
function __om_preexec --on-event fish_preexec
  printf '${OSC('133;C')}'
end
function __om_postexec --on-event fish_postexec
  printf '${OSC('133;D;%s')}' $status
end
# OSC 7 needs no prompt wrapper, so fish gets this one even though it cannot
# have the prompt marks: PWD is a variable, and fish will tell us when it moves.
function __om_cwd --on-variable PWD
  printf '${OSC('7;file://%s')}' "$PWD"
end
__om_cwd
`

/**
 * Which shells this can be injected into, and with what.
 *
 * `posix` covers zsh and bash both, because that is all `LocalShellKind`
 * distinguishes; the snippet is chosen from the shell's actual path instead, by
 * the caller. Absent kinds get nothing and are not an error — a session with no
 * integration is a session where click-to-move stays off, which is the correct
 * degradation and not a failure.
 *
 * Deliberately absent: `cmd`, `powershell`, `pwsh`, `wsl`. PowerShell can do
 * this and is worth adding; cmd cannot; and a WSL shell is a different
 * filesystem, so a path written on the host side does not resolve inside it.
 */
export type IntegrationShell = 'zsh' | 'bash' | 'fish'

/**
 * The OTHER files zsh reads out of ZDOTDIR, each handing back to the user's.
 *
 * This is not optional politeness. Setting `ZDOTDIR` redirects zsh's whole
 * startup chain, not just `.zshrc`: it looks for `.zshenv`, `.zprofile`,
 * `.zshrc` and `.zlogin` in THAT directory and never in `$HOME`. So a user who
 * sets PATH in `~/.zshenv` — which is the file zsh's own documentation
 * recommends for exactly that — would have lost it, in a shell that otherwise
 * looked fine, with the breakage showing up later as "command not found" for
 * something their terminal finds.
 *
 * `$HOME` rather than `$OPSMAXX_USER_ZDOTDIR` here because `.zshenv` runs
 * BEFORE our `.zshrc` and cannot rely on a variable our `.zshrc` restores;
 * `$HOME` is what zsh itself would have used.
 */
export function zshPassthrough(file: '.zshenv' | '.zprofile' | '.zlogin'): string {
  return `# OpsMaxx shell integration: hand back to this user's own ${file}.
# ZDOTDIR points at OpsMaxx's directory, which redirects zsh's ENTIRE startup
# chain — so without this file, ${file} would simply never be read.
[ -f "\${OPSMAXX_USER_ZDOTDIR:-$HOME}/${file}" ] && . "\${OPSMAXX_USER_ZDOTDIR:-$HOME}/${file}"
`
}

export function snippetFor(shell: IntegrationShell): string {
  switch (shell) {
    case 'zsh':
      return ZSH
    case 'bash':
      return BASH
    case 'fish':
      return FISH
  }
}

/**
 * Which snippet a shell wants, from its kind and its absolute path.
 *
 * The path is matched on its basename only, and only against a fixed list, so
 * nothing about the path can select anything other than one of three constants
 * — `/tmp/evil/zsh` gets the zsh snippet, which is the same text `/bin/zsh`
 * gets, and that text does not mention the path.
 */
export function integrationFor(kind: LocalShellKind, path: string): IntegrationShell | null {
  // gitbash and msys2 ARE bash, and their POSIX-ness is the whole point of them.
  if (kind === 'gitbash' || kind === 'msys2') return 'bash'
  if (kind !== 'posix') return null
  const base = path.replace(/\.exe$/i, '').split(/[/\\]/).pop() ?? ''
  if (base === 'zsh') return 'zsh'
  if (base === 'bash' || base === 'sh') return 'bash'
  if (base === 'fish') return 'fish'
  return null
}

// ---------------------------------------------------------------------------
// The remote half: asking a shell we did not spawn to report its directory
// ---------------------------------------------------------------------------

/** The OSC 7 report itself, double-quoted so it can live inside `eval '…'`. */
const REMOTE_PRINTF = `printf "${OSC('7;file://%s')}" "$PWD"`

/**
 * One line, typed into a remote shell, that makes it report its cwd from then on.
 *
 * Everything above this point works by owning the spawn — args and env chosen
 * before the shell starts. An SSH session has no spawn here: ssh2 opens a
 * channel and the far end runs whatever that account's login shell is. The only
 * channel into it is the same one the user's keystrokes go down, so the snippet
 * has to be *typed*, and the user will see it echo once. That is the honest
 * cost, and it is why this is sent when following is switched on rather than on
 * every connection.
 *
 * ── Why the shape is this ugly ────────────────────────────────────────────
 *
 * It has to be harmless in a shell it does not fit, because we cannot know what
 * the far end runs until it answers. The `test … && eval '…'` wrapper is what
 * buys that:
 *
 *   bash / zsh  the test passes, eval installs a per-prompt hook.
 *   fish        `$BASH_VERSION$ZSH_VERSION` is empty, so the test fails and the
 *               eval's argument is never parsed — fish would reject `f() { }`
 *               outright, so it must never reach fish's parser. (fish ≥ 3.0,
 *               for `&&`; a fish 2.x from 2016 prints one error.)
 *   sh / dash   the test fails, nothing happens, no cwd is ever reported.
 *
 * Which is the real ceiling: a remote shell that is not bash or zsh reports
 * nothing, and there is no way to ask it that also works on the ones that are.
 * The Files pane therefore has to treat "no directory has arrived" as a state
 * it shows the user, not as a state it waits in forever.
 *
 * ponytail: single-shot install, no idempotence guard. Sending it twice adds a
 * second hook that prints the same path twice a prompt — invisible to the user
 * and cheaper than the guard would be. Add one if a caller ever sends it per
 * navigation rather than per session.
 */
export const REMOTE_CWD_BOOTSTRAP =
  `test -n "$BASH_VERSION$ZSH_VERSION" && eval '` +
  `__om_cwd() { ${REMOTE_PRINTF}; }; ` +
  `if [ -n "$ZSH_VERSION" ]; then precmd_functions+=(__om_cwd); ` +
  `else PROMPT_COMMAND="__om_cwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi; ` +
  `__om_cwd'\n`

// ---------------------------------------------------------------------------
// Parsing, for the renderer
// ---------------------------------------------------------------------------

/**
 * The absolute path out of an OSC 7 payload, or null if it is not one.
 *
 * `file://<host>/<path>`. The host is ignored on purpose: this app only ever
 * reads the sequence from a session it already knows the far end of, and a
 * shell that reports a hostname the app cannot resolve (a container, a host
 * behind a jump chain, a machine that simply disagrees about its own name) must
 * not lose its path over it.
 *
 * Percent-decoded, falling back to the raw text when decoding throws — a
 * directory whose name contains a bare `%` is legal on every filesystem here
 * and is not a reason to report nothing.
 *
 * It lives beside parseOsc133 rather than in the renderer because a shell
 * snippet and the parser that reads it back are one contract, and the test that
 * runs the snippet through a real shell has to reach the parser without
 * dragging xterm into a Node process.
 */
export function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

export type PromptMark =
  | { kind: 'prompt-start' }
  | { kind: 'input-start' }
  | { kind: 'command-start' }
  | { kind: 'command-done'; exit: number | null }

/**
 * One OSC 133 payload — the text BETWEEN `ESC ] 133 ;` and the terminator,
 * which is what xterm hands an OSC handler registered for 133.
 *
 * Unknown letters return null rather than throwing: the sequence is a shared
 * contract that other terminals extend (`133;P`, `133;L`), and a shell that
 * emits one of those is not malformed, it is just saying something this does
 * not use.
 */
export function parseOsc133(payload: string): PromptMark | null {
  const parts = payload.split(';')
  switch (parts[0]) {
    case 'A':
      return { kind: 'prompt-start' }
    case 'B':
      return { kind: 'input-start' }
    case 'C':
      return { kind: 'command-start' }
    case 'D': {
      // `D` alone is legal and means "finished, status unknown".
      const raw = parts[1]
      if (raw === undefined || raw === '') return { kind: 'command-done', exit: null }
      const exit = Number(raw)
      return { kind: 'command-done', exit: Number.isInteger(exit) ? exit : null }
    }
    default:
      return null
  }
}
