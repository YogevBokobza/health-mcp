import type { HealthFundId, Medication } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';

export interface StoredMedication {
  id: number;
  company_id: string;
  name: string;
  dosage: string | null;
  form: string | null;
  prescribed_by: string | null;
  last_dispensed: string | null;
  valid_until: string | null;
  refills_remaining: number | null;
  days_until_expiry: number | null;
  status: string;
  first_seen_at: string;
  updated_at: string;
}

/**
 * Writes a fetch result into the table.
 *
 * Upserts on (fund, name, valid_until): a re-fetch updates the row it already has
 * rather than appending a duplicate, because this table answers "what am I on now",
 * not "what did every fetch return". `first_seen_at` is preserved on update so the
 * history of when a prescription appeared is not lost to that.
 *
 * `days_until_expiry` is recomputed by the scraper on every fetch, so a stale row from
 * last week reports last week's number until the next sync — which is why callers
 * should look at `sync_runs` before treating it as current.
 */
export function upsertMedications(companyId: HealthFundId, medications: Medication[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();

  const statement = db.prepare(
    `INSERT INTO medications (
       company_id, name, dosage, form, prescribed_by, last_dispensed, valid_until,
       refills_remaining, days_until_expiry, status, raw, first_seen_at, updated_at
     ) VALUES (
       @companyId, @name, @dosage, @form, @prescribedBy, @lastDispensed, @validUntil,
       @refillsRemaining, @daysUntilExpiry, @status, @raw, @now, @now
     )
     ON CONFLICT (company_id, name, valid_until) DO UPDATE SET
       dosage            = @dosage,
       form              = @form,
       prescribed_by     = @prescribedBy,
       last_dispensed    = @lastDispensed,
       refills_remaining = @refillsRemaining,
       days_until_expiry = @daysUntilExpiry,
       status            = @status,
       raw               = @raw,
       updated_at        = @now`,
  );

  const writeAll = db.transaction((items: Medication[]) => {
    for (const medication of items) {
      statement.run({
        companyId,
        name: medication.name,
        dosage: medication.dosage,
        form: medication.form,
        prescribedBy: medication.prescribedBy,
        lastDispensed: medication.lastDispensed,
        validUntil: medication.validUntil,
        refillsRemaining: medication.refillsRemaining,
        daysUntilExpiry: medication.daysUntilExpiry,
        status: medication.status,
        raw: medication.raw ? JSON.stringify(medication.raw) : null,
        now,
      });
    }
    return items.length;
  });

  return writeAll(medications);
}

export function listMedications(options: {
  companyId?: HealthFundId;
  expiringWithinDays?: number;
  includeExpired?: boolean;
} = {}): StoredMedication[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.companyId) {
    clauses.push('company_id = @companyId');
    params.companyId = options.companyId;
  }

  if (options.includeExpired === false) {
    clauses.push("status != 'expired'");
  }

  if (options.expiringWithinDays !== undefined) {
    clauses.push('days_until_expiry IS NOT NULL AND days_until_expiry <= @withinDays');
    params.withinDays = options.expiringWithinDays;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  // Soonest to expire first; unknown expiry sorts last rather than looking urgent.
  return openDatabase()
    .prepare(
      `SELECT * FROM medications ${where}
       ORDER BY CASE WHEN days_until_expiry IS NULL THEN 1 ELSE 0 END, days_until_expiry ASC`,
    )
    .all(params) as StoredMedication[];
}

export interface SyncRun {
  id: number;
  company_id: string;
  started_at: string;
  finished_at: string | null;
  success: number;
  error_type: string | null;
  error_message: string | null;
  record_count: number;
}

export function startSyncRun(companyId: HealthFundId): number {
  const result = openDatabase()
    .prepare('INSERT INTO sync_runs (company_id, started_at) VALUES (?, ?)')
    .run(companyId, new Date().toISOString());

  return Number(result.lastInsertRowid);
}

export function finishSyncRun(
  id: number,
  outcome: { success: boolean; recordCount?: number; errorType?: string; errorMessage?: string },
): void {
  openDatabase()
    .prepare(
      `UPDATE sync_runs
         SET finished_at = ?, success = ?, record_count = ?, error_type = ?, error_message = ?
       WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      outcome.success ? 1 : 0,
      outcome.recordCount ?? 0,
      outcome.errorType ?? null,
      outcome.errorMessage ?? null,
      id,
    );
}

/** The most recent run per fund, so a caller can tell how stale the data is. */
export function lastSyncRun(companyId: HealthFundId): SyncRun | null {
  return (
    (openDatabase()
      .prepare('SELECT * FROM sync_runs WHERE company_id = ? ORDER BY id DESC LIMIT 1')
      .get(companyId) as SyncRun | undefined) ?? null
  );
}
