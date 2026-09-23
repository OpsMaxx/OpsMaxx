import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WsEvent, WsFrame as WireFrame } from '../src/shared/httpSocket'
import { maskProtocol, protocolCarriesCredential } from '../src/shared/apiModel'
import {
  FULL_FRAME_BYTES,
  MAX_FRAMES,
  MAX_RING_BYTES,
  compact,
  newRing,
  pushFrame,
  resetWsSessionsForTests,
  shownProtocol,
  toFrame,
  useWsSessions,
  utf8Length,
  windowFor
} from '../src/renderer/src/store/wsSessions'

// The WebSocket log's memory and render bounds (ARCH-M6, M7): 5,000 frames AND
// 32 MiB per tab, oldest out first; full bytes only up to 64 KiB; and a flood
// reaches React once per animation frame, not once per frame.

const wire = (data: string | ArrayBuffer, direction: WireFrame['direction'] = 'incoming'): WireFrame => ({
  direction,
  opcode: typeof data === 'string' ? 'text' : 'binary',
  data,
  at: 1_700_000_000_000
})

describe('the ring', () => {
  it('keeps at most 5,000 frames, dropping the oldest and counting them', () => {
    const ring = newRing()
    for (let i = 1; i <= MAX_FRAMES + 7; i++) pushFrame(ring, toFrame(wire(`m${i}`), i))
    const frames = compact(ring)
    expect(frames).toHaveLength(MAX_FRAMES)
    expect(frames[0].preview).toBe('m8')
    expect(frames.at(-1)!.preview).toBe(`m${MAX_FRAMES + 7}`)
    expect(ring.stats.dropped).toBe(7)
  })

  it('keeps at most 32 MiB, whatever the frame count', () => {
    const ring = newRing()
    const big = 'x'.repeat(FULL_FRAME_BYTES)
    const n = MAX_RING_BYTES / FULL_FRAME_BYTES + 40
    for (let i = 1; i <= n; i++) pushFrame(ring, toFrame(wire(big), i))
    const frames = compact(ring)
    expect(frames).toHaveLength(MAX_RING_BYTES / FULL_FRAME_BYTES)
    expect(frames[0].id).toBe(41)
    expect(ring.bytes).toBeLessThanOrEqual(MAX_RING_BYTES)
    expect(ring.stats.dropped).toBe(40)
  })

  it('counts a frame over 64 KiB as its 64 KiB preview, not its size', () => {
    const ring = newRing()
    for (let i = 1; i <= 600; i++) pushFrame(ring, toFrame(wire('y'.repeat(200 * 1024)), i))
    // 600 × 64 KiB is 37.5 MiB of previews: the byte cap bites, not the count.
    expect(compact(ring)).toHaveLength(512)
  })

  it('keeps full bytes only for frames of 64 KiB or less', () => {
    const small = toFrame(wire('a'.repeat(FULL_FRAME_BYTES)), 1)
    expect(small.text).toHaveLength(FULL_FRAME_BYTES)

    const large = toFrame(wire('b'.repeat(FULL_FRAME_BYTES + 1)), 2)
    expect(large.text).toBeUndefined()
    expect(large.preview).toHaveLength(FULL_FRAME_BYTES)
    expect(large.size).toBe(FULL_FRAME_BYTES + 1)

    const bin = toFrame(wire(new ArrayBuffer(FULL_FRAME_BYTES + 1)), 3)
    expect(bin.bytes).toBeUndefined()
    expect(bin.binary).toBe(true)
    expect(bin.size).toBe(FULL_FRAME_BYTES + 1)
    expect(toFrame(wire(new ArrayBuffer(16)), 4).bytes?.byteLength).toBe(16)
  })

  it('measures text in UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('€')).toBe(3)
    expect(utf8Length('😀')).toBe(4)
    expect(toFrame(wire('😀'), 1).size).toBe(4)
  })
})

