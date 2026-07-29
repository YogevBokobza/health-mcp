import type { Database } from 'better-sqlite3-multiple-ciphers';

/**
 * The schema is intentionally small and flat.
 *
 * `sqlQuery` exposes these tables to an agent for read-only questions, so the columns
 * are the contract: they are named for what a person would ask about, not for how the
 * scraper happens to return things.
 */
export const SCHEMA_VERSION = 4;

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

  /**
   * Upcoming appointments. Keyed by (company_id, appointment_id) — the scraper's id is
   * already stable across re-fetches of the same booking, so this answers "what's on
   * the calendar" rather than accumulating a copy of the same appointment per fetch.
   */
  `CREATE TABLE IF NOT EXISTS appointments (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     company_id     TEXT NOT NULL,
     appointment_id TEXT NOT NULL,
     start          TEXT NOT NULL,
     doctor_name    TEXT,
     specialty      TEXT,
     clinic         TEXT,
     raw            TEXT,
     first_seen_at  TEXT NOT NULL,
     updated_at     TEXT NOT NULL,
     UNIQUE (company_id, appointment_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments (start)`,

  `CREATE TABLE IF NOT EXISTS test_results (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     company_id      TEXT NOT NULL,
     test_result_id  TEXT NOT NULL,
     test_name       TEXT NOT NULL,
     performed_on    TEXT,
     ordering_doctor TEXT,
     raw              TEXT,
     first_seen_at    TEXT NOT NULL,
     updated_at       TEXT NOT NULL,
     UNIQUE (company_id, test_result_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_test_results_performed_on ON test_results (performed_on)`,

  `CREATE TABLE IF NOT EXISTS vaccinations (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     company_id      TEXT NOT NULL,
     vaccination_id  TEXT NOT NULL,
     vaccine_name    TEXT NOT NULL,
     administered_on TEXT NOT NULL,
     dose             TEXT,
     location         TEXT,
     raw              TEXT,
     first_seen_at    TEXT NOT NULL,
     updated_at       TEXT NOT NULL,
     UNIQUE (company_id, vaccination_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_vaccinations_administered_on ON vaccinations (administered_on)`,

  /** One row per fetch attempt, successful or not — one history per fund per resource. */
  `CREATE TABLE IF NOT EXISTS sync_runs (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     company_id    TEXT NOT NULL,
     resource      TEXT NOT NULL DEFAULT 'medications',
     started_at    TEXT NOT NULL,
     finished_at   TEXT,
     success       INTEGER NOT NULL DEFAULT 0,
     error_type    TEXT,
     error_message TEXT,
     record_count  INTEGER NOT NULL DEFAULT 0
   )`,
];

/**
 * Columns added after a table's first release, applied to installs that already have
 * the table without them. `CREATE TABLE IF NOT EXISTS` above only covers a table that
 * doesn't exist yet — an existing sync_runs from schema v1 needs this to gain `resource`.
 */
function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Tables an agent may read through `sqlQuery`. */
export const READABLE_TABLES = [
  'medications',
  'appointments',
  'test_results',
  'vaccinations',
  'sync_runs',
] as const;

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

    addColumnIfMissing(db, 'sync_runs', 'resource', "TEXT NOT NULL DEFAULT 'medications'");

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
