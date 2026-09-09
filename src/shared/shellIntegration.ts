// Shell integration: the OSC 133 marks, and the snippets that emit them.
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
// A remote SSH session gets nothing and degrades to silence. A remote host that
// already emits OSC 133 from its own dotfiles works for free, because the
// renderer parses the marks wherever they come from.
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
}
# Prepended, keeping anything already there — a bare assignment would silently
# disable another tool's prompt hook.
PROMPT_COMMAND="__om_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS0='\\e]133;C\\a'
PS1="$PS1"'\\[\\e]133;B\\a\\]'
`

/**
 * fish: the command marks only.
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
 */
const FISH = `
# OpsMaxx shell integration (OSC 133). Injected per session; not installed.
function __om_preexec --on-event fish_preexec
  printf '${OSC('133;C')}'
end
function __om_postexec --on-event fish_postexec
  printf '${OSC('133;D;%s')}' $status
end
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
// Parsing, for the renderer
// ---------------------------------------------------------------------------

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
