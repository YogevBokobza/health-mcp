import { openDatabase } from './database.js';

interface OtpChallengeRow {
  challenge_id: string;
  company_id: string;
  created_at: string;
  expires_at: string;
}

export interface OtpChallengeRecord {
  challengeId: string;
  companyId: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Metadata only — never the live `Scraper`/browser, which cannot survive a process
 * restart regardless. This is what lets `takeOtpChallengeRecord` tell an
 * `auth_complete` orphaned by a mid-login process restart apart from a genuinely
 * expired or bogus challenge id, both of which otherwise look identical.
 */
export function recordOtpChallenge(challengeId: string, companyId: string, expiresAt: number): void {
  openDatabase()
    .prepare(
      `INSERT INTO otp_challenges (challenge_id, company_id, created_at, expires_at)
       VALUES (@challengeId, @companyId, @createdAt, @expiresAt)
       ON CONFLICT (challenge_id) DO NOTHING`,
    )
    .run({
      challengeId,
      companyId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
}

export function findOtpChallengeRecord(challengeId: string): OtpChallengeRecord | null {
  const row = openDatabase()
    .prepare(
      'SELECT challenge_id, company_id, created_at, expires_at FROM otp_challenges WHERE challenge_id = ?',
    )
    .get(challengeId) as OtpChallengeRow | undefined;

  if (!row) return null;

  return {
    challengeId: row.challenge_id,
    companyId: row.company_id,
    createdAt: Date.parse(row.created_at),
    expiresAt: Date.parse(row.expires_at),
  };
}

export function deleteOtpChallengeRecord(challengeId: string): void {
  openDatabase().prepare('DELETE FROM otp_challenges WHERE challenge_id = ?').run(challengeId);
}

/** Drops persisted records past their TTL. Safe to call on a timer. */
export function sweepExpiredOtpChallengeRecords(now = Date.now()): number {
  const result = openDatabase()
    .prepare('DELETE FROM otp_challenges WHERE expires_at < ?')
    .run(new Date(now).toISOString());

  return result.changes;
}
