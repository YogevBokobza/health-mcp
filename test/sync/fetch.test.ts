import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScraperOptions, TestResult } from 'israeli-health-scrapers';

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
const { lastSyncRun } = await import('../../src/db/sync-runs.js');
const { fetchTestResultsForFund } = await import('../../src/sync/fetch.js');

const fictionalResult: TestResult = {
  id: 'fictional-sync-result',
  testName: 'בדיקת סנכרון בדיונית',
  performedOn: '2026-07-28',
  orderingDoctor: 'ד״ר בדיקה בדיוני',
  provider: HealthFundTypes.maccabi,
};

beforeAll(() => {
  openDatabase();
  saveCredentials(HealthFundTypes.maccabi, { id: 'fictional-member-id' });
});

beforeEach(() => {
  scraperFactory.mockReset();
  openDatabase().prepare('DELETE FROM test_results').run();
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
