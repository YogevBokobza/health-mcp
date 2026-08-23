import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Form17Request, Medication, ScraperOptions, TestResult, Vaccination } from 'israeli-health-scrapers';

const scraperFactory = vi.hoisted(() => vi.fn());

vi.mock('israeli-health-scrapers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('israeli-health-scrapers')>();
  return { ...actual, createScraper: scraperFactory };
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-sync-test-'));
process.env.HEALTH_MCP_DATA_DIR = tempDir;
process.env.HEALTH_MCP_KEY = 'fictional-sync-test-key';
process.env.HEALTH_MCP_AUDIT = 'off';

const { HealthFundTypes, ScraperErrorTypes } = await import('israeli-health-scrapers');
const { closeDatabase, openDatabase } = await import('../../src/db/database.js');
const { saveCredentials } = await import('../../src/db/credentials.js');
const { listTestResults, listTestResultValues } = await import('../../src/db/test-results.js');
const { listVaccinations } = await import('../../src/db/vaccinations.js');
const { listForm17Requests } = await import('../../src/db/form17.js');
const { listMedications, upsertMedications } = await import('../../src/db/medications.js');
const { lastSyncRun } = await import('../../src/db/sync-runs.js');
const {
  classifyFetchFailure,
  fetchFund,
  fetchForm17ForFund,
  fetchTestResultDetailsForFund,
  fetchTestResultsForFund,
  fetchVaccinationsForFund,
} = await import('../../src/sync/fetch.js');

const fictionalResult: TestResult = {
  id: 'fictional-sync-result',
  testName: 'בדיקת סנכרון בדיונית',
  performedOn: '2026-07-28',
  resultedOn: null,
  orderingDoctor: 'ד״ר בדיקה בדיוני',
  category: null,
  kind: 'lab',
  isPartial: false,
  institute: null,
  documentAvailable: false,
  provider: HealthFundTypes.maccabi,
};

function fictionalMedication(overrides: Partial<Medication> = {}): Medication {
  return {
    name: 'תרופת סנכרון בדיונית',
    dosage: '10 מ״ג',
    form: 'טבליות',
    prescribedBy: 'ד״ר דמיון בלבד',
    lastDispensed: null,
    validUntil: '2026-08-15',
    refillsRemaining: null,
    daysUntilExpiry: 17,
    status: 'expiring_soon',
    isStanding: false,
    provider: HealthFundTypes.maccabi,
    ...overrides,
  };
}

beforeAll(() => {
  openDatabase();
  saveCredentials(HealthFundTypes.maccabi, { id: 'fictional-member-id' });
});

beforeEach(() => {
  scraperFactory.mockReset();
  openDatabase().prepare('DELETE FROM test_result_values').run();
  openDatabase().prepare('DELETE FROM test_results').run();
  openDatabase().prepare('DELETE FROM medications').run();
  openDatabase().prepare('DELETE FROM form17_requests').run();
  openDatabase().prepare('DELETE FROM sync_runs').run();
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function successfulScraper(accounts: unknown[]) {
  return { scrape: vi.fn().mockResolvedValue({ success: true, accounts }) };
}

function expectFinishedFailedTestResultSync(message: string): void {
  expect(lastSyncRun(HealthFundTypes.maccabi, 'testResults')).toMatchObject({
    resource: 'testResults',
    success: 0,
    error_type: 'GENERAL_ERROR',
    error_message: message,
  });
  expect(lastSyncRun(HealthFundTypes.maccabi, 'testResults')?.finished_at).not.toBeNull();
}

describe('fetchVaccinationsForFund', () => {
  const vaccination: Vaccination = {
    id: 'fictional-sync-vaccination',
    vaccineName: 'חיסון סנכרון דמיוני',
    administeredOn: '2026-04-03',
    ageAtAdministration: 31.7,
    dose: 'מנה 2',
    location: 'מרפאת סנכרון',
    provider: HealthFundTypes.maccabi,
  };

  it('requests only vaccinations, stores the flattened snapshot, and records success', async () => {
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: true,
        accounts: [{ provider: HealthFundTypes.maccabi, medications: [], vaccinations: [vaccination] }],
      }),
    });

    await expect(fetchVaccinationsForFund(HealthFundTypes.maccabi)).resolves.toMatchObject({
      success: true,
      recordCount: 1,
    });
    expect(scraperFactory).toHaveBeenCalledWith(expect.objectContaining({ fetch: ['vaccinations'] }));
    expect(listVaccinations({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({
        vaccination_id: vaccination.id,
        age_at_administration: vaccination.ageAtAdministration,
      }),
    ]);
    expect(lastSyncRun(HealthFundTypes.maccabi, 'vaccinations')).toMatchObject({ success: 1, record_count: 1 });
  });

  it('returns scraper failures and records finished failure history', async () => {
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: false,
        errorType: ScraperErrorTypes.InvalidPassword,
        errorMessage: 'fictional vaccination credentials rejected',
      }),
    });

    await expect(fetchVaccinationsForFund(HealthFundTypes.maccabi)).resolves.toMatchObject({
      success: false,
      recordCount: 0,
      errorType: ScraperErrorTypes.InvalidPassword,
      status: 'credentials_rejected',
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'vaccinations')).toMatchObject({
      success: 0,
      error_message: 'fictional vaccination credentials rejected',
    });
  });
});

