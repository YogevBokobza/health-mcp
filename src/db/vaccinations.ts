import type { HealthFundId, Vaccination } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';

export interface StoredVaccination {
  id: number;
  company_id: string;
  vaccination_id: string;
  vaccine_name: string;
  administered_on: string;
  dose: string | null;
  location: string | null;
  raw: string | null;
  first_seen_at: string;
  updated_at: string;
}

/**
 * Reconciles the stored rows with the scraper's complete vaccination snapshot.
 *
 * Scraper snapshots are expected to have unique IDs, but malformed or merged
 * account results can repeat one. We keep the last occurrence for each ID,
 * preserving the first-seen order of IDs, and return the number of unique rows
 * actually stored (matching the sync run's record count).
 */
export function upsertVaccinations(companyId: HealthFundId, vaccinations: Vaccination[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();
  const uniqueVaccinations = new Map<string, Vaccination>();
  for (const vaccination of vaccinations) uniqueVaccinations.set(vaccination.id, vaccination);
  const items = [...uniqueVaccinations.values()];
  const statement = db.prepare(
    `INSERT INTO vaccinations (
       company_id, vaccination_id, vaccine_name, administered_on, dose, location, raw,
       first_seen_at, updated_at
     ) VALUES (
       @companyId, @vaccinationId, @vaccineName, @administeredOn, @dose, @location, @raw,
       @now, @now
     )
     ON CONFLICT (company_id, vaccination_id) DO UPDATE SET
       vaccine_name    = @vaccineName,
       administered_on = @administeredOn,
       dose             = @dose,
       location         = @location,
       raw              = @raw,
       updated_at       = @now`,
  );

  return db.transaction(() => {
    const ids = new Set<string>();
    for (const vaccination of items) {
      ids.add(vaccination.id);
      statement.run({
        companyId,
        vaccinationId: vaccination.id,
        vaccineName: vaccination.vaccineName,
        administeredOn: vaccination.administeredOn,
        dose: vaccination.dose,
        location: vaccination.location,
        raw: vaccination.raw ? JSON.stringify(vaccination.raw) : null,
        now,
      });
    }

    if (ids.size === 0) {
      db.prepare('DELETE FROM vaccinations WHERE company_id = ?').run(companyId);
    } else {
      const placeholders = [...ids].map(() => '?').join(', ');
      db.prepare(
        `DELETE FROM vaccinations WHERE company_id = ? AND vaccination_id NOT IN (${placeholders})`,
      ).run(companyId, ...ids);
    }
    return items.length;
  })();
}

export function listVaccinations(
  options: { companyId?: HealthFundId } = {},
): StoredVaccination[] {
  const where = options.companyId ? 'WHERE company_id = @companyId' : '';
  return openDatabase()
    .prepare(`SELECT * FROM vaccinations ${where} ORDER BY administered_on DESC`)
    .all(options.companyId ? { companyId: options.companyId } : {}) as StoredVaccination[];
}
