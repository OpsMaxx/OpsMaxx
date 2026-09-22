import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ExternalLink,
  Folder,
  File,
  Upload,
  Download,
  FolderPlus,
  ChevronRight,
  Home,
  RefreshCw,
  Search,
  Edit3,
  Trash2,
  Link2,
  Loader2,
  AlertTriangle, CornerLeftUp
} from 'lucide-react'
import { ContextMenu, MenuEntry } from '../connections/ContextMenu'
import { Modal } from '../common/Modal'
import { toast } from '../../store/toast'
import { useApp } from '../../store/app'
import { bytes, clsx } from '../../lib/format'
import { sshHopsFor } from '../../lib/ssh'
import { LOCAL_TARGET } from '../../../../shared/execTarget'
import { REMOTE_CWD_BOOTSTRAP } from '../../../../shared/shellIntegration'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { classifyConnectionError, errorText } from '../../lib/connectionError'
import { openSettings } from '../../store/nav'
import type { Server } from '../../types'
import type { SftpEntry, SftpProgress, SftpResult, SftpUploadSummary, SshAuth } from '../../../../shared/ssh'
import { bridgeOn } from '../../lib/bridge'
import { EmptyState } from '../common/EmptyState'

const asAuth = (a: string): SshAuth => (a === 'password' || a === 'agent' ? a : 'key')

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

// Local paths come from the OS, so they may be Windows-style.
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function mtimeLabel(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.toLocaleString('en-US', { month: 'short' })} ${String(d.getDate()).padStart(2, '0')} ${d
    .toTimeString()
    .slice(0, 5)}`
}

/** Something the user can click about a failure. */
interface Fix {
  label: string
  run: () => void
}

interface SftpFailure {
  message: string
  detail?: string
  fix?: Fix
  retry: Fix
}

const MISSING = /no such file|ENOENT/i

// A file operation that failed, said as a sentence.
//
// "Rename failed" tells the user only that they already know. Which file, in
// which directory, and whether the server said "you may not" or "that is not
// there" is the part that decides what they do next — so that is what this
// says. An error nothing recognises keeps the server's own words: an unhelpful
// string still beats discarding the only evidence there is.
function fileFailure(verb: string, what: string, dir: string, error: string | undefined): string {
  if (classifyConnectionError(error) === 'permission') return `${dir} does not allow you to ${verb} ${what}.`
  if (error && MISSING.test(error)) return `${what} is no longer in ${dir}.`
  return error ? `Could not ${verb} ${what} — ${error}` : `Could not ${verb} ${what}.`
}

// Why the SSH chain behind the Files tab would not come up, and the one screen
// that holds the setting to change.
function connectFailure(
  server: Server,
  error: string | undefined,
  editServer: (id: string) => void,
  retry: Fix
): SftpFailure {
  const fixServer: Fix = { label: `Edit ${server.name}`, run: () => editServer(server.id) }
  const of = (message: string, fix?: Fix): SftpFailure => ({ message, detail: error, fix, retry })

  switch (classifyConnectionError(error)) {
    case 'host-key':
      return of(`${server.name} presented a different host key, so the connection was refused.`, {
        label: 'Review saved keys',
        run: () => openSettings('security')
      })
    case 'key-missing':
      return of(`${server.name}'s private key file is not where the connection says it is.`, fixServer)
    case 'passphrase':
      return of(`${server.name}'s private key needs a passphrase.`, fixServer)
    case 'auth':
      return of(`${server.name} rejected the saved credential.`, fixServer)
    case 'refused':
      return of(`Nothing is listening on ${server.host}:${server.port}.`, fixServer)
    case 'unreachable':
      return of(`${server.host} did not answer in time.`, fixServer)
    default:
      return of(`Could not open files on ${server.name}.`)
  }
}

// Partial files a transfer could not remove, said once with every path.
function reportLeftover(paths: string[] | undefined, where: string): void {
  if (paths?.length)
    toast(`${paths.length === 1 ? 'A partial file' : `${paths.length} partial files`} could not be removed ${where}: ${paths.join(', ')}`, 'error')
}

/** An upload or download waiting for the channel, or on it. */
type Transfer = { kind: 'upload'; paths: string[]; dir: string } | { kind: 'download'; remotes: string[]; dir: string }

type OverwriteAnswer = 'overwrite' | 'skip' | 'cancel'

/**
 * Why the overwrite dialog is up. `exists`: files of these names are there.
 * `unchecked`: the folder could not be listed, so they may be. `dir` and
 * `owner`: main could not replace them with a new copy (see planUpload) and
 * they can only be overwritten in place.
 */
type OverwriteWhy = 'exists' | 'unchecked' | 'dir' | 'owner'

const IN_PLACE_RISK = 'If the transfer fails or is cancelled, the file may be left incomplete.'

// The next few names in the queue, which is what tells the user their drop
// was kept.
function queueNames(queue: Transfer[]): string {
  const names = queue.flatMap((t) => (t.kind === 'upload' ? t.paths.map(baseName) : t.remotes.map(baseName)))
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
}

