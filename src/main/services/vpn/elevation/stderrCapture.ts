import { StringDecoder } from 'node:string_decoder'
import type { ChildProcess } from 'node:child_process'
import { redactOutput } from '../../secretRedaction'

/** Buffer a privileged child's stderr, redacted, to a fixed ceiling.
 *
 *  **Redact, then cap — in that order, on every chunk.** SECURITY.md states the
 *  rule for the credential proxy and this is the other place it has to hold:
 *  capping first can cut the END marker off a PEM block, after which the
 *  private-key pattern matches nothing and the body is stored as prose.
 *  Measured against the accumulator this replaces: 5.4 KiB of openvpn chatter
 *  followed by an OpenSSH private key delivered in 4 KiB chunks left 42 of 52
 *  64-character lines of key material in the buffer, unredacted, because the
 *  8 KiB cut landed between the two markers. Same input through this: none.
 *
 *  The cap is applied *after* the append, which is the other half of the same
 *  bug. A `length < cap` test in front of `+=` is not a cap: one 64 KiB chunk
 *  arriving on an empty buffer passed it and stored all 64 KiB.
 *
 *  Why re-redacting the whole buffer per chunk is correct rather than just
 *  lazy: a key split across chunks has its body wiped by the unterminated-PEM
 *  rule on the chunk that carries the BEGIN marker, and the complete-block rule
 *  collapses the pair once the END marker arrives. Neither needs the raw text
 *  to still be there. Nothing unredacted is ever held longer than one chunk.
 *
 *  ponytail: O(buffer x chunks) — 8 KiB re-scanned per chunk on a failure path
 *  that runs once per connect. Redact incrementally only if that ever shows up
 *  in a profile. */
export function captureStderr(child: ChildProcess, cap: number): () => string {
  const decoder = new StringDecoder('utf8')
  let text = ''
  let full = false
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (full) return
    // StringDecoder rather than String(chunk): a pipe splits where it likes, and
    // decoding each half on its own turns a UTF-8 sequence straddling the
    // boundary into replacement characters — in a path, a hostname, or the
    // localised error text that is the whole reason this is captured.
    text = redactOutput(text + (typeof chunk === 'string' ? chunk : decoder.write(chunk)))
    if (text.length >= cap) {
      // Everything kept is already redacted, so the cut can only land inside
      // redacted text. What follows is dropped rather than rotated: this exists
      // to classify one failure, and the first 8 KiB is where the failure is.
      text = text.slice(0, cap)
      full = true
    }
  })
  return () => text
}
