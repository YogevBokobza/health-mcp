import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HealthFundTypes,
  type Appointment,
  type Form17Request,
  type HealthDocument,
  type Medication,
  type TestResult,
  type TestResultValue,
  type Vaccination,
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
const {
  upsertTestResults,
  storeTestResultDetails,
  listTestResults,
  listTestResultValues,
  countTestResultValues,
  findTestResultForExport,
} = await import('../../src/db/test-results.js');
const { loadDocument } = await import('../../src/store/documents.js');
const { upsertVaccinations, listVaccinations } = await import('../../src/db/vaccinations.js');
const { upsertForm17Requests, listForm17Requests } = await import('../../src/db/form17.js');
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
    isStanding: true,
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
    resultedOn: null,
    orderingDoctor: 'ד"ר דמיון בלבד',
    category: null,
    kind: 'other',
    isPartial: false,
    institute: null,
    documentAvailable: false,
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

  it('stores the standing flag as 0/1 for both standing and one-off prescriptions', () => {
    upsertMedications(HealthFundTypes.maccabi, [
      medication({ name: 'תרופה קבועה בדיונית', isStanding: true }),
      medication({ name: 'תרופה חד-פעמית בדיונית', validUntil: '2026-09-30', isStanding: false }),
    ]);

    const byName = new Map(listMedications().map((row) => [row.name, row.is_standing]));
    expect(byName.get('תרופה קבועה בדיונית')).toBe(1);
    expect(byName.get('תרופה חד-פעמית בדיונית')).toBe(0);
  });

  it('updates the standing flag in place when a prescription changes category', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication({ isStanding: false })]);
    upsertMedications(HealthFundTypes.maccabi, [medication({ isStanding: true })]);

    const rows = listMedications({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_standing).toBe(1);
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
      'resulted_on',
      'ordering_doctor',
      'category',
      'kind',
      'is_partial',
      'institute',
      'document_available',
      'document_path',
      'document_bytes',
      'document_sha256',
      'detailed_at',
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

const fictionalAnalyteName = 'גלוקוז בדיוני';

function testResultValue(overrides: Partial<TestResultValue> = {}): TestResultValue {
  return {
    code: 'FICT-1',
    name: fictionalAnalyteName,
    group: 'כימיה בדיונית',
    value: 90,
    text: null,
    unit: 'mg/dl',
    referenceMin: 70,
    referenceMax: 100,
    status: 'within',
    measuredOn: '2026-07-14',
    ...overrides,
  };
}

function fictionalDocument(content = 'fictional pdf bytes, not a real report'): HealthDocument {
  return {
    fileName: 'בדיקת דמיון.pdf',
    contentType: 'application/pdf',
    byteLength: Buffer.byteLength(content),
    content: Buffer.from(content).toString('base64'),
  };
}

describe('test result details (values and documents)', () => {
  beforeEach(() => {
    openDatabase().prepare('DELETE FROM test_result_values').run();
    openDatabase().prepare('DELETE FROM test_results').run();
  });

  afterEach(() => {
    openDatabase().prepare('DELETE FROM test_result_values').run();
    openDatabase().prepare('DELETE FROM test_results').run();
  });

  it('stores measured values and reports how many are behind each result', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-detail-1', kind: 'lab', values: [testResultValue()] }),
    ]);

    const values = listTestResultValues({ companyId: HealthFundTypes.maccabi });
    expect(values).toContainEqual(
      expect.objectContaining({ name: fictionalAnalyteName, value: 90, status: 'within' }),
    );
    expect(countTestResultValues({ companyId: HealthFundTypes.maccabi }).get('fictional-detail-1')).toBe(1);
  });

  it('filters values by analyte name, date range, and out-of-range-only', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({
        id: 'fictional-detail-filter',
        kind: 'lab',
        values: [
          testResultValue({ name: fictionalAnalyteName, value: 90, status: 'within', measuredOn: '2026-07-14' }),
          testResultValue({
            name: 'המוגלובין בדיוני',
            value: 8,
            status: 'below',
            referenceMin: 12,
            measuredOn: '2026-01-01',
          }),
        ],
      }),
    ]);

    expect(listTestResultValues({ companyId: HealthFundTypes.maccabi, name: 'גלוקוז' })).toHaveLength(1);
    expect(
      listTestResultValues({ companyId: HealthFundTypes.maccabi, from: '2026-06-01' }),
    ).toHaveLength(1);
    expect(
      listTestResultValues({ companyId: HealthFundTypes.maccabi, outOfRangeOnly: true }),
    ).toEqual([expect.objectContaining({ name: 'המוגלובין בדיוני' })]);
  });

  it('replaces a batch wholesale on re-fetch, dropping a value the fund withdrew', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({
        id: 'fictional-detail-replace',
        kind: 'lab',
        values: [testResultValue(), testResultValue({ code: 'FICT-2', name: 'אשלגן בדיוני' })],
      }),
    ]);
    expect(listTestResultValues({ companyId: HealthFundTypes.maccabi })).toHaveLength(2);

    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-detail-replace', kind: 'lab', values: [testResultValue()] }),
    ]);

    expect(listTestResultValues({ companyId: HealthFundTypes.maccabi })).toHaveLength(1);
  });

  it('preserves first_seen_at for a value that survives a re-fetch', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-detail-firstseen', kind: 'lab', values: [testResultValue()] }),
    ]);
    const before = listTestResultValues({ companyId: HealthFundTypes.maccabi })[0]!.first_seen_at;

    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-detail-firstseen', kind: 'lab', values: [testResultValue({ value: 95 })] }),
    ]);

    expect(listTestResultValues({ companyId: HealthFundTypes.maccabi })[0]?.first_seen_at).toBe(before);
  });

  it('does not delete values when a value fetch was not attempted (values undefined, not empty)', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-detail-untouched', kind: 'lab', values: [testResultValue()] }),
    ]);

    // A plain timeline upsert never sets `values` at all.
    upsertTestResults(HealthFundTypes.maccabi, [testResult({ id: 'fictional-detail-untouched', kind: 'lab' })]);

    expect(listTestResultValues({ companyId: HealthFundTypes.maccabi })).toHaveLength(1);
  });

  it('saves a result document encrypted on disk and records its checksum on the row', () => {
    const content = 'fictional imaging report content';
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({
        id: 'fictional-detail-doc',
        kind: 'document',
        documentAvailable: true,
        document: fictionalDocument(content),
      }),
    ]);

    const [row] = listTestResults({ companyId: HealthFundTypes.maccabi });
    expect(row?.document_path).toBeTruthy();
    expect(row?.document_sha256).toBeTruthy();
    expect(row?.detailed_at).toBeTruthy();

    const raw = fs.readFileSync(row!.document_path!);
    expect(raw.includes(Buffer.from(content))).toBe(false);
    expect(loadDocument(row!.document_path!, row!.document_sha256!).toString('utf8')).toBe(content);

    const forExport = findTestResultForExport(HealthFundTypes.maccabi, 'fictional-detail-doc');
    expect(forExport).toEqual({ document_path: row!.document_path, document_sha256: row!.document_sha256 });
  });

  it('marks detailed_at without document fields when the result has no document', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-detail-nodoc', kind: 'lab', values: [] }),
    ]);

    const [row] = listTestResults({ companyId: HealthFundTypes.maccabi });
    expect(row?.detailed_at).toBeTruthy();
    expect(row?.document_path).toBeNull();
  });

  it('leaves values and document metadata intact after a subsequent plain timeline refresh', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({
        id: 'fictional-detail-survives-refresh',
        kind: 'document',
        documentAvailable: true,
        document: fictionalDocument(),
      }),
    ]);
    const before = listTestResults({ companyId: HealthFundTypes.maccabi })[0]!;
    expect(before.document_path).toBeTruthy();

    // The cheap refresh path: re-lists the timeline without touching detail columns.
    upsertTestResults(HealthFundTypes.maccabi, [
      testResult({
        id: 'fictional-detail-survives-refresh',
        kind: 'document',
        documentAvailable: true,
        testName: 'שם מעודכן בדיוני',
      }),
    ]);

    const after = listTestResults({ companyId: HealthFundTypes.maccabi })[0]!;
    expect(after.test_name).toBe('שם מעודכן בדיוני');
    expect(after.document_path).toBe(before.document_path);
    expect(after.document_sha256).toBe(before.document_sha256);
    expect(after.detailed_at).toBe(before.detailed_at);
  });

  it('is not reachable through the raw-SQL query operation', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      testResult({ id: 'fictional-detail-sql-guard', kind: 'lab', values: [testResultValue()] }),
    ]);

    expect(() => runSafeQuery('SELECT * FROM test_result_values')).toThrow();
    expect(listTables().map((table) => table.name)).not.toContain('test_result_values');
  });
});