describe('fetchForm17ForFund', () => {
  const form17Request: Form17Request = {
    id: 'fictional-sync-form17',
    requestType: 'טופס 17 סנכרון בדיוני',
    status: 'בטיפול',
    submittedOn: '2026-07-01',
    statusUpdatedOn: '2026-07-05',
    providerName: 'ד״ר טופס בדיוני',
    appointmentOn: '2026-08-01',
    documentLabels: ['מסמך סנכרון'],
    canChangeAppointment: true,
    requiresAdditionalInfo: false,
    provider: HealthFundTypes.maccabi,
  };

  it('requests only form17, stores the flattened snapshot, and records success', async () => {
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: true,
        accounts: [{ provider: HealthFundTypes.maccabi, medications: [], form17: [form17Request] }],
      }),
    });

    await expect(fetchForm17ForFund(HealthFundTypes.maccabi)).resolves.toMatchObject({
      success: true,
      recordCount: 1,
    });
    expect(scraperFactory).toHaveBeenCalledWith(expect.objectContaining({ fetch: ['form17'] }));
    expect(listForm17Requests({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({
        request_id: form17Request.id,
        status: 'בטיפול',
        can_change_appointment: 1,
      }),
    ]);
    expect(lastSyncRun(HealthFundTypes.maccabi, 'form17')).toMatchObject({ success: 1, record_count: 1 });
  });

  it('returns scraper failures and records finished failure history', async () => {
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: false,
        errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
        errorMessage: 'fictional form17 session gone',
      }),
    });

    await expect(fetchForm17ForFund(HealthFundTypes.maccabi)).resolves.toMatchObject({
      success: false,
      recordCount: 0,
      errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
      status: 'session_expired',
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'form17')).toMatchObject({
      success: 0,
      // The raw scraper message, not a CLI-oriented rewrite: the agent-facing "what to
      // do next" lives in the outcome's `next` field, not here.
      error_message: 'fictional form17 session gone',
    });
  });
});

