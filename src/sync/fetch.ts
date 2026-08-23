import {
  createScraper,
  ScraperErrorTypes,
  type FetchTarget,
  type HealthAccount,
  type HealthFundId,
  type ScraperOptions,
} from 'israeli-health-scrapers';

import { requireCredentials } from '../db/credentials.js';
import { replaceMedicationsSnapshot } from '../db/medications.js';
import { upsertAppointments } from '../db/appointments.js';
import { storeTestResultDetails, upsertTestResults } from '../db/test-results.js';
import { upsertVaccinations } from '../db/vaccinations.js';
import { upsertForm17Requests } from '../db/form17.js';
import { finishSyncRun, startSyncRun, type SyncResource } from '../db/sync-runs.js';
import { scraperDataDir } from '../config/paths.js';

export interface FetchOutcome {
  companyId: HealthFundId;
  success: boolean;
  recordCount: number;
  errorType?: string;
  errorMessage?: string;
  /** Failure classification; present only when `success` is false. */
  status?: FetchFailureStatus;
  /** What an agent should do next about the failure; null when there is no advice. */
  next?: string | null;
}

/** What went wrong at the auth layer, in the vocabulary an agent can act on. */
export type FetchFailureStatus = 'session_expired' | 'credentials_rejected' | 'fetch_failed';

export interface FetchFailureAction {
  status: FetchFailureStatus;
  /**
   * An instruction to the agent, not to the member: it names the MCP or CLI action
   * that recovers. English on purpose — the member-facing wording is the agent's
   * to produce (docs/AGENT-INSTALL.md sets the convention).
   */
  next: string | null;
}

/**
 * Turns a scraper errorType into the pair every failed fetch returns: a coarse
 * status and the recovery step. A refresh runs unattended, so "the fund asked for
 * an SMS code" actually means "the stored session expired" — and an agent told
 * merely that cannot recover without being told how.
 */
export function classifyFetchFailure(companyId: string, errorType?: string): FetchFailureAction {
  if (errorType === ScraperErrorTypes.TwoFactorRetrieverMissing) {
    return {
      status: 'session_expired',
      next: `The stored session for ${companyId} expired or was invalidated. Ask the user to re-authenticate: call auth_start for ${companyId}, get the SMS code from the user, then finish with auth_complete.`,
    };
  }

  if (errorType === ScraperErrorTypes.InvalidPassword) {
    return {
      status: 'credentials_rejected',
      next: `The fund rejected the stored password for ${companyId}. Ask the user for the current password and update the stored credentials via the CLI (docs/AGENT-INSTALL.md, "When logins expire").`,
    };
  }

  if (errorType === ScraperErrorTypes.ChangePassword) {
    return {
      status: 'credentials_rejected',
      next: `${companyId} requires a password change before logging in. Ask the user to change it on the fund's website, then update the stored credentials via the CLI (docs/AGENT-INSTALL.md, "When logins expire").`,
    };
  }

  if (errorType === ScraperErrorTypes.AccountBlocked) {
    return {
      status: 'credentials_rejected',
      next: `The account at ${companyId} is blocked. Ask the user to unblock it with the fund, then re-authenticate with auth_start.`,
    };
  }

  return { status: 'fetch_failed', next: null };
}

/**
 * Scrapes one fund for one resource and writes the result into the local database.
 *
 * Every attempt is recorded in `sync_runs`, successful or not, per resource — the
 * question "is this data stale, or did the last three fetches fail?" is exactly what a
 * caller needs to answer before trusting a `days_until_expiry` or an appointment time,
 * and it cannot be answered from the medications/appointments tables alone. Shared
 * between fetchFund and fetchAppointmentsForFund because the only thing that differs
 * between "refresh medications" and "refresh appointments" is which resource to ask
 * the scraper for and where to write what comes back.
 */
