import type { PromptMark } from '../../../shared/shellIntegration'

/**
 * Click-to-move: where the cursor is, where the click was, and what to send.
 *
 * Pure, and deliberately knowing nothing about xterm. The caller measures the
 * grid and reads the buffer; this decides. That split is what makes the logic
 * testable at all — nothing in the 342-file suite mounts a terminal, and jsdom
 * has neither the observers a live terminal needs nor a canvas to measure.
 */

/** Where the shell's editable input begins, from the last OSC 133 marks. */
export interface PromptState {
  /** Absolute row of the last `133;B`, or null if none has been seen. */
  inputRow: number | null
  /** Absolute column of the last `133;B`. */
  inputCol: number | null
  /** True between `133;C` and `133;D` — a command is running. */
  running: boolean
  /** Grid width when the mark was taken, so a resize can invalidate it. */
  cols: number | null
}

export const NO_PROMPT: PromptState = { inputRow: null, inputCol: null, running: false, cols: null }

/**
 * Fold one mark into the prompt state.
 *
 * `133;B` is the only one that records a position, and it records the cursor's
 * position at the moment the shell finished printing its prompt — which is
 * exactly where the user's typing starts, however many lines the prompt took
 * and whatever it contains. This is the thing that cannot be inferred from the
 * screen, and the reason a version of this feature without shell integration
 * can only ever guess.
 */
export function applyMark(
  state: PromptState,
  mark: PromptMark,
  cursor: { row: number; col: number; cols?: number }
): PromptState {
  switch (mark.kind) {
    case 'prompt-start':
      // A new prompt invalidates the old input position; the B that follows
      // will set the new one.
      return { inputRow: null, inputCol: null, running: false, cols: null }
    case 'input-start':
      return {
        inputRow: cursor.row,
        inputCol: cursor.col,
        running: false,
        cols: cursor.cols ?? null
      }
    case 'command-start':
      return { ...state, running: true }
    case 'command-done':
      return { ...state, running: false }
  }
}

export interface MoveContext {
  /** Absolute row/col the click landed on. */
  click: { row: number; col: number }
  /** Absolute row/col the cursor is at now. */
  cursor: { row: number; col: number }
  prompt: PromptState
  /** Columns per row, for converting a row difference into a character count. */
  cols: number
  /** False in vim/less/htop — the alternate screen owns its own cursor. */
  normalScreen: boolean
  /** True when the application has asked for mouse reporting; it owns clicks. */
  mouseReporting: boolean
  /** DECCKM: changes which escape the arrow keys are. */
  applicationCursorKeys: boolean
}

/**
 * The keystrokes that move the shell's cursor to the click, or null to do
 * nothing.
 *
 * Null is the common and correct answer. Every guard below is a case where
 * sending arrows would do something the user did not ask for:
 *
 *  - No `133;B` seen: we do not know where input starts, so a click anywhere
 *    could be output, and arrows would go to whatever is reading stdin.
 *  - A command is running: `read -p` in a script passes every OTHER check and
 *    would eat the arrows. This is the case the pre-integration design called
 *    unavoidable; the C/D marks are what make it avoidable.
 *  - Alternate screen, or mouse reporting on: the application owns the cursor
 *    and the click respectively.
 *  - A click before the input start: that is the prompt itself, not text.
 */
export function movementFor(ctx: MoveContext): string | null {
  const { click, cursor, prompt, cols } = ctx
  if (!ctx.normalScreen || ctx.mouseReporting) return null
  if (prompt.running) return null
  if (prompt.inputRow === null || prompt.inputCol === null) return null
  /**
   * The terminal was resized since the mark was taken.
   *
   * A resize rewraps the buffer, so the absolute row the mark recorded no longer
   * points at the same text and the arithmetic below would measure from the
   * wrong origin. The width is stored ON the mark rather than passed separately,
   * so there is one source of truth for "when was this taken". The next prompt
   * records a fresh mark, which makes doing nothing cost one keystroke of
   * patience.
   */
  if (prompt.cols !== null && prompt.cols !== cols) return null

  // Offsets from the start of input, in characters, treating the input as one
  // logical line that wrapped. This is what makes a multi-line prompt and a
  // wrapped command both work: neither the row count nor the prompt's width
  // enters the arithmetic beyond this conversion.
  const offset = (row: number, col: number): number =>
    (row - (prompt.inputRow as number)) * cols + (col - (prompt.inputCol as number))

  const target = offset(click.row, click.col)
  const current = offset(cursor.row, cursor.col)

  // Before the input start: the click was on the prompt, not on anything the
  // user typed.
  if (target < 0) return null
  const delta = target - current
  if (delta === 0) return null
  /**
   * A sanity bound on how far one click may move.
   *
   * Without it a click at the far end of a long scrollback produced hundreds of
   * thousands of arrow keys — a single write of megabytes into the pty, which
   * the shell then processes one keystroke at a time. Any real edit is within a
   * screen or two of the cursor; a delta beyond that means the marks and the
   * screen disagree, and the safe response to that is to do nothing.
   */
  if (Math.abs(delta) > cols * 8) return null

  // DECCKM decides the form. This is not a bail-out condition — an application
  // that set it still wants arrows, it wants them spelled the other way, and
  // sending the wrong form prints letters into the line instead of moving.
  // Written as `\x1b` escapes rather than literal ESC bytes. A raw control
  // character in a source file survives today and is invisible in review, but
  // any formatter or editor that normalises it away would leave this sending
  // the literal text `[D` — which types two characters into the user's shell
  // instead of moving the cursor, silently.
  const left = ctx.applicationCursorKeys ? '\x1bOD' : '\x1b[D'
  const right = ctx.applicationCursorKeys ? '\x1bOC' : '\x1b[C'
  return (delta > 0 ? right : left).repeat(Math.abs(delta))
}

/**
 * Whether a pointer gesture was a click rather than the start of a selection.
 *
 * Anything past a few pixels is a drag, and a drag is a selection — hijacking
 * it would make text unselectable, which is a much worse regression than
 * click-to-move is an improvement.
 */
export function isClickNotDrag(
  down: { x: number; y: number },
  up: { x: number; y: number },
  threshold = 4
): boolean {
  return Math.abs(up.x - down.x) <= threshold && Math.abs(up.y - down.y) <= threshold
}
