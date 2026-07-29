#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import { SCRAPERS, createScraper, type HealthFundId } from 'israeli-health-scrapers';

import { appDataDir, databasePath, scraperDataDir } from '../config/paths.js';
import { closeDatabase, databaseExists, openDatabase } from '../db/database.js';
import {
  deleteCredentials,
  listCredentialedFunds,
  requireCredentials,
  saveCredentials,
} from '../db/credentials.js';
import { listMedications } from '../db/medications.js';
import { listTestResults } from '../db/test-results.js';
import { listVaccinations } from '../db/vaccinations.js';
import { lastSyncRun } from '../db/sync-runs.js';
import { fetchFunds, fetchTestResultsForFund, fetchVaccinationsForFund } from '../sync/fetch.js';
import { writeClaudeConfig } from './configure-claude.js';

process.env.IHS_DATA_DIR ??= scraperDataDir();
// The library encrypts stored sessions with its own key; reuse HEALTH_MCP_KEY rather
// than asking the member to manage a second secret.
process.env.IHS_SESSION_KEY ??= process.env.HEALTH_MCP_KEY;

const credentialsFileSchema = z.array(
  z.object({
    companyId: z.string(),
    id: z.string().min(1),
    password: z.string().optional(),
  }),
);

function usage(): void {
  stdout.write(`health-mcp — local-first access to your Israeli health fund account

Commands:
  ingest-creds -f <file.json>   Store fund credentials in the encrypted database
  list-creds                    Show which funds have credentials stored
  remove-creds <fund>           Delete stored credentials for a fund
  login <fund>                  Interactive login; stores a reusable session
  fetch [fund...]               Fetch and store data (defaults to every configured fund)
  fetch-test-results [fund]     Fetch and store test results (one fund only)
  fetch-vaccinations [fund]     Fetch and store vaccinations (one fund only)
  medications [fund]            Print stored prescriptions
  test-results [fund]           Print stored test results, newest first
  vaccinations [fund]           Print stored vaccinations, newest first
  status                        Where data lives and when each fund last synced
  configure-claude              Add this server to Claude Desktop's config

The database is encrypted with HEALTH_MCP_KEY, which is never written to disk.
Generate one with: openssl rand -base64 32
`);
}