describe('fetchFund', () => {
  it('replaces a renewed medication instead of retaining its previous validity period', async () => {
    upsertMedications(HealthFundTypes.maccabi, [fictionalMedication()]);
    scraperFactory.mockReturnValue(
      successfulScraper([
        {
          medications: [
            fictionalMedication({
              validUntil: '2026-10-15',
              daysUntilExpiry: 78,
              status: 'active',
            }),
          ],
        },
      ]),
    );

    await expect(fetchFund(HealthFundTypes.maccabi)).resolves.toEqual({
      companyId: HealthFundTypes.maccabi,
      success: true,
      recordCount: 1,
    });
    expect(listMedications({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({ valid_until: '2026-10-15' }),
    ]);
  });

  it('clears stored medications after a successful empty snapshot', async () => {
    upsertMedications(HealthFundTypes.maccabi, [fictionalMedication()]);
    scraperFactory.mockReturnValue(successfulScraper([{ medications: [] }]));

    await expect(fetchFund(HealthFundTypes.maccabi)).resolves.toMatchObject({
      success: true,
      recordCount: 0,
    });
    expect(listMedications({ companyId: HealthFundTypes.maccabi })).toEqual([]);
  });

  it('preserves stored medications when the scrape fails', async () => {
    upsertMedications(HealthFundTypes.maccabi, [fictionalMedication()]);
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: false,
        errorType: ScraperErrorTypes.InvalidPassword,
        errorMessage: 'fictional rejected credentials',
      }),
    });

    await expect(fetchFund(HealthFundTypes.maccabi)).resolves.toMatchObject({ success: false });
    expect(listMedications({ companyId: HealthFundTypes.maccabi })).toHaveLength(1);
  });
});

describe('fetchTestResultsForFund', () => {
  it('keeps company, fetch target, and session storage authoritative over caller options', async () => {
    scraperFactory.mockReturnValue(successfulScraper([{ testResults: [fictionalResult] }]));

    const outcome = await fetchTestResultsForFund(HealthFundTypes.maccabi, {
      companyId: HealthFundTypes.clalit,
      fetch: ['medications'],
      storeSession: false,
      timeout: 4321,
    } as Partial<ScraperOptions>);

    expect(scraperFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: HealthFundTypes.maccabi,
        fetch: ['testResults'],
        storeSession: true,
        timeout: 4321,
      }),
    );
    expect(outcome).toEqual({ companyId: HealthFundTypes.maccabi, success: true, recordCount: 1 });
    expect(listTestResults({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({ test_result_id: 'fictional-sync-result' }),
    ]);
  });

  it('finishes test-result sync as failed when scraper construction throws', async () => {
    scraperFactory.mockImplementation(() => {
      throw new Error('fictional construction failure');
    });

    await expect(fetchTestResultsForFund(HealthFundTypes.maccabi)).rejects.toThrow(
      'fictional construction failure',
    );
    expectFinishedFailedTestResultSync('fictional construction failure');
  });

  it('finishes test-result sync as failed when scraping rejects', async () => {
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockRejectedValue(new Error('fictional asynchronous failure')),
    });

    await expect(fetchTestResultsForFund(HealthFundTypes.maccabi)).rejects.toThrow(
      'fictional asynchronous failure',
    );
    expectFinishedFailedTestResultSync('fictional asynchronous failure');
  });

  it('preserves returned scraper failures and records finished failure history', async () => {
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: false,
        errorType: ScraperErrorTypes.InvalidPassword,
        errorMessage: 'fictional rejected credentials',
      }),
    });

    await expect(fetchTestResultsForFund(HealthFundTypes.maccabi)).resolves.toEqual({
      companyId: HealthFundTypes.maccabi,
      success: false,
      recordCount: 0,
      errorType: ScraperErrorTypes.InvalidPassword,
      errorMessage: 'fictional rejected credentials',
      status: 'credentials_rejected',
      next: expect.any(String),
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'testResults')).toMatchObject({
      success: 0,
      error_type: ScraperErrorTypes.InvalidPassword,
      error_message: 'fictional rejected credentials',
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'testResults')?.finished_at).not.toBeNull();
  });
});

