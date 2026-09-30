import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import type { SshHop } from '../../shared/ssh'

/**
 * A stand-in for an ssh2 Client, for the screenshot demo only.
 *
 * Every SSH feature dials through ssh.ts's connectClient, so answering there
 * lets the real renderer, the real IPC handlers and the real parsers run
 * against invented hosts. It implements exactly what ssh.ts, sftp.ts and
 * metrics.ts call -- exec, shell, sftp, end, and the close/error events -- and
 * nothing more; anything else is logged, so a new caller shows up in a dev
 * run's console rather than as a silent empty panel.
 */

const warned = new Set<string>()

export interface DemoFile {
  name: string
  dir?: boolean
  size?: number
  /** Days ago, for the mtime column. */
  ageDays?: number
}

export interface Responder {
  /** Output of a non-interactive command. Unknown commands answer '' and are logged. */
  exec(host: SshHop, command: string): { stdout: string; code: number }
  /** One line typed at the demo shell. */
  shell(host: SshHop, line: string): string
  /** The directory listing SFTP shows. */
  files(host: SshHop, path: string): DemoFile[] | null
  home(host: SshHop): string
  prompt(host: SshHop, cwd: string): string
}

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
  write(_data: unknown): boolean {
    return true
  }
  end(): void {
    this.close()
  }
  setWindow(): void {}
  signal(): void {}
  close(): void {
    setImmediate(() => this.emit('close', 0, null))
  }
}

function execChannel(stdout: string, code: number): FakeChannel {
  const ch = new FakeChannel()
  setImmediate(() => {
    if (stdout) ch.emit('data', Buffer.from(stdout))
    ch.emit('exit', code, null)
    ch.emit('close', code, null)
  })
  return ch
}

/** An interactive shell: echoes keystrokes, answers each line from the responder. */
function shellChannel(host: SshHop, r: Responder): FakeChannel {
  const ch = new FakeChannel()
  let line = ''
  const cwd = r.home(host)
  const out = (s: string): void => {
    ch.emit('data', Buffer.from(s))
  }
  ch.write = (data: unknown): boolean => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    for (const c of text) {
      if (c === '\r' || c === '\n') {
        out('\r\n')
        const reply = r.shell(host, line.trim())
        if (reply) out(reply.replace(/\r?\n/g, '\r\n') + '\r\n')
        line = ''
        out(r.prompt(host, cwd))
      } else if (c === '\x7f') {
        if (line) {
          line = line.slice(0, -1)
          out('\b \b')
        }
      } else if (c >= ' ') {
        line += c
        out(c)
      }
    }
    return true
  }
  setImmediate(() => out(r.prompt(host, cwd)))
  return ch
}

function fakeSftp(host: SshHop, r: Responder): unknown {
  const now = Math.floor(Date.now() / 1000)
  const attrsFor = (f: DemoFile): { mode: number; size: number; mtime: number } => ({
    mode: f.dir ? 0o040755 : 0o100644,
    size: f.size ?? (f.dir ? 4096 : 0),
    mtime: now - Math.round((f.ageDays ?? 0) * 86_400)
  })
  return {
    realpath: (_p: string, cb: (err: Error | undefined, abs: string) => void) =>
      setImmediate(() => cb(undefined, r.home(host))),
    readdir: (path: string, cb: (err: Error | undefined, list: unknown[]) => void) =>
      setImmediate(() => {
        const files = r.files(host, path)
        if (!files) return cb(new Error('No such file'), [])
        cb(
          undefined,
          files.map((f) => ({ filename: f.name, longname: '', attrs: attrsFor(f) }))
        )
      }),
    lstat: (_p: string, cb: (err: Error | undefined, a: unknown) => void) =>
      setImmediate(() => cb(undefined, attrsFor({ name: '', dir: true }))),
    end: () => undefined
  }
}

export function fakeClient(host: SshHop, r: Responder): Client {
  const c = new EventEmitter() as EventEmitter & Record<string, unknown>
  let ended = false
  c.exec = (command: string, optsOrCb: unknown, maybeCb?: unknown): void => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (
      err: Error | undefined,
      stream: FakeChannel
    ) => void
    const { stdout, code } = r.exec(host, command)
    setImmediate(() => cb(undefined, execChannel(stdout, code)))
  }
  c.shell = (_pty: unknown, cb: (err: Error | undefined, stream: FakeChannel) => void): void => {
    setImmediate(() => cb(undefined, shellChannel(host, r)))
  }
  c.sftp = (cb: (err: Error | undefined, sftp: unknown) => void): void => {
    setImmediate(() => cb(undefined, fakeSftp(host, r)))
  }
  c.end = (): void => {
    if (ended) return
    ended = true
    setImmediate(() => c.emit('close'))
  }
  c.destroy = c.end
  // Unknown properties are reported, not thrown: `then` is probed by every
  // promise that resolves with this object, and ssh.ts reads a few optional
  // internals. A property somebody actually calls shows up in the log.
  return new Proxy(c, {
    get(target, prop) {
      if (prop in target || typeof prop === 'symbol' || prop === 'then') {
        return Reflect.get(target, prop)
      }
      if (!warned.has(prop)) {
        warned.add(prop)
        console.warn(`[demo] SSH client property not faked: ${prop}`)
      }
      return undefined
    }
  }) as unknown as Client
}
