import type { HealthFundId, TestResult, TestResultValue } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';
import { saveDocument } from '../store/documents.js';

export interface StoredTestResult {
  id: number;
  company_id: string;
  test_result_id: string;
  test_name: string;
  performed_on: string | null;
  resulted_on: string | null;
  ordering_doctor: string | null;
  category: string | null;
  kind: string | null;
  is_partial: number;
  institute: string | null;
  document_available: number;
  document_path: string | null;
  document_bytes: number | null;
  document_sha256: string | null;
  /** When this result's values and document were last fetched; null means never. */
  detailed_at: string | null;
  raw: string | null;
  first_seen_at: string;
  updated_at: string;
}

export interface StoredTestResultValue {
  id: number;
  company_id: string;
  test_result_id: string;
  code: string | null;
  name: string;
  group_name: string | null;
  value: number | null;
  text: string | null;
  unit: string | null;
  reference_min: number | null;
  reference_max: number | null;
  status: string;
  measured_on: string | null;
  raw: string | null;
  first_seen_at: string;
  updated_at: string;
}

/**
 * What makes two measurements the same measurement, for carrying `first_seen_at`
 * across a re-fetch.
 *
 * JSON of the identifying fields, so no separator character inside a field can merge
 * two analytes that only differ where the separator went. The fund's analyte code is
 * the real identity, but it is not always given, and one batch can report the same
 * analyte from two samples (blood and urine glucose), which the name separates.
 */
function valueIdentity(value: { code: string | null; name: string }): string {
  return JSON.stringify([value.code, value.name]);
}

/**
 * Writes the timeline into the table.
 *
 * Deliberately leaves the detail columns alone. This runs on every cheap refresh, and
 * a refresh that re-listed the timeline must not wipe the values and documents an
 * earlier, expensive fetch collected — omitting those columns from the UPDATE clause
 * is what buys that.
 */