describe('fetchTestResultDetailsForFund', () => {
  const labEntry: TestResult = {
    ...fictionalResult,
    id: 'fictional-sync-detail-result',
    kind: 'lab',
    values: [
      {
        code: 'FICT-1',
        name: 'גלוקוז סנכרון בדיוני',
        group: null,
        value: 90,
        text: null,
        unit: 'mg/dl',
        referenceMin: 70,
        referenceMax: 100,
        status: 'within',
        measuredOn: '2026-07-28',
      },
    ],
  };

  it('requests testResultDetails, records its own sync-run resource, and stores values', async () => {
    scraperFactory.mockReturnValue(successfulScraper([{ testResults: [labEntry] }]));

    const outcome = await fetchTestResultDetailsForFund(HealthFundTypes.maccabi);

    expect(scraperFactory).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: ['testResultDetails'] }),
    );
    expect(outcome).toMatchObject({ success: true, recordCount: 1, documentCount: 0 });
    expect(listTestResultValues({ companyId: HealthFundTypes.maccabi })).toEqual([
      expect.objectContaining({ name: 'גלוקוז סנכרון בדיוני', value: 90 }),
    ]);
    expect(lastSyncRun(HealthFundTypes.maccabi, 'testResultDetails')).toMatchObject({
      resource: 'testResultDetails',
      success: 1,
      record_count: 1,
    });
    // The cheap timeline resource's own history is untouched by the detail fetch.
    expect(lastSyncRun(HealthFundTypes.maccabi, 'testResults')).toBeNull();
  });

  it('counts documents separately from values, so a document-only result is not reported as empty', async () => {
    const documentEntry: TestResult = {
      ...fictionalResult,
      id: 'fictional-sync-detail-document',
      kind: 'document',
      documentAvailable: true,
      document: {
        fileName: 'fictional-sync-report.pdf',
        contentType: 'application/pdf',
        byteLength: 4,
        content: Buffer.from('fict').toString('base64'),
      },
    };
    scraperFactory.mockReturnValue(successfulScraper([{ testResults: [documentEntry] }]));

    const outcome = await fetchTestResultDetailsForFund(HealthFundTypes.maccabi);

    // Zero lab values, one document — recordCount alone would read as "nothing found".
    expect(outcome).toMatchObject({ success: true, recordCount: 0, documentCount: 1 });
  });

  it('passes since as testResultDetailsSince, not as a raw scraper option', async () => {
    scraperFactory.mockReturnValue(successfulScraper([{ testResults: [] }]));

    await fetchTestResultDetailsForFund(HealthFundTypes.maccabi, { since: '2026-01-01' });

    expect(scraperFactory).toHaveBeenCalledWith(
      expect.objectContaining({ testResultDetailsSince: '2026-01-01' }),
    );
  });

  it('records finished failure history under its own resource, distinct from testResults', async () => {
    scraperFactory.mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        success: false,
        errorType: ScraperErrorTypes.InvalidPassword,
        errorMessage: 'fictional detail credentials rejected',
      }),
    });

    await expect(fetchTestResultDetailsForFund(HealthFundTypes.maccabi)).resolves.toMatchObject({
      success: false,
      status: 'credentials_rejected',
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'testResultDetails')).toMatchObject({
      success: 0,
      error_message: 'fictional detail credentials rejected',
    });
  });
});

describe('classifyFetchFailure', () => {
  it('maps a missing OTP retriever to a session_expired re-auth instruction', () => {
    const action = classifyFetchFailure('maccabi', ScraperErrorTypes.TwoFactorRetrieverMissing);
    expect(action.status).toBe('session_expired');
    expect(action.next).toContain('auth_start');
    expect(action.next).toContain('auth_complete');
  });

  it('maps password failures to credentials_rejected', () => {
    for (const errorType of [
      ScraperErrorTypes.InvalidPassword,
      ScraperErrorTypes.ChangePassword,
      ScraperErrorTypes.AccountBlocked,
    ]) {
      expect(classifyFetchFailure('maccabi', errorType).status).toBe('credentials_rejected');
    }
  });

  it('leaves operational failures unclassified', () => {
    expect(classifyFetchFailure('maccabi', ScraperErrorTypes.Timeout)).toEqual({
      status: 'fetch_failed',
      next: null,
    });
    expect(classifyFetchFailure('maccabi', undefined)).toEqual({ status: 'fetch_failed', next: null });
  });
});
