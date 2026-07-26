import { describe, expect, it } from 'vitest';

import { assertSafeSelect, UnsafeQueryError } from '../../src/db/query.js';

/**
 * `assertSafeSelect` is the boundary between an agent's free-text SQL and a database
 * holding medical records. It gets its own tests rather than being covered only
 * through the tool that calls it.
 */
describe('assertSafeSelect', () => {
  it('accepts ordinary read queries', () => {
    expect(() => assertSafeSelect('SELECT * FROM medications')).not.toThrow();
    expect(() =>
      assertSafeSelect('SELECT name, days_until_expiry FROM medications WHERE status = ?'),
    ).not.toThrow();
    expect(() => assertSafeSelect('  select count(*) from sync_runs  ')).not.toThrow();
  });

  it('accepts a CTE', () => {
    expect(() =>
      assertSafeSelect('WITH soon AS (SELECT * FROM medications) SELECT * FROM soon'),
    ).not.toThrow();
  });

  it('tolerates a single trailing semicolon', () => {
    expect(() => assertSafeSelect('SELECT 1 FROM medications;')).not.toThrow();
  });

  describe('refuses anything that is not a read', () => {
    const mutations = [
      'DELETE FROM medications',
      'UPDATE medications SET name = "x"',
      'INSERT INTO medications (name) VALUES ("x")',
      'DROP TABLE medications',
      'ALTER TABLE medications ADD COLUMN x TEXT',
      'CREATE TABLE evil (a TEXT)',
      'PRAGMA key = "guess"',
      'VACUUM',
      'ATTACH DATABASE "/tmp/x.db" AS x',
    ];

    for (const sql of mutations) {
      it(sql.split(' ')[0]!.toLowerCase(), () => {
        expect(() => assertSafeSelect(sql)).toThrow(UnsafeQueryError);
      });
    }
  });

  it('refuses a second statement smuggled after a semicolon', () => {
    // The classic: a valid SELECT with a mutation riding along behind it.
    expect(() => assertSafeSelect('SELECT 1; DROP TABLE medications')).toThrow(UnsafeQueryError);
  });

  it('refuses reading the credentials table', () => {
    // The whole design is that an agent works from a stored session and never handles
    // a credential. Selecting them back would undo exactly that.
    expect(() => assertSafeSelect('SELECT * FROM credentials')).toThrow(/not readable/i);
    expect(() => assertSafeSelect('SELECT national_id FROM credentials WHERE 1=1')).toThrow(
      UnsafeQueryError,
    );
  });

  it('refuses a join that reaches the credentials table', () => {
    expect(() =>
      assertSafeSelect('SELECT m.name FROM medications m JOIN credentials c ON 1=1'),
    ).toThrow(UnsafeQueryError);
  });

  it('refuses enumerating the schema through sqlite internals', () => {
    expect(() => assertSafeSelect('SELECT name FROM sqlite_master')).toThrow(/internal/i);
  });

  it('is not fooled by a forbidden word appearing inside a string literal', () => {
    // "delete" here is data, not a keyword — refusing it would make legitimate
    // questions fail for no reason.
    expect(() =>
      assertSafeSelect(`SELECT * FROM medications WHERE name = 'do not delete me'`),
    ).not.toThrow();
  });

  it('is not fooled by a comment hiding a mutation', () => {
    expect(() => assertSafeSelect('SELECT 1 /* harmless */ FROM medications')).not.toThrow();
    expect(() => assertSafeSelect('-- SELECT\nDELETE FROM medications')).toThrow(UnsafeQueryError);
  });

  it('refuses an empty query', () => {
    expect(() => assertSafeSelect('   ')).toThrow(UnsafeQueryError);
  });
});
