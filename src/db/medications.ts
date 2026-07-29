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

function medicationIdentity(medication: Pick<Medication, 'name' | 'validUntil'>): string {
  return JSON.stringify([medication.name, medication.validUntil]);
}

function medicationParams(
  companyId: HealthFundId,
  medication: Medication,
  firstSeenAt: string,
  now: string,
): Record<string, unknown> {
  return {
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
    firstSeenAt,
    now,
  };
}

const INSERT_MEDICATION = `INSERT INTO medications (
   company_id, name, dosage, form, prescribed_by, last_dispensed, valid_until,
   refills_remaining, days_until_expiry, status, raw, first_seen_at, updated_at
 ) VALUES (
   @companyId, @name, @dosage, @form, @prescribedBy, @lastDispensed, @validUntil,
   @refillsRemaining, @daysUntilExpiry, @status, @raw, @firstSeenAt, @now
 )`;

/**
 * Adds medications to the table or updates an exact (fund, name, valid_until) match.
 * Snapshot refreshes should use replaceMedicationsSnapshot so records no longer returned
 * by the fund are removed.
 */
export function upsertMedications(companyId: HealthFundId, medications: Medication[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();
  const statement = db.prepare(
    `${INSERT_MEDICATION}
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
      statement.run(medicationParams(companyId, medication, now, now));
    }
    return items.length;
  });

  return writeAll(medications);
}

/** Replaces one fund's medications with its latest successful scraper snapshot. */
export function replaceMedicationsSnapshot(
  companyId: HealthFundId,
  medications: Medication[],
): number {
  const db = openDatabase();
  const now = new Date().toISOString();
  const selectExisting = db.prepare(
    'SELECT name, valid_until, first_seen_at FROM medications WHERE company_id = ?',
  );
  const removeAll = db.prepare('DELETE FROM medications WHERE company_id = ?');
  const insert = db.prepare(INSERT_MEDICATION);

  const replaceAll = db.transaction(() => {
    const existing = selectExisting.all(companyId) as Pick<
      StoredMedication,
      'name' | 'valid_until' | 'first_seen_at'
    >[];
    const firstSeenByIdentity = new Map<string, string>();
    for (const row of existing) {
      const identity = medicationIdentity({ name: row.name, validUntil: row.valid_until });
      const firstSeenAt = firstSeenByIdentity.get(identity);
      if (firstSeenAt === undefined || row.first_seen_at < firstSeenAt) {
        firstSeenByIdentity.set(identity, row.first_seen_at);
      }
    }

    const snapshot = new Map(
      medications.map((medication) => [medicationIdentity(medication), medication]),
    );
    removeAll.run(companyId);
    for (const [identity, medication] of snapshot) {
      insert.run(
        medicationParams(companyId, medication, firstSeenByIdentity.get(identity) ?? now, now),
      );
    }
    return snapshot.size;
  });

  return replaceAll();
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

// Sync-run tracking (startSyncRun/finishSyncRun/lastSyncRun) lives in ./sync-runs.js —
// it isn't medications-specific, appointments uses the same history table.
