import type { HealthFundId, ScraperCredentials } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';

interface CredentialRow {
  company_id: string;
  national_id: string;
  password: string | null;
}

/**
 * Credentials live in the encrypted database, not in a file beside it.
 *
 * One secret to protect — the database key — rather than a key plus a credentials file
 * that someone will inevitably forget to delete after ingesting it.
 */
export function saveCredentials(companyId: HealthFundId, credentials: ScraperCredentials): void {
  const now = new Date().toISOString();

  openDatabase()
    .prepare(
      `INSERT INTO credentials (company_id, national_id, password, created_at, updated_at)
       VALUES (@companyId, @nationalId, @password, @now, @now)
       ON CONFLICT (company_id) DO UPDATE SET
         national_id = @nationalId,
         password    = @password,
         updated_at  = @now`,
    )
    .run({
      companyId,
      nationalId: credentials.id,
      password: credentials.password ?? null,
      now,
    });
}

export function getCredentials(companyId: HealthFundId): ScraperCredentials | null {
  const row = openDatabase()
    .prepare('SELECT company_id, national_id, password FROM credentials WHERE company_id = ?')
    .get(companyId) as CredentialRow | undefined;

  if (!row) return null;

  return { id: row.national_id, password: row.password ?? undefined };
}

/** Which funds have credentials stored. Returns ids only — never the secrets. */
export function listCredentialedFunds(): HealthFundId[] {
  const rows = openDatabase()
    .prepare('SELECT company_id FROM credentials ORDER BY company_id')
    .all() as { company_id: HealthFundId }[];

  return rows.map((row) => row.company_id);
}

export function deleteCredentials(companyId: HealthFundId): boolean {
  const result = openDatabase()
    .prepare('DELETE FROM credentials WHERE company_id = ?')
    .run(companyId);

  return result.changes > 0;
}

/** Same as `getCredentials`, with a message naming the fix. */
export function requireCredentials(companyId: HealthFundId): ScraperCredentials {
  const credentials = getCredentials(companyId);
  if (!credentials) {
    throw new Error(
      `No stored credentials for ${companyId}. Run: health-mcp ingest-creds -f credentials.json`,
    );
  }
  return credentials;
}
