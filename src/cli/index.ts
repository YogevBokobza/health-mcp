#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
import {
  countTestResultValues,
  findTestResultForExport,
  listTestResultValues,
  listTestResults,
} from '../db/test-results.js';
import { listVaccinations } from '../db/vaccinations.js';
import { listForm17Requests } from '../db/form17.js';
import { lastSyncRun } from '../db/sync-runs.js';
import {
  fetchFunds,
  fetchForm17ForFund,
  fetchTestResultDetailsForFund,
  fetchTestResultsForFund,
  fetchVaccinationsForFund,
  type FetchOutcome,
} from '../sync/fetch.js';
import { exportDocument } from '../store/documents.js';
import { writeClaudeConfig } from './configure-claude.js';

// require, not an import assertion: works identically from source (tsx) and from the
// built dist/cli/index.js, where '../../package.json' resolves to the package root.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

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

/**
 * Options that take a value, so `--test creatinine` is not read as the fund
 * "creatinine".
 *
 * Listing them is what lets a positional argument be recognized by position: without
 * it, "the first argument that is not a flag" would pick up whatever followed one.
 */
const VALUE_OPTIONS = ['--since', '--test'] as const;

interface ParsedArgs {
  /** Arguments that are neither an option nor an option's value. */
  positional: string[];
  option: (name: (typeof VALUE_OPTIONS)[number]) => string | undefined;
  has: (name: string) => boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const switches = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (VALUE_OPTIONS.includes(arg as (typeof VALUE_OPTIONS)[number])) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} needs a value.`);
      options.set(arg, value);
      i += 1;
    } else if (arg.startsWith('-')) {
      switches.add(arg);
    } else {
      positional.push(arg);
    }
  }

  return {
    positional,
    option: (name) => options.get(name),
    has: (name) => switches.has(name),
  };
}

function usage(): void {
  stdout.write(`health-mcp — local-first access to your Israeli health fund account

Commands:
  ingest-creds -f <file.json>   Store fund credentials in the encrypted database
  list-creds                    Show which funds have credentials stored
  remove-creds <fund>           Delete stored credentials for a fund
  login <fund>                  Interactive login; stores a reusable session
  fetch [fund...]               Fetch and store data (defaults to every configured fund)
  fetch-test-results [fund]     Fetch and store the test-results timeline (one request)
  fetch-test-result-details [fund] [--since YYYY-MM-DD]
                                 Fetch the results themselves: every lab value, and every
                                 result document, encrypted to disk. Slow — one request
                                 per test.
  fetch-vaccinations [fund]     Fetch and store vaccinations (one fund only)
  fetch-form17 [fund]           Fetch and store Form 17 requests (one fund only)
  medications [fund]            Print stored prescriptions
  test-results [fund]           Print stored test results, newest first
  test-result-values [fund] [--test NAME] [--abnormal] [--since YYYY-MM-DD]
                                 Print stored lab values, newest first
  export-document <fund> <resultId> <destination> [--overwrite]
                                 Decrypt a stored test-result document to a file
  vaccinations [fund]           Print stored vaccinations, newest first
  form17 [fund]                 Print stored Form 17 requests, newest first
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

/**
 * Renders one fetch outcome, adding the CLI-specific recovery hint the shared
 * classifier deliberately leaves out (it speaks to whichever agent is listening, not
 * to a terminal).
 */
function printOutcome(outcome: FetchOutcome): void {
  if (outcome.success) {
    stdout.write(`${outcome.companyId}: ${outcome.recordCount} records\n`);
    return;
  }

  stdout.write(`${outcome.companyId}: FAILED — ${outcome.errorType}: ${outcome.errorMessage}\n`);
  if (outcome.status === 'session_expired') {
    stdout.write(`  → session expired; run: health-mcp login ${outcome.companyId}\n`);
  } else if (outcome.status === 'credentials_rejected') {
    stdout.write(`  → update credentials with: health-mcp ingest-creds -f <file>\n`);
  }
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

  for (const outcome of outcomes) printOutcome(outcome);

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

    // Both standing (תרופה קבועה) and one-off valid prescriptions are stored now, so
    // mark which is which rather than letting them look identical.
    const kind = row.is_standing === null ? '' : row.is_standing ? 'קבועה' : 'חד-פעמית';

    stdout.write(
      `${row.name.padEnd(28)} ${(row.valid_until ?? '—').padEnd(12)} ${kind.padEnd(9)} ${expiry}\n`,
    );
  }
}

async function fetchTestResults(args: string[]): Promise<void> {
  const companyId = (args.find((arg) => !arg.startsWith('-')) ?? 'maccabi') as HealthFundId;
  requireCredentials(companyId);

  const outcome = await fetchTestResultsForFund(companyId, { verbose: args.includes('--verbose') });

  printOutcome(outcome);
  if (!outcome.success) process.exitCode = 1;
}

function testResults(args: string[]): void {
  const companyId = args.find((arg) => !arg.startsWith('-')) as HealthFundId | undefined;
  const rows = listTestResults(companyId ? { companyId } : {});

  if (rows.length === 0) {
    stdout.write('No stored test results. Run: health-mcp fetch-test-results\n');
    return;
  }

  const valueCounts = countTestResultValues(companyId ? { companyId } : {});

  for (const row of rows) {
    const values = valueCounts.get(row.test_result_id) ?? 0;
    // What is actually behind this row: numbers, a saved (encrypted) file, a file we
    // have not fetched yet, or — for an imaging study — nothing this tool can ever
    // fetch, which must not read as "not fetched yet".
    const detail = values
      ? `${values} values`
      : row.document_path
        ? 'document stored'
        : row.document_available
          ? 'document (not fetched)'
          : row.kind === 'imaging'
            ? 'imaging — view on fund site only'
            : row.detailed_at
              ? '—'
              : 'not fetched';

    stdout.write(
      `${(row.performed_on ?? '—').padEnd(12)} ${row.test_name.padEnd(30)} ` +
        `${(row.ordering_doctor ?? '').padEnd(20)} ${detail}\n`,
    );
  }
}

