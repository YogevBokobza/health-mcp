import crypto from 'node:crypto';
import type { HealthFundId, Scraper } from 'israeli-health-scrapers';

import { OTP_CHALLENGE_TTL_MS } from '../constants.js';
import {
  deleteOtpChallengeRecord,
  findOtpChallengeRecord,
  recordOtpChallenge,
  sweepExpiredOtpChallengeRecords,
} from '../db/otp-challenges.js';

/**
 * MCP is not an interactive channel: a tool call cannot block while the member reads an
 * SMS. So an OTP login splits into `auth_start` and `auth_complete`, and the live
 * scraper — with its open browser — must survive between the two, because the fund ties
 * the code to that session and a fresh browser would invalidate it.
 *
 * Holding an open browser in memory is bounded by a short TTL so a login the member
 * abandoned does not leave one running indefinitely.
 */
export interface PendingChallenge {
  challengeId: string;
  companyId: HealthFundId;
  scraper: Scraper;
  expiresAt: number;
}

/**
 * Result of redeeming a challenge id. `lostToRestart` means a challenge with that id
 * genuinely existed and has not expired, but its browser lived in a different process
 * than the one handling this call — not every MCP client guarantees one long-lived
 * process for the full `auth_start` / `auth_complete` round trip, and the live
 * `Scraper` cannot be persisted to survive that. It is distinct from `unknown` (no
 * record of that id at all) and `expired` (a real TTL expiry) so the caller can tell
 * the member what actually happened instead of a generic "unknown or expired".
 */
export type TakeChallengeResult =
  | { status: 'found'; challenge: PendingChallenge }
  | { status: 'expired' }
  | { status: 'lostToRestart' }
  | { status: 'unknown' };

const pending = new Map<string, PendingChallenge>();

export function createChallenge(
  companyId: HealthFundId,
  scraper: Scraper,
  ttlMs = OTP_CHALLENGE_TTL_MS,
): PendingChallenge {
  const challenge: PendingChallenge = {
    challengeId: crypto.randomUUID(),
    companyId,
    scraper,
    expiresAt: Date.now() + ttlMs,
  };
  pending.set(challenge.challengeId, challenge);
  recordOtpChallenge(challenge.challengeId, companyId, challenge.expiresAt);
  return challenge;
}

/**
 * Redeems a challenge id. A hit in this process's memory is the normal path; a miss
 * falls back to the persisted metadata (never the browser) to tell a restart-orphaned
 * id apart from one that is truly unknown or expired. Expired challenges are cleaned
 * up either way.
 */
export function takeChallenge(challengeId: string): TakeChallengeResult {
  const challenge = pending.get(challengeId);
  if (challenge) {
    if (Date.now() > challenge.expiresAt) {
      pending.delete(challengeId);
      deleteOtpChallengeRecord(challengeId);
      void challenge.scraper.terminate(false);
      return { status: 'expired' };
    }
    return { status: 'found', challenge };
  }

  const record = findOtpChallengeRecord(challengeId);
  if (!record) return { status: 'unknown' };

  if (Date.now() > record.expiresAt) {
    deleteOtpChallengeRecord(challengeId);
    return { status: 'expired' };
  }
  return { status: 'lostToRestart' };
}

export function finishChallenge(challengeId: string): void {
  pending.delete(challengeId);
  deleteOtpChallengeRecord(challengeId);
}

/** Drops challenges past their TTL. Safe to call on a timer. */
export function sweepExpiredChallenges(now = Date.now()): number {
  let swept = 0;
  for (const [id, challenge] of pending) {
    if (now > challenge.expiresAt) {
      pending.delete(id);
      deleteOtpChallengeRecord(id);
      void challenge.scraper.terminate(false);
      swept++;
    }
  }
  // Also drops persisted records left behind by other processes — e.g. one that
  // crashed or restarted before ever calling finishChallenge on its own challenges.
  swept += sweepExpiredOtpChallengeRecords(now);
  return swept;
}

/** Terminates every open challenge. Called on shutdown. */
export async function closeAllChallenges(): Promise<void> {
  const open = [...pending.values()];
  pending.clear();
  for (const challenge of open) deleteOtpChallengeRecord(challenge.challengeId);
  await Promise.all(open.map((c) => c.scraper.terminate(false).catch(() => {})));
}
