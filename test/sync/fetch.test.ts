import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Medication, ScraperOptions, TestResult, Vaccination } from 'israeli-health-scrapers';

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
const { listTestResults } = await import('../../src/db/test-results.js');
const { listVaccinations } = await import('../../src/db/vaccinations.js');
const { listMedications, upsertMedications } = await import('../../src/db/medications.js');
const { lastSyncRun } = await import('../../src/db/sync-runs.js');
const { fetchFund, fetchTestResultsForFund, fetchVaccinationsForFund } = await import('../../src/sync/fetch.js');

const fictionalResult: TestResult = {
  id: 'fictional-sync-result',
  testName: 'בדיקת סנכרון בדיונית',
  performedOn: '2026-07-28',
  orderingDoctor: 'ד״ר בדיקה בדיוני',
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
  openDatabase().prepare('DELETE FROM test_results').run();
  openDatabase().prepare('DELETE FROM medications').run();
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
      expect.objectContaining({ vaccination_id: vaccination.id }),
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
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'vaccinations')).toMatchObject({
      success: 0,
      error_message: 'fictional vaccination credentials rejected',
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
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'testResults')).toMatchObject({
      success: 0,
      error_type: ScraperErrorTypes.InvalidPassword,
      error_message: 'fictional rejected credentials',
    });
    expect(lastSyncRun(HealthFundTypes.maccabi, 'testResults')?.finished_at).not.toBeNull();
  });
});
