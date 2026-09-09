import { describe, it, expect } from 'vitest'
import {
  integrationFor,
  parseOsc133,
  snippetFor,
  zshPassthrough,
  type IntegrationShell
} from '../src/shared/shellIntegration'
import {
  NO_PROMPT,
  applyMark,
  isClickNotDrag,
  movementFor
} from '../src/renderer/src/lib/clickToMove'

/**
 * OSC 133 shell integration, and the click-to-move that rides on it.
 *
 * The marks are the whole point. Without `133;B` a terminal cannot know which
 * column the user's typing starts at, so a click-to-move built without it can
 * only handle the line the cursor is already on and silently does nothing
 * elsewhere — which reads as broken. Every guard below is a case where sending
 * arrow keys would do something the user did not ask for.
 */

const SHELLS: IntegrationShell[] = ['zsh', 'bash', 'fish']

describe('snippets', () => {
  it('emits all four marks in zsh and bash', () => {
    for (const shell of ['zsh', 'bash'] as const) {
      const body = snippetFor(shell)
      for (const mark of ['133;A', '133;B', '133;C', '133;D']) {
        expect(body, `${shell} is missing ${mark}`).toContain(mark)
      }
    }
  })

  /**
   * fish gets the command marks and deliberately not the prompt marks.
   *
   * Everything fish loads from `vendor_conf.d` runs BEFORE `config.fish`, so a
   * `fish_prompt` wrapper installed from there is defined and then replaced by
   * the user's own — which removes the marks it was there to add. There is no
   * post-config hook to install one from instead, so claiming A/B in fish would
   * be claiming something that does not happen.
   */
  it('gives fish the command marks only, and says so', () => {
    const body = snippetFor('fish')
    expect(body).toContain('133;C')
    expect(body).toContain('133;D')
    expect(body).not.toContain('133;A')
    expect(body).not.toContain('133;B')
    // And it must not try to wrap the prompt, which is the thing that breaks.
    expect(body).not.toContain('fish_prompt')
  })

  /**
   * The command line itself must never be reported. localPty promises nothing
   * typed into the shell is recorded, and a snippet emitting `633;E` would be a
   * keylogger with a friendly name.
   */
  it('never reports the command line', () => {
    for (const shell of SHELLS) {
      expect(snippetFor(shell)).not.toContain('633;E')
    }
  })

  // Both mechanisms REPLACE the user's rc file rather than adding to it, so a
  // snippet that forgot this would silently wipe someone's shell config.
  it('sources the user own config, since it displaces it', () => {
    expect(snippetFor('zsh')).toContain('OPSMAXX_USER_ZDOTDIR')
    expect(snippetFor('zsh')).toContain('.zshrc')
    expect(snippetFor('bash')).toContain('.bashrc')
  })

  // A bare assignment would disable another tool's prompt hook.
  it('adds to existing hooks rather than replacing them', () => {
    expect(snippetFor('zsh')).toContain('precmd_functions+=')
    expect(snippetFor('bash')).toContain('${PROMPT_COMMAND:+')
    // fish uses named event handlers, which are additive by construction.
    expect(snippetFor('fish')).toContain('--on-event')
  })

  /**
   * Without zero-width markers the shell counts the escape sequence as printed
   * columns, mis-measures the prompt and wraps the line early — a subtle,
   * infuriating bug that looks like a theme problem.
   */
  it('marks the prompt suffix as zero-width', () => {
    expect(snippetFor('zsh')).toContain('%{')
    expect(snippetFor('bash')).toContain('\\[')
  })

  // Only the two that displace a startup file need to hand it back.
  it('sources the user config only where it replaces one', () => {
    expect(snippetFor('fish')).not.toContain('config.fish')
  })
})

/**
 * ZDOTDIR redirects zsh's ENTIRE startup chain, not just .zshrc — it looks for
 * .zshenv, .zprofile, .zshrc and .zlogin in that directory and never in $HOME.
 * So a user who sets PATH in ~/.zshenv, which is the file zsh's own docs
 * recommend for it, loses it in every shell this app opens unless each of those
 * is handed back. The breakage would surface much later, as "command not found"
 * for something their own terminal finds.
 */
describe('the rest of the zsh startup chain', () => {
  it('hands every redirected file back to the user', () => {
    for (const f of ['.zshenv', '.zprofile', '.zlogin'] as const) {
      const body = zshPassthrough(f)
      expect(body, f).toContain(f)
      // $HOME as the fallback, because .zshenv runs before our .zshrc has had a
      // chance to restore anything.
      expect(body, f).toContain('$HOME')
    }
  })

  it('does not emit prompt marks from the passthroughs', () => {
    // Only .zshrc hooks the prompt. A .zshenv that did would run for every
    // non-interactive zsh too, including every `zsh -c` in a script.
    for (const f of ['.zshenv', '.zprofile', '.zlogin'] as const) {
      expect(zshPassthrough(f)).not.toContain('133;')
    }
  })
})

