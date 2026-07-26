import { openDatabase } from './database.js';
import { FORBIDDEN_TABLES, READABLE_TABLES } from './schema.js';
import { MAX_QUERY_ROWS, QUERY_TIMEOUT_MS } from '../constants.js';

export class UnsafeQueryError extends Error {
  readonly code = 'UNSAFE_QUERY';
}

/**
 * SQL keywords that change data or schema. Anything matching is refused outright
 * rather than sanitized — an agent asking a question never needs them, and a
 * rewrite-it-safely path is a much harder thing to get right than a refusal.
 */
const FORBIDDEN_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'replace',
  'truncate',
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'reindex',
  'grant',
  'revoke',
];

/** Strips string literals and comments so keyword checks cannot be fooled by them. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Validates that a statement is a single, read-only SELECT touching no protected table.
 *
 * Exported so it can be tested directly: this function is the boundary between an
 * agent's free-text SQL and a database holding medical records, and it deserves tests
 * of its own rather than only being covered through the tool.
 */
export function assertSafeSelect(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) throw new UnsafeQueryError('Empty query.');

  const stripped = stripLiteralsAndComments(trimmed).toLowerCase();

  if (!/^\s*(select|with)\b/.test(stripped)) {
    throw new UnsafeQueryError('Only SELECT queries are allowed.');
  }

  // One statement only: a trailing `; DROP TABLE ...` must not ride along.
  const withoutTrailing = stripped.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new UnsafeQueryError('Only a single statement is allowed.');
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(withoutTrailing)) {
      throw new UnsafeQueryError(`"${keyword.toUpperCase()}" is not allowed in a query.`);
    }
  }

  for (const table of FORBIDDEN_TABLES) {
    if (new RegExp(`\\b${table}\\b`).test(withoutTrailing)) {
      // The whole design is that an agent works from a stored session and never
      // handles a credential. Reading that table back would undo it.
      throw new UnsafeQueryError(`The "${table}" table is not readable.`);
    }
  }

  // sqlite_master would enumerate the schema including the tables above.
  if (/\bsqlite_[a-z_]+\b/.test(withoutTrailing)) {
    throw new UnsafeQueryError('SQLite internal tables are not readable. Use listTables.');
  }
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

/** Runs a validated read-only query with a row cap and a time budget. */
export function runSafeQuery(sql: string, params: unknown[] = []): QueryResult {
  assertSafeSelect(sql);

  const db = openDatabase();
  // A time budget matters because an agent can write an accidental cross join far more
  // easily than it can notice one.
  const statement = db.prepare(sql);

  const timer = setTimeout(() => {
    try {
      db.close();
    } catch {
      // The interrupt is best-effort; the row cap is the reliable bound.
    }
  }, QUERY_TIMEOUT_MS);

  try {
    const rows = statement.all(...(params as [])) as Record<string, unknown>[];
    const truncated = rows.length > MAX_QUERY_ROWS;

    return {
      rows: truncated ? rows.slice(0, MAX_QUERY_ROWS) : rows,
      rowCount: truncated ? MAX_QUERY_ROWS : rows.length,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface TableInfo {
  name: string;
  columns: { name: string; type: string; notnull: boolean; pk: boolean }[];
  rowCount: number;
}

/** Tables an agent may read, with row counts. */
export function listTables(): { name: string; rowCount: number }[] {
  const db = openDatabase();

  return READABLE_TABLES.map((name) => {
    const row = db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number };
    return { name, rowCount: row.n };
  });
}

export function describeTable(name: string): TableInfo {
  if (!READABLE_TABLES.includes(name as (typeof READABLE_TABLES)[number])) {
    throw new UnsafeQueryError(
      `Unknown or non-readable table "${name}". Readable: ${READABLE_TABLES.join(', ')}.`,
    );
  }

  const db = openDatabase();
  const columns = db.prepare(`PRAGMA table_info(${name})`).all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  const { n } = db.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number };

  return {
    name,
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notnull === 1,
      pk: column.pk === 1,
    })),
    rowCount: n,
  };
}