// ---- Real SFTP -------------------------------------------------------------
function RealSftp({ server, tabId }: { server?: Server; tabId?: string }): React.JSX.Element {
  // Absent server means this machine.
  const local = server === undefined
  // One session per server, as before; one for this machine, shared the same
  // way across every tab showing it.
  const key = server?.id ?? 'local'
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SftpFailure | null>(null)
  const [query, setQuery] = useState('')
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: SftpEntry } | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ path: string; content: string } | null>(null)
  const [progress, setProgress] = useState<SftpProgress | null>(null)
  const [queue, setQueue] = useState<Transfer[]>([])
  const [running, setRunning] = useState<Transfer | null>(null)
  const [overwrite, setOverwrite] = useState<{
    names: string[]
    dir: string
    why: OverwriteWhy
    answer: (a: OverwriteAnswer) => void
  } | null>(null)
  const [dropping, setDropping] = useState(false)
  // Non-null while the breadcrumb is being typed into.
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const editorCommand = useApp((s) => s.settings.externalEditorCommand)
  const preferExternal = useApp((s) => s.settings.openFilesExternally)
  const openServerEditor = useApp((s) => s.openServerEditor)

  // Remote writes triggered by an external save happen in the main process, so
  // the result is reported back here.
  useEffect(() => {
    return bridgeOn('sftp.onExternalSaved', window.opsmaxx?.sftp?.onExternalSaved, (r) => {
      const name = r.remotePath.split('/').pop()
      if (r.ok) toast(`${name} saved to the server`, 'ok')
      // No button: the file is open in the user's own editor, and saving it
      // there again is the retry — one that exists outside this window.
      else if (r.error) toast(`${name} was saved locally but not uploaded — ${r.error}`, 'error')
      else toast(`${name} was saved locally, but uploading it to the server failed.`, 'error')
    })
  }, [])
  const [linked, setLinked] = useState(true)
  const connectedRef = useRef(false)

  // Sync with the terminal: follow its cwd (via OSC 7) and push `cd` when the
  // user navigates here.
  //
  // Both live under the **active pane's** id, not the tab's: a tab holds up to
  // four terminals and "the terminal" this view follows is whichever one has
  // focus. Reading `tabSession[tabId]` — which is what this did while a tab had
  // exactly one session — now matches nothing at all, so the link silently
  // stops working rather than following the wrong pane.
  //
  // And only a pane on *this* server: a tab can hold a local shell beside a
  // remote one, and a local pane's OSC-7 cwd is a path on this machine. Left
  // unfiltered, focusing it would send the browser off to list `/Users/…` on
  // the server and push a `cd` for it down the wrong session.
  const paneId = useApp((s) => {
    const tp = tabId ? s.panes[tabId] : undefined
    const pane = tp?.panes.find((p) => p.id === tp.activePaneId)
    if (!pane) return undefined
    // A local Files view follows a LOCAL pane, and a server's follows a pane on
    // that server. Crossing them would send the browser off to list a path
    // from the wrong machine and push a `cd` down the wrong session.
    if (local) return pane.target.kind === 'local' ? pane.id : undefined
    return pane.target.kind === 'ssh' && pane.target.serverId === server?.id ? pane.id : undefined
  })
  const session = useApp((s) => (paneId ? s.tabSession[paneId] : undefined))
  const termCwd = useApp((s) => (paneId ? s.tabCwd[paneId] : undefined))
  const setTabCwd = useApp((s) => s.setTabCwd)
  // A local shell only reports its directory when the shell-integration snippet
  // was injected at spawn, and that is a setting which ships OFF. Without it
  // there is nothing to follow and no amount of waiting will produce one.
  const integration = useApp((s) => s.settings.shellIntegration === true)

  /**
   * Write to whichever kind of session this pane actually is.
   *
   * This used to be `window.opsmaxx.ssh.write(session, …)` unconditionally. A
   * local pane's session id belongs to the local pty map, so `ssh:write` looked
   * it up among the SSH sessions, found nothing and returned — every `cd` the
   * Files pane pushed to a local shell was dropped in silence.
   */
  const writeToShell = useCallback(
    (data: string): void => {
      if (!session) return
      if (local) window.opsmaxx?.local?.write(session, data)
      else window.opsmaxx?.ssh?.write(session, data)
    },
    [local, session]
  )

  /**
   * Ask a REMOTE shell to report its directory, once per session.
   *
   * A local shell is spawned by this app and gets the OSC 7 emitter through its
   * own startup files (shared/shellIntegration.ts). Nothing spawns the remote
   * one, so the only way in is the channel the user types on — hence a line
   * typed into it, which echoes once. Sent only while following is switched on,
   * so a user who never links never sees it.
   *
   * It cannot be made to work everywhere: the snippet installs a prompt hook in
   * bash and zsh, and deliberately evaluates to nothing in fish or dash rather
   * than erroring there. Those shells report no directory at all, which the
   * link button below has to say out loud.
   */
  const bootstrapped = useRef<string | null>(null)
  useEffect(() => {
    if (local || !linked || !session || bootstrapped.current === session) return
    bootstrapped.current = session
    window.opsmaxx?.ssh?.write(session, REMOTE_CWD_BOOTSTRAP)
  }, [local, linked, session])

  /**
   * Whether following can work here at all, and why not when it cannot.
   *
   * Four distinct states, because they need four different things from the
   * user: there is no terminal to follow; the setting that makes a local shell
   * report is off; the shell has been asked and has not answered; or it works.
   * Collapsing them into an enabled-looking toggle is what made this read as
   * broken — the button was on, the pane never moved, and nothing said why.
   */
  const follow: { can: boolean; why: string; fix?: Fix } = !paneId
    ? {
        can: false,
        why: local
          ? 'No local shell open in this tab to follow. Open one in the terminal beside this pane.'
          : `No terminal on ${server?.name ?? 'this server'} open in this tab to follow.`
      }
    : local && !integration
      ? {
          can: false,
          why: 'Following needs shell integration, which is off. Without it the shell never tells OpsMaxx where it is.',
          fix: { label: 'Turn on shell integration', run: () => openSettings('terminal') }
        }
      : !termCwd
        ? {
            can: true,
            why: local
              ? 'This shell has not reported a directory. zsh, bash and fish report one; cmd, PowerShell and a login bash cannot be asked to.'
              : 'This shell has not reported a directory. OpsMaxx asks bash and zsh to on the first link; other remote shells cannot be asked.'
          }
        : { can: true, why: '' }
  const following = linked && follow.can && !!termCwd

  const cfg = useCallback(
    () =>
      server === undefined
        ? LOCAL_TARGET
        : {
            sessionId: `sftp-${server.id}`,
            serverId: server.id,
            host: server.host,
            port: server.port,
            username: server.username,
            auth: asAuth(server.auth),
            cols: 80,
            rows: 24,
            hops: sshHopsFor(server)
          },
    [server]
  )

  // Any call over this channel can need a credential the vault holds, and the
  // handler rejects rather than returning a result when it is locked. Routing
  // through withVaultUnlock turns that into an unlock dialog and a call that
  // finishes, instead of a promise nobody catches and a spinner that never stops.
  const unlocked = useCallback(
    <T,>(run: () => Promise<T>): Promise<T> =>
      // Nothing on this machine needs a credential the vault holds, so a local
      // browse must not raise an unlock dialog.
      server === undefined
        ? run()
        : withVaultUnlock(`Opening files on ${server.name}`, run),
    [server]
  )

  const list = useCallback(
    async (p: string): Promise<boolean> => {
      setLoading(true)
      setError(null)
      let res: SftpResult<SftpEntry[]> | undefined
      try {
        res = await unlocked(async () => window.opsmaxx?.sftp.list(key, p))
      } catch (err) {
        res = { ok: false, error: errorText(err) }
      }
      if (res?.ok && res.data) {
        setEntries(res.data)
        setPath(p)
        setLoading(false)
        return true
      }
      const detail = res?.error
      const message =
        classifyConnectionError(detail) === 'permission'
          ? `You do not have permission to open ${p}.`
          : detail && MISSING.test(detail)
            ? `${p} is not there any more.`
            : `Could not open ${p}.`
      // A failed step into a directory leaves the last good one loaded, so the
      // way out is back to it rather than a retry that fails the same way.
      setError({
        message,
        detail,
        retry:
          p === path
            ? { label: 'Try again', run: () => void list(p) }
            : { label: `Back to ${path}`, run: () => void list(path) }
      })
      setLoading(false)
      return false
    },
    [key, path, unlocked]
  )

  // Navigate here AND mirror the change to the terminal (cd) when linked.
  const navigate = useCallback(
    async (p: string): Promise<void> => {
      const ok = await list(p)
      if (!ok) return
      if (paneId) setTabCwd(paneId, p)
      if (linked && session) {
        const q = p.replace(/'/g, `'\\''`)
        writeToShell(`cd '${q}'\n`)
      }
    },
    [list, paneId, setTabCwd, linked, session, writeToShell]
  )

  // Opening the channel, and the way back in after it failed. Retrying a failed
  // connect has to redial — listing a key that never connected only produces a
  // second, less recognisable failure.
  const connect = useCallback(
    async (alive: () => boolean): Promise<void> => {
      setLoading(true)
      setError(null)
      let res: SftpResult<{ home: string }> | undefined
      try {
        res = await unlocked(async () => window.opsmaxx?.sftp.connect(key, cfg()))
      } catch (err) {
        res = { ok: false, error: errorText(err) }
      }
      if (!alive()) return
      if (res?.ok) {
        connectedRef.current = true
        // Start where the terminal is, if known; otherwise the SFTP home.
        await list(termCwd || res.data?.home || '/')
        return
      }
      setError(
        // connectFailure names SSH failure modes — a changed host key, a
        // missing private key, a refused credential. None of them can happen
        // opening a folder on this machine, so a local failure is reported as
        // itself rather than dressed as a connection problem.
        server === undefined
          ? {
              message: res?.error ?? 'Could not open files on this machine.',
              retry: { label: 'Try again', run: () => void connect(() => true) }
            }
          : connectFailure(server, res?.error, openServerEditor, {
              label: 'Try again',
              run: () => void connect(() => true)
            })
      )
      setLoading(false)
    },
    // list and termCwd deliberately excluded: this reconnects a channel, and
    // rebuilding it whenever the current directory changes would redial the
    // whole jump chain on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, cfg, unlocked, server, openServerEditor]
  )

  useEffect(() => {
    let alive = true
    void connect(() => alive)
    return () => {
      // Keep the SFTP connection cached in the main process so re-opening the
      // Files tab is instant instead of re-establishing the SSH/jump chain.
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Follow the terminal's cwd when it changes (does not push cd back).
  //
  // `loading` is a dependency, not just a read. A cwd that arrives while a
  // listing is in flight — which is exactly what happens when the pane is
  // connecting and the shell prints its first prompt — was previously tested
  // once against a stale `loading`, dropped, and never re-tested, so the first
  // `cd` after opening the tab was the one most likely to be missed.
  useEffect(() => {
    if (linked && termCwd && connectedRef.current && termCwd !== path && !loading) {
      void list(termCwd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termCwd, linked, loading])

  const open = (e: SftpEntry): void => {
    if (e.dir) void navigate(join(path, e.name))
    else if (preferExternal) void openExternally(e)
    else void openFile(e)
  }

  // Opens in the user's own editor (VS Code by default) and writes the file
  // back on every save, instead of the built-in inline editor.
  const openExternally = async (e: SftpEntry): Promise<void> => {
    const remote = join(path, e.name)
    const r = await window.opsmaxx?.sftp.editExternal(key, remote, editorCommand)
    if (r?.ok) toast(`Opened ${e.name} — saves upload automatically`, 'ok')
    else
      toast(fileFailure('open', e.name, path, r?.error), 'error', {
        label: 'Open here instead',
        run: () => void openFile(e)
      })
  }

  const openFile = async (e: SftpEntry): Promise<void> => {
    if (e.size > 2_000_000) {
      toast(`${e.name} is ${bytes(e.size)} — too large for the editor in this window.`, 'error', {
        label: editorCommand ? `Open in ${editorCommand}` : 'Open in your editor',
        run: () => void openExternally(e)
      })
      return
    }
    const res = await window.opsmaxx?.sftp.read(key, join(path, e.name))
    if (res?.ok) setEditor({ path: join(path, e.name), content: res.data ?? '' })
    // No button: the same read through the external editor goes down the same
    // channel and is refused for the same reason.
    else toast(fileFailure('read', e.name, path, res?.error), 'error')
  }

  const saveFile = async (content: string): Promise<void> => {
    if (!editor) return
    const name = editor.path.split('/').pop() ?? editor.path
    const res = await window.opsmaxx?.sftp.write(key, editor.path, content)
    if (res?.ok) {
      toast(`${name} saved`, 'ok')
      setEditor(null)
    } else
      // The editor stays open, so the retry writes exactly what is still on
      // screen rather than whatever the file happens to hold now.
      toast(fileFailure('save', name, path, res?.error), 'error', {
        label: 'Try again',
        run: () => void saveFile(content)
      })
  }

  const createFolder = async (): Promise<void> => {
    if (!newName.trim()) return setCreating(false)
    const res = await window.opsmaxx?.sftp.mkdir(key, join(path, newName.trim()))
    if (res?.ok) {
      toast(`Created ${newName.trim()}`)
      setNewName('')
      setCreating(false)
      void list(path)
      // The name field stays open behind this, so there is nothing a button
      // would do that the still-focused input does not already offer.
    } else toast(fileFailure('create', newName.trim(), path, res?.error), 'error')
  }

  const doRename = async (from: SftpEntry, to: string): Promise<void> => {
    setRenaming(null)
    if (!to.trim() || to === from.name) return
    const res = await window.opsmaxx?.sftp.rename(key, join(path, from.name), join(path, to.trim()))
    if (res?.ok) void list(path)
    else
      toast(fileFailure('rename', from.name, path, res?.error), 'error', {
        label: 'Rename again',
        run: () => setRenaming(from.name)
      })
  }

  const remove = async (e: SftpEntry): Promise<void> => {
    if (!window.confirm(`Delete ${e.name}? This cannot be undone.`)) return
    const res = await window.opsmaxx?.sftp.remove(key, join(path, e.name), e.dir)
    if (res?.ok) {
      toast(`Deleted ${e.name}`)
      void list(path)
      // Actionless on purpose: the same delete against the same permissions
      // fails the same way, and a button that repeats it is theatre.
    } else toast(fileFailure('delete', e.name, path, res?.error), 'error')
  }

  // Transfer progress is reported from the main process while a transfer runs.
  useEffect(() => {
    return bridgeOn('sftp.onProgress', window.opsmaxx?.sftp?.onProgress, (p) => {
      if (p.key === key) setProgress(p)
    })
  }, [key])

  // The listing on screen when a transfer ends, which is not necessarily the
  // one that was on screen when it was queued.
  const refresh = useRef<() => void>(() => {})
  refresh.current = () => void list(path)

  const askOverwrite = (names: string[], dir: string, why: OverwriteWhy): Promise<OverwriteAnswer> =>
    new Promise((resolve) =>
      setOverwrite({
        names,
        dir,
        why,
        answer: (a) => {
          setOverwrite(null)
          resolve(a)
        }
      })
    )

  const upload = (locals: string[]): void => {
    const paths = locals.filter(Boolean)
    if (paths.length) setQueue((q) => [...q, { kind: 'upload', paths, dir: path }])
  }

  const runUpload = async ({ paths, dir }: { paths: string[]; dir: string }): Promise<void> => {
    // Checked when the upload starts rather than when it was queued: the
    // transfer ahead of it may have just put a file of the same name there.
    // A listing that failed says nothing about what is there, and reading it
    // as "nothing clashes" is how a file gets replaced without a word. Every
    // name is treated as a possible clash instead, and the dialog says why.
    const listing = await window.opsmaxx?.sftp.list(key, dir)
    const unchecked = !listing?.ok
    const there = new Set(unchecked ? paths.map(baseName) : (listing.data ?? []).map((x) => x.name))
    let chosen = paths
    const clashes = paths.map(baseName).filter((n) => there.has(n))
    if (clashes.length) {
      const answer = await askOverwrite(clashes, dir, unchecked ? 'unchecked' : 'exists')
      if (answer === 'cancel') return
      if (answer === 'skip') chosen = paths.filter((p) => !there.has(baseName(p)))
      if (!chosen.length) return
    }
    const send = async (files: string[], inPlace?: string[]): Promise<SftpResult<SftpUploadSummary> | undefined> => {
      // Shown immediately: the first step event only arrives once bytes move.
      setProgress({ key, name: baseName(files[0]), transferred: 0, total: 0, index: 1, count: files.length })
      return window.opsmaxx?.sftp.upload(key, files, dir, inPlace)
    }
    const res = await send(chosen)
    const sum: SftpUploadSummary = {
      uploaded: [...(res?.data?.uploaded ?? [])],
      failed: [...(res?.data?.failed ?? [])],
      cancelled: res?.data?.cancelled,
      leftover: [...(res?.data?.leftover ?? [])],
      incomplete: [...(res?.data?.incomplete ?? [])]
    }
    // Files main could not replace with a new copy go out again, in place —
    // but only once the user has been told what that risks.
    const again = sum.cancelled ? [] : (res?.data?.needsInPlace ?? [])
    const approved: string[] = []
    for (const why of ['dir', 'owner'] as const) {
      const names = again.filter((x) => x.reason === why).map((x) => x.name)
      if (names.length && (await askOverwrite(names, dir, why)) === 'overwrite') approved.push(...names)
    }
    if (approved.length) {
      const second = await send(
        chosen.filter((p) => approved.includes(baseName(p))),
        approved
      )
      sum.uploaded.push(...(second?.data?.uploaded ?? []))
      sum.failed.push(...(second?.data?.failed ?? []))
      sum.leftover?.push(...(second?.data?.leftover ?? []))
      sum.incomplete?.push(...(second?.data?.incomplete ?? []))
      sum.cancelled ||= second?.data?.cancelled
      if (!second?.ok && second?.error && !second.data) sum.failed.push({ name: approved[0], error: second.error })
    }

    const done = sum.uploaded.length
    // One toast for how it ended. A Cancel that lands while a file is being
    // swapped into place lets that swap finish (see sftpUpload), so "cancelled"
    // and "uploaded" can both be true — said as what actually happened.
    if (sum.cancelled)
      toast(
        !done
          ? 'Upload cancelled.'
          : done === chosen.length
            ? 'Upload finished before it could be cancelled.'
            : `Uploaded ${done} of ${chosen.length} files to ${dir}; the rest were cancelled.`,
        'info'
      )
    else if (done) toast(`Uploaded ${done} file${done > 1 ? 's' : ''} to ${dir}`, 'ok')
    for (const f of sum.failed) {
      // The summary reports basenames; the local file that produced one is
      // still in `chosen`, which is what makes a per-file retry possible.
      const local = chosen.find((x) => baseName(x) === f.name)
      toast(
        fileFailure('upload', f.name, dir, f.error),
        'error',
        local
          ? { label: 'Try again', run: () => setQueue((q) => [...q, { kind: 'upload', paths: [local], dir }]) }
          : undefined
      )
    }
    // A new copy leaves the target untouched until it is complete (see
    // sftpUpload), so what a cancel or failure can leave is a temporary copy —
    // named whenever removing one failed — or, for a file the user agreed to
    // overwrite in place, the file itself, part-written.
    reportLeftover(sum.leftover, 'on the server')
    if (sum.incomplete?.length)
      toast(
        `${sum.incomplete.join(', ')} may be incomplete on the server: ${sum.incomplete.length === 1 ? 'it was' : 'they were'} being overwritten in place when the upload stopped.`,
        'error'
      )
    if (!sum.cancelled && !done && !sum.failed.length && !again.length)
      toast(res?.error ? `Nothing was uploaded to ${dir} — ${res.error}` : `Nothing was uploaded to ${dir}.`, 'error', {
        label: 'Choose files',
        run: () => void pickAndUpload()
      })
  }

  const pickAndUpload = async (): Promise<void> => {
    const picked = await window.opsmaxx?.dialog.openUpload()
    if (picked?.length) upload(picked)
  }

  /**
   * Save a file into a folder the user picks.
   *
   * The folder comes from the OS picker in main, and main refuses a download
   * into any folder that did not. Files only: nothing here lists a directory
   * recursively, and a folder "downloaded" as nothing would be worse than
   * saying so.
   */
  const download = async (e: SftpEntry): Promise<void> => {
    if (e.dir) {
      toast(
        `${e.name} is a folder. Only files can be downloaded so far — open it and download what is inside.`,
        'info',
        { label: `Open ${e.name}`, run: () => void navigate(join(path, e.name)) }
      )
      return
    }
    const remote = join(path, e.name)
    const dir = await window.opsmaxx?.dialog.pickDownloadFolder()
    if (dir) setQueue((q) => [...q, { kind: 'download', remotes: [remote], dir }])
  }

  const runDownload = async ({ remotes, dir }: { remotes: string[]; dir: string }): Promise<void> => {
    const name = (r: string): string => r.split('/').pop() ?? r
    const first = name(remotes[0])
    setProgress({ key, name: first, transferred: 0, total: 0, index: 1, count: remotes.length, direction: 'down' })
    const res = await window.opsmaxx?.sftp.download(key, remotes, dir)
    const saved = res?.data?.saved ?? []
    const failed = res?.data?.failed ?? []
    if (saved.length)
      toast(saved.length === 1 ? `Saved ${saved[0]} to ${dir}` : `Saved ${saved.length} files to ${dir}`, 'ok')
    for (const f of failed) {
      const remote = remotes.find((r) => name(r) === f.name)
      toast(
        fileFailure('download', f.name, remote ? remote.slice(0, -f.name.length - 1) || '/' : path, f.error),
        'error',
        remote
          ? { label: 'Try again', run: () => setQueue((q) => [...q, { kind: 'download', remotes: [remote], dir }]) }
          : undefined
      )
    }
    reportLeftover(res?.data?.leftover, 'on this machine')
    if (res?.data?.cancelled) toast('Download cancelled.', 'info')
    else if (!saved.length && !failed.length)
      toast(res?.error ? `Nothing was downloaded — ${res.error}` : 'Nothing was downloaded.', 'error')
  }

  // Pressed, and not yet answered. Main returns at once even on a stalled link,
  // so this is normally a flicker — but a button that looks unpressed after a
  // click invites a second one.
  const [cancelling, setCancelling] = useState(false)
  const cancelTransfer = (): void => {
    setCancelling(true)
    void window.opsmaxx?.sftp.cancel(key)
  }

  // One transfer at a time: they share the single cached SFTP channel. What
  // arrives meanwhile — a second drop, the Upload button, a Download — waits
  // here in order. It used to be dropped on the floor, with nothing said.
  useEffect(() => {
    if (running || !queue.length) return
    const [next, ...rest] = queue
    setQueue(rest)
    setRunning(next)
    void (next.kind === 'upload' ? runUpload(next) : runDownload(next)).finally(() => {
      setProgress(null)
      setCancelling(false)
      setRunning(null)
      refresh.current()
    })
    // runUpload and runDownload are rebuilt every render; the queue is what
    // decides when the next one starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, running])

  const onDrop = (ev: React.DragEvent): void => {
    ev.preventDefault()
    setDropping(false)
    const paths = Array.from(ev.dataTransfer.files)
      .map((f) => window.opsmaxx?.sftp.pathFor(f))
      .filter((p): p is string => !!p)
    if (paths.length) upload(paths)
  }

  const menu = (e: SftpEntry): MenuEntry[] => [
    ...(!e.dir
      ? [
          { label: 'Open in editor (inline)', icon: <Edit3 size={14} />, onClick: () => void openFile(e) },
          {
            label: editorCommand ? `Open in ${editorCommand}` : 'Open in default app',
            icon: <ExternalLink size={14} />,
            onClick: () => void openExternally(e)
          }
        ]
      : []),
    { label: 'Rename', icon: <Edit3 size={14} />, onClick: () => setRenaming(e.name) },
    {
      label: e.dir ? 'Download (files only)' : 'Download…',
      icon: <Download size={14} />,
      onClick: () => void download(e)
    },
    { separator: true, label: '' },
    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => void remove(e) }
  ]

  const parts = path === '/' ? [] : path.split('/').filter(Boolean)
  const parent = parts.length > 0 ? `/${parts.slice(0, -1).join('/')}` : null

  /**
   * The parent, written the way every shell and file manager writes it.
   *
   * The breadcrumb above can already go up, but `..` is the notation people
   * arrive with — from `ls`, from Finder, from every SFTP client — and its
   * absence is the kind of small unfamiliarity that makes a tree feel like
   * somebody else's idea of a filesystem.
   *
   * Only `..`, not `.`: it is the one that DOES something. A row for the
   * directory you are already looking at is a control that cannot be pressed,
   * and `ls` prints it because `ls` prints entries, not because anyone
   * navigates to it.
   *
   * Filtered out while searching, because it matches no query and a stray `..`
   * on top of three results reads as a result.
   */
  const upRow: SftpEntry | null =
    parent !== null && query.trim() === ''
      ? { name: '..', dir: true, link: false, size: 0, mtime: 0, perms: '' }
      : null

  const visible = entries.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div
      className="content"
      style={{
        paddingTop: 0,
        outline: dropping ? '2px dashed var(--accent)' : undefined,
        outlineOffset: -4
      }}
      onDragOver={(ev) => {
        // Without this the window would try to navigate to the dropped file.
        ev.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={onDrop}
    >
      <div className="viewbar" style={{ margin: '0 -20px 16px', paddingLeft: 20, paddingRight: 20 }}>
        <button className="icon-btn" onClick={() => void navigate('/')} title="Root">
          <Home size={15} />
        </button>
        {/* Click the trail to type a path.
            Crumbs are for walking a tree you are exploring; an administrator
            who already knows they want /etc/postgresql should not have to walk
            there. Editing turns the same strip into a field, which is where
            everyone looks for it — the address bar of a browser, the path bar
            of a file manager. */}
        {editingPath === null ? (
          <div
            className="row"
            style={{ gap: 2, flex: 1, overflow: 'hidden', cursor: 'text' }}
            title="Click to type a path"
            onClick={() => setEditingPath(path)}
          >
            {parts.map((p, i) => (
              <span key={i} className="row" style={{ gap: 2 }}>
                <ChevronRight size={13} className="faint" />
                <button
                  className="btn ghost sm"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    void navigate('/' + parts.slice(0, i + 1).join('/'))
                  }}
                >
                  {p}
                </button>
              </span>
            ))}
            {parts.length === 0 && <span className="faint mono">/</span>}
          </div>
        ) : (
          <input
            className="input mono"
            style={{ flex: 1, height: 26 }}
            autoFocus
            aria-label="Path"
            value={editingPath}
            onChange={(ev) => setEditingPath(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') {
                const target = editingPath.trim()
                setEditingPath(null)
                // A path that does not exist reports itself through the usual
                // failure banner rather than being validated here, so the
                // message says what the server said.
                if (target !== '') void navigate(target.startsWith('/') ? target : `/${target}`)
              }
              if (ev.key === 'Escape') setEditingPath(null)
            }}
            onBlur={() => setEditingPath(null)}
          />
        )}
        {/* Follow the terminal.
            Three visual states, not two. `active` means a directory is
            actually arriving; a link that is on but has heard nothing is lit
            no differently from one that is off, because a control that looks
            on and does nothing is the defect this path exists to fix.

            Not `disabled` when following is impossible: a disabled button
            swallows the click and the explanation with it. `aria-disabled`
            plus the muted styling says the same thing to a screen reader and
            to the eye, and the click still lands — on the reason, and on the
            one setting that fixes it. */}
        <button
          className={clsx('icon-btn', following && 'active')}
          style={follow.can ? undefined : { opacity: 0.45 }}
          aria-disabled={!follow.can}
          aria-label="Follow terminal"
          aria-pressed={follow.can ? linked : undefined}
          title={
            follow.why
              ? follow.why
              : linked
                ? `Following the terminal (${termCwd}) — click to unlink`
                : 'Not following the terminal — click to link'
          }
          onClick={() => {
            // A reason on a tooltip is a reason nobody on a keyboard ever
            // reads, and nobody reads one before clicking anyway. Say it when
            // they ask for the thing it prevents.
            if (!follow.can) return toast(follow.why, 'error', follow.fix)
            setLinked((v) => !v)
            if (!linked && follow.why) toast(follow.why, 'error', follow.fix)
          }}
        >
          <Link2 size={15} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void list(path)}>
          <RefreshCw size={14} />
        </button>
        <button className="btn sm" onClick={() => setCreating(true)}>
          <FolderPlus size={13} /> New folder
        </button>
        <button
          className="btn sm"
          title="Upload files — you can also drag them onto this list"
          onClick={() => void pickAndUpload()}
        >
          <Upload size={13} /> Upload
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12, gap: 6, position: 'relative' }}>
        <Search size={14} className="faint" style={{ position: 'absolute', left: 10 }} />
        <input
          className="input grow"
          style={{ paddingLeft: 30 }}
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {progress && (
        <div className="row" style={{ marginBottom: queue.length ? 4 : 12, gap: 10 }}>
          {progress.direction === 'down' ? (
            <Download size={14} className="faint" aria-label="Downloading" />
          ) : (
            <Upload size={14} className="faint" aria-label="Uploading" />
          )}
          <span className="faint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {progress.name}
            {progress.count > 1 ? ` · ${progress.index}/${progress.count}` : ''}
            {progress.total ? ` · ${bytes(progress.transferred)} / ${bytes(progress.total)}` : ''}
          </span>
          <div className="bar" style={{ flex: 1 }}>
            <span
              style={{
                width: `${progress.total ? Math.round((progress.transferred / progress.total) * 100) : 0}%`
              }}
            />
          </div>
          <button className="btn ghost sm" disabled={cancelling} onClick={cancelTransfer}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      )}

      {queue.length > 0 && (
        <div className="row faint" style={{ marginBottom: 12, gap: 10, fontSize: 'var(--fs-caption)' }} data-testid="transfer-queue">
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {queue.length} queued: {queueNames(queue)}
          </span>
          <button className="btn ghost sm" onClick={() => setQueue([])}>
            Clear queue
          </button>
        </div>
      )}

      {loading && (
        <div className="empty" style={{ height: 200 }}>
          <Loader2 size={22} className="spin" />
          <p>Loading {path}…</p>
        </div>
      )}

      {error && !loading && (
        <div className="empty" style={{ height: 220 }}>
          <div className="empty-icon" style={{ color: 'var(--danger)' }}>
            <AlertTriangle size={22} />
          </div>
          <h3>{error.message}</h3>
          {error.detail && error.detail !== error.message && (
            <p className="mono selectable" style={{ fontSize: 11 }}>
              {error.detail}
            </p>
          )}
          <div className="row" style={{ gap: 8 }}>
            {error.fix && (
              <button className="btn primary" onClick={error.fix.run}>
                {error.fix.label}
              </button>
            )}
            <button className="btn" onClick={error.retry.run}>
              <RefreshCw size={14} /> {error.retry.label}
            </button>
          </div>
        </div>
      )}

      {!loading && !error && (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '50%' }}>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Permissions</th>
            </tr>
          </thead>
          <tbody>
            {creating && (
              <tr>
                <td colSpan={4}>
                  <div className="row" style={{ gap: 8 }}>
                    <FolderPlus size={15} style={{ color: 'var(--warn)' }} />
                    <input
                      className="input"
                      autoFocus
                      style={{ height: 28 }}
                      placeholder="Folder name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createFolder()
                        if (e.key === 'Escape') setCreating(false)
                      }}
                      onBlur={() => void createFolder()}
                    />
                  </div>
                </td>
              </tr>
            )}
            {upRow && (
              <tr
                key=".."
                style={{ cursor: 'pointer' }}
                onDoubleClick={() => void list(parent as string)}
                data-testid="parent-row"
              >
                <td>
                  <span className="row" style={{ gap: 8 }} onClick={() => void list(parent as string)}>
                    <CornerLeftUp size={15} style={{ color: 'var(--text-faint)' }} />
                    <span className="mono">..</span>
                    <span className="faint" style={{ fontSize: 11 }}>
                      parent directory
                    </span>
                  </span>
                </td>
                <td />
                <td />
                <td />
              </tr>
            )}
            {visible.map((e) => (
              <tr
                key={e.name}
                style={{ cursor: 'pointer' }}
                onDoubleClick={() => open(e)}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  setCtx({ x: ev.clientX, y: ev.clientY, entry: e })
                }}
              >
                <td>
                  {renaming === e.name ? (
                    <input
                      className="input"
                      autoFocus
                      style={{ height: 26 }}
                      defaultValue={e.name}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') void doRename(e, (ev.target as HTMLInputElement).value)
                        if (ev.key === 'Escape') setRenaming(null)
                      }}
                      onBlur={(ev) => void doRename(e, ev.target.value)}
                    />
                  ) : (
                    <span className="row" style={{ gap: 8 }} onClick={() => open(e)}>
                      {e.dir ? (
                        <Folder size={15} style={{ color: 'var(--warn)' }} />
                      ) : e.link ? (
                        <Link2 size={15} className="faint" />
                      ) : (
                        <File size={15} className="faint" />
                      )}
                      {e.name}
                    </span>
                  )}
                </td>
                <td className="faint">{e.dir ? '—' : bytes(e.size)}</td>
                <td className="faint">{mtimeLabel(e.mtime)}</td>
                <td className="mono faint">{e.perms}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                {/* Inside a table cell, so the compact variant: same three
                    parts as every other empty state, no glyph tile. It also
                    now distinguishes a directory with nothing in it from a
                    filter that matched nothing, which read identically. */}
                <td colSpan={4} style={{ padding: 0 }}>
                  <EmptyState
                    compact
                    title={query ? 'Nothing matches' : 'Empty directory'}
                    message={
                      query
                        ? `No file or folder here matches "${query}".`
                        : 'There is nothing in this directory.'
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} entries={menu(ctx.entry)} onClose={() => setCtx(null)} />}

      {overwrite && (
        <Modal
          title={
            overwrite.why === 'dir' || overwrite.why === 'owner'
              ? 'Overwrite in place?'
              : 'Replace files on the server?'
          }
          subtitle={overwrite.dir}
          // Closing an in-place question is a Skip: those files were the only
          // ones left, so there is nothing else to cancel.
          onClose={() => overwrite.answer(overwrite.why === 'dir' || overwrite.why === 'owner' ? 'skip' : 'cancel')}
          cancelLabel={overwrite.why === 'dir' || overwrite.why === 'owner' ? null : 'Cancel all'}
          footer={
            <button className="btn secondary size-28" onClick={() => overwrite.answer('skip')}>
              Skip
            </button>
          }
          confirm={{
            label: overwrite.why === 'dir' || overwrite.why === 'owner' ? 'Overwrite in place' : 'Overwrite',
            destructive: true,
            onClick: () => overwrite.answer('overwrite')
          }}
        >
          <p style={{ marginTop: 0 }}>
            {overwrite.why === 'unchecked'
              ? `Could not check ${overwrite.dir} for existing files, so any of these may replace one already there. Skip uploads none of them.`
              : overwrite.why === 'dir'
                ? `This folder isn't writable, so the file can only be overwritten in place. ${IN_PLACE_RISK}`
                : overwrite.why === 'owner'
                  ? `A new copy could not be given the existing file's owner or permissions, so it can only be overwritten in place, which keeps them. ${IN_PLACE_RISK}`
                  : `${overwrite.names.length === 1 ? 'A file with this name is' : 'Files with these names are'} already in ${overwrite.dir}. Overwriting replaces ${overwrite.names.length === 1 ? 'it' : 'them'}; Skip uploads only the rest.`}
          </p>
          <ul className="mono" style={{ fontSize: 'var(--fs-identifier)', maxHeight: 180, overflow: 'auto' }}>
            {overwrite.names.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Modal>
      )}

      {editor && (
        <FileEditor
          path={editor.path}
          initial={editor.content}
          onClose={() => setEditor(null)}
          onSave={saveFile}
        />
      )}
    </div>
  )
}