async function fetchTestResultDetails(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const companyId = (parsed.positional[0] ?? 'maccabi') as HealthFundId;
  requireCredentials(companyId);

  const since = parsed.option('--since');
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error('Usage: health-mcp fetch-test-result-details [fund] --since YYYY-MM-DD');
  }

  stdout.write(
    `Fetching test results from ${SCRAPERS[companyId].name}${since ? ` since ${since}` : ''}. This takes time — one request per test.\n`,
  );

  const outcome = await fetchTestResultDetailsForFund(companyId, {
    verbose: parsed.has('--verbose'),
    ...(since ? { since } : {}),
  });

  outcome.success
    ? stdout.write(`${outcome.companyId}: ${outcome.recordCount} lab values stored\n`)
    : printOutcome(outcome);
  if (!outcome.success) process.exitCode = 1;
}

function testResultValues(args: string[]): void {
  const parsed = parseArgs(args);
  const companyId = parsed.positional[0] as HealthFundId | undefined;
  const name = parsed.option('--test');
  const from = parsed.option('--since');

  const rows = listTestResultValues({
    ...(companyId ? { companyId } : {}),
    ...(name ? { name } : {}),
    ...(from ? { from } : {}),
    outOfRangeOnly: parsed.has('--abnormal'),
  });

  if (rows.length === 0) {
    stdout.write('No stored lab values. Run: health-mcp fetch-test-result-details\n');
    return;
  }

  for (const row of rows) {
    const range =
      row.reference_min !== null || row.reference_max !== null
        ? `[${row.reference_min ?? ''}–${row.reference_max ?? ''}]`
        : '';
    const flag = row.status === 'above' ? '↑' : row.status === 'below' ? '↓' : ' ';
    const measured = row.value !== null ? String(row.value) : (row.text ?? '—');

    stdout.write(
      `${(row.measured_on ?? row.performed_on ?? '—').padEnd(12)} ${row.name.padEnd(28)} ` +
        `${flag} ${measured.padEnd(10)} ${(row.unit ?? '').padEnd(12)} ${range}\n`,
    );
  }
}

function exportDocumentCommand(args: string[]): void {
  const parsed = parseArgs(args);
  const [companyId, resultId, destinationPath] = parsed.positional as [
    HealthFundId | undefined,
    string | undefined,
    string | undefined,
  ];

  if (!companyId || !resultId || !destinationPath) {
    throw new Error('Usage: health-mcp export-document <fund> <resultId> <destination> [--overwrite]');
  }

  const result = findTestResultForExport(companyId, resultId);
  if (!result || !result.document_path || !result.document_sha256) {
    throw new Error(
      `No stored document for ${resultId}. Run: health-mcp fetch-test-result-details ${companyId}`,
    );
  }

  exportDocument(result.document_path, result.document_sha256, destinationPath, {
    overwrite: parsed.has('--overwrite'),
  });
  stdout.write(`decrypted to ${destinationPath}\n`);
}

async function fetchVaccinations(args: string[]): Promise<void> {
  const companyId = (args.find((arg) => !arg.startsWith('-')) ?? 'maccabi') as HealthFundId;
  requireCredentials(companyId);
  const outcome = await fetchVaccinationsForFund(companyId, { verbose: args.includes('--verbose') });
  printOutcome(outcome);
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
    const age = row.age_at_administration === null ? '' : `age ${row.age_at_administration}`;
    stdout.write(
      `${row.administered_on.padEnd(12)} ${row.vaccine_name.padEnd(30)} ${age} ${row.dose ?? ''} ${row.location ?? ''}\n`,
    );
  }
}

async function fetchForm17(args: string[]): Promise<void> {
  const companyId = (args.find((arg) => !arg.startsWith('-')) ?? 'maccabi') as HealthFundId;
  requireCredentials(companyId);
  const outcome = await fetchForm17ForFund(companyId, { verbose: args.includes('--verbose') });
  printOutcome(outcome);
  if (!outcome.success) process.exitCode = 1;
}

function form17(args: string[]): void {
  const companyId = args.find((arg) => !arg.startsWith('-')) as HealthFundId | undefined;
  const rows = listForm17Requests(companyId ? { companyId } : {});
  if (rows.length === 0) {
    stdout.write('No stored Form 17 requests. Run: health-mcp fetch-form17\n');
    return;
  }
  for (const row of rows) {
    const documents = JSON.parse(row.document_labels ?? '[]') as string[];
    const appointment = row.appointment_on ? ` appointment ${row.appointment_on}` : '';
    stdout.write(
      `${(row.submitted_on ?? '—').padEnd(12)} ${row.request_type.padEnd(20)} ${row.status}${appointment}${documents.length > 0 ? ` [${documents.join(', ')}]` : ''}\n`,
    );
  }
}

function status(): void {
  stdout.write(`version:        ${version}\n`);
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
    case 'fetch-test-result-details':
      await fetchTestResultDetails(args);
      break;
    case 'fetch-vaccinations':
      await fetchVaccinations(args);
      break;
    case 'fetch-form17':
      await fetchForm17(args);
      break;
    case 'medications':
      medications(args);
      break;
    case 'test-results':
      testResults(args);
      break;
    case 'test-result-values':
      testResultValues(args);
      break;
    case 'export-document':
      exportDocumentCommand(args);
      break;
    case 'vaccinations':
      vaccinations(args);
      break;
    case 'form17':
      form17(args);
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
