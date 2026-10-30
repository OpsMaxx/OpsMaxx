import { randomBytes } from 'node:crypto'
import type { Client, SFTPWrapper } from 'ssh2'
import { LocalizedError } from '../../shared/i18n'

/**
 * An image from this computer's clipboard, put where a program on the server
 * can read it.
 *
 * Claude Code takes an image paste by reading the clipboard of the machine it
 * runs on. Over SSH that is the server, which has never seen anything copied
 * here, so Ctrl+V there finds nothing. It also takes a pasted PATH to an image
 * file -- anything ending .png, .jpg, .gif or .webp -- and reads the file the
 * moment the path lands. So the terminal writes the image to the server over
 * its own connection, the one the user opened, and pastes the path instead.
 *
 * Each paste gets a directory of its own under /tmp, made with mode 0700 by an
 * SFTP mkdir that fails if the name exists, holding one 0600 file opened with
 * O_EXCL. Nothing another account planted in /tmp can be followed or written
 * through, and nobody but the logged-in account can read the image. The
 * terminal removes it when it closes.
 */

/** Bigger than any screenshot; small enough that a stray paste is not a long upload. */
export const PASTED_IMAGE_MAX_BYTES = 20 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** What main will write: PNG bytes, as Electron's clipboard hands them over, and no more than the cap. */
export function isPastableImage(png: unknown): png is Uint8Array {
  return (
    png instanceof Uint8Array &&
    png.byteLength > PNG_SIGNATURE.length &&
    png.byteLength <= PASTED_IMAGE_MAX_BYTES &&
    PNG_SIGNATURE.every((b, i) => png[i] === b)
  )
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))))
}

const step = (run: (cb: (err?: Error | null) => void) => void): Promise<void> =>
  new Promise((resolve, reject) => run((err) => (err ? reject(err) : resolve())))

/** Write the image to the server and return the path to paste. */
export async function uploadPastedImage(client: Client, png: Uint8Array): Promise<string> {
  const dir = `/tmp/opsmaxx-paste-${randomBytes(8).toString('hex')}`
  const path = `${dir}/clipboard.png`
  let sftp: SFTPWrapper
  try {
    sftp = await openSftp(client)
  } catch (err) {
    throw new LocalizedError('main.pastedImage.noSftp', { detail: String((err as Error).message ?? err) })
  }
  try {
    await step((cb) => sftp.mkdir(dir, { mode: 0o700 }, cb))
    await step((cb) => sftp.writeFile(path, Buffer.from(png), { mode: 0o600, flag: 'wx' }, cb))
    return path
  } catch (err) {
    // Half a paste is still a file on someone's server.
    await step((cb) => sftp.rmdir(dir, cb)).catch(() => undefined)
    throw new LocalizedError('main.pastedImage.writeFailed', { detail: String((err as Error).message ?? err) })
  } finally {
    sftp.end()
  }
}

/** Remove what uploadPastedImage wrote. Never throws: the connection may already be gone. */
export async function removePastedImages(client: Client, paths: string[]): Promise<void> {
  let sftp: SFTPWrapper
  try {
    sftp = await openSftp(client)
  } catch {
    return
  }
  for (const path of paths) {
    await step((cb) => sftp.unlink(path, cb)).catch(() => undefined)
    await step((cb) => sftp.rmdir(path.slice(0, path.lastIndexOf('/')), cb)).catch(() => undefined)
  }
  sftp.end()
}
