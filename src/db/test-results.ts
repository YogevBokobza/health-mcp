import type { HealthFundId, TestResult } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';

export interface StoredTestResult {
  id: number;
  company_id: string;
  test_result_id: string;
  test_name: string;
  performed_on: string | null;
  ordering_doctor: string | null;
  raw: string | null;
  first_seen_at: string;
  updated_at: string;
}

export function upsertTestResults(companyId: HealthFundId, testResults: TestResult[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();

  const statement = db.prepare(
    `INSERT INTO test_results (
       company_id, test_result_id, test_name, performed_on, ordering_doctor, raw,
       first_seen_at, updated_at
     ) VALUES (
       @companyId, @testResultId, @testName, @performedOn, @orderingDoctor, @raw, @now, @now
     )
     ON CONFLICT (company_id, test_result_id) DO UPDATE SET
       test_name       = @testName,
       performed_on    = @performedOn,
       ordering_doctor = @orderingDoctor,
       raw              = @raw,
       updated_at       = @now`,
  );

  const writeAll = db.transaction((items: TestResult[]) => {
    for (const testResult of items) {
      statement.run({
        companyId,
        testResultId: testResult.id,
        testName: testResult.testName,
        performedOn: testResult.performedOn,
        orderingDoctor: testResult.orderingDoctor,
        raw: testResult.raw ? JSON.stringify(testResult.raw) : null,
        now,
      });
    }
    return items.length;
  });

  return writeAll(testResults);
}

export function listTestResults(
  options: { companyId?: HealthFundId } = {},
): StoredTestResult[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.companyId) {
    clauses.push('company_id = @companyId');
    params.companyId = options.companyId;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  return openDatabase()
    .prepare(
      `SELECT * FROM test_results ${where}
       ORDER BY CASE WHEN performed_on IS NULL THEN 1 ELSE 0 END, performed_on DESC`,
    )
    .all(params) as StoredTestResult[];
}
