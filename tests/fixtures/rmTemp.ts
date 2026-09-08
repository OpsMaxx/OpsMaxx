import { rmSync } from 'node:fs'

/**
 * Remove a test's temp root, tolerating a directory that is still being
 * written to.
 *
 * The supervisor writes `<runId>.pid` under its runRoot when it spawns and
 * unlinks it when a run goes terminal, and does both fire-and-forget —
 * `void unlink(...)` in `goTerminal`, a `.catch()`-swallowed `writeFile` in
 * `writePidRecord`. Neither is awaitable from a test, so a write can still be
 * in flight when teardown runs. `fs.promises` work executes on libuv's
 * threadpool, so it proceeds *in parallel* with a synchronous `rmSync` on the
 * main thread: the walk empties a directory, a queued write puts a file back,
 * and the `rmdir` fails ENOTEMPTY.
 *
 * `force: true` does not cover this — it suppresses missing paths, not
 * repopulated ones. Neither does `maxRetries`, which is the tempting fix and
 * measurably useless here: `rmSync` is synchronous, so its internal retries
 * cannot yield to let the pending writes finish. Measured over 40 attempts
 * with four writes in flight: `maxRetries: 5` failed 20 times, the loop below
 * failed none. The `await` is the entire difference.
 */
export async function rmTemp(root: string, attempts = 10): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (i >= attempts - 1 || code !== 'ENOTEMPTY') throw err
      // Yields, so the queued threadpool writes can land before the next try.
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}
