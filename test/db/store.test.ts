import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HealthFundTypes,
  type Appointment,
  type Medication,
  type TestResult,
} from 'israeli-health-scrapers';

// The data dir and key must be set before anything opens the database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-test-'));
process.env.HEALTH_MCP_DATA_DIR = tempDir;
process.env.HEALTH_MCP_KEY = 'test-key-not-a-real-secret';
process.env.HEALTH_MCP_AUDIT = 'off';

const { closeDatabase, openDatabase } = await import('../../src/db/database.js');
const { saveCredentials, getCredentials, listCredentialedFunds, deleteCredentials } = await import(
  '../../src/db/credentials.js'
);
const { upsertMedications, replaceMedicationsSnapshot, listMedications } = await import(
  '../../src/db/medications.js'
);
const { upsertAppointments, listAppointments } = await import('../../src/db/appointments.js');
const { startSyncRun, finishSyncRun, lastSyncRun } = await import('../../src/db/sync-runs.js');
const { runSafeQuery, listTables, describeTable } = await import('../../src/db/query.js');
const { upsertTestResults, listTestResults } = await import('../../src/db/test-results.js');
const { operationsFor } = await import('../../src/operations.js');

function medication(overrides: Partial<Medication> = {}): Medication {
  return {
    name: 'אומפרדקס 20 מ"ג',
    dosage: '20 מ"ג',
    form: 'קפסולות',
    prescribedBy: 'ד"ר כהן',
    lastDispensed: '2026-05-12',
    validUntil: '2026-08-12',
    refillsRemaining: 2,
    daysUntilExpiry: 17,
    status: 'expiring_soon',
    provider: HealthFundTypes.maccabi,
    ...overrides,
  };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'abc123',
    start: '2026-08-09T14:30:00+03:00',
    doctorName: 'ד"ר כהן רונית',
    specialty: 'עור | ביקור רגיל',
    clinic: 'רחוב הדוגמה 1, עיר בדיונית',
    provider: HealthFundTypes.maccabi,
    ...overrides,
  };
}

const fictionalTestResultName = 'בדיקת אבק כוכבים בדיונית';

function testResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'fictional-result-001',
    testName: fictionalTestResultName,
    performedOn: '2026-07-14',
    orderingDoctor: 'ד"ר דמיון בלבד',
    provider: HealthFundTypes.maccabi,
    raw: { fictionalTimelineLabel: 'nebula-alpha' },
    ...overrides,
  };
}