async function ingestCreds(args: string[]): Promise<void> {
  const fileIndex = args.findIndex((arg) => arg === '-f' || arg === '--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;

  if (!file) throw new Error('Usage: health-mcp ingest-creds -f credentials.json');

  const parsed = credentialsFileSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

  for (const entry of parsed) {
    if (!(entry.companyId in SCRAPERS)) {
      throw new Error(
        `Unknown fund "${entry.companyId}". Known: ${Object.keys(SCRAPERS).join(', ')}`,
      );
    }
    saveCredentials(entry.companyId as HealthFundId, { id: entry.id, password: entry.password });
    stdout.write(`stored credentials for ${entry.companyId}\n`);
  }

  stdout.write(
    `\nCredentials are now in the encrypted database at:\n  ${databasePath()}\n\n` +
      `Delete ${file} — it holds the same secrets in plain text.\n`,
  );
}

async function login(args: string[]): Promise<void> {
  const companyId = (args[0] ?? 'maccabi') as HealthFundId;
  const credentials = requireCredentials(companyId);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  // Headed by default: a first login is exactly when a CAPTCHA or an unexpected consent
  // screen appears, and those are only solvable if the member can see the page.
  const scraper = createScraper({
    companyId,
    showBrowser: !args.includes('--headless'),
    storeSession: true,
    verbose: args.includes('--verbose'),
    otpCodeRetriever: async () => (await rl.question('הזן את קוד ה-SMS: ')).trim(),
  });

  try {
    stdout.write(`מתחבר ל${SCRAPERS[companyId].name}...\n`);
    const result = await scraper.login(credentials);

    if (!result.success) {
      stdout.write(`ההתחברות נכשלה: ${result.errorType} — ${result.errorMessage}\n`);
      process.exitCode = 1;
      return;
    }
    stdout.write('ההתחברות הושלמה וה-session נשמר.\n');
  } finally {
    rl.close();
    await scraper.terminate(true).catch(() => {});
  }
}

async function fetch(args: string[]): Promise<void> {
  const requested = args.filter((arg) => !arg.startsWith('-')) as HealthFundId[];
  const funds = requested.length > 0 ? requested : listCredentialedFunds();

  if (funds.length === 0) {
    throw new Error('No funds configured. Run: health-mcp ingest-creds -f credentials.json');
  }

  const outcomes = await fetchFunds(funds, { verbose: args.includes('--verbose') });

  for (const outcome of outcomes) {
    stdout.write(
      outcome.success
        ? `${outcome.companyId}: ${outcome.recordCount} records\n`
        : `${outcome.companyId}: FAILED — ${outcome.errorType}: ${outcome.errorMessage}\n`,
    );
  }

  if (outcomes.some((outcome) => !outcome.success)) process.exitCode = 1;
}

function medications(args: string[]): void {
  const companyId = args.find((arg) => !arg.startsWith('-')) as HealthFundId | undefined;
  const rows = listMedications(companyId ? { companyId } : {});

  if (rows.length === 0) {
    stdout.write('No stored prescriptions. Run: health-mcp fetch\n');
    return;
  }

  for (const row of rows) {
    const expiry =
      row.days_until_expiry === null
        ? 'תוקף לא ידוע'
        : row.days_until_expiry < 0
          ? `פג לפני ${Math.abs(row.days_until_expiry)} ימים`
          : `${row.days_until_expiry} ימים לתפוגה`;

    stdout.write(`${row.name.padEnd(28)} ${(row.valid_until ?? '—').padEnd(12)} ${expiry}\n`);
  }
}

async function fetchTestResults(args: string[]): Promise<void> {
  const companyId = (args.find((arg) => !arg.startsWith('-')) ?? 'maccabi') as HealthFundId;
  requireCredentials(companyId);

  const outcome = await fetchTestResultsForFund(companyId, { verbose: args.includes('--verbose') });

  stdout.write(
    outcome.success
      ? `${outcome.companyId}: ${outcome.recordCount} records\n`
      : `${outcome.companyId}: FAILED — ${outcome.errorType}: ${outcome.errorMessage}\n`,
  );
  if (!outcome.success) process.exitCode = 1;
}

function testResults(args: string[]): void {
  const companyId = args.find((arg) => !arg.startsWith('-')) as HealthFundId | undefined;
  const rows = listTestResults(companyId ? { companyId } : {});

  if (rows.length === 0) {
    stdout.write('No stored test results. Run: health-mcp fetch-test-results\n');
    return;
  }

  for (const row of rows) {
    stdout.write(
      `${(row.performed_on ?? '—').padEnd(12)} ${row.test_name.padEnd(30)} ${row.ordering_doctor ?? ''}\n`,
    );
  }
}

async function fetchVaccinations(args: string[]): Promise<void> {
  const companyId = (args.find((arg) => !arg.startsWith('-')) ?? 'maccabi') as HealthFundId;
  requireCredentials(companyId);
  const outcome = await fetchVaccinationsForFund(companyId, { verbose: args.includes('--verbose') });
  stdout.write(
    outcome.success
      ? `${outcome.companyId}: ${outcome.recordCount} records\n`
      : `${outcome.companyId}: FAILED — ${outcome.errorType}: ${outcome.errorMessage}\n`,
  );
  if (!outcome.success) process.exitCode = 1;
}

function vaccinations(args: string[]): void {
  const companyId = args.find((arg) => !arg.startsWith('-')) as HealthFundId | undefined;
  const rows = listVaccinations(companyId ? { companyId } : {});
  if (rows.length === 0) {
    stdout.write('No stored vaccinations. Run: health-mcp fetch-vaccinations\n');
    return;
  }
  for (const row of rows) {
    stdout.write(
      `${row.administered_on.padEnd(12)} ${row.vaccine_name.padEnd(30)} ${row.dose ?? ''} ${row.location ?? ''}\n`,
    );
  }
}

function status(): void {
  stdout.write(`data directory: ${appDataDir()}\n`);
  stdout.write(`database:       ${databasePath()}${databaseExists() ? '' : ' (not created yet)'}\n`);

  if (!databaseExists()) return;

  const funds = listCredentialedFunds();
  if (funds.length === 0) {
    stdout.write('\nNo funds configured.\n');
    return;
  }

  stdout.write('\nfund      last sync\n');
  for (const fund of funds) {
    const sync = lastSyncRun(fund, 'medications');
    stdout.write(
      `${fund.padEnd(10)}${
        sync
          ? `${sync.finished_at ?? sync.started_at} ${sync.success ? 'ok' : `FAILED (${sync.error_type})`}`
          : 'never'
      }\n`,
    );
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'ingest-creds':
      await ingestCreds(args);
      break;
    case 'list-creds': {
      const funds = listCredentialedFunds();
      stdout.write(funds.length > 0 ? `${funds.join('\n')}\n` : 'none\n');
      break;
    }
    case 'remove-creds': {
      const fund = args[0] as HealthFundId | undefined;
      if (!fund) throw new Error('Usage: health-mcp remove-creds <fund>');
      stdout.write(deleteCredentials(fund) ? `removed ${fund}\n` : `no credentials for ${fund}\n`);
      break;
    }
    case 'login':
      await login(args);
      break;
    case 'fetch':
      await fetch(args);
      break;
    case 'fetch-test-results':
      await fetchTestResults(args);
      break;
    case 'fetch-vaccinations':
      await fetchVaccinations(args);
      break;
    case 'medications':
      medications(args);
      break;
    case 'test-results':
      testResults(args);
      break;
    case 'vaccinations':
      vaccinations(args);
      break;
    case 'status':
      status();
      break;
    case 'configure-claude':
      writeClaudeConfig();
      break;
    case 'init':
      openDatabase();
      stdout.write(`database ready at ${databasePath()}\n`);
      break;
    default:
      usage();
      if (command) process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
