import type { Database } from 'better-sqlite3-multiple-ciphers';

/**
 * The schema is intentionally small and flat.
 *
 * `sqlQuery` exposes these tables to an agent for read-only questions, so the columns
 * are the contract: they are named for what a person would ask about, not for how the
 * scraper happens to return things.
 */
export const SCHEMA_VERSION = 1;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER NOT NULL
   )`,

  /**
   * Login details per fund. Lives inside the encrypted database rather than in a
   * config file so there is exactly one secret to protect — the database key.
   */
  `CREATE TABLE IF NOT EXISTS credentials (
     company_id  TEXT PRIMARY KEY,
     national_id TEXT NOT NULL,
     password    TEXT,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,

  /**
   * Standing prescriptions.
   *
   * Keyed by (company_id, name, valid_until) so re-running a fetch updates a
   * prescription in place instead of accumulating a new copy every time — the table
   * is meant to answer "what am I on now", not to be an append-only log.
   */
  `CREATE TABLE IF NOT EXISTS medications (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     company_id        TEXT NOT NULL,
     name              TEXT NOT NULL,
     dosage            TEXT,
     form              TEXT,
     prescribed_by     TEXT,
     last_dispensed    TEXT,
     valid_until       TEXT,
     refills_remaining INTEGER,
     days_until_expiry INTEGER,
     status            TEXT NOT NULL,
     raw               TEXT,
     first_seen_at     TEXT NOT NULL,
     updated_at        TEXT NOT NULL,
     UNIQUE (company_id, name, valid_until)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_medications_status ON medications (status)`,
  `CREATE INDEX IF NOT EXISTS idx_medications_expiry ON medications (days_until_expiry)`,

  /** One row per fetch attempt, successful or not. */
  `CREATE TABLE IF NOT EXISTS sync_runs (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     company_id    TEXT NOT NULL,
     started_at    TEXT NOT NULL,
     finished_at   TEXT,
     success       INTEGER NOT NULL DEFAULT 0,
     error_type    TEXT,
     error_message TEXT,
     record_count  INTEGER NOT NULL DEFAULT 0
   )`,
];

/** Tables an agent may read through `sqlQuery`. */
export const READABLE_TABLES = ['medications', 'sync_runs'] as const;

/**
 * Never readable through `sqlQuery`, whatever the policy grants.
 *
 * The point of this server is that an agent works from a stored session and never
 * handles a credential; letting it SELECT the credentials table would hand back
 * exactly what the design withholds.
 */
export const FORBIDDEN_TABLES = ['credentials', 'schema_version'] as const;

export function migrate(db: Database): void {
  db.exec('BEGIN');
  try {
    for (const statement of STATEMENTS) db.exec(statement);

    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;

    if (!row) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version !== SCHEMA_VERSION) {
      db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
