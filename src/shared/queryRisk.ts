/**
 * How much damage a query in the editor can do before it is run.
 *
 * The query editor ran anything on Ctrl+Enter. Meanwhile `docker rm` in this
 * same app demands a typed phrase scaled to its blast radius, and so does
 * draining a Kubernetes node. `DROP TABLE users` did not even ask — the most
 * destructive control in the product had the least protection in front of it,
 * which is the inversion this file exists to end.
 *
 * PURE, like `commandRisk.ts` and `dbOps.ts`: text in, a judgement out. No
 * driver, no IO. That is what lets the cases below be tested as themselves
 * rather than through a mock of a database.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 *
 * Not a SQL parser, and not a security boundary. A determined user can defeat
 * any regex here, and that is fine: this protects against the slip -- the
 * WHERE clause not yet typed, the DROP left at the top of the scratch buffer,
 * the wrong tab -- not against the author of the query. Anyone who can open
 * this editor already has the credential. The failure that matters is the
 * accident, and accidents are exactly what a regex catches.
 *
 * So it errs toward asking. A false "are you sure" costs one keystroke; a
 * missed `DELETE` with no `WHERE` costs a table.
 */

export type QueryRisk = 'read' | 'write' | 'destructive'

export type QueryConfirmation =
  | { kind: 'none' }
  | { kind: 'confirm' }
  | { kind: 'type-to-confirm'; phrase: string }

/**
 * Strip what a keyword can hide behind.
 *
 * Comments and single-quoted string literals go, so `SELECT 'drop table'` is a
 * read and a DROP hidden behind a block comment is not.
 *
 * Double quotes and backticks stay, because in SQL they delimit IDENTIFIERS
 * rather than strings: removing them erased the very name a DROP is aimed at,
 * and `DROP TABLE "public"."user_sessions"` came back with nothing to ask the
 * user to type. They also carry MongoDB's commands, which arrive here as JSON.
 * The cost is that a MySQL session with ANSI_QUOTES off can put a string in
 * double quotes and have it read as an identifier -- a false "are you sure",
 * which is the direction this file errs in on purpose.
 */
function strip(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Statements, split on semicolons that are not inside a literal. */
function statements(sql: string): string[] {
  return strip(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Irreversible by themselves: the data or the object is gone when they return.
const DESTRUCTIVE = [
  /^drop\s+/i,
  /^truncate\s+/i,
  /^alter\s+table\s+\S+\s+drop\s+/i,
  /^drop\s+database\s+/i,
  // Postgres and MySQL maintenance that locks or rewrites a live table.
  /^vacuum\s+full\b/i,
  /^reindex\s+/i,
  // MongoDB, whose "queries" arrive here as JSON commands.
  /"drop"\s*:/i,
  /"dropDatabase"\s*:/i,
  // Redis.
  /^flushall\b/i,
  /^flushdb\b/i
]

const WRITE = [/^insert\s+/i, /^update\s+/i, /^delete\s+/i, /^create\s+/i, /^alter\s+/i, /^grant\s+/i, /^revoke\s+/i]

/** An unqualified DELETE or UPDATE — the whole table, usually by accident. */
function unscoped(stmt: string): boolean {
  if (!/^(delete|update)\s+/i.test(stmt)) return false
  return !/\swhere\s/i.test(stmt)
}

/** The worst thing this text does, across every statement in it. */
export function queryRisk(sql: string): QueryRisk {
  let worst: QueryRisk = 'read'
  for (const stmt of statements(sql)) {
    if (DESTRUCTIVE.some((re) => re.test(stmt)) || unscoped(stmt)) return 'destructive'
    if (WRITE.some((re) => re.test(stmt))) worst = 'write'
  }
  return worst
}

/**
 * What to ask before running it.
 *
 * A read runs. A write asks once, because an editor that interrupts every
 * INSERT trains the user to dismiss the dialog without reading it -- which is
 * how the destructive one gets dismissed too. Only the irreversible asks for a
 * word, and the word is the object being destroyed where there is one, so the
 * confirmation cannot be satisfied without looking at what it names.
 */
export function queryConfirmation(sql: string): QueryConfirmation {
  const risk = queryRisk(sql)
  if (risk === 'read') return { kind: 'none' }
  if (risk === 'write') return { kind: 'confirm' }
  return { kind: 'type-to-confirm', phrase: destroyedObject(sql) ?? 'RUN' }
}

/**
 * The name the destructive statement is aimed at.
 *
 * Typing it is a better confirmation than typing a fixed word: it cannot be
 * done from muscle memory, and it fails when the user is looking at a different
 * statement from the one about to run.
 */
export function destroyedObject(sql: string): string | null {
  for (const stmt of statements(sql)) {
    const m =
      /^drop\s+(?:table|view|index|database|schema|collection)\s+(?:if\s+exists\s+)?([A-Za-z0-9_."`[\]]+)/i.exec(
        stmt
      ) ?? /^truncate\s+(?:table\s+)?([A-Za-z0-9_."`[\]]+)/i.exec(stmt)
    if (m) {
      // Bare name, without schema qualification or quoting: the user has to be
      // able to type it from what the dialog shows them.
      const raw = m[1].replace(/[`"[\]]/g, '')
      const last = raw.split('.').pop()
      if (last) return last
    }
  }
  return null
}
