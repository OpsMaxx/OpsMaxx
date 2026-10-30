import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDbCell } from '../../../../shared/dbCell'
import {
  Play,
  Plug,
  RefreshCw,
  Table2,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Database,
  Gauge,
  FileCode2,
  TerminalSquare,
  Activity,
  Loader2,
  Pencil,
  Trash2
} from 'lucide-react'
import { useApp, useWorkspaceServers } from '../../store/app'
import { TabStrip } from '../panel/TabStrip'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useDragSize } from '../../hooks/useDragSize'
import { clsx } from '../../lib/format'
import { DbShell } from './DbShell'
import { DbOpsPanel } from './DbOpsPanel'
import { MongoMonitor } from './MongoMonitor'
import { toast } from '../../store/toast'
import { KIND_COLOR, KIND_SHORT } from './DatabaseSidebar'
import { withVaultUnlock } from '../../lib/withVaultUnlock'
import { classifyConnectionError, errorText } from '../../lib/connectionError'
import { Modal } from '../common/Modal'
import { queryConfirmation, queryRisk, type QueryConfirmation } from '../../../../shared/queryRisk'
import { openDatabaseCreator, openDatabaseEditor } from '../../store/dbEditor'
import { openSettings } from '../../store/nav'
import { supportsDbOps, type DbVerdictLevel } from '../../../../shared/dbOps'
import { dbConnectConfig } from '../../lib/dbConfig'
import { formatDbAddress } from '../../../../shared/dbAddress'
import { EmptyState } from '../common/EmptyState'
import type { DatabaseConn, DbKind, Server } from '../../types'
import type { DbConnectConfig, DbInfo, DbQueryResult, DbTestResult } from '../../../../shared/db'
import type { MessageKey } from '../../../../shared/i18n'
import { t as translate, useT } from '../../lib/i18n'
import { Trans } from '../../lib/Trans'

/** Where the connection has got to. Named because Results reads it too. */
type ConnPhase = 'idle' | 'connecting' | 'ok' | 'error'

const DEFAULT_QUERY: Record<DbKind, string> = {
  postgres: 'SELECT * FROM information_schema.tables LIMIT 20;',
  mysql: 'SHOW TABLES;',
  mssql: 'SELECT name FROM sys.tables;',
  mongodb: '{ "listCollections": 1 }',
  redis: 'PING'
}
const KIND_LABEL: Record<DbKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis'
}

// Moved to lib/dbConfig.ts when the size sampler needed the same shape. One
// builder, so a jump host cannot be remembered here and forgotten there.
const cfgOf = dbConnectConfig

// One sentence for a connection failure, picked from what the driver said.
// The driver's own words stay on screen underneath; this is the part that says
// which setting to go and look at.
function connSummary(db: DatabaseConn, jump: Server | undefined, error: string | undefined): string {
  // Through formatDbAddress for the same reason as the chrome above: an error
  // message is a display surface, and a record carrying a whole connection
  // string in `host` would put the password in a toast.
  const where = formatDbAddress(db.host, db.port)
  const host = formatDbAddress(db.host, null)
  switch (classifyConnectionError(error)) {
    case 'refused':
      return translate('databases.view.conn.refused', { where })
    case 'unreachable':
      return translate('databases.view.conn.unreachable', { host })
    case 'auth':
      return translate('databases.view.conn.auth', { host })
    case 'host-key':
      return jump
        ? translate('databases.view.conn.hostKeyJump', { jump: jump.name })
        : translate('databases.view.conn.hostKey')
    case 'key-missing':
      return jump
        ? translate('databases.view.conn.keyMissingJump', { jump: jump.name })
        : translate('databases.view.conn.keyMissing')
    case 'passphrase':
      return jump
        ? translate('databases.view.conn.passphraseJump', { jump: jump.name })
        : translate('databases.view.conn.passphrase')
    case 'permission':
      return translate('databases.view.conn.permission', {
        user: db.username || translate('databases.view.conn.thisUser'),
        database: db.database || translate('databases.add.thisDatabase')
      })
    default:
      return translate('databases.view.conn.failed', { name: db.name })
  }
}

/**
 * What the Operations tab says when it is not the tab you are looking at.
 *
 * `unknown` earns a mark of its own: a question that could not be asked is not
 * a pass, and a badge that only lit for `watch`/`alarm` would render "we were
 * not allowed to check replication" as a clean tab.
 */
const OPS_BADGE: Record<DbVerdictLevel, { label: string; chip: string; titleKey: MessageKey }> = {
  ok: { label: '', chip: 'ok', titleKey: 'databases.view.opsBadge.ok' },
  unknown: { label: '?', chip: '', titleKey: 'databases.view.opsBadge.unknown' },
  watch: { label: '!', chip: 'warn', titleKey: 'databases.view.opsBadge.watch' },
  alarm: { label: '!', chip: 'danger', titleKey: 'databases.view.opsBadge.alarm' }
}

/** What each engine calls the things in the schema column, keyed so that no
 *  sentence is built by lowercasing a translated heading. */
