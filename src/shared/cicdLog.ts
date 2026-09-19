// What a CI log has to lose before a person can read it.
//
// ---------------------------------------------------------------------------
// JENKINS CONSOLE NOTES
// ---------------------------------------------------------------------------
//
// Jenkins does not store its console as plain text. Anything that wants to
// annotate a line -- the timestamper, the ansicolor plugin, the pipeline step
// boundaries, the "started by" link -- serialises a `ConsoleNote` object,
// base64s it, and splices it INTO the byte stream at the point it applies.
// `hudson/console/ConsoleNote.java` wraps each one in an ANSI "conceal"
// sequence so a terminal hides it:
//
//     PREAMBLE_STR  = ESC [ 8 m h a :
//     <base64 of the serialised note, always beginning `////4` in practice>
//     POSTAMBLE_STR = ESC [ 0 m
//
// A browser is not a terminal and renders none of that, so `/logText/…` output
// arrives with multi-hundred-character base64 blobs interleaved through the
// real output. That is what the operator was looking at.
//
// The preamble is matched EXACTLY, including `ha:`, and the body is matched as
// "anything that is not another escape" rather than as base64: a note whose
// postamble fell outside the byte cap must still go, and a `[^ESC]*` run
// cannot swallow the next note or the next colour code if it does.
//
// ---------------------------------------------------------------------------
// AND THE ORDINARY ANSI UNDERNEATH
// ---------------------------------------------------------------------------
//
// All three providers emit it. Jenkins does when the AnsiColor plugin is on,
// GitLab's job traces are coloured by default, and GitHub's step output carries
// whatever the tool inside it printed. Colour is stripped rather than rendered:
// the pane has no terminal emulator in it, and half-rendered colour is worse
// than none.
//
// This runs on text written by whoever opened the merge request, so it is
// written to have no backtracking hazard: every pattern is anchored on ESC and
// bounded by a character class that excludes ESC.

/** ESC [ 8 m h a : — `ConsoleNote.PREAMBLE_STR`, the exact bytes Jenkins writes. */
// The rule guards against a control character reaching a pattern by accident.
// Here finding one is the entire purpose.
// eslint-disable-next-line no-control-regex
const JENKINS_NOTE = /\[8mha:[^]*(?:\[0m)?/g

/**
 * CSI, OSC and the two-character escapes, in that order.
 *
 * OSC is matched before the single-character fallback so that a title-setting
 * sequence's payload goes with it rather than being left on screen. Its
 * terminator is BEL or ESC-backslash, which is why the body excludes both.
 */
// As above: ESC and BEL are the bytes this exists to remove.
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;:?]*[ -/]*[@-~]|\][^]*(?:|\\)?|[@-Z\\-_]/g

/**
 * A log as it should be shown.
 *
 * Idempotent, and deliberately so: it is applied once in the Jenkins adapter
 * (before the byte cap, so the cap cannot slice a note in half and leave the
 * base64 behind with its preamble gone) and once more at the dispatch in
 * `wiring.ts`, which is the single point every provider's log passes through.
 *
 * `\r` is left alone. A progress bar that redraws itself with carriage returns
 * is still the output the tool produced, and collapsing it here would mean
 * deciding which of the redraws was the real one.
 */
export function cleanCicdLog(text: string): string {
  if (text === '') return ''
  return text.replace(JENKINS_NOTE, '').replace(ANSI, '')
}