describe('the flush', () => {
  let frameCallbacks: (() => void)[]
  let emit: (event: WsEvent) => void

  beforeEach(async () => {
    frameCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frameCallbacks.push(cb))
    vi.stubGlobal('window', {
      opsmaxx: {
        httpSocket: {
          open: async () => ({ ok: true, id: 'sock-1', protocol: '' }),
          send: async () => ({ ok: true }),
          close: async () => {},
          onEvent: (_id: string, cb: (e: WsEvent) => void) => {
            emit = cb
            return () => {}
          }
        }
      }
    })
    await useWsSessions.getState().connect('tab-1', { url: 'ws://127.0.0.1:9/', via: { kind: 'direct' } })
    frameCallbacks.splice(0).forEach((cb) => cb())
  })

  afterEach(() => {
    resetWsSessionsForTests()
    useWsSessions.setState({ sessions: {}, composers: {} })
    vi.unstubAllGlobals()
  })

  it('batches a burst of frames into one setState on the next animation frame', () => {
    const before = useWsSessions.getState().sessions['tab-1']
    expect(before.state).toBe('open')
    const setStates = vi.fn()
    const stop = useWsSessions.subscribe(setStates)

    for (let i = 0; i < 1_000; i++) emit({ type: 'frame', frame: wire(`f${i}`) })
    expect(setStates).not.toHaveBeenCalled()
    expect(frameCallbacks).toHaveLength(1)

    frameCallbacks.splice(0).forEach((cb) => cb())
    expect(setStates).toHaveBeenCalledTimes(1)
    const after = useWsSessions.getState().sessions['tab-1']
    expect(after.version).toBe(before.version + 1)
    expect(after.stats.received).toBe(1_000)
    stop()
  })

  it('reports eviction in the session counters, which the log shows as "N older frames dropped"', () => {
    for (let i = 0; i < MAX_FRAMES + 25; i++) emit({ type: 'frame', frame: wire(`f${i}`) })
    frameCallbacks.splice(0).forEach((cb) => cb())
    const ring = useWsSessions.getState().ringFor('tab-1')
    expect(ring).toHaveLength(MAX_FRAMES)
    // The 'Connecting…' and 'Connected' system rows went first.
    expect(useWsSessions.getState().sessions['tab-1'].stats.dropped).toBe(27)
    expect(ring.at(-1)!.preview).toBe(`f${MAX_FRAMES + 24}`)
  })
})

describe('windowFor', () => {
  it('returns the rows in view plus overscan, clamped to the list', () => {
    expect(windowFor(0, 280, 28, 1000, 8)).toEqual({ start: 0, end: 18 })
    expect(windowFor(28 * 100, 280, 28, 1000, 8)).toEqual({ start: 92, end: 118 })
    expect(windowFor(28 * 995, 280, 28, 1000, 8)).toEqual({ start: 987, end: 1000 })
    expect(windowFor(0, 280, 28, 0)).toEqual({ start: 0, end: 0 })
    expect(windowFor(-50, 280, 28, 5, 0)).toEqual({ start: 0, end: 5 })
    expect(windowFor(28 * 2000, 280, 28, 10, 2)).toEqual({ start: 10, end: 10 })
  })
})

describe('subprotocols that carry a credential', () => {
  it('recognises the Kubernetes bearer form, and not an ordinary subprotocol', () => {
    expect(protocolCarriesCredential('base64url.bearer.authorization.k8s.io.ZXlKaGJHY2lPaUp')).toBe(true)
    expect(protocolCarriesCredential('graphql-ws')).toBe(false)
    expect(protocolCarriesCredential('v2.json')).toBe(false)
    expect(protocolCarriesCredential('{{k8sToken}}')).toBe(false)
  })

  it('masks the token and keeps the name readable', () => {
    expect(maskProtocol('base64url.bearer.authorization.k8s.io.ZXlKaGJHY2lPaUp')).toBe('base64url.bearer.authorization.•••')
    expect(maskProtocol('x.token')).toBe('x.•••')
    expect(maskProtocol('graphql-ws')).toBe('graphql-ws')
  })
})

describe('the subprotocol the server chose, as shown', () => {
  it('shows a protocol name, masks a credential-shaped one, and hides anything else', () => {
    expect(shownProtocol('graphql-transport-ws')).toBe('graphql-transport-ws')
    expect(shownProtocol('v12.stomp')).toBe('v12.stomp')
    expect(shownProtocol('base64url.bearer.authorization.k8s.io.ZXlKaGJHY2lPaUp')).toBe('base64url.bearer.authorization.•••')
    // A server echoing a vault-resolved raw token: no sensitive part to key
    // on, so the whole value goes.
    expect(shownProtocol('eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop')).toBe('•••')
    expect(shownProtocol('sk_' + 'live_51Habcdefghijklmnopqrstuv')).toBe('•••')
  })
})
