import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthFundTypes, type TestResult, type Vaccination } from 'israeli-health-scrapers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-cli-test-'));
const key = 'fictional-cli-test-key';

process.env.HEALTH_MCP_DATA_DIR = tempDir;
process.env.HEALTH_MCP_KEY = key;
process.env.HEALTH_MCP_AUDIT = 'off';

const { closeDatabase, openDatabase } = await import('../src/db/database.js');
const { upsertTestResults } = await import('../src/db/test-results.js');
const { upsertVaccinations } = await import('../src/db/vaccinations.js');

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HEALTH_MCP_DATA_DIR: tempDir,
      HEALTH_MCP_KEY: key,
      HEALTH_MCP_AUDIT: 'off',
    },
  });
}

beforeAll(() => {
  openDatabase();
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('CLI vaccinations command', () => {
  it('prints stored vaccinations newest first for the selected fund', () => {
    const vaccinations: Vaccination[] = [
      {
        id: 'fictional-cli-vaccination-earlier',
        vaccineName: 'חיסון מוקדם דמיוני',
        administeredOn: '2024-01-02',
        dose: 'מנה 1',
        location: 'מרפאה א',
        provider: HealthFundTypes.maccabi,
      },
      {
        id: 'fictional-cli-vaccination-later',
        vaccineName: 'חיסון מאוחר דמיוני',
        administeredOn: '2026-07-20',
        dose: 'מנה 2',
        location: 'מרפאה ב',
        provider: HealthFundTypes.maccabi,
      },
    ];
    upsertVaccinations(HealthFundTypes.maccabi, vaccinations);
    closeDatabase();

    const result = runCli('vaccinations', 'maccabi');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('חיסון מאוחר דמיוני');
    expect(result.stdout.indexOf('2026-07-20')).toBeLessThan(result.stdout.indexOf('2024-01-02'));
    openDatabase();
  });

  it('shows the dedicated refresh command when no vaccinations are stored', () => {
    openDatabase().prepare('DELETE FROM vaccinations').run();
    closeDatabase();

    const result = runCli('vaccinations', 'maccabi');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No stored vaccinations. Run: health-mcp fetch-vaccinations\n');
    openDatabase();
  });

  it('advertises the vaccination fetch command', () => {
    const result = runCli();
    expect(result.stdout).toContain('fetch-vaccinations [fund]');
    expect(result.stdout).toContain('vaccinations [fund]');
  });
});

describe('CLI test-results command', () => {
  it('prints stored results newest first for the selected fund', () => {
    const results: TestResult[] = [
      {
        id: 'fictional-cli-earlier',
        testName: 'בדיקת מוקדם בדיונית',
        performedOn: '2026-07-10',
        orderingDoctor: 'ד״ר דוגמה מוקדם',
        provider: HealthFundTypes.maccabi,
      },
      {
        id: 'fictional-cli-later',
        testName: 'בדיקת מאוחר בדיונית',
        performedOn: '2026-07-20',
        orderingDoctor: 'ד״ר דוגמה מאוחר',
        provider: HealthFundTypes.maccabi,
      },
    ];
    upsertTestResults(HealthFundTypes.maccabi, results);
    closeDatabase();

    const result = runCli('test-results', 'maccabi');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('2026-07-20');
    expect(result.stdout).toContain('בדיקת מאוחר בדיונית');
    expect(result.stdout.indexOf('2026-07-20')).toBeLessThan(result.stdout.indexOf('2026-07-10'));

    openDatabase();
  });

  it('shows the dedicated refresh command when no results are stored', () => {
    openDatabase().prepare('DELETE FROM test_results').run();
    closeDatabase();

    const result = runCli('test-results', 'maccabi');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No stored test results. Run: health-mcp fetch-test-results\n');

    openDatabase();
  });
});