const OBJECT_COPY: Record<
  'keyspace' | 'databases' | 'tables',
  { headingKey: MessageKey; noneKey: MessageKey; filterKey: MessageKey; noMatchKey: MessageKey }
> = {
  keyspace: {
    headingKey: 'databases.view.objects.keyspace.heading',
    noneKey: 'databases.view.objects.keyspace.none',
    filterKey: 'databases.view.objects.keyspace.filter',
    noMatchKey: 'databases.view.objects.keyspace.noMatch'
  },
  databases: {
    headingKey: 'databases.view.objects.databases.heading',
    noneKey: 'databases.view.objects.databases.none',
    filterKey: 'databases.view.objects.databases.filter',
    noMatchKey: 'databases.view.objects.databases.noMatch'
  },
  tables: {
    headingKey: 'databases.view.objects.tables.heading',
    noneKey: 'databases.view.objects.tables.none',
    filterKey: 'databases.view.objects.tables.filter',
    noMatchKey: 'databases.view.objects.tables.noMatch'
  }
}

/**
 * What a database's collections are, once somebody has opened it.
 *
 * `'loading'` and `'denied'` are states of their own rather than an empty
 * array: a database whose collections could not be listed -- which is the
 * ordinary case for `admin` and `config` under a read-only user -- must not
 * render as a database with no collections in it.
 */
type Collections = Record<string, string[] | 'loading' | 'denied'>

