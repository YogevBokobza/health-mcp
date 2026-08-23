import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';

import { migrate, SCHEMA_VERSION } from '../../src/db/schema.js';

/**
 * `migrate` runs directly against a plain (unencrypted) in-memory database here — it
 * only issues SQL, so it needs none of the encryption machinery `openDatabase` wires
 * up, and a migration test should not need a real key to exercise a schema change.
 */
describe('migrate', () => {
  it('leaves a fresh database at the current schema version', () => {
    const db = new Database(':memory:');
    migrate(db);

    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
  });

  it('clears pre-existing test_results and test_result_values rows when upgrading past the identity change (v9)', () => {
    const db = new Database(':memory:');

    // Simulate an install left at schema v8, before test-result identity moved from a
    // name/date/doctor hash to the fund's own type::request_id.
    db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    db.exec(`INSERT INTO schema_version (version) VALUES (8)`);
    db.exec(`
      CREATE TABLE test_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL,
        test_result_id TEXT NOT NULL,
        test_name TEXT NOT NULL,
        performed_on TEXT,
        ordering_doctor TEXT,
        raw TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (company_id, test_result_id)
      )
    `);
    db.prepare(
      `INSERT INTO test_results (company_id, test_result_id, test_name, first_seen_at, updated_at)
       VALUES ('maccabi', 'fictional-legacy-hash-id', 'legacy fictional result', '2026-01-01', '2026-01-01')`,
    ).run();

    migrate(db);

    expect(db.prepare('SELECT count(*) AS n FROM test_results').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM test_result_values').get()).toEqual({ n: 0 });
    expect((db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version).toBe(
      SCHEMA_VERSION,
    );
  });

  it('does not clear test_results for an install already past the identity change', () => {
    const db = new Database(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO test_results (company_id, test_result_id, test_name, first_seen_at, updated_at)
       VALUES ('maccabi', 'lab_result::11111111', 'fictional current-scheme result', '2026-01-01', '2026-01-01')`,
    ).run();

    migrate(db);

    expect(db.prepare('SELECT count(*) AS n FROM test_results').get()).toEqual({ n: 1 });
  });
});
