import { describe, expect, it } from 'vitest'
import { destroyedObject, queryConfirmation, queryRisk } from '../src/shared/queryRisk'

/**
 * The inversion this classifier exists to end: in the same app, `docker rm`
 * demanded a typed phrase scaled to its blast radius and `DROP TABLE users` ran
 * on Ctrl+Enter with nothing in between.
 */

describe('reads run without interruption', () => {
  for (const q of [
    'SELECT * FROM users',
    'select id, name from accounts where id = 3',
    'SHOW TABLES',
    'EXPLAIN ANALYZE SELECT 1',
    'WITH t AS (SELECT 1) SELECT * FROM t'
  ]) {
    it(`${q.slice(0, 34)}`, () => {
      expect(queryRisk(q)).toBe('read')
      expect(queryConfirmation(q)).toEqual({ kind: 'none' })
    })
  }

  it('is not fooled by a keyword inside a string literal', () => {
    expect(queryRisk("SELECT * FROM notes WHERE body = 'drop table users'")).toBe('read')
  })

  it('is not fooled by a keyword in a comment', () => {
    expect(queryRisk('-- drop table users\nSELECT 1')).toBe('read')
    expect(queryRisk('/* drop table users */ SELECT 1')).toBe('read')
  })
})

describe('writes ask once', () => {
  it('asks for ordinary writes without demanding a word', () => {
    // An editor that interrupts every INSERT trains the user to dismiss the
    // dialog unread, which is how the destructive one gets dismissed too.
    expect(queryConfirmation("INSERT INTO users (name) VALUES ('a')")).toEqual({ kind: 'confirm' })
    expect(queryConfirmation('UPDATE users SET name = $1 WHERE id = $2')).toEqual({ kind: 'confirm' })
    expect(queryConfirmation('DELETE FROM sessions WHERE expires < now()')).toEqual({ kind: 'confirm' })
  })
})

describe('the irreversible asks for the name', () => {
  it('treats DROP as destructive and asks for the object', () => {
    expect(queryRisk('DROP TABLE users')).toBe('destructive')
    expect(queryConfirmation('DROP TABLE users')).toEqual({ kind: 'type-to-confirm', phrase: 'users' })
  })

  it('unwraps quoting and schema qualification so the phrase is typeable', () => {
    expect(destroyedObject('DROP TABLE IF EXISTS "public"."user_sessions"')).toBe('user_sessions')
    expect(destroyedObject('DROP TABLE `app`.`orders`')).toBe('orders')
    expect(destroyedObject('TRUNCATE TABLE events')).toBe('events')
  })

  it('catches a DELETE or UPDATE with no WHERE', () => {
    // The single most common accident in a query editor: the statement is
    // correct and the clause has not been typed yet.
    expect(queryRisk('DELETE FROM users')).toBe('destructive')
    expect(queryRisk('UPDATE users SET admin = true')).toBe('destructive')
  })

  it('catches the non-SQL engines too', () => {
    expect(queryRisk('FLUSHALL')).toBe('destructive')
    expect(queryRisk('{ "drop": "sessions" }')).toBe('destructive')
  })

  it('takes the worst statement in a batch, not the first', () => {
    expect(queryRisk('SELECT 1; DROP TABLE users; SELECT 2')).toBe('destructive')
    expect(destroyedObject('SELECT 1; DROP TABLE users')).toBe('users')
  })

  it('falls back to a fixed word when there is no name to type', () => {
    expect(queryConfirmation('FLUSHALL')).toEqual({ kind: 'type-to-confirm', phrase: 'RUN' })
  })
})

describe('an empty editor', () => {
  it('is a read, not a crash', () => {
    expect(queryRisk('')).toBe('read')
    expect(queryRisk('   \n  ')).toBe('read')
  })
})
