import fs from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import type { Database as DatabaseType } from 'better-sqlite3-multiple-ciphers';

import { databasePath, ensureAppDataDir } from '../config/paths.js';
import { migrate } from './schema.js';

export class DatabaseKeyError extends Error {
  readonly code = 'DATABASE_KEY';
}

let handle: DatabaseType | undefined;

/**
 * Reads the encryption key from the environment.
 *
 * The key is never written to disk — not to a config file, not to the database it
 * unlocks. It is supplied per run, which is what keeps an attacker with a copy of the
 * database file from also having the means to open it.
 */
function encryptionKey(): string {
  const key = process.env.HEALTH_MCP_KEY;

  if (!key || key.length < 8) {
    throw new DatabaseKeyError(
      'HEALTH_MCP_KEY is not set (or is too short). It unlocks the local database and ' +
        'is never stored on disk — pass it in the environment for each run.',
    );
  }

  return key;
}

/**
 * Opens the encrypted database, creating and migrating it on first use.
 *
 * A wrong key surfaces as a clear error rather than SQLite's "file is not a database",
 * which is the same message a corrupt file produces and sends people down the wrong path.
 */
export function openDatabase(): DatabaseType {
  if (handle) return handle;

  ensureAppDataDir();
  const file = databasePath();
  const existed = fs.existsSync(file);

  const db = new Database(file);
  db.pragma(`key='${encryptionKey().replace(/'/g, "''")}'`);

  try {
    // Forces SQLCipher to actually decrypt a page.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (error) {
    db.close();
    if (existed) {
      throw new DatabaseKeyError(
        `Could not open ${file} with the supplied HEALTH_MCP_KEY. The key is wrong, or the file is damaged.`,
      );
    }
    throw error;
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  // Least privilege: the database and its WAL sidecars are for this user only.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.chmodSync(`${file}${suffix}`, 0o600);
    } catch {
      // The sidecars may not exist yet; the mode is applied again on later opens.
    }
  }

  handle = db;
  return db;
}

export function closeDatabase(): void {
  handle?.close();
  handle = undefined;
}

/** True when a database already exists on disk. */
export function databaseExists(): boolean {
  return fs.existsSync(databasePath());
}