export function upsertTestResults(companyId: HealthFundId, testResults: TestResult[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();

  const statement = db.prepare(
    `INSERT INTO test_results (
       company_id, test_result_id, test_name, performed_on, resulted_on, ordering_doctor,
       category, kind, is_partial, institute, document_available, raw,
       first_seen_at, updated_at
     ) VALUES (
       @companyId, @testResultId, @testName, @performedOn, @resultedOn, @orderingDoctor,
       @category, @kind, @isPartial, @institute, @documentAvailable, @raw, @now, @now
     )
     ON CONFLICT (company_id, test_result_id) DO UPDATE SET
       test_name          = @testName,
       performed_on       = @performedOn,
       resulted_on        = @resultedOn,
       ordering_doctor    = @orderingDoctor,
       category           = @category,
       kind               = @kind,
       is_partial         = @isPartial,
       institute          = @institute,
       document_available = @documentAvailable,
       raw                = @raw,
       updated_at         = @now`,
  );

  const writeAll = db.transaction((items: TestResult[]) => {
    for (const testResult of items) {
      statement.run({
        companyId,
        testResultId: testResult.id,
        testName: testResult.testName,
        performedOn: testResult.performedOn,
        resultedOn: testResult.resultedOn,
        orderingDoctor: testResult.orderingDoctor,
        category: testResult.category,
        kind: testResult.kind,
        isPartial: testResult.isPartial ? 1 : 0,
        institute: testResult.institute,
        documentAvailable: testResult.documentAvailable ? 1 : 0,
        raw: testResult.raw ? JSON.stringify(testResult.raw) : null,
        now,
      });
    }
    return items.length;
  });

  return writeAll(testResults);
}

function valueParams(
  companyId: HealthFundId,
  testResultId: string,
  value: TestResultValue,
  previouslySeen: Map<string, string>,
  now: string,
): Record<string, unknown> {
  return {
    companyId,
    testResultId,
    code: value.code,
    name: value.name,
    groupName: value.group,
    value: value.value,
    text: value.text,
    unit: value.unit,
    referenceMin: value.referenceMin,
    referenceMax: value.referenceMax,
    status: value.status,
    measuredOn: value.measuredOn,
    raw: value.raw ? JSON.stringify(value.raw) : null,
    firstSeenAt: previouslySeen.get(valueIdentity(value)) ?? now,
    now,
  };
}

/**
 * Stores everything a detail fetch produced: the timeline rows, each laboratory
 * result's measured values, and each result document (encrypted to disk).
 *
 * Returns the number of measured values written, not the number of results — the
 * values are the point of the operation, and "74 results" would report the same number
 * whether or not a single value came back.
 *
 * A result whose detail was not fetched this run (outside a `since` window, or a batch
 * the fund refused to expand) keeps whatever it already had: `values` being absent
 * means "not fetched", which is not the same as "fetched and empty" and must not delete
 * anything.
 */
export function storeTestResultDetails(companyId: HealthFundId, testResults: TestResult[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();

  upsertTestResults(companyId, testResults);

  const replaceValues = db.prepare(
    'DELETE FROM test_result_values WHERE company_id = ? AND test_result_id = ?',
  );
  // The DELETE above means a conflict can only come from one batch reporting the same
  // analyte twice; keeping the later row is better than aborting the whole transaction
  // on a unique-constraint violation.
  const insertValue = db.prepare(
    `INSERT INTO test_result_values (
       company_id, test_result_id, code, name, group_name, value, text, unit,
       reference_min, reference_max, status, measured_on, raw, first_seen_at, updated_at
     ) VALUES (
       @companyId, @testResultId, @code, @name, @groupName, @value, @text, @unit,
       @referenceMin, @referenceMax, @status, @measuredOn, @raw, @firstSeenAt, @now
     )
     ON CONFLICT (company_id, test_result_id, code, name) DO UPDATE SET
       group_name    = @groupName,
       value         = @value,
       text          = @text,
       unit          = @unit,
       reference_min = @referenceMin,
       reference_max = @referenceMax,
       status        = @status,
       measured_on   = @measuredOn,
       raw           = @raw,
       updated_at    = @now`,
  );
  const firstSeen = db.prepare(
    `SELECT code, name, first_seen_at FROM test_result_values
      WHERE company_id = ? AND test_result_id = ?`,
  );
  const markDetailed = db.prepare(
    `UPDATE test_results
        SET detailed_at = @now, document_path = @path, document_bytes = @bytes,
            document_sha256 = @sha256, updated_at = @now
      WHERE company_id = @companyId AND test_result_id = @testResultId`,
  );
  const markDetailedWithoutDocument = db.prepare(
    `UPDATE test_results SET detailed_at = @now, updated_at = @now
      WHERE company_id = @companyId AND test_result_id = @testResultId`,
  );

  let written = 0;

  const writeAll = db.transaction((items: TestResult[]) => {
    for (const testResult of items) {
      const hasValues = testResult.values !== undefined;
      const hasDocument = testResult.document !== undefined;
      if (!hasValues && !hasDocument) continue;

      if (hasValues) {
        // A re-fetch of the same batch replaces its values wholesale: a fund that
        // corrects or withdraws a measurement should not leave the old one behind, and
        // a batch is small enough that rewriting it is simpler than diffing it.
        const previouslySeen = new Map(
          (
            firstSeen.all(companyId, testResult.id) as Pick<
              StoredTestResultValue,
              'code' | 'name' | 'first_seen_at'
            >[]
          ).map((row) => [valueIdentity(row), row.first_seen_at]),
        );

        replaceValues.run(companyId, testResult.id);

        for (const value of testResult.values ?? []) {
          insertValue.run(valueParams(companyId, testResult.id, value, previouslySeen, now));
          written += 1;
        }
      }

      if (hasDocument && testResult.document) {
        const saved = saveDocument(companyId, testResult.id, testResult.document);
        markDetailed.run({
          companyId,
          testResultId: testResult.id,
          path: saved.path,
          bytes: saved.byteLength,
          sha256: saved.sha256,
          now,
        });
      } else {
        markDetailedWithoutDocument.run({ companyId, testResultId: testResult.id, now });
      }
    }
  });

  writeAll(testResults);

  return written;
}

export function listTestResults(
  options: {
    companyId?: HealthFundId;
    /** Only results performed on or after this ISO date. */
    from?: string;
    /** Only results performed on or before this ISO date. */
    to?: string;
    kind?: string;
    /** Only results whose document has been downloaded. */
    withDocument?: boolean;
  } = {},
): StoredTestResult[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.companyId) {
    clauses.push('company_id = @companyId');
    params.companyId = options.companyId;
  }
  if (options.from) {
    clauses.push('performed_on >= @from');
    params.from = options.from;
  }
  if (options.to) {
    clauses.push('performed_on <= @to');
    params.to = options.to;
  }
  if (options.kind) {
    clauses.push('kind = @kind');
    params.kind = options.kind;
  }
  if (options.withDocument) {
    clauses.push('document_path IS NOT NULL');
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  return openDatabase()
    .prepare(
      `SELECT * FROM test_results ${where}
       ORDER BY CASE WHEN performed_on IS NULL THEN 1 ELSE 0 END, performed_on DESC`,
    )
    .all(params) as StoredTestResult[];
}

/** How many measured values are stored per result — cheap, and the answer to "did the detail fetch land". */
export function countTestResultValues(options: { companyId?: HealthFundId } = {}): Map<string, number> {
  const rows = openDatabase()
    .prepare(
      `SELECT test_result_id, count(*) AS n FROM test_result_values
       ${options.companyId ? 'WHERE company_id = @companyId' : ''}
       GROUP BY test_result_id`,
    )
    .all(options.companyId ? { companyId: options.companyId } : {}) as {
    test_result_id: string;
    n: number;
  }[];

  return new Map(rows.map((row) => [row.test_result_id, row.n]));
}

export interface StoredTestResultValueRow extends StoredTestResultValue {
  /** Joined from the parent result, so one row is readable on its own. */
  test_name: string;
  performed_on: string | null;
}

/**
 * The analyte-level view: one row per measurement, newest first.
 *
 * This is what answers the questions the timeline cannot — a single analyte's history,
 * or everything that has ever fallen outside its reference range. The parent result's
 * name and date are joined in so a row means something without a second lookup.
 */
export function listTestResultValues(
  options: {
    companyId?: HealthFundId;
    /** Case-insensitive substring of the analyte name, e.g. "ferritin". */
    name?: string;
    from?: string;
    to?: string;
    /** Only values that fell outside their reference range. */
    outOfRangeOnly?: boolean;
    limit?: number;
  } = {},
): StoredTestResultValueRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.companyId) {
    clauses.push('v.company_id = @companyId');
    params.companyId = options.companyId;
  }
  if (options.name) {
    clauses.push('lower(v.name) LIKE @name');
    params.name = `%${options.name.toLowerCase()}%`;
  }
  if (options.from) {
    clauses.push('coalesce(v.measured_on, r.performed_on) >= @from');
    params.from = options.from;
  }
  if (options.to) {
    clauses.push('coalesce(v.measured_on, r.performed_on) <= @to');
    params.to = options.to;
  }
  if (options.outOfRangeOnly) {
    clauses.push("v.status IN ('below', 'above')");
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.limit = options.limit ?? 1_000;

  return openDatabase()
    .prepare(
      `SELECT v.*, r.test_name, r.performed_on
         FROM test_result_values v
         JOIN test_results r
           ON r.company_id = v.company_id AND r.test_result_id = v.test_result_id
        ${where}
        ORDER BY coalesce(v.measured_on, r.performed_on) DESC, v.name ASC
        LIMIT @limit`,
    )
    .all(params) as StoredTestResultValueRow[];
}

/** One result row plus what it takes to decrypt its stored document, for exportDocument. */
export function findTestResultForExport(
  companyId: HealthFundId,
  testResultId: string,
): Pick<StoredTestResult, 'document_path' | 'document_sha256'> | null {
  return (
    (openDatabase()
      .prepare(
        `SELECT document_path, document_sha256 FROM test_results
          WHERE company_id = ? AND test_result_id = ?`,
      )
      .get(companyId, testResultId) as Pick<StoredTestResult, 'document_path' | 'document_sha256'> | undefined) ??
    null
  );
}
