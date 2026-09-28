import { describe, it, expect } from 'vitest'
import { formatDbCell } from '../src/shared/dbCell'

// The grid used String(v): a JSON column read "[object Object]" and a DATETIME
// read "Mon Sep 28 2026 10:51:20 GMT+0500 (Pakistan Standard Time)".
describe('a database value in a result grid', () => {
  it('shows a JSON column as its JSON, not "[object Object]"', () => {
    expect(formatDbCell({ path: '/sdcard', files: [1, 2] })).toBe('{"path":"/sdcard","files":[1,2]}')
    expect(formatDbCell([{ a: 1 }])).toBe('[{"a":1}]')
  })

  it('shows a date the way the database stores it, in the local time the driver read it in', () => {
    expect(formatDbCell(new Date(2026, 8, 28, 10, 51, 20))).toBe('2026-09-28 10:51:20')
    expect(formatDbCell(new Date(2026, 8, 28, 10, 51, 20, 7))).toBe('2026-09-28 10:51:20.007')
    expect(formatDbCell({ at: new Date(2026, 0, 2, 3, 4, 5) })).toBe('{"at":"2026-01-02 03:04:05"}')
  })

  it('shows binary as hex and caps a large blob', () => {
    expect(formatDbCell(new Uint8Array([0, 255, 16]))).toBe('0x00ff10')
    expect(formatDbCell(new Uint8Array(100))).toMatch(/^0x(00){64}… \(100 bytes\)$/)
  })

  it('does not throw on a bigint, alone or nested', () => {
    expect(formatDbCell(12345678901234567890n)).toBe('12345678901234567890')
    expect(formatDbCell({ id: 1n })).toBe('{"id":"1"}')
  })

  it('leaves scalars as they were', () => {
    expect(formatDbCell('COMPLETED')).toBe('COMPLETED')
    expect(formatDbCell(1)).toBe('1')
    expect(formatDbCell(false)).toBe('false')
    expect(formatDbCell(null)).toBe('')
  })
})
