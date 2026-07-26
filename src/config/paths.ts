import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const APP_NAME = 'HealthMCP';

/**
 * OS-conventional application data directory.
 *
 * The database holds medical records, so it belongs where the platform expects
 * private application state — not in whatever directory the server happened to be
 * launched from, which for an MCP client is unpredictable.
 */
export function appDataDir(): string {
  if (process.env.HEALTH_MCP_DATA_DIR) return path.resolve(process.env.HEALTH_MCP_DATA_DIR);

  const home = os.homedir();

  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'),
        APP_NAME,
      );
  }
}

export function databasePath(): string {
  return path.join(appDataDir(), 'database.db');
}

export function auditPath(): string {
  return path.join(appDataDir(), 'audit.jsonl');
}

export function policyPath(): string {
  return process.env.HEALTH_MCP_POLICY_FILE ?? path.join(appDataDir(), 'policy.json');
}

/** Where the scraper library keeps its login sessions and diagnostics dumps. */
export function scraperDataDir(): string {
  return path.join(appDataDir(), 'scraper');
}

/** Creates the app directory with owner-only permissions. */
export function ensureAppDataDir(): string {
  const dir = appDataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