export function DatabaseView({
  db,
  visible
}: {
  db: DatabaseConn
  /**
   * Whether this is the database tab on screen. Every open database stays
   * mounted so its results and shell history survive a switch, which means a
   * background tab would otherwise keep the live monitor sampling.
   */
  visible: boolean
}): React.JSX.Element {
  const t = useT()
  const deleteDatabase = useApp((s) => s.deleteDatabase)
  const servers = useWorkspaceServers()
  // The bastion this database is reached through, when it has one. Named in
  // failures so "the key is missing" says whose key.
  const jumpServer = db.sshServerId ? servers.find((s) => s.id === db.sshServerId) : undefined
  const [query, setQuery] = useState(DEFAULT_QUERY[db.kind])
  const [result, setResult] = useState<DbQueryResult | null>(null)
  const [running, setRunning] = useState(false)
  // `message` is the sentence a person reads; `detail` is the driver's own text,
  // kept beside it so nothing is lost when the sentence is the short version.
  const [conn, setConn] = useState<{
    phase: ConnPhase
    message?: string
    detail?: string
  }>({ phase: 'idle' })
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [dbName, setDbName] = useState(db.database)
  // Database picker. `typed` is true only while the user is actively typing, so
  // opening the list from the chevron always shows every database rather than
  // just the ones matching the currently selected name.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const [mode, setMode] = useState<'query' | 'shell' | 'ops' | 'monitor'>('query')
  // Operational reads exist for PostgreSQL, MySQL/MariaDB, MongoDB and Redis.
  // The last two were held back from the first pass deliberately, because they
  // answer completely different questions — replica-set state and oplog window;
  // eviction policy, persistence and the link to a master — and a thin
  // imitation of the SQL page would have been worse than no page. SQL Server
  // still has no tab, and DB_OPS_UNSUPPORTED_NOTE says why.
  const hasOps = supportsDbOps(db.kind)
  /**
   * The worst verdict the last operational read produced.
   *
   * Held HERE and not in DbOpsPanel because the panel is unmounted the moment
   * the operator switches back to the query tab, and the tab nobody has open is
   * exactly the one the badge exists for. It is why worstVerdict() ranks
   * `unknown` above `ok`: a question that could not be asked has to be able to
   * put a mark on a closed tab.
   */
  const [opsLevel, setOpsLevel] = useState<DbVerdictLevel | null>(null)
  useEffect(() => {
    setOpsLevel(null)
  }, [db.id])
  const pickerRef = useRef<HTMLDivElement>(null)
  useClickOutside(pickerRef, () => setPickerOpen(false), pickerOpen)

  const cfgWith = useCallback(
    (dbn: string): DbConnectConfig => ({ ...cfgOf(db, servers), database: dbn }),
    [db, servers]
  )

  // Every call that reaches the database can need a credential the vault holds
  // — its own password, or the bastion's key. Routing them through this means a
  // locked vault produces an unlock dialog and the call finishing, rather than
  // a rejected promise nobody catches.
  const unlocked = useCallback(
    <T,>(run: () => Promise<T>): Promise<T> =>
      withVaultUnlock(t('databases.view.connectingReason', { name: db.name }), run),
    [db.name, t]
  )

  /**
   * The MongoDB tree, one entry per database that has been opened.
   *
   * Lazily filled. `listDatabases` names the databases on connect -- one call,
   * names only -- and a database's collections are fetched the first time its
   * row is expanded. A server with several hundred databases is a list of
   * several hundred names here and not several hundred listCollections.
   */
  const [collections, setCollections] = useState<Collections>({})
  const [openDbs, setOpenDbs] = useState<Record<string, boolean>>({})

  const loadInfo = useCallback(
    async (dbn: string): Promise<DbInfo | undefined> => {
      try {
        const i = await unlocked(async () => window.opsmaxx?.db.info(cfgWith(dbn)))
        if (i) setInfo(i)
        // dbInfo already returns the selected database's collections, so the
        // tree starts with the one the operator is pointed at already filled
        // rather than fetching it a second time to draw the same names.
        if (i?.ok && dbn) {
          setCollections((c) => ({ ...c, [dbn]: i.tables ?? [] }))
          setOpenDbs((o) => ({ ...o, [dbn]: true }))
        }
        return i
      } catch {
        // The connection banner already carries the failure; a second copy of
        // it here would just be the same problem counted twice.
        return undefined
      }
    },
    [cfgWith, unlocked]
  )

  const init = useCallback(
    async (dbn: string): Promise<void> => {
      setConn({ phase: 'connecting' })
      let r: DbTestResult | undefined
      try {
        r = await unlocked(async () => window.opsmaxx?.db.test(cfgWith(dbn)))
      } catch (err) {
        const detail = errorText(err)
        setConn({ phase: 'error', message: connSummary(db, jumpServer, detail), detail })
        return
      }
      if (!r?.ok) {
        setConn({ phase: 'error', message: connSummary(db, jumpServer, r?.error), detail: r?.error })
        return
      }
      setConn({ phase: 'ok', message: r.version })
      const i = await loadInfo(dbn)
      // MongoDB connection strings often omit the database (e.g. replica-set
      // URIs), so queries would hit the empty default db. Auto-pick a real
      // database so the user sees their data.
      if (db.kind === 'mongodb' && !dbn && i?.databases?.length) {
        const pick = i.databases.find((d) => !['admin', 'local', 'config'].includes(d)) ?? i.databases[0]
        if (pick) {
          setDbName(pick)
          await loadInfo(pick)
        }
      }
    },
    [cfgWith, loadInfo, unlocked, db, jumpServer]
  )

  useEffect(() => {
    setQuery(DEFAULT_QUERY[db.kind])
    setResult(null)
    setInfo(null)
    setCollections({})
    setOpenDbs({})
    setDbName(db.database)
    void init(db.database)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db.id])

  const test = (): void => void init(dbName)

  const selectDb = (dbn: string): void => {
    setDbName(dbn)
    setTyped(false)
    setResult(null)
    void loadInfo(dbn)
  }

  /**
   * Open or close one database in the tree, fetching its collections once.
   *
   * Closing never discards what was fetched: reopening a database the operator
   * has already looked at is instant, and a second listCollections against a
   * server that has not changed is a round trip for nothing.
   */
  const toggleDb = useCallback(
    async (dbn: string): Promise<void> => {
      const opening = !openDbs[dbn]
      setOpenDbs((o) => ({ ...o, [dbn]: opening }))
      if (!opening || collections[dbn] !== undefined) return
      setCollections((c) => ({ ...c, [dbn]: 'loading' }))
      try {
        const i = await unlocked(async () => window.opsmaxx?.db.info(cfgWith(dbn)))
        // `denied` and not an empty array. A read-only user is routinely
        // refused listCollections on admin and config, and "no collections" is
        // a different and wrong answer.
        setCollections((c) => ({ ...c, [dbn]: i?.ok ? (i.tables ?? []) : 'denied' }))
      } catch {
        setCollections((c) => ({ ...c, [dbn]: 'denied' }))
      }
    },
    [cfgWith, collections, openDbs, unlocked]
  )

  const settings = useApp((st) => st.settings)
  const setSettings = useApp((st) => st.setSettings)
  const allDbs = info?.databases ?? []

  // What this engine calls the things in the left column, in one place rather
  // than as a conditional at each of the three sites that needed it. MongoDB
  // draws a tree rather than a list, so its column is headed by the level the
  // tree starts at.
  const isTree = db.kind === 'mongodb'
  const objectWord = db.kind === 'redis' ? 'keyspace' : isTree ? 'databases' : 'tables'
  const objectCopy = OBJECT_COPY[objectWord]
  const objects = isTree ? (info?.databases ?? []) : (info?.tables ?? [])
  const [objectFilter, setObjectFilter] = useState('')
  const needle = objectFilter.trim().toLowerCase()
  /**
   * Whether a database survives the filter.
   *
   * The filter reaches DOWN as well as across: a database whose own name does
   * not match stays when a collection already fetched for it does. It cannot
   * reach into a database nobody has opened, because those collections have not
   * been fetched -- and fetching every one of them to answer a keystroke is
   * precisely the enumeration the lazy tree exists to avoid.
   */
  const matchesTree = (d: string): boolean => {
    if (d.toLowerCase().includes(needle)) return true
    const c = collections[d]
    return Array.isArray(c) && c.some((n) => n.toLowerCase().includes(needle))
  }
  const shownObjects = !needle
    ? objects
    : objects.filter(isTree ? matchesTree : (t) => t.toLowerCase().includes(needle))

  // Both dividers, persisted through settings so an arrangement survives a
  // restart. Clamped: a column dragged to nothing is a column the user cannot
  // get back.
  const schema = useDragSize(settings.dbSchemaWidth, {
    min: 150,
    max: 520,
    onCommit: (dbSchemaWidth) => setSettings({ dbSchemaWidth })
  })
  const editor = useDragSize(settings.dbEditorHeight, {
    min: 80,
    max: 600,
    axis: 'y',
    onCommit: (dbEditorHeight) => setSettings({ dbEditorHeight })
  })
  const emptyHint =
    isTree
      ? t('databases.view.emptyHint.mongodb')
      : db.kind === 'redis'
        ? t('databases.view.emptyHint.redis')
        : t('databases.view.emptyHint.sql')
  const shownDbs = typed
    ? allDbs.filter((d) => d.toLowerCase().includes(dbName.trim().toLowerCase()))
    : allDbs

  const execute = useCallback(async () => {
    if (!query.trim()) return
    setRunning(true)
    let r: DbQueryResult | undefined
    try {
      r = await unlocked(async () => window.opsmaxx?.db.query(cfgWith(dbName), query))
    } catch (err) {
      r = { ok: false, error: errorText(err) }
    }
    setResult(r ?? { ok: false, error: t('databases.view.noAnswer') })
    if (r?.ok && conn.phase !== 'ok') setConn({ phase: 'ok' })
    setRunning(false)
  }, [query, conn.phase, cfgWith, dbName, unlocked, t])

  /**
   * What the editor is waiting to be told before it runs.
   *
   * The gate lives in `run`, not on the button, because Ctrl+Enter is the other
   * way in and was the one people actually used. `DROP TABLE users` went
   * straight to the server from a keystroke while `docker rm` in this same app
   * demanded a typed phrase -- the most destructive control in the product had
   * the least in front of it.
   */
  const [pendingRun, setPendingRun] = useState<QueryConfirmation | null>(null)
  const [phrase, setPhrase] = useState('')

  const run = useCallback((): void => {
    if (!query.trim()) return
    const ask = queryConfirmation(query)
    if (ask.kind === 'none') {
      void execute()
      return
    }
    setPhrase('')
    setPendingRun(ask)
  }, [query, execute])

  const confirmRun = (): void => {
    setPendingRun(null)
    void execute()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      run()
    }
  }

  /**
   * Whether the results pane has anything to say.
   *
   * It used to be `flex: 1` unconditionally, so before the first query two
   * thirds of a maximised window were one grey sentence and the editor was a
   * 160px box above it -- which is what the screenshot of this view was of.
   * With nothing to show, the space belongs to the thing the operator is
   * actually using. The divider comes back with the results, because there is
   * nothing to divide until then.
   */
  const resultsOpen = result !== null || conn.phase === 'connecting' || conn.phase === 'error'

  const insertTable = (t: string): void => {
    if (db.kind === 'mongodb') setQuery(`{ "find": "${t}", "limit": 20 }`)
    else if (db.kind === 'redis') setQuery(`KEYS *`)
    else setQuery(`SELECT * FROM ${t} LIMIT 100;`)
  }

  return (
    <div className="main">
      <div className="viewbar">
        <span className="mono" style={{ fontWeight: 700, color: KIND_COLOR[db.kind] }}>
          {KIND_LABEL[db.kind]}
        </span>
        <b>{db.name}</b>
        {/* Never `{db.host}` directly. A record saved by a build before the
            connection-string parser was fixed carries the entire string —
            password included — in `host`, and this line is the chrome that
            printed it permanently. formatDbAddress re-parses on read, so such
            a record heals the first time it is shown. */}
        <span className="server-meta mono" title={formatDbAddress(db.host, db.port)}>
          {formatDbAddress(db.host, db.port)}
        </span>
        {db.kind === 'mongodb' ? (
          <div ref={pickerRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <input
              className="input"
              style={{ height: 26, width: 170, padding: '0 22px 0 8px' }}
              placeholder={t('databases.view.pickerPlaceholder')}
              title={t('databases.view.pickerTitle')}
              value={dbName}
              onFocus={() => setPickerOpen(true)}
              onChange={(e) => {
                setTyped(true)
                setPickerOpen(true)
                setDbName(e.target.value)
              }}
              onBlur={(e) => {
                // Ignore blur caused by clicking an entry in the picker itself —
                // that path commits through selectDb already.
                if (pickerRef.current?.contains(e.relatedTarget as Node)) return
                setPickerOpen(false)
                if (e.target.value !== db.database || typed) selectDb(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setPickerOpen(false)
                  selectDb((e.target as HTMLInputElement).value)
                }
              }}
            />
            <button
              className="icon-btn sm"
              title={t('databases.view.showAll')}
              style={{ marginLeft: -22, height: 22, width: 22 }}
              onClick={() => {
                setTyped(false)
                setPickerOpen((o) => !o)
              }}
            >
              <ChevronDown size={13} />
            </button>
            {pickerOpen && (
              <div className="menu" style={{ top: 30, left: 0, minWidth: 190, maxHeight: 300, overflowY: 'auto' }}>
                <div className="menu-label">{t('databases.view.pickerHeading', { count: allDbs.length })}</div>
                {shownDbs.map((d) => (
                  <button
                    key={d}
                    className="menu-item"
                    onClick={() => {
                      setPickerOpen(false)
                      selectDb(d)
                    }}
                  >
                    <span className="mono">{d}</span>
                  </button>
                ))}
                {shownDbs.length === 0 && (
                  <div className="faint" style={{ padding: '4px 10px 8px', fontSize: 11 }}>
                    {allDbs.length ? t('databases.view.pickerNoMatch') : t('databases.view.pickerNone')}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          dbName && <span className="chip">{dbName}</span>
        )}
        <div className="row" style={{ gap: 4, marginLeft: 4 }}>
          <button className={`btn sm${mode === 'query' ? ' primary' : ''}`} onClick={() => setMode('query')}>
            <FileCode2 size={13} /> {t('databases.view.modeQuery')}
          </button>
          <button className={`btn sm${mode === 'shell' ? ' primary' : ''}`} onClick={() => setMode('shell')}>
            <TerminalSquare size={13} /> {t('databases.view.modeShell')}
          </button>
          {isTree && (
            <button
              className={`btn sm${mode === 'monitor' ? ' primary' : ''}`}
              onClick={() => setMode('monitor')}
              title={t('databases.view.modeMonitorTitle')}
            >
              <Gauge size={13} /> {t('databases.view.modeMonitor')}
            </button>
          )}
          {hasOps && (
            <button
              className={`btn sm${mode === 'ops' ? ' primary' : ''}`}
              onClick={() => setMode('ops')}
              title={
                opsLevel ? t('databases.view.opsLast', { verdict: t(OPS_BADGE[opsLevel].titleKey) }) : undefined
              }
            >
              <Activity size={13} /> {t('databases.view.modeOps')}
              {opsLevel && opsLevel !== 'ok' && (
                <span className={`chip ${OPS_BADGE[opsLevel].chip}`} style={{ marginLeft: 4 }}>
                  {OPS_BADGE[opsLevel].label}
                </span>
              )}
            </button>
          )}
        </div>
        <span className="spacer" />
        {conn.phase === 'connecting' && <Loader2 size={14} className="spin" />}
        {conn.phase === 'ok' && (
          <span className="chip ok" title={conn.message}>
            <CheckCircle2 size={12} /> {t('databases.view.connected')}
          </span>
        )}
        {conn.phase === 'error' && (
          <span className="chip danger" title={conn.message}>
            <AlertTriangle size={12} /> {t('databases.view.error')}
          </span>
        )}
        <button className="btn sm" onClick={test}>
          <Plug size={13} /> {t('common.test')}
        </button>
        <button
          className="btn sm danger"
          onClick={() => {
            deleteDatabase(db.id)
            void window.opsmaxx?.secrets.delete(db.id)
            toast(t('databases.deleted', { name: db.name }))
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {conn.phase === 'error' && (
        <div className="conn-error">
          <AlertTriangle size={14} />
          <div style={{ minWidth: 0 }}>
            <div className="selectable">{conn.message}</div>
            {conn.detail && conn.detail !== conn.message && (
              <div className="mono faint selectable" style={{ fontSize: 11 }}>
                {conn.detail}
              </div>
            )}
          </div>
          <span className="spacer" />
          {/* A host key that no longer matches is not fixed by editing the
              connection — the saved key has to be reviewed and forgotten
              first, so that is the button that gets offered instead. */}
          {classifyConnectionError(conn.detail) === 'host-key' ? (
            <button className="btn sm" onClick={() => openSettings('security')}>
              {t('databases.view.reviewKeys')}
            </button>
          ) : (
            <button className="btn sm" onClick={() => openDatabaseEditor(db.id)}>
              <Pencil size={13} /> {t('databases.editConnection')}
            </button>
          )}
          <button className="btn sm" onClick={test}>
            {t('common.retry')}
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="db-schema" style={{ width: schema.size }}>
          <div className="db-schema-head">
            <span className="sidebar-title">{t(objectCopy.headingKey)}</span>
            {objects.length > 0 && <span className="db-count">{objects.length}</span>}
          </div>
          {/* A filter, once the list is longer than a glance. A schema column
              that needs scrolling and cannot be searched is a list you read
              rather than a list you use. */}
          {objects.length > 12 && (
            <input
              className="input db-filter"
              placeholder={t(objectCopy.filterKey)}
              value={objectFilter}
              spellCheck={false}
              onChange={(e) => setObjectFilter(e.target.value)}
            />
          )}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {/* Four states, and only two of them used to be drawn.
                While `info` was null -- connecting, or a load that failed --
                this rendered NOTHING: a heading with a blank column under it,
                which looks exactly like a database that has no collections in
                it. A MongoDB connection to an unreachable host sat like that
                for thirty seconds, and the only thing on screen saying
                otherwise was a 14px spinner in the toolbar. */}
            {conn.phase === 'error' ? (
              <EmptyState
                compact
                title={t('databases.view.notConnected')}
                message={t('databases.view.notConnectedSchema')}
              />
            ) : conn.phase === 'connecting' || (!info && !objects.length) ? (
              <div className="row faint" style={{ gap: 8, padding: 12 }}>
                <Loader2 size={13} className="spin" />
                <span>{t('common.loading')}</span>
              </div>
            ) : objects.length === 0 ? (
              <EmptyState compact title={t(objectCopy.noneKey)} message={emptyHint} />
            ) : shownObjects.length === 0 ? (
              <EmptyState
                compact
                title={t('databases.view.nothingMatches')}
                message={t(objectCopy.noMatchKey, { filter: objectFilter })}
              />
            ) : isTree ? (
              shownObjects.map((d) => (
                <DatabaseNode
                  key={d}
                  name={d}
                  open={!!openDbs[d]}
                  selected={d === dbName}
                  collections={collections[d]}
                  filter={needle}
                  onToggle={() => void toggleDb(d)}
                  onPick={(coll) => {
                    if (d !== dbName) selectDb(d)
                    insertTable(coll)
                  }}
                />
              ))
            ) : (
              shownObjects.map((t) => (
                <div key={t} className="tree-row" onClick={() => insertTable(t)}>
                  <Table2 size={13} className="faint" />
                  <span className="label" title={t}>
                    {t}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div
          className={clsx('resizer static', schema.dragging && 'dragging')}
          onMouseDown={schema.onMouseDown}
          role="separator"
          aria-label={t('databases.view.resizeSchema')}
        />

        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          {mode === 'monitor' && isTree ? (
            <MongoMonitor cfg={cfgWith(dbName)} visible={visible} />
          ) : mode === 'ops' && hasOps ? (
            <DbOpsPanel cfg={cfgWith(dbName)} kind={db.kind} onVerdict={setOpsLevel} />
          ) : mode === 'shell' ? (
            <DbShell
              cfg={cfgWith(dbName)}
              kind={db.kind}
              dbName={dbName}
              onUseDatabase={selectDb}
              onSchemaChanged={() => void loadInfo(dbName)}
            />
          ) : (
            <>
          <div
            className={clsx('db-editor', !resultsOpen && 'grow')}
            style={resultsOpen ? { height: editor.size } : undefined}
          >
            <textarea
              className="textarea"
              style={{ flex: 1, width: '100%', resize: 'none' }}
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder={
                db.kind === 'redis'
                  ? t('databases.view.editorPlaceholder.redis')
                  : db.kind === 'mongodb'
                    ? t('databases.view.editorPlaceholder.mongodb')
                    : t('databases.view.editorPlaceholder.sql')
              }
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary sm" disabled={running} onClick={run}>
                {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}{' '}
                {t('databases.view.run')}
                <span className="kbd" style={{ marginLeft: 6 }}>
                  Ctrl ⏎
                </span>
              </button>
              <span className="spacer" />
              {result?.elapsedMs != null && (
                <span className="faint" style={{ fontSize: 11 }}>
                  {result.rowCount != null
                    ? t('databases.view.rowsAndTime', { count: result.rowCount, ms: result.elapsedMs })
                    : t('databases.view.elapsed', { ms: result.elapsedMs })}
                </span>
              )}
              <button className="icon-btn sm" title={t('databases.view.refreshSchema')} onClick={() => void test()}>
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          {/* The editor and the results share the height between them, and the
              user decides how. It was a fixed 110px textarea above a results
              pane that took everything else -- so on a maximised window a query
              too long to read sat in a small box under a screenful of nothing. */}
          {resultsOpen && (
            <div
              className={clsx('resizer-h', editor.dragging && 'dragging')}
              onMouseDown={editor.onMouseDown}
              role="separator"
              aria-label={t('databases.view.resizeEditor')}
            />
          )}

          <div className={clsx('db-results', !resultsOpen && 'idle')}>
            <Results result={result} phase={conn.phase} where={formatDbAddress(db.host, db.port)} />
          </div>
            </>
          )}
        </div>
      </div>

      {pendingRun && (
        <Modal
          title={
            pendingRun.kind === 'type-to-confirm'
              ? t('databases.view.confirm.undoneTitle')
              : t('databases.view.confirm.runTitle')
          }
          subtitle={`${db.name}${dbName ? ` · ${dbName}` : ''}`}
          onClose={() => setPendingRun(null)}
          confirm={{
            label: t('databases.view.run'),
            destructive: pendingRun.kind === 'type-to-confirm',
            disabled:
              pendingRun.kind === 'type-to-confirm' && phrase.trim() !== pendingRun.phrase,
            onClick: confirmRun
          }}
        >
          {/* The statement itself, not a description of it. The accident this
              catches is usually that the query on screen is not the query the
              user thinks is on screen. */}
          <pre className="code-block selectable" style={{ maxHeight: 180, overflow: 'auto' }}>
            {query.trim()}
          </pre>
          {pendingRun.kind === 'type-to-confirm' ? (
            <>
              <p className="s-desc">
                {queryRisk(query) === 'destructive' && pendingRun.phrase !== 'RUN'
                  ? t('databases.view.confirm.destroys', { target: pendingRun.phrase })
                  : t('databases.view.confirm.irreversible')}
              </p>
              <label className="s-desc" htmlFor="db-confirm-phrase">
                <Trans
                  i18nKey="databases.view.confirm.typePhrase"
                  values={{ phrase: pendingRun.phrase }}
                  components={{ b: <b /> }}
                />
              </label>
              <input
                id="db-confirm-phrase"
                className="input"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && phrase.trim() === pendingRun.phrase) confirmRun()
                }}
              />
            </>
          ) : (
            <p className="s-desc">{t('databases.view.confirm.writes')}</p>
          )}
        </Modal>
      )}
    </div>
  )
}


/**
 * One database in the MongoDB tree, with its collections under it.
 *
 * The children have four states and they are four different sentences: not
 * opened yet, being fetched, refused, and a database that genuinely holds
 * nothing. The one that earns its own branch is `denied` -- `admin` and
 * `config` refuse listCollections to an ordinary user, and drawing that as "no
 * collections" tells the operator something false about the server.
 */
function DatabaseNode({
  name,
  open,
  selected,
  collections,
  filter,
  onToggle,
  onPick
}: {
  name: string
  open: boolean
  /** The database queries currently run against. */
  selected: boolean
  collections: string[] | 'loading' | 'denied' | undefined
  /** The active filter, already lowercased. */
  filter: string
  onToggle: () => void
  onPick: (collection: string) => void
}): React.JSX.Element {
  const t = useT()
  const loaded = Array.isArray(collections) ? collections : null
  const shown = filter && loaded && !name.toLowerCase().includes(filter)
    ? loaded.filter((c) => c.toLowerCase().includes(filter))
    : loaded
  // A database kept in the results only because one of its collections matched
  // is opened whether or not the operator opened it: the row that explains why
  // it is still on screen is the child, not the parent.
  const expanded = open || (!!filter && !name.toLowerCase().includes(filter) && !!shown?.length)

  return (
    <div>
      <div className={clsx('tree-row', selected && 'active')} onClick={onToggle}>
        <ChevronRight size={14} className={clsx('chev', expanded && 'open')} />
        <Database size={13} className="faint" />
        <span className="label" title={name}>
          {name}
        </span>
        <span className="spacer" />
        {loaded && (
          <span className="db-count" title={t('databases.view.collectionCount', { count: loaded.length })}>
            {loaded.length}
          </span>
        )}
      </div>
      {expanded && (
        <div className="tree-children">
          {collections === 'loading' ? (
            <div className="row faint db-tree-note" style={{ gap: 8 }}>
              <Loader2 size={12} className="spin" />
              <span>{t('common.loading')}</span>
            </div>
          ) : collections === 'denied' ? (
            <div className="faint db-tree-note">
              {t('databases.view.collectionsDenied', { name })}
            </div>
          ) : shown === null ? null : shown.length === 0 ? (
            <div className="faint db-tree-note">
              {loaded && loaded.length > 0 ? t('databases.view.noMatchHere') : t('databases.view.noCollections')}
            </div>
          ) : (
            shown.map((c) => (
              <div
                key={c}
                className="tree-row"
                onClick={(e) => {
                  e.stopPropagation()
                  onPick(c)
                }}
              >
                <Table2 size={13} className="faint" />
                <span className="label" title={c}>
                  {c}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// A JSON value is one unbroken run of text, so without this a single payload
// column widens the table past the screen. Wrapped anywhere, kept whole, so
// selecting a cell still copies the entire value.
const CELL_STYLE: React.CSSProperties = { maxWidth: 480, overflowWrap: 'anywhere' }

function Results({
  result,
  phase,
  where
}: {
  result: DbQueryResult | null
  phase: ConnPhase
  where: string
}): React.JSX.Element {
  const t = useT()
  // Connecting is not "no results yet".
  //
  // The empty state below tells the user to write a query and press Run, which
  // is wrong advice while the connection is still being made and worse advice
  // when it has failed: it invites an action against a server that is not
  // there, and says nothing about the only thing actually happening. The whole
  // window read as an empty database rather than a pending connection.
  if (!result && phase === 'connecting') {
    return (
      <div className="row faint" style={{ gap: 8, padding: 16, alignItems: 'center' }}>
        <Loader2 size={14} className="spin" />
        <span>{t('databases.view.connectingTo', { where })}</span>
      </div>
    )
  }
  if (!result && phase === 'error') {
    return (
      <EmptyState
        compact
        title={t('databases.view.notConnected')}
        message={t('databases.view.notConnectedResults')}
      />
    )
  }
  if (!result) {
    // The fourth empty-state grammar in the app, and the barest: a single grey
    // sentence with no container, no title and no action, in the slot where a
    // full results grid otherwise renders. `compact` exists for exactly this —
    // in-panel, no glyph tile — so the shape matches every other empty state
    // without the centred hero treatment that would be wrong here.
    return (
      <EmptyState
        compact
        title={t('databases.view.noResultsTitle')}
        message={t('databases.view.noResults')}
      />
    )
  }
  if (!result.ok) {
    return (
      <div className="log-line error" style={{ padding: 16, whiteSpace: 'pre-wrap' }}>
        <span className="lvl">{t('databases.view.errorLevel')}</span>
        <span className="selectable">{result.error}</span>
      </div>
    )
  }
  if (result.kind === 'rows' && result.columns) {
    const rows = (result.rows ?? []).slice(0, 500)
    return (
      <table className="table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            {result.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="faint">{i + 1}</td>
              {r.map((v, j) => (
                <td key={j} className="mono selectable" style={CELL_STYLE}>
                  {v === null ? <span className="faint">NULL</span> : formatDbCell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (result.kind === 'message') {
    return <div style={{ padding: 16 }}>{result.message}</div>
  }
  // Array of documents (e.g. MongoDB find) → render as a table.
  const j = result.json
  if (Array.isArray(j) && j.length > 0 && j.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    const cols = Array.from(new Set(j.flatMap((o) => Object.keys(o as object)))).slice(0, 40)
    const cell = formatDbCell
    return (
      <table className="table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(j as Record<string, unknown>[]).slice(0, 500).map((o, i) => (
            <tr key={i}>
              <td className="faint">{i + 1}</td>
              {cols.map((c) => (
                <td key={c} className="mono selectable" style={CELL_STYLE}>
                  {c in o ? cell(o[c]) : <span className="faint">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <pre className="selectable" style={{ padding: 16, fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap' }}>
      {JSON.stringify(result.json ?? result.message ?? null, null, 2)}
    </pre>
  )
}

export function DatabaseWorkspace(): React.JSX.Element {
  const t = useT()
  const databases = useApp((s) => s.databases)
  const activeId = useApp((s) => s.activeDatabaseId)
  const openIds = useApp((s) => s.openDatabaseIds)
  const setActive = useApp((s) => s.setActiveDatabase)
  const closeDatabase = useApp((s) => s.closeDatabase)
  const moveOpenDatabase = useApp((s) => s.moveOpenDatabase)

  const open = openIds.map((id) => databases.find((d) => d.id === id)).filter((d): d is DatabaseConn => !!d)
  const active = open.find((d) => d.id === activeId) ?? open[0]

  if (!active) {
    return (
      <div className="main">
        <div className="empty">
          <div className="empty-icon">
            <Table2 size={26} />
          </div>
          <h3>{t('databases.workspace.emptyTitle')}</h3>
          <p>{t('databases.workspace.emptyBody')}</p>
          <button className="btn primary" onClick={openDatabaseCreator}>
            <Plug size={15} /> {t('databases.workspace.add')}
          </button>
        </div>
      </div>
    )
  }
  // Every open database stays mounted and is hidden when inactive, so its
  // shell history, results and connection survive switching tabs.
  return (
    <div className="main">
      {/**
       * The same strip the session tabs use.
       *
       * This was a second implementation: a `<div onClick>` per tab, with its
       * own markup and its own close button. It agreed with the session strip
       * on every hard part — keep every tab mounted, hide the inactive ones —
       * and shared no code, so the two drifted. When the session strip moved
       * its scrolling onto an inner element this one silently lost the ability
       * to scroll at all, which is exactly the failure a shared component
       * makes impossible rather than merely unlikely.
       *
       * Adopting it also brings what was only ever built once: keyboard
       * navigation through the ARIA tabs pattern, an overflow menu when the
       * strip runs out of room, drag-to-reorder, and a close button that is
       * not clickable while it is invisible.
       */}
      <TabStrip
        label={t('databases.workspace.tabs')}
        items={open.map((d) => ({
          id: d.id,
          title: d.name,
          // The engine, in the colour the rest of the app uses for it.
          icon: (
            <span className="db-kind" style={{ color: KIND_COLOR[d.kind] }}>
              {KIND_SHORT[d.kind]}
            </span>
          ),
          tooltip: `${d.name} — ${KIND_LABEL[d.kind]}`
        }))}
        activeId={active.id}
        onSelect={setActive}
        onClose={closeDatabase}
        onReorder={moveOpenDatabase}
      />
      {open.map((d) => (
        <div
          key={d.id}
          style={{ display: d.id === active.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}
        >
          <DatabaseView db={d} visible={d.id === active.id} />
        </div>
      ))}
    </div>
  )
}