describe('integrationFor', () => {
  it('recognises the POSIX shells it can inject into', () => {
    expect(integrationFor('posix', '/bin/zsh')).toBe('zsh')
    expect(integrationFor('posix', '/bin/bash')).toBe('bash')
    expect(integrationFor('posix', '/opt/homebrew/bin/fish')).toBe('fish')
  })

  it('treats Git Bash and MSYS2 as bash, which is what they are', () => {
    expect(integrationFor('gitbash', 'C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(integrationFor('msys2', 'C:\\msys64\\usr\\bin\\bash.exe')).toBe('bash')
  })

  // Not a failure: a session with no marks is one where the features that need
  // them stay off.
  it('declines the shells it cannot do this in', () => {
    expect(integrationFor('cmd', 'C:\\Windows\\system32\\cmd.exe')).toBeNull()
    expect(integrationFor('powershell', 'powershell.exe')).toBeNull()
    expect(integrationFor('wsl', 'wsl.exe')).toBeNull()
    expect(integrationFor('posix', '/usr/bin/tcsh')).toBeNull()
  })

  // The path selects one of three constants and appears in none of them.
  it('selects on the basename only', () => {
    expect(integrationFor('posix', '/tmp/anywhere/zsh')).toBe('zsh')
    expect(snippetFor('zsh')).not.toContain('/tmp/anywhere')
  })
})

describe('parseOsc133', () => {
  it('reads the four marks', () => {
    expect(parseOsc133('A')).toEqual({ kind: 'prompt-start' })
    expect(parseOsc133('B')).toEqual({ kind: 'input-start' })
    expect(parseOsc133('C')).toEqual({ kind: 'command-start' })
    expect(parseOsc133('D;0')).toEqual({ kind: 'command-done', exit: 0 })
    expect(parseOsc133('D;127')).toEqual({ kind: 'command-done', exit: 127 })
  })

  it('accepts a bare D, which means finished with an unknown status', () => {
    expect(parseOsc133('D')).toEqual({ kind: 'command-done', exit: null })
  })

  // Other terminals extend this sequence; a shell emitting one of those is not
  // malformed, it is saying something we do not use.
  it('ignores extensions rather than treating them as errors', () => {
    expect(parseOsc133('P;Cwd=/tmp')).toBeNull()
    expect(parseOsc133('L')).toBeNull()
    expect(parseOsc133('')).toBeNull()
  })
})

describe('prompt state', () => {
  it('records where input starts, from the cursor at the B mark', () => {
    const s = applyMark(NO_PROMPT, { kind: 'input-start' }, { row: 10, col: 12, cols: 80 })
    expect(s).toEqual({ inputRow: 10, inputCol: 12, running: false, cols: 80 })
  })

  it('invalidates the old position when a new prompt begins', () => {
    let s = applyMark(NO_PROMPT, { kind: 'input-start' }, { row: 10, col: 12 })
    s = applyMark(s, { kind: 'prompt-start' }, { row: 11, col: 0 })
    expect(s.inputRow).toBeNull()
  })

  it('tracks whether a command is running', () => {
    let s = applyMark(NO_PROMPT, { kind: 'input-start' }, { row: 5, col: 2 })
    s = applyMark(s, { kind: 'command-start' }, { row: 5, col: 9 })
    expect(s.running).toBe(true)
    s = applyMark(s, { kind: 'command-done', exit: 0 }, { row: 6, col: 0 })
    expect(s.running).toBe(false)
  })
})

describe('movementFor', () => {
  const base = {
    prompt: { inputRow: 10, inputCol: 10, running: false, cols: 80 },
    cols: 80,
    normalScreen: true,
    mouseReporting: false,
    applicationCursorKeys: false
  }

  it('moves right when the click is past the cursor', () => {
    const seq = movementFor({
      ...base,
      cursor: { row: 10, col: 15 },
      click: { row: 10, col: 18 }
    })
    expect(seq).toBe('\u001b[C'.repeat(3))
  })

  it('moves left when the click is before the cursor', () => {
    const seq = movementFor({
      ...base,
      cursor: { row: 10, col: 15 },
      click: { row: 10, col: 12 }
    })
    expect(seq).toBe('\u001b[D'.repeat(3))
  })

  /**
   * The reason the offset is computed in characters rather than rows and
   * columns: a wrapped command is one logical line, and moving from the end of
   * a wrapped row to the start of the next is a single character step.
   */
  it('crosses a wrapped line as one continuous run of characters', () => {
    const seq = movementFor({
      ...base,
      cursor: { row: 11, col: 5 },
      click: { row: 10, col: 78 }
    })
    // From (11,5) back to (10,78): (80-78) + 5 = 7 characters left.
    expect(seq).toBe('\u001b[D'.repeat(7))
  })

  it('does nothing when the click is where the cursor already is', () => {
    expect(
      movementFor({ ...base, cursor: { row: 10, col: 15 }, click: { row: 10, col: 15 } })
    ).toBeNull()
  })

  // The click was on the prompt, not on anything the user typed.
  it('does nothing for a click before the input start', () => {
    expect(
      movementFor({ ...base, cursor: { row: 10, col: 15 }, click: { row: 10, col: 4 } })
    ).toBeNull()
  })

  // Without a B mark we do not know where input begins, so a click could be
  // anywhere and the arrows would go to whatever is reading stdin.
  it('does nothing when no prompt mark has been seen', () => {
    expect(
      movementFor({
        ...base,
        prompt: NO_PROMPT,
        cursor: { row: 10, col: 15 },
        click: { row: 10, col: 18 }
      })
    ).toBeNull()
  })

  /**
   * The case a version without shell integration cannot handle. A `read -p` in
   * a running script passes every other check — normal screen, no mouse
   * reporting, a prompt on screen — and would swallow the arrows.
   */
  it('does nothing while a command is running', () => {
    expect(
      movementFor({
        ...base,
        prompt: { ...base.prompt, running: true },
        cursor: { row: 10, col: 15 },
        click: { row: 10, col: 18 }
      })
    ).toBeNull()
  })

  it('does nothing in a full-screen application', () => {
    expect(
      movementFor({
        ...base,
        normalScreen: false,
        cursor: { row: 10, col: 15 },
        click: { row: 10, col: 18 }
      })
    ).toBeNull()
  })

  it('does nothing when the application is reading the mouse itself', () => {
    expect(
      movementFor({
        ...base,
        mouseReporting: true,
        cursor: { row: 10, col: 15 },
        click: { row: 10, col: 18 }
      })
    ).toBeNull()
  })

  /**
   * DECCKM is not a bail-out: an application that set it still wants arrows,
   * spelled the other way. Sending the wrong form types letters into the line
   * instead of moving the cursor.
   */
  it('uses the application cursor-key form when DECCKM is set', () => {
    const seq = movementFor({
      ...base,
      applicationCursorKeys: true,
      cursor: { row: 10, col: 15 },
      click: { row: 10, col: 17 }
    })
    expect(seq).toBe('\u001bOC'.repeat(2))
  })
})

describe('isClickNotDrag', () => {
  // Hijacking a drag would make text unselectable, which is a far worse
  // regression than click-to-move is an improvement.
  it('treats a small movement as a click and a large one as a selection', () => {
    expect(isClickNotDrag({ x: 100, y: 50 }, { x: 102, y: 51 })).toBe(true)
    expect(isClickNotDrag({ x: 100, y: 50 }, { x: 140, y: 50 })).toBe(false)
    expect(isClickNotDrag({ x: 100, y: 50 }, { x: 100, y: 70 })).toBe(false)
  })
})

describe('movementFor safety bounds', () => {
  const base = {
    prompt: { inputRow: 10, inputCol: 10, running: false, cols: 80 },
    cursor: { row: 10, col: 15 },
    cols: 80,
    normalScreen: true,
    mouseReporting: false,
    applicationCursorKeys: false
  }

  /**
   * A resize rewraps the buffer, so the absolute row the mark recorded no
   * longer points at the same text — the arithmetic would be measured from the
   * wrong origin. The next prompt records a fresh mark, so refusing costs one
   * keystroke of patience.
   */
  it('does nothing when the terminal was resized since the mark', () => {
    expect(movementFor({ ...base, cols: 100, click: { row: 10, col: 18 } })).toBeNull()
    // Same width: still works.
    expect(movementFor({ ...base, click: { row: 10, col: 18 } })).not.toBeNull()
  })

  /**
   * Without a bound, a click at the far end of a long scrollback produced
   * hundreds of thousands of arrow keys — megabytes written into the pty for
   * one click, which the shell then processes a keystroke at a time. A delta
   * that large means the marks and the screen disagree.
   */
  it('refuses an implausibly large jump rather than flooding the pty', () => {
    const far = movementFor({ ...base, click: { row: 5000, col: 0 } })
    expect(far).toBeNull()
  })

  it('still allows a jump across a few wrapped rows', () => {
    const seq = movementFor({ ...base, click: { row: 13, col: 15 } })
    expect(seq).not.toBeNull()
    expect(seq!.length).toBeGreaterThan(0)
  })
})
