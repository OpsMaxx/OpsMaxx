import { join } from 'node:path'
import { open } from 'node:fs/promises'

/**
 * A file name that came from the other end of a download, made safe to create
 * in the folder the user picked.
 *
 * The name is the remote side's choice, and nothing stops a server from
 * listing a file called `..\..\Startup\x.bat` — a legal name on Linux, a path
 * on Windows. So every separator either platform recognises splits the name,
 * `.` and `..` segments are dropped, and what is left is joined back with `_`.
 * Control characters go; the characters Windows refuses become `_`; trailing
 * dots and spaces, which Windows silently strips, are removed so the name that
 * is written is the name that was checked. A device name (CON, NUL, COM1,
 * COM¹, CONIN$…) opens the device rather than a file on Windows, so it is
 * prefixed.
 *
 * Null when nothing usable is left, rather than an invented name the user
 * would not recognise.
 */
export function safeLocalName(remote: string): string | null {
  const name = remote
    // C0 and C1 controls, and format characters: U+202E turns
    // `invoice\u202Egpj.exe` into what a file manager shows as invoiceexe.jpg,
    // and zero-width ones make two different names look the same.
    // eslint-disable-next-line no-control-regex -- matching them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, '')
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .join('_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/[. ]+$/, '')
  if (name === '' || /^\.+$/.test(name)) return null
  return /^(con|prn|aux|nul|conin\$|conout\$|com[\d¹²³]|lpt[\d¹²³])(\.|$)/i.test(name) ? `_${name}` : name
}

/**
 * Create an empty file for `name` in `dir` and return its path, without ever
 * replacing something already there.
 *
 * `wx` fails if the path exists — including as a symlink — so the check and
 * the create are one step and nothing can appear between them. A clash takes
 * the next free `name (n).ext`, the way a browser saves a second copy.
 */
export async function reserveLocalFile(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 0; n < 1000; n++) {
    const candidate = join(dir, n === 0 ? name : `${stem} (${n})${ext}`)
    try {
      await (await open(candidate, 'wx')).close()
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`a thousand files named like ${name} are already in that folder`)
}