function FileEditor({
  path,
  initial,
  onClose,
  onSave
}: {
  path: string
  initial: string
  onClose: () => void
  onSave: (c: string) => void
}): React.JSX.Element {
  const [content, setContent] = useState(initial)
  const dirty = content !== initial
  return (
    <Modal
      title={path.split('/').pop() ?? 'File'}
      subtitle={path}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="faint mono" style={{ fontSize: 11 }}>
            {content.length} bytes {dirty ? '· modified' : ''}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={!dirty} onClick={() => onSave(content)}>
            Save
          </button>
        </>
      }
    >
      <textarea
        className="textarea"
        style={{ minHeight: '52vh', fontSize: 12 }}
        value={content}
        spellCheck={false}
        onChange={(e) => setContent(e.target.value)}
      />
    </Modal>
  )
}

// ---- Demo (simulated) ------------------------------------------------------
const DEMO_TREE: Record<string, { name: string; dir: boolean; size: number; mtime: string; perms: string }[]> = {
  '/': [
    { name: 'etc', dir: true, size: 0, mtime: 'Apr 12', perms: 'drwxr-xr-x' },
    { name: 'home', dir: true, size: 0, mtime: 'Mar 02', perms: 'drwxr-xr-x' },
    { name: 'opt', dir: true, size: 0, mtime: 'Jan 20', perms: 'drwxr-xr-x' },
    { name: 'var', dir: true, size: 0, mtime: 'May 01', perms: 'drwxr-xr-x' }
  ],
  '/opt': [
    { name: 'app', dir: true, size: 0, mtime: 'May 08', perms: 'drwxr-xr-x' },
    { name: 'docker-compose.yml', dir: false, size: 2143, mtime: 'May 08', perms: '-rw-r--r--' },
    { name: '.env', dir: false, size: 512, mtime: 'May 08', perms: '-rw-------' }
  ],
  '/opt/app': [
    { name: 'src', dir: true, size: 0, mtime: 'May 07', perms: 'drwxr-xr-x' },
    { name: 'package.json', dir: false, size: 1820, mtime: 'May 07', perms: '-rw-r--r--' },
    { name: 'nginx.conf', dir: false, size: 3412, mtime: 'Apr 30', perms: '-rw-r--r--' },
    { name: 'server.js', dir: false, size: 9821, mtime: 'May 07', perms: '-rw-r--r--' }
  ]
}
const EDITORS = ['VS Code', 'Cursor', 'Sublime Text', 'Notepad++', 'System Default']

