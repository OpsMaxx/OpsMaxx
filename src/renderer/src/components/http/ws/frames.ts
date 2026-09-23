import type { WsFrame } from '../../../store/wsSessions'

// Pure helpers for showing a frame. Every one returns text for a React text
// node; nothing a server sent is ever parsed as markup.

export type LogFilter = 'all' | 'out' | 'in' | 'system'

export const dirLabel = (f: WsFrame): string =>
  f.dir === 'out' ? 'Sent' : f.dir === 'in' ? 'Received' : f.error ? 'Error' : 'System'

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** HH:MM:SS.mmm, local time. */
export function stamp(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** What a frame holds as text: the whole of it, or its 64 KiB head, or hex. */
export const frameText = (f: WsFrame): string => f.text ?? f.preview

/** The row's one-line preview. */
export const oneLine = (f: WsFrame): string => f.preview.slice(0, 240).replace(/\s+/g, ' ')

export function prettyJson(text: string): string | null {
  const t = text.trimStart()
  if (t[0] !== '{' && t[0] !== '[') return null
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

export function matches(f: WsFrame, filter: LogFilter, query: string): boolean {
  if (filter !== 'all' && f.dir !== filter) return false
  return query === '' || f.preview.toLowerCase().includes(query)
}

/** How many of `frames` (ids ascending) are newer than `seenId`. */
export function newerThan(frames: readonly WsFrame[], seenId: number): number {
  let lo = 0
  let hi = frames.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid].id > seenId) hi = mid
    else lo = mid + 1
  }
  return frames.length - lo
}

/** The log pane is wide enough to put the detail beside the rows (UX-M10). */
export const detailPlacement = (width: number): 'right' | 'below' => (width >= 560 ? 'right' : 'below')