describe('vaccinations', () => {
  const vaccination = (overrides: Partial<Vaccination> = {}): Vaccination => ({
    id: 'fictional-vaccination-1',
    vaccineName: 'חיסון דמיוני א',
    administeredOn: '2026-03-14',
    ageAtAdministration: 42.5,
    dose: 'מנה 1',
    location: 'מרפאת דוגמה',
    provider: HealthFundTypes.maccabi,
    ...overrides,
  });

  it('upserts a fund-isolated snapshot and removes records absent from the next snapshot', () => {
    upsertVaccinations(HealthFundTypes.maccabi, [
      vaccination(),
      vaccination({ id: 'fictional-vaccination-2', administeredOn: '2025-01-02' }),
    ]);
    upsertVaccinations(HealthFundTypes.clalit, [
      vaccination({ id: 'fictional-clalit-vaccination', provider: HealthFundTypes.clalit }),
    ]);

    expect(
      upsertVaccinations(HealthFundTypes.maccabi, [
        vaccination({ location: 'מרפאה מעודכנת', ageAtAdministration: 43.1 }),
      ]),
    ).toBe(1);
    expect(listVaccinations({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({
        vaccination_id: 'fictional-vaccination-1',
        vaccine_name: 'חיסון דמיוני א',
        administered_on: '2026-03-14',
        age_at_administration: 43.1,
        location: 'מרפאה מעודכנת',
      }),
    ]);
    expect(listVaccinations({ companyId: HealthFundTypes.clalit })).toHaveLength(1);
  });

  it('deduplicates duplicate IDs using the last occurrence and reports unique rows', () => {
    const duplicateId = 'fictional-vaccination-duplicate';
    const uniqueCount = upsertVaccinations(HealthFundTypes.maccabi, [
      vaccination({ id: duplicateId, location: 'מרפאה ראשונה' }),
      vaccination({ id: 'fictional-vaccination-distinct', administeredOn: '2025-02-03' }),
      vaccination({ id: duplicateId, location: 'מרפאה אחרונה' }),
    ]);

    expect(uniqueCount).toBe(2);
    expect(listVaccinations({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({ vaccination_id: duplicateId, location: 'מרפאה אחרונה' }),
      expect.objectContaining({ vaccination_id: 'fictional-vaccination-distinct' }),
    ]);
  });

  it('does not store a fictional vaccination name in plaintext on disk', () => {
    const vaccineName = 'חיסון הצפנה דמיוני';
    upsertVaccinations(HealthFundTypes.maccabi, [vaccination({ vaccineName })]);
    closeDatabase();
    const raw = fs.readFileSync(path.join(tempDir, 'database.db'));
    expect(raw.includes(Buffer.from(vaccineName))).toBe(false);
    openDatabase();
  });

  it('orders newest first and exposes vaccinations to safe SQL queries', () => {
    upsertVaccinations(HealthFundTypes.maccabi, [
      vaccination({ id: 'fictional-vaccination-old', administeredOn: '2024-01-02' }),
      vaccination({ id: 'fictional-vaccination-new', administeredOn: '2026-07-20' }),
    ]);

    expect(listVaccinations({ companyId: HealthFundTypes.maccabi }).map((row) => row.vaccination_id)).toEqual([
      'fictional-vaccination-new',
      'fictional-vaccination-old',
    ]);
    expect(listTables()).toContainEqual({ name: 'vaccinations', rowCount: 3 });
    expect(describeTable('vaccinations').columns.map((column) => column.name)).toContain(
      'age_at_administration',
    );
    expect(runSafeQuery('SELECT vaccination_id FROM vaccinations').rowCount).toBeGreaterThan(0);
  });
});

describe('form17 requests', () => {
  const form17Request = (overrides: Partial<Form17Request> = {}): Form17Request => ({
    id: 'fictional-form17-1',
    requestType: 'טופס 17 בדיוני',
    status: 'אושר',
    submittedOn: '2026-06-01',
    statusUpdatedOn: '2026-06-05',
    providerName: 'ד"ר דמיון בלבד',
    appointmentOn: '2026-07-01',
    documentLabels: ['אישור בדיוני'],
    canChangeAppointment: true,
    requiresAdditionalInfo: false,
    provider: HealthFundTypes.maccabi,
    ...overrides,
  });

  it('upserts a fund-isolated snapshot and removes requests absent from the next snapshot', () => {
    upsertForm17Requests(HealthFundTypes.maccabi, [
      form17Request(),
      form17Request({ id: 'fictional-form17-2', submittedOn: '2025-03-04' }),
    ]);
    upsertForm17Requests(HealthFundTypes.clalit, [
      form17Request({ id: 'fictional-clalit-form17', provider: HealthFundTypes.clalit }),
    ]);

    expect(
      upsertForm17Requests(HealthFundTypes.maccabi, [
        form17Request({ status: 'בטיפול', canChangeAppointment: null }),
      ]),
    ).toBe(1);
    expect(listForm17Requests({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({
        request_id: 'fictional-form17-1',
        status: 'בטיפול',
        can_change_appointment: null,
        requires_additional_info: 0,
      }),
    ]);
    expect(listForm17Requests({ companyId: HealthFundTypes.clalit })).toHaveLength(1);
  });

  it('deduplicates duplicate IDs using the last occurrence and reports unique rows', () => {
    const duplicateId = 'fictional-form17-duplicate';
    const uniqueCount = upsertForm17Requests(HealthFundTypes.maccabi, [
      form17Request({ id: duplicateId, providerName: 'ספק ראשון' }),
      form17Request({ id: 'fictional-form17-distinct', submittedOn: '2025-02-03' }),
      form17Request({ id: duplicateId, providerName: 'ספק אחרון' }),
    ]);

    expect(uniqueCount).toBe(2);
    expect(listForm17Requests({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({ request_id: duplicateId, provider_name: 'ספק אחרון' }),
      expect.objectContaining({ request_id: 'fictional-form17-distinct' }),
    ]);
  });

  it('preserves first_seen_at across an update and stores document labels as JSON', () => {
    upsertForm17Requests(HealthFundTypes.maccabi, [form17Request()]);
    const before = listForm17Requests({ companyId: HealthFundTypes.maccabi })[0]!.first_seen_at;

    upsertForm17Requests(HealthFundTypes.maccabi, [
      form17Request({ documentLabels: ['מסמך א', 'מסמך ב'] }),
    ]);

    const row = listForm17Requests({ companyId: HealthFundTypes.maccabi })[0]!;
    expect(row.first_seen_at).toBe(before);
    expect(JSON.parse(row.document_labels!)).toEqual(['מסמך א', 'מסמך ב']);
  });

  it('does not store a fictional form17 request type in plaintext on disk', () => {
    const requestType = 'טופס הצפנה בדיוני';
    upsertForm17Requests(HealthFundTypes.maccabi, [form17Request({ requestType })]);
    closeDatabase();
    const raw = fs.readFileSync(path.join(tempDir, 'database.db'));
    expect(raw.includes(Buffer.from(requestType))).toBe(false);
    openDatabase();
  });

  it('orders newest submitted first and exposes form17_requests to safe SQL queries', () => {
    upsertForm17Requests(HealthFundTypes.maccabi, [
      form17Request({ id: 'fictional-form17-old', submittedOn: '2024-01-02' }),
      form17Request({ id: 'fictional-form17-new', submittedOn: '2026-07-20' }),
    ]);

    expect(
      listForm17Requests({ companyId: HealthFundTypes.maccabi }).map((row) => row.request_id),
    ).toEqual(['fictional-form17-new', 'fictional-form17-old']);
    expect(listTables()).toContainEqual({ name: 'form17_requests', rowCount: 3 });
    expect(describeTable('form17_requests').columns.map((column) => column.name)).toContain(
      'requires_additional_info',
    );
    expect(runSafeQuery('SELECT request_id FROM form17_requests').rowCount).toBeGreaterThan(0);
  });

  it('returns form17 freshness from the production list operation', async () => {
    upsertForm17Requests(HealthFundTypes.maccabi, [form17Request()]);
    const runId = startSyncRun(HealthFundTypes.maccabi, 'form17');
    finishSyncRun(runId, { success: true, recordCount: 1 });

    try {
      const listOperation = operationsFor(HealthFundTypes.maccabi).find(
        (operation) => operation.name === 'form17.list',
      );
      expect(listOperation).toBeDefined();

      const result = (await listOperation!.run({})) as {
        items: { request_id: string }[];
        lastSync: { success: boolean } | null;
      };
      expect(result.items).toContainEqual(expect.objectContaining({ request_id: 'fictional-form17-1' }));
      expect(result.lastSync).toMatchObject({ success: true });
    } finally {
      openDatabase().prepare('DELETE FROM sync_runs WHERE id = ?').run(runId);
    }
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