beforeAll(() => {
  openDatabase();
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('database', () => {
  it('creates the file with owner-only permissions where POSIX modes are supported', () => {
    if (process.platform === 'win32') return;

    const mode = fs.statSync(path.join(tempDir, 'database.db')).mode & 0o777;
    // Medical records: readable by this user and nobody else.
    expect(mode).toBe(0o600);
  });

  it('stores nothing in plaintext on disk', () => {
    saveCredentials(HealthFundTypes.maccabi, { id: '123456782', password: 'hunter2' });
    closeDatabase();

    const raw = fs.readFileSync(path.join(tempDir, 'database.db'));
    expect(raw.includes(Buffer.from('hunter2'))).toBe(false);
    expect(raw.includes(Buffer.from('123456782'))).toBe(false);

    openDatabase();
  });

  it('does not store the fictional test-result name in plaintext on disk', () => {
    upsertTestResults(HealthFundTypes.maccabi, [testResult()]);
    closeDatabase();

    const raw = fs.readFileSync(path.join(tempDir, 'database.db'));
    expect(raw.includes(Buffer.from(fictionalTestResultName))).toBe(false);

    openDatabase();
  });
});

describe('credentials', () => {
  it('round-trips and updates in place', () => {
    saveCredentials(HealthFundTypes.maccabi, { id: '123456782', password: 'first' });
    saveCredentials(HealthFundTypes.maccabi, { id: '123456782', password: 'second' });

    expect(getCredentials(HealthFundTypes.maccabi)).toEqual({
      id: '123456782',
      password: 'second',
    });
    expect(listCredentialedFunds()).toEqual([HealthFundTypes.maccabi]);
  });

  it('keeps a password-less account distinguishable from a missing one', () => {
    saveCredentials(HealthFundTypes.mock, { id: '000000000' });

    expect(getCredentials(HealthFundTypes.mock)).toEqual({ id: '000000000', password: undefined });
    expect(getCredentials(HealthFundTypes.clalit)).toBeNull();

    deleteCredentials(HealthFundTypes.mock);
  });

  it('is not reachable through the query tool', () => {
    expect(() => runSafeQuery('SELECT * FROM credentials')).toThrow();
  });
});

describe('medications', () => {
  beforeEach(() => {
    openDatabase().prepare('DELETE FROM medications').run();
  });

  it('upserts rather than duplicating on a re-fetch', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication()]);
    upsertMedications(HealthFundTypes.maccabi, [medication({ refillsRemaining: 1 })]);

    const rows = listMedications({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refills_remaining).toBe(1);
  });

  it('preserves first_seen_at across an update', () => {
    // Otherwise every fetch would erase when a prescription first appeared.
    upsertMedications(HealthFundTypes.maccabi, [medication()]);
    const before = listMedications()[0]!.first_seen_at;
    upsertMedications(HealthFundTypes.maccabi, [medication({ status: 'active' })]);
    expect(listMedications()[0]?.first_seen_at).toBe(before);
  });

  it('treats a different validity period as a different prescription', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication()]);
    upsertMedications(HealthFundTypes.maccabi, [medication({ validUntil: '2027-01-03' })]);
    expect(listMedications({ companyId: HealthFundTypes.maccabi })).toHaveLength(2);
  });

  it('replaces medications missing from the latest snapshot', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication({ validUntil: '2026-08-12' })]);

    replaceMedicationsSnapshot(HealthFundTypes.maccabi, [
      medication({ validUntil: '2026-10-12', daysUntilExpiry: 78, status: 'active' }),
    ]);

    const rows = listMedications({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valid_until).toBe('2026-10-12');
  });

  it('preserves exact entries and all distinct entries in the latest snapshot', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication()]);
    const firstSeenAt = listMedications({ companyId: HealthFundTypes.maccabi })[0]!.first_seen_at;

    replaceMedicationsSnapshot(HealthFundTypes.maccabi, [
      medication({ refillsRemaining: 1 }),
      medication({ validUntil: '2026-10-12', daysUntilExpiry: 78, status: 'active' }),
    ]);

    const rows = listMedications({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.valid_until === '2026-08-12')?.first_seen_at).toBe(firstSeenAt);
  });

  it('deduplicates nullable identities within a snapshot', () => {
    expect(
      replaceMedicationsSnapshot(HealthFundTypes.maccabi, [
        medication({ validUntil: null, daysUntilExpiry: null, status: 'unknown' }),
        medication({ validUntil: null, daysUntilExpiry: null, status: 'unknown' }),
      ]),
    ).toBe(1);
    expect(listMedications({ companyId: HealthFundTypes.maccabi })).toHaveLength(1);
  });

  it('preserves the earliest first_seen_at from legacy nullable duplicates', () => {
    const insert = openDatabase().prepare(
      `INSERT INTO medications (
         company_id, name, valid_until, status, first_seen_at, updated_at
       ) VALUES (?, ?, NULL, 'unknown', ?, ?)`,
    );
    insert.run(HealthFundTypes.maccabi, 'תרופה בדיונית ללא תאריך', '2026-01-01', '2026-01-01');
    insert.run(HealthFundTypes.maccabi, 'תרופה בדיונית ללא תאריך', '2026-02-01', '2026-02-01');

    replaceMedicationsSnapshot(HealthFundTypes.maccabi, [
      medication({
        name: 'תרופה בדיונית ללא תאריך',
        validUntil: null,
        daysUntilExpiry: null,
        status: 'unknown',
      }),
    ]);

    expect(listMedications({ companyId: HealthFundTypes.maccabi })[0]?.first_seen_at).toBe(
      '2026-01-01',
    );
  });

  it('clears only the refreshed fund when the latest snapshot is empty', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication()]);
    upsertMedications(HealthFundTypes.mock, [
      medication({ name: 'תרופה בדיונית לקרן אחרת', provider: HealthFundTypes.mock }),
    ]);

    replaceMedicationsSnapshot(HealthFundTypes.maccabi, []);

    expect(listMedications({ companyId: HealthFundTypes.maccabi })).toEqual([]);
    expect(listMedications({ companyId: HealthFundTypes.mock })).toHaveLength(1);
  });

  it('sorts soonest-to-expire first and puts unknown expiry last', () => {
    upsertMedications(HealthFundTypes.maccabi, [
      medication({ name: 'ונטולין', validUntil: '2026-04-20', daysUntilExpiry: -97, status: 'expired' }),
      medication({ name: 'לא ידוע', validUntil: null, daysUntilExpiry: null, status: 'unknown' }),
    ]);

    const rows = listMedications();
    expect(rows[0]?.name).toBe('ונטולין');
    expect(rows.at(-1)?.name).toBe('לא ידוע');
  });

  it('filters by expiry window and excludes expired on request', () => {
    expect(listMedications({ expiringWithinDays: 20 }).every((r) => r.days_until_expiry! <= 20)).toBe(
      true,
    );
    expect(listMedications({ includeExpired: false }).some((r) => r.status === 'expired')).toBe(
      false,
    );
  });
});

