import {
  createScraper,
  ScraperErrorTypes,
  type HealthFundId,
  type ScraperOptions,
} from 'israeli-health-scrapers';

import { requireCredentials } from '../db/credentials.js';
import { finishSyncRun, startSyncRun, upsertMedications } from '../db/medications.js';
import { scraperDataDir } from '../config/paths.js';

export interface FetchOutcome {
  companyId: HealthFundId;
  success: boolean;
  recordCount: number;
  errorType?: string;
  errorMessage?: string;
}

/**
 * Fetches one fund and writes the result into the local database.
 *
 * Every attempt is recorded in `sync_runs`, successful or not — the question "is this
 * data stale, or did the last three fetches fail?" is exactly what a caller needs to
 * answer before trusting a `days_until_expiry`, and it cannot be answered from the
 * medications table alone.
 */
export async function fetchFund(
  companyId: HealthFundId,
  options: Partial<ScraperOptions> = {},
): Promise<FetchOutcome> {
  const credentials = requireCredentials(companyId);
  const runId = startSyncRun(companyId);

  // Point the library's session and diagnostics storage inside our app data dir, so
  // everything this tool owns lives in one place the user can find and delete.
  process.env.IHS_DATA_DIR ??= scraperDataDir();

  const scraper = createScraper({
    companyId,
    storeSession: true,
    fetch: ['medications'],
    ...options,
  });

  const result = await scraper.scrape(credentials);

  if (!result.success) {
    // fetch deliberately never carries an otpCodeRetriever — it runs unattended. This
    // exact errorType is what "the stored session no longer works" looks like: it
    // expired, or the member logged in elsewhere and the fund invalidated it. The
    // library's message talks about otpCodeRetriever, which means nothing to a member
    // deciding what to do next.
    const errorMessage =
      result.errorType === ScraperErrorTypes.TwoFactorRetrieverMissing
        ? `Session expired or you logged in elsewhere. Run: health-mcp login ${companyId}`
        : result.errorMessage;

    finishSyncRun(runId, {
      success: false,
      errorType: result.errorType,
      errorMessage,
    });

    return {
      companyId,
      success: false,
      recordCount: 0,
      errorType: result.errorType,
      errorMessage,
    };
  }

  const medications = result.accounts?.flatMap((account) => account.medications) ?? [];
  const recordCount = upsertMedications(companyId, medications);

  finishSyncRun(runId, { success: true, recordCount });

  return { companyId, success: true, recordCount };
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
