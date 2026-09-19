import { describe, expect, it } from 'vitest'
import { cleanCicdLog } from '../src/shared/cicdLog'
import { createJenkinsAdapter } from '../src/main/services/cicd/jenkins'
import type { CicdHttp, CicdResponse } from '../src/shared/cicd'

/**
 * The fixture is the real escape shape, not a guess at it.
 *
 * `ESC [ 8 m h a :` is `hudson.console.ConsoleNote.PREAMBLE_STR` verbatim, and
 * the base64 below is a capture off a live controller's `/logText/progressiveText`
 * -- which is why it starts `////4` (the note's own magic) and continues into a
 * gzip member (`H4sIAAAAAAAA…`, base64-shifted to `x+LCAAAAAAAAP9…` because the
 * note header offsets it by one byte). A fabricated blob of arbitrary base64
 * would pass a test written against a fabricated matcher; this one would not.
 */
const NOTE_BODY =
  '////4No3DUbI4KFzN+TFo3/HwjJ0OxfCsFf7nX1HhehPMYRGAAAAlx+LCAAAAAAAAP9b85aBtbiIQTGjNKU4P08vOT+vOD8nVc83PyU1L1ioJzMv2y+/JJUBAhiZGBgqihhk0NSjKDXES8xNLClKTC7JzM+zKs4vLUpO1UvOz9VLzs/V80/KSk0usQKqYQGqYWDQAOLiILAZDABnQEXvbAAAAA=='
const note = (): string => `[8mha:${NOTE_BODY}[0m`

describe('cleanCicdLog', () => {
  it('removes a Jenkins console note and keeps the line it was spliced into', () => {
    const raw = `${note()}Started by user Zeeshan\n${note()}[Pipeline] {\n`
    const out = cleanCicdLog(raw)
    expect(out).toBe('Started by user Zeeshan\n[Pipeline] {\n')
    // The base64 is the visible symptom; assert on it directly so a matcher
    // that merely eats the preamble cannot pass.
    expect(out).not.toContain('////4')
    expect(out).not.toContain('ha:')
  })

  it('removes a note whose postamble was cut off by a byte cap', () => {
    const truncated = `[8mha:${NOTE_BODY.slice(0, 40)}`
    expect(cleanCicdLog(`ok\n${truncated}`)).toBe('ok\n')
  })

  it('does not let one note swallow the text between it and the next', () => {
    const raw = `${note()}first\n${note()}second\n`
    expect(cleanCicdLog(raw)).toBe('first\nsecond\n')
  })

  it('strips AnsiColor plugin output around a note', () => {
    const raw = `${note()}[0;31m+ exit 1[0m\n`
    expect(cleanCicdLog(raw)).toBe('+ exit 1\n')
  })

  it('strips the OSC title sequences a build tool writes', () => {
    expect(cleanCicdLog(']0;buildingmake: *** [all] Error 2\n')).toBe(
      'make: *** [all] Error 2\n'
    )
  })

  it('is idempotent, because it is applied twice on the Jenkins path', () => {
    const once = cleanCicdLog(`${note()}npm ERR! code ELIFECYCLE\n`)
    expect(cleanCicdLog(once)).toBe(once)
  })

  it('leaves carriage-return progress output alone', () => {
    // Collapsing it would mean deciding which redraw was the real one.
    expect(cleanCicdLog('10%\r50%\r100%\n')).toBe('10%\r50%\r100%\n')
  })

  it('leaves a log with nothing to strip byte-identical', () => {
    const plain = 'Finished: SUCCESS\n'
    expect(cleanCicdLog(plain)).toBe(plain)
  })
})

/**
 * The adapter, not the helper. The bug the operator saw was in what
 * `getLog` returned, and cleaning after the byte cap would still have passed
 * every assertion above.
 */
describe('the Jenkins adapter cleans before it caps', () => {
  const respond = (body: string, headers: Record<string, string> = {}): CicdHttp => {
    return async (): Promise<CicdResponse> => ({ status: 200, headers, body })
  }

  it('returns the log with the notes gone', async () => {
    const body = `${note()}Started by user Zeeshan\n${note()}Finished: FAILURE\n`
    const adapter = createJenkinsAdapter(respond(body, { 'x-text-size': String(body.length) }), {
      connectionId: 'c1'
    })
    const chunk = await adapter.getLog('job/build', '42', undefined, undefined)
    expect(chunk.text).toBe('Started by user Zeeshan\nFinished: FAILURE\n')
    // The cursor is the SERVER's byte offset into the raw stream and must not
    // be recomputed from the cleaned text, or the next fetch re-reads.
    expect(chunk.cursor).toBe(String(body.length))
  })

  it('caps on what the reader will see, and never mid-note', async () => {
    // Four notes' worth of concealed annotation around 40 characters of real
    // output. A cap applied to the raw bytes would keep the tail of a note and
    // withhold the output; applied to the cleaned text it keeps the output.
    const real = 'line one\nline two\nline three\nline four\n'
    const body = real
      .split('\n')
      .map((l) => (l ? `${note()}${l}\n` : ''))
      .join('')
    const adapter = createJenkinsAdapter(respond(body), {
      connectionId: 'c1',
      maxLogBytes: real.length
    })
    const chunk = await adapter.getLog('job/build', '42', undefined, undefined)
    expect(chunk.text).toBe(real)
    expect(chunk.withheldBytes).toBeUndefined()
  })
})