describe('appointments', () => {
  it('upserts on (company, appointment id) rather than duplicating on a re-fetch', () => {
    upsertAppointments(HealthFundTypes.maccabi, [appointment()]);
    upsertAppointments(HealthFundTypes.maccabi, [appointment({ clinic: 'כתובת אחרת' })]);

    const rows = listAppointments({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clinic).toBe('כתובת אחרת');
  });

  it('treats a different appointment id as a different booking', () => {
    upsertAppointments(HealthFundTypes.maccabi, [appointment({ id: 'def456' })]);
    expect(listAppointments({ companyId: HealthFundTypes.maccabi })).toHaveLength(2);
  });

  it('sorts soonest first', () => {
    upsertAppointments(HealthFundTypes.maccabi, [
      appointment({ id: 'sooner', start: '2026-08-01T09:00:00+03:00' }),
    ]);

    const rows = listAppointments({ companyId: HealthFundTypes.maccabi });
    expect(rows[0]?.appointment_id).toBe('sooner');
  });
});

describe('test results', () => {
  beforeEach(() => {
    openDatabase().prepare('DELETE FROM test_results').run();
  });

  afterEach(() => {
    openDatabase().prepare('DELETE FROM test_results').run();
  });

  it('upserts on (company, test result id) and updates mapped fields and raw', () => {
    upsertTestResults(HealthFundTypes.maccabi, [testResult()]);
    upsertTestResults(HealthFundTypes.maccabi, [
      testResult({
        testName: 'בדיקת ירח בדיונית מעודכנת',
        performedOn: '2026-07-21',
        orderingDoctor: 'ד"ר אגדה בלבד',
        raw: { fictionalTimelineLabel: 'nebula-beta' },
      }),
    ]);

    const rows = listTestResults({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      test_result_id: 'fictional-result-001',
      test_name: 'בדיקת ירח בדיונית מעודכנת',
      performed_on: '2026-07-21',
      ordering_doctor: 'ד"ר אגדה בלבד',
    });
    expect(JSON.parse(rows[0]!.raw!)).toEqual({ fictionalTimelineLabel: 'nebula-beta' });
  });

  it('preserves first_seen_at across an update', () => {
    upsertTestResults(HealthFundTypes.maccabi, [testResult()]);
    const before = listTestResults({ companyId: HealthFundTypes.maccabi })
      .find((row) => row.test_result_id === 'fictional-result-001')!.first_seen_at;

    upsertTestResults(HealthFundTypes.maccabi, [testResult({ testName: 'שם בדיוני נוסף' })]);

    const after = listTestResults({ companyId: HealthFundTypes.maccabi })
      .find((row) => row.test_result_id === 'fictional-result-001')!.first_seen_at;
    expect(after).toBe(before);
  });

  it('treats a different test result id as a distinct timeline entry', () => {
    upsertTestResults(HealthFundTypes.maccabi, [
      testResult(),
      testResult({ id: 'fictional-result-002', testName: 'בדיקת שביט בדיונית' }),
    ]);

    expect(listTestResults({ companyId: HealthFundTypes.maccabi })).toHaveLength(2);
  });

  it('sorts newest performed date first and unknown dates last', () => {
    upsertTestResults(HealthFundTypes.maccabi, [
      testResult({
        id: 'fictional-result-003',
        testName: 'בדיקת ערפילית בדיונית',
        performedOn: null,
      }),
      testResult({
        id: 'fictional-result-004',
        testName: 'בדיקת מטאור בדיונית',
        performedOn: '2026-07-28',
      }),
    ]);

    const rows = listTestResults({ companyId: HealthFundTypes.maccabi });
    expect(rows[0]?.test_result_id).toBe('fictional-result-004');
    expect(rows.at(-1)?.test_result_id).toBe('fictional-result-003');
  });

  it('is exposed through table discovery and safe SQL querying', () => {
    upsertTestResults(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-query-result', testName: 'בדיקת שאילתה בדיונית' }),
    ]);

    expect(listTables()).toContainEqual({ name: 'test_results', rowCount: 1 });

    const table = describeTable('test_results');
    expect(table.columns.map((column) => column.name)).toEqual([
      'id',
      'company_id',
      'test_result_id',
      'test_name',
      'performed_on',
      'ordering_doctor',
      'raw',
      'first_seen_at',
      'updated_at',
    ]);

    const result = runSafeQuery(
      'SELECT test_result_id, test_name FROM test_results WHERE company_id = ?',
      [HealthFundTypes.maccabi],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([
      {
        test_result_id: 'fictional-query-result',
        test_name: 'בדיקת שאילתה בדיונית',
      },
    ]);
  });
});

describe('sync runs', () => {
  it('records a failed fetch, not just successful ones', () => {
    // "Is this data stale, or did the last fetch fail?" cannot be answered from the
    // medications table alone.
    const id = startSyncRun(HealthFundTypes.maccabi, 'medications');
    finishSyncRun(id, { success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'nope' });

    const run = lastSyncRun(HealthFundTypes.maccabi, 'medications');
    expect(run?.success).toBe(0);
    expect(run?.error_type).toBe('INVALID_PASSWORD');
  });

  it('keeps medications and appointments history separate for the same fund', () => {
    const medId = startSyncRun(HealthFundTypes.maccabi, 'medications');
    finishSyncRun(medId, { success: true, recordCount: 3 });

    const apptId = startSyncRun(HealthFundTypes.maccabi, 'appointments');
    finishSyncRun(apptId, { success: true, recordCount: 1 });

    expect(lastSyncRun(HealthFundTypes.maccabi, 'medications')?.record_count).toBe(3);
    expect(lastSyncRun(HealthFundTypes.maccabi, 'appointments')?.record_count).toBe(1);
  });

  it('keeps test-result freshness isolated and returns it from the production list operation', async () => {
    const db = openDatabase();
    const testResultId = 'fictional-task-3-freshness-result-only';
    const syncRunIds: number[] = [];

    try {
      upsertTestResults(HealthFundTypes.maccabi, [
        testResult({ id: testResultId, testName: 'בדיקת רעננות בדיונית' }),
      ]);

      const medicationRunId = startSyncRun(HealthFundTypes.maccabi, 'medications');
      syncRunIds.push(medicationRunId);
      finishSyncRun(medicationRunId, { success: false, errorType: 'FICTIONAL_MEDICATION_ERROR' });

      const appointmentRunId = startSyncRun(HealthFundTypes.maccabi, 'appointments');
      syncRunIds.push(appointmentRunId);
      finishSyncRun(appointmentRunId, { success: true, recordCount: 7 });

      const testResultRunId = startSyncRun(HealthFundTypes.maccabi, 'testResults');
      syncRunIds.push(testResultRunId);
      finishSyncRun(testResultRunId, { success: true, recordCount: 1 });

      const medicationSync = lastSyncRun(HealthFundTypes.maccabi, 'medications');
      const appointmentSync = lastSyncRun(HealthFundTypes.maccabi, 'appointments');
      const testResultSync = lastSyncRun(HealthFundTypes.maccabi, 'testResults');

      expect(medicationSync).toMatchObject({ success: 0, error_type: 'FICTIONAL_MEDICATION_ERROR' });
      expect(appointmentSync).toMatchObject({ success: 1, record_count: 7 });
      expect(testResultSync).toMatchObject({ success: 1, record_count: 1 });

      const listOperation = operationsFor(HealthFundTypes.maccabi).find(
        (operation) => operation.name === 'testResults.list',
      );
      expect(listOperation).toBeDefined();

      const result = (await listOperation!.run({})) as {
        items: { company_id: string; test_result_id: string; test_name: string }[];
        lastSync: { at: string; success: boolean; errorType: string | null } | null;
      };
      expect(result.items).toContainEqual(
        expect.objectContaining({
          company_id: HealthFundTypes.maccabi,
          test_result_id: testResultId,
          test_name: 'בדיקת רעננות בדיונית',
        }),
      );
      expect(result.lastSync).toEqual({
        at: testResultSync!.finished_at,
        success: true,
        errorType: null,
      });
    } finally {
      db.prepare('DELETE FROM test_results WHERE company_id = ? AND test_result_id = ?').run(
        HealthFundTypes.maccabi,
        testResultId,
      );
      const deleteSyncRun = db.prepare('DELETE FROM sync_runs WHERE id = ?');
      for (const id of syncRunIds) deleteSyncRun.run(id);
    }
  });
});
