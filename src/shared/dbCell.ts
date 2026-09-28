// How one database value is written in a result grid.
//
// The grid used `String(v)`, so every value a driver hands over as an object
// read as its JS coercion rather than its contents: a MySQL or PostgreSQL JSON
// column as "[object Object]", a DATETIME as "Mon Sep 28 2026 10:51:20
// GMT+0500 (Pakistan Standard Time)", a BLOB as a comma-separated byte list.
// One function, used by every grid and the shell, so they cannot disagree.

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

// Binary is shown as hex, capped: a multi-megabyte BLOB in one cell is a frozen
// window, and nobody reads past the first bytes of one anyway.
const BINARY_PREVIEW_BYTES = 64

/**
 * A date as the database shows it: `YYYY-MM-DD HH:MM:SS`, plus `.mmm` only
 * when there are milliseconds.
 *
 * In local time, because that is how mysql2 and pg built the Date from a
 * zone-less DATETIME/TIMESTAMP in the first place -- formatting it back in
 * local time returns exactly the value stored. UTC here would shift every such
 * value by the machine's offset.
 */
function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Invalid date'
  const ms = d.getMilliseconds()
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    (ms ? `.${pad(ms, 3)}` : '')
  )
}

function formatBinary(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes.subarray(0, BINARY_PREVIEW_BYTES)) hex += b.toString(16).padStart(2, '0')
  return `0x${hex}${bytes.length > BINARY_PREVIEW_BYTES ? `… (${bytes.length} bytes)` : ''}`
}

/** A cell's text. `null` and `undefined` are the caller's to render (NULL, blank, a dash). */
export function formatDbCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return formatDate(v)
  // A Buffer arrives across IPC as a plain Uint8Array.
  if (v instanceof Uint8Array) return formatBinary(v)
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object') {
    try {
      // Nested dates keep the same form as a top-level one, and a bigint --
      // which JSON.stringify throws on -- is written as its digits.
      return JSON.stringify(v, function (key, value) {
        const raw = (this as Record<string, unknown>)[key]
        if (raw instanceof Date) return formatDate(raw)
        return typeof value === 'bigint' ? value.toString() : value
      })
    } catch {
      return String(v)
    }
  }
  return String(v)
}
