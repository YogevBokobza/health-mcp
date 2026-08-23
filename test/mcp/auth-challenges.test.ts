import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Scraper } from 'israeli-health-scrapers';

// The data dir and key must be set before anything opens the database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-otp-test-'));
process.env.HEALTH_MCP_DATA_DIR = tempDir;
process.env.HEALTH_MCP_KEY = 'test-key-not-a-real-secret';
process.env.HEALTH_MCP_AUDIT = 'off';

function fakeScraper(): Scraper {
  return { terminate: async () => {} } as unknown as Scraper;
}

/**
 * Each `vi.resetModules()` below gives `database.js` a fresh module instance (and thus
 * a fresh, separately-opened `Database` handle) to simulate a process restart. Closing
 * the *current* registry's handle after each step is what lets Windows release the
 * file for the next reopen and for the final cleanup.
 */
async function closeCurrentDatabaseHandle(): Promise<void> {
  const { closeDatabase } = await import('../../src/db/database.js');
  closeDatabase();
}

afterAll(async () => {
  await closeCurrentDatabaseHandle();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * `vi.resetModules()` between a "create" step and a "take" step gives each its own
 * fresh in-memory `pending` Map (and its own fresh `database.js` handle onto the same
 * on-disk file) — the same shape of state loss a real MCP server restart produces,
 * without needing a second OS process.
 */
describe('OTP challenge survival across a process restart', () => {
  it('tells a restart-orphaned challenge apart from a genuinely unknown one', async () => {
    const { createChallenge } = await import('../../src/mcp/auth-challenges.js');
    const { challengeId } = createChallenge('maccabi', fakeScraper());

    await closeCurrentDatabaseHandle();
    vi.resetModules();
    const { takeChallenge } = await import('../../src/mcp/auth-challenges.js');

    expect(takeChallenge(challengeId).status).toBe('lostToRestart');
    expect(takeChallenge('never-issued-challenge-id').status).toBe('unknown');
  });

  it('still reports expiry once the TTL has genuinely passed, even after a restart', async () => {
    await closeCurrentDatabaseHandle();
    vi.resetModules();
    const { createChallenge } = await import('../../src/mcp/auth-challenges.js');
    const { challengeId } = createChallenge('maccabi', fakeScraper(), -1);

    await closeCurrentDatabaseHandle();
    vi.resetModules();
    const { takeChallenge } = await import('../../src/mcp/auth-challenges.js');

    expect(takeChallenge(challengeId).status).toBe('expired');
  });

  it('resolves normally, with the live scraper, inside a single process', async () => {
    await closeCurrentDatabaseHandle();
    vi.resetModules();
    const { createChallenge, takeChallenge } = await import('../../src/mcp/auth-challenges.js');
    const scraper = fakeScraper();
    const { challengeId } = createChallenge('maccabi', scraper);

    const outcome = takeChallenge(challengeId);
    expect(outcome.status).toBe('found');
    if (outcome.status === 'found') {
      expect(outcome.challenge.scraper).toBe(scraper);
    }
  });

  it('a completed challenge cannot be redeemed twice, even across a restart', async () => {
    await closeCurrentDatabaseHandle();
    vi.resetModules();
    const { createChallenge, finishChallenge } = await import('../../src/mcp/auth-challenges.js');
    const { challengeId } = createChallenge('maccabi', fakeScraper());
    finishChallenge(challengeId);

    await closeCurrentDatabaseHandle();
    vi.resetModules();
    const { takeChallenge } = await import('../../src/mcp/auth-challenges.js');
    expect(takeChallenge(challengeId).status).toBe('unknown');
  });
});
