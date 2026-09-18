import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveBundledBinary, BundledBinaryError } from '../bundledBinary'
import type { AddyErrorCode } from '../../../shared/addy'

/**
 * The addyd sidecar, as main talks to it.
 *
 * NDJSON over stdio, responses matched to requests by id, events distinguished
 * from responses purely by the ABSENCE of an id. That is netd's protocol
 * verbatim and the copying is deliberate: the two sidecars should not have two
 * slightly different framings for one reader to hold in their head.
 *
 * THE SPLIT THIS CLIENT EXISTS TO KEEP. addyd --crypto holds the account key
 * and never links a WebRTC stack; main holds the HTTP client, the proxy
 * configuration and the certificate store and never holds a key. What crosses
 * the pipe is a method, a path and a body hash going one way and a signature
 * coming back -- never a key, never a socket.
 */

export class AddyError extends Error {
  constructor(
    readonly code: AddyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AddyError'
  }
}

interface Frame {
  id?: string
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string }
  event?: string
  data?: unknown
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface AddySidecar {
  send<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  close(): Promise<void>
  alive(): boolean
}

/**
 * Spawns `addyd --crypto`.
 *
 * Through the manifest-verifying resolver, like every other bundled binary:
 * the process that is about to be handed the account key is the last one that
 * should be started without checking its bytes.
 */
export async function openAddyd(log?: (line: string) => void): Promise<AddySidecar> {
  let resolved
  try {
    resolved = await resolveBundledBinary('addyd', 'npm run build:addyd')
  } catch (err) {
    if (err instanceof BundledBinaryError) {
      throw new AddyError('relay-unreachable', err.message)
    }
    throw err
  }

  const child: ChildProcessWithoutNullStreams = spawn(resolved.path, ['--crypto'], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const pending = new Map<string, Pending>()
  let seq = 0
  let closed = false
  let buffer = ''

  const settleAll = (err: Error): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  const handleLine = (line: string): void => {
    const text = line.trim()
    if (!text) return
    let frame: Frame
    try {
      frame = JSON.parse(text) as Frame
    } catch {
      // stdout is protocol-only and the sidecar routes its own logging through
      // a `log` EVENT, so a line here is something written before main() ran
      // -- a runtime warning, usually. Worth keeping rather than dropping.
      log?.(text)
      return
    }

    // Events carry no id. That absence IS the distinction, and it is the one
    // part of this protocol a reader must not have to guess at.
    if (frame.id === undefined) {
      if (frame.event === 'log' && typeof frame.data === 'object' && frame.data) {
        const d = frame.data as { level?: string; message?: string }
        log?.(`[addyd ${d.level ?? 'info'}] ${d.message ?? ''}`)
      }
      return
    }

    const held = pending.get(frame.id)
    if (!held) return
    pending.delete(frame.id)
    clearTimeout(held.timer)

    if (frame.ok) {
      held.resolve(frame.result)
      return
    }
    // A code the renderer's union does not know becomes `internal`, the same
    // downgrade the sidecar applies on its own side. A typo'd constant must
    // not be able to reach the UI as a code nothing handles.
    const code = (frame.error?.code ?? 'internal') as AddyErrorCode
    held.reject(new AddyError(code, frame.error?.message ?? 'the sidecar failed without saying why'))
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => log?.(chunk.trimEnd()))

  child.on('exit', (code, signal) => {
    closed = true
    // Every outstanding request fails with a reason. A sidecar that dies
    // leaving promises unsettled is a backup that hangs rather than fails, and
    // a hang is the one failure nobody gets an error report for.
    settleAll(
      new AddyError(
        'internal',
        `addyd exited (${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`})`
      )
    )
  })
  child.on('error', (err) => {
    closed = true
    settleAll(new AddyError('internal', `addyd could not start: ${err.message}`))
  })

  return {
    alive: () => !closed,
    send<T>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
      if (closed) return Promise.reject(new AddyError('internal', 'addyd is not running'))
      const id = String(++seq)
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          // The id is NOT reused after a timeout. A late reply to a timed-out
          // request must not be able to resolve the next one, which is what an
          // id counter that wrapped or was recycled would allow.
          reject(new AddyError('internal', `addyd did not answer ${method} within ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      settleAll(new AddyError('internal', 'addyd was stopped'))
      return new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        // stdin EOF is the sidecar's own shutdown signal -- it treats a closed
        // parent as "stop", which is the orphan safety net. SIGKILL after a
        // grace period, because a wedged child must never hold the app open.
        child.stdin.end()
        const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
        kill.unref?.()
      })
    }
  }
}
