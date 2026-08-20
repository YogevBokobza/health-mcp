import type { HealthFundId } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';

/** Which collection a sync run fetched — one row of history per resource per fund. */
export type SyncResource = 'medications' | 'appointments' | 'testResults' | 'vaccinations';

export interface SyncRun {
  id: number;
  company_id: string;
  resource: SyncResource;
  started_at: string;
  finished_at: string | null;
  success: number;
  error_type: string | null;
  error_message: string | null;
  record_count: number;
}

export function startSyncRun(companyId: HealthFundId, resource: SyncResource): number {
  const result = openDatabase()
    .prepare('INSERT INTO sync_runs (company_id, resource, started_at) VALUES (?, ?, ?)')
    .run(companyId, resource, new Date().toISOString());

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

/** The most recent run per fund and resource, so a caller can tell how stale the data is. */
export function lastSyncRun(companyId: HealthFundId, resource: SyncResource): SyncRun | null {
  return (
    (openDatabase()
      .prepare(
        'SELECT * FROM sync_runs WHERE company_id = ? AND resource = ? ORDER BY id DESC LIMIT 1',
      )
      .get(companyId, resource) as SyncRun | undefined) ?? null
  );
}
