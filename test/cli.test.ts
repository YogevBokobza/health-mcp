import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthFundTypes, type Form17Request, type TestResult, type Vaccination } from 'israeli-health-scrapers';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-cli-test-'));
const key = 'fictional-cli-test-key';

process.env.HEALTH_MCP_DATA_DIR = tempDir;
process.env.HEALTH_MCP_KEY = key;
process.env.HEALTH_MCP_AUDIT = 'off';

const { closeDatabase, openDatabase } = await import('../src/db/database.js');
const { upsertTestResults, storeTestResultDetails } = await import('../src/db/test-results.js');
const { upsertVaccinations } = await import('../src/db/vaccinations.js');
const { upsertForm17Requests } = await import('../src/db/form17.js');

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
        ageAtAdministration: 20.1,
        dose: 'מנה 1',
        location: 'מרפאה א',
        provider: HealthFundTypes.maccabi,
      },
      {
        id: 'fictional-cli-vaccination-later',
        vaccineName: 'חיסון מאוחר דמיוני',
        administeredOn: '2026-07-20',
        ageAtAdministration: 22.6,
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
    expect(result.stdout).toContain('age 22.6');
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
        resultedOn: null,
        orderingDoctor: 'ד״ר דוגמה מוקדם',
        category: null,
        kind: 'lab',
        isPartial: false,
        institute: null,
        documentAvailable: false,
        provider: HealthFundTypes.maccabi,
      },
      {
        id: 'fictional-cli-later',
        testName: 'בדיקת מאוחר בדיונית',
        performedOn: '2026-07-20',
        resultedOn: null,
        orderingDoctor: 'ד״ר דוגמה מאוחר',
        category: null,
        kind: 'lab',
        isPartial: false,
        institute: null,
        documentAvailable: false,
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

  it('advertises the detail-tier commands', () => {
    const result = runCli();
    expect(result.stdout).toContain('fetch-test-result-details [fund]');
    expect(result.stdout).toContain('test-result-values [fund]');
    expect(result.stdout).toContain('export-document <fund> <resultId> <destination>');
  });
});

describe('CLI test-result-values and export-document commands', () => {
  const detailResultId = 'fictional-cli-detail-result';

  it('prints stored lab values and supports the analyte/abnormal filters', () => {
    storeTestResultDetails(HealthFundTypes.maccabi, [
      {
        id: detailResultId,
        testName: 'בדיקת פרטים בדיונית',
        performedOn: '2026-07-15',
        resultedOn: null,
        orderingDoctor: null,
        category: null,
        kind: 'lab',
        isPartial: false,
        institute: null,
        documentAvailable: false,
        provider: HealthFundTypes.maccabi,
        values: [
          {
            code: 'FICT-CLI-1',
            name: 'גלוקוז דמיוני',
            group: null,
            value: 90,
            text: null,
            unit: 'mg/dl',
            referenceMin: 70,
            referenceMax: 100,
            status: 'within',
            measuredOn: '2026-07-15',
          },
          {
            code: 'FICT-CLI-2',
            name: 'המוגלובין דמיוני',
            group: null,
            value: 8,
            text: null,
            unit: 'g/dl',
            referenceMin: 12,
            referenceMax: 16,
            status: 'below',
            measuredOn: '2026-07-15',
          },
        ],
      },
    ]);
    closeDatabase();

    const all = runCli('test-result-values', 'maccabi');
    expect(all.status).toBe(0);
    expect(all.stdout).toContain('גלוקוז דמיוני');
    expect(all.stdout).toContain('המוגלובין דמיוני');

    const abnormalOnly = runCli('test-result-values', 'maccabi', '--abnormal');
    expect(abnormalOnly.stdout).toContain('המוגלובין דמיוני');
    expect(abnormalOnly.stdout).not.toContain('גלוקוז דמיוני');

    const byName = runCli('test-result-values', 'maccabi', '--test', 'גלוקוז');
    expect(byName.stdout).toContain('גלוקוז דמיוני');
    expect(byName.stdout).not.toContain('המוגלובין דמיוני');

    openDatabase();
  });

  it('exports a stored document and refuses to overwrite without the flag', () => {
    const content = 'fictional exported cli document content';
    storeTestResultDetails(HealthFundTypes.maccabi, [
      {
        id: 'fictional-cli-export-result',
        testName: 'בדיקת ייצוא בדיונית',
        performedOn: '2026-07-16',
        resultedOn: null,
        orderingDoctor: null,
        category: null,
        kind: 'document',
        isPartial: false,
        institute: null,
        documentAvailable: true,
        provider: HealthFundTypes.maccabi,
        document: {
          fileName: 'ייצוא בדיוני.pdf',
          contentType: 'application/pdf',
          byteLength: Buffer.byteLength(content),
          content: Buffer.from(content).toString('base64'),
        },
      },
    ]);
    closeDatabase();

    const destination = path.join(tempDir, 'exported-cli-document.pdf');

    const exported = runCli('export-document', 'maccabi', 'fictional-cli-export-result', destination);
    expect(exported.status).toBe(0);
    expect(fs.readFileSync(destination, 'utf8')).toBe(content);

    const refused = runCli('export-document', 'maccabi', 'fictional-cli-export-result', destination);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('already exists');

    const overwritten = runCli(
      'export-document',
      'maccabi',
      'fictional-cli-export-result',
      destination,
      '--overwrite',
    );
    expect(overwritten.status).toBe(0);

    openDatabase();
    fs.rmSync(destination, { force: true });
  });
});

describe('CLI form17 command', () => {
  const form17Request = (overrides: Partial<Form17Request> = {}): Form17Request => ({
    id: 'fictional-cli-form17-earlier',
    requestType: 'טופס 17 מוקדם',
    status: 'אושר',
    submittedOn: '2026-05-10',
    statusUpdatedOn: '2026-05-15',
    providerName: 'ד"ר דוגמה מוקדם',
    appointmentOn: '2026-06-10',
    documentLabels: ['אישור מוקדם'],
    canChangeAppointment: false,
    requiresAdditionalInfo: null,
    provider: HealthFundTypes.maccabi,
    ...overrides,
  });

  it('prints stored form17 requests newest first for the selected fund', () => {
    upsertForm17Requests(HealthFundTypes.maccabi, [
      form17Request(),
      form17Request({
        id: 'fictional-cli-form17-later',
        requestType: 'טופס 17 מאוחר',
        submittedOn: '2026-07-20',
        appointmentOn: null,
        documentLabels: [],
      }),
    ]);
    closeDatabase();

    const result = runCli('form17', 'maccabi');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('טופס 17 מאוחר');
    expect(result.stdout).toContain('אושר');
    expect(result.stdout).toContain('[אישור מוקדם]');
    expect(result.stdout.indexOf('2026-07-20')).toBeLessThan(result.stdout.indexOf('2026-05-10'));
    openDatabase();
  });

  it('shows the dedicated refresh command when no form17 requests are stored', () => {
    openDatabase().prepare('DELETE FROM form17_requests').run();
    closeDatabase();

    const result = runCli('form17', 'maccabi');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No stored Form 17 requests. Run: health-mcp fetch-form17\n');
    openDatabase();
  });

  it('advertises the form17 fetch command', () => {
    const result = runCli();
    expect(result.stdout).toContain('fetch-form17 [fund]');
    expect(result.stdout).toContain('form17 [fund]');
  });
});