async function runFetch(
  companyId: HealthFundId,
  resource: SyncResource,
  fetchTargets: FetchTarget[],
  store: (companyId: HealthFundId, accounts: HealthAccount[]) => number,
  options: Partial<ScraperOptions>,
): Promise<FetchOutcome> {
  const credentials = requireCredentials(companyId);
  const runId = startSyncRun(companyId, resource);

  try {
    // Point the library's session and diagnostics storage inside our app data dir, so
    // everything this tool owns lives in one place the user can find and delete.
    process.env.IHS_DATA_DIR ??= scraperDataDir();

    const scraper = createScraper({
      ...options,
      companyId,
      storeSession: true,
      fetch: fetchTargets,
    });

    const result = await scraper.scrape(credentials);

    if (!result.success) {
      // fetch deliberately never carries an otpCodeRetriever — it runs unattended. The
      // classifier turns the scraper's error vocabulary into the status/next pair an
      // agent can act on; the raw errorMessage stays as the fund's own words for
      // diagnostics, and the CLI renders its own hint from the status.
      const action = classifyFetchFailure(companyId, result.errorType);

      finishSyncRun(runId, {
        success: false,
        errorType: result.errorType,
        errorMessage: result.errorMessage,
      });

      return {
        companyId,
        success: false,
        recordCount: 0,
        errorType: result.errorType,
        errorMessage: result.errorMessage,
        ...action,
      };
    }

    const recordCount = store(companyId, result.accounts ?? []);

    finishSyncRun(runId, { success: true, recordCount });

    return { companyId, success: true, recordCount };
  } catch (error) {
    finishSyncRun(runId, {
      success: false,
      errorType: ScraperErrorTypes.General,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function fetchFund(
  companyId: HealthFundId,
  options: Partial<ScraperOptions> = {},
): Promise<FetchOutcome> {
  return runFetch(
    companyId,
    'medications',
    ['medications'],
    (id, accounts) =>
      replaceMedicationsSnapshot(id, accounts.flatMap((account) => account.medications)),
    options,
  );
}

/**
 * Refreshes appointments only — kept separate from fetchFund rather than folded into
 * one "fetch everything" call, because appointments costs a lot more: the list view
 * has no clinic/location or instructions, so the scraper clicks into every single
 * appointment's detail page to get them. A caller that only wants medications should
 * not pay for that on every refresh.
 */
export async function fetchAppointmentsForFund(
  companyId: HealthFundId,
  options: Partial<ScraperOptions> = {},
): Promise<FetchOutcome> {
  return runFetch(
    companyId,
    'appointments',
    ['appointments'],
    (id, accounts) => upsertAppointments(id, accounts.flatMap((account) => account.appointments ?? [])),
    options,
  );
}

export async function fetchTestResultsForFund(
  companyId: HealthFundId,
  options: Partial<ScraperOptions> = {},
): Promise<FetchOutcome> {
  return runFetch(
    companyId,
    'testResults',
    ['testResults'],
    (id, accounts) => upsertTestResults(id, accounts.flatMap((account) => account.testResults ?? [])),
    options,
  );
}

/**
 * Refreshes the results themselves — every laboratory value, and every result document
 * saved to disk (encrypted).
 *
 * Its own operation rather than part of fetchTestResultsForFund, for the same reason
 * appointments is not part of fetchFund: this one costs a request per result while the
 * timeline costs one, and a caller that just wants to know whether new results arrived
 * should not pay for it.
 *
 * `since` bounds the per-result work to results performed on or after that date. The
 * timeline is still refreshed in full — it is the cheap part.
 */
export async function fetchTestResultDetailsForFund(
  companyId: HealthFundId,
  options: Partial<ScraperOptions> & { since?: string } = {},
): Promise<FetchOutcome> {
  const { since, ...scraperOptions } = options;

  return runFetch(
    companyId,
    'testResultDetails',
    ['testResultDetails'],
    (id, accounts) => storeTestResultDetails(id, accounts.flatMap((account) => account.testResults ?? [])),
    { ...scraperOptions, ...(since ? { testResultDetailsSince: since } : {}) },
  );
}

export async function fetchVaccinationsForFund(
  companyId: HealthFundId,
  options: Partial<ScraperOptions> = {},
): Promise<FetchOutcome> {
  return runFetch(
    companyId,
    'vaccinations',
    ['vaccinations'],
    (id, accounts) => upsertVaccinations(id, accounts.flatMap((account) => account.vaccinations ?? [])),
    options,
  );
}

/**
 * Refreshes Form 17 commitment requests only. Expensive like appointments, not cheap
 * like medications: the list lazy-loads as the page scrolls and every row must be
 * expanded before its status, appointment, and document details can be read.
 */
export async function fetchForm17ForFund(
  companyId: HealthFundId,
  options: Partial<ScraperOptions> = {},
): Promise<FetchOutcome> {
  return runFetch(
    companyId,
    'form17',
    ['form17'],
    (id, accounts) => upsertForm17Requests(id, accounts.flatMap((account) => account.form17 ?? [])),
    options,
  );
}

/**
 * Fetches several funds.
 *
 * Sequential rather than parallel: these are logins to a member's own accounts, and
 * hammering several funds at once is both rude and a good way to trip rate limiting
 * for no real gain — a fetch is not latency-sensitive.
 */
export async function fetchFunds(
  companyIds: HealthFundId[],
  options: Partial<ScraperOptions> = {},
): Promise<FetchOutcome[]> {
  const outcomes: FetchOutcome[] = [];

  for (const companyId of companyIds) {
    try {
      outcomes.push(await fetchFund(companyId, options));
    } catch (error) {
      // One fund failing must not abort the sweep over the others.
      outcomes.push({
        companyId,
        success: false,
        recordCount: 0,
        errorType: 'GENERAL_ERROR',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcomes;
}