function DemoSftp(): React.JSX.Element {
  const setModal = useApp((s) => s.setModal)
  const [path, setPath] = useState('/opt/app')
  const [query, setQuery] = useState('')
  const [ctx, setCtx] = useState<{ x: number; y: number; name: string; dir: boolean } | null>(null)
  const entries = (DEMO_TREE[path] ?? []).filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
  const parts = path === '/' ? [] : path.split('/').filter(Boolean)

  // Everything in this pane is a fixture. Saying "(demo)" after the fact
  // explains nothing to someone who never chose a demo — the way out of it is
  // a real server, so that is the button.
  const notReal = (what: string): void =>
    toast(`${what} does nothing here — this is a sample file list, not a real server.`, 'info', {
      label: 'Add a real server',
      run: () => setModal('add-server')
    })

  const open = (e: { name: string; dir: boolean }): void => {
    if (e.dir) {
      const next = path === '/' ? `/${e.name}` : `${path}/${e.name}`
      if (DEMO_TREE[next]) setPath(next)
      else notReal(`${e.name}/`)
    } else notReal(e.name)
  }

  return (
    <div className="content" style={{ paddingTop: 0 }}>
      <div className="viewbar" style={{ margin: '0 -20px 16px', paddingLeft: 20, paddingRight: 20 }}>
        <button className="icon-btn" onClick={() => setPath('/')} title="Root">
          <Home size={15} />
        </button>
        <div className="row" style={{ gap: 2, flex: 1, overflow: 'hidden' }}>
          {parts.map((p, i) => (
            <span key={i} className="row" style={{ gap: 2 }}>
              <ChevronRight size={13} className="faint" />
              <button className="btn ghost sm" onClick={() => setPath('/' + parts.slice(0, i + 1).join('/'))}>
                {p}
              </button>
            </span>
          ))}
        </div>
        <span className="chip warn">demo</span>
        {/* The only control in this pane that used to fail silently, in a pane
            whose entire design is "nothing works here, and it says so". */}
        <button className="btn sm" onClick={() => notReal('Upload')}>
          <Upload size={13} /> Upload
        </button>
      </div>

      <div className="row" style={{ marginBottom: 12, gap: 6, position: 'relative' }}>
        <Search size={14} className="faint" style={{ position: 'absolute', left: 10 }} />
        <input
          className="input grow"
          style={{ paddingLeft: 30 }}
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <table className="table">
        <thead>
          <tr>
            <th style={{ width: '50%' }}>Name</th>
            <th>Size</th>
            <th>Modified</th>
            <th>Permissions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr
              key={e.name}
              style={{ cursor: 'pointer' }}
              onClick={() => open(e)}
              onContextMenu={(ev) => {
                ev.preventDefault()
                setCtx({ x: ev.clientX, y: ev.clientY, name: e.name, dir: e.dir })
              }}
            >
              <td>
                <span className="row" style={{ gap: 8 }}>
                  {e.dir ? <Folder size={15} style={{ color: 'var(--warn)' }} /> : <File size={15} className="faint" />}
                  {e.name}
                </span>
              </td>
              <td className="faint">{e.dir ? '—' : bytes(e.size)}</td>
              <td className="faint">{e.mtime}</td>
              <td className="mono faint">{e.perms}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          entries={[
            { label: 'Download', icon: <Download size={14} />, onClick: () => notReal('Download') },
            ...(!ctx.dir
              ? EDITORS.map((ed) => ({
                  label: `Open with ${ed}`,
                  icon: <Edit3 size={14} />,
                  onClick: () => notReal(`Open with ${ed}`)
                }))
              : []),
            { separator: true, label: '' },
            { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => notReal('Delete') }
          ]}
        />
      )}
    </div>
  )
}

/**
 * The Files view.
 *
 * `server` is optional: absent means this machine, which main serves from
 * node:fs behind the same channel and the same result shape. Deliberately not
 * a synthesized Server — see shared/execTarget.ts for why that row must not
 * exist.
 */
export function SftpView({ server, tabId }: { server?: Server; tabId?: string }): React.JSX.Element {
  if (!server) return <RealSftp server={undefined} tabId={tabId} />
  return server.demo === false ? <RealSftp server={server} tabId={tabId} /> : <DemoSftp />
}
