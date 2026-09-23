import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog } from 'electron'

vi.mock('../src/main/services/ssh', () => ({ acquire: vi.fn(), release: vi.fn() }))
const { saveResponse, safeFileName } = await import('../src/main/services/httpClient')

describe('http:saveResponse', () => {
  it.each([
    ['../../.zshrc', '.zshrc'],
    ['/etc/x', 'x'],
    ['..\\..\\evil.bat', 'evil.bat'],
    ['a‮fdp.exe', 'afdp.exe'],
    ['re\u0000port\n.json', 'report.json'],
    ['..', 'response'],
    ['', 'response']
  ])('offers %j as %j', (input, expected) => {
    expect(safeFileName(input)).toBe(expected)
  })

  it('starts the dialog in Downloads and writes the bytes unmodified where the user chose', async () => {
    const target = join(app.getPath('userData'), 'saved.bin')
    const show = vi.fn(async (_opts: { defaultPath: string }) => ({ canceled: false, filePath: target }))
    dialog.showSaveDialog = show as never
    const bytes = new Uint8Array([0, 1, 2, 0xff, 0x1f, 0x8b]).buffer
    expect(await saveResponse(null, '../../.zshrc', bytes)).toBe(target)
    expect(show.mock.calls[0][0].defaultPath).toBe(join(app.getPath('downloads'), '.zshrc'))
    expect([...readFileSync(target)]).toEqual([0, 1, 2, 0xff, 0x1f, 0x8b])
  })

  it('writes nothing when dismissed, and refuses what is not bytes', async () => {
    dialog.showSaveDialog = (async () => ({ canceled: true })) as never
    expect(await saveResponse(null, 'x', new ArrayBuffer(1))).toBeNull()
    await expect(saveResponse(null, 'x', 'not bytes')).rejects.toThrow()
  })
})
