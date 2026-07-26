/**
 * health-mcp — local-first MCP server for Israeli health fund accounts.
 *
 * Sits on top of israeli-health-scrapers the way asher-mcp sits on top of
 * israeli-bank-scrapers: the library reads the fund, this adds encrypted local
 * storage, a permission model, and the agent protocol.
 */

export { openDatabase, closeDatabase, databaseExists, DatabaseKeyError } from './db/database.js';
export { saveCredentials, getCredentials, listCredentialedFunds } from './db/credentials.js';
export { listMedications } from './db/medications.js';
export { listAppointments } from './db/appointments.js';
export { startSyncRun, finishSyncRun, lastSyncRun } from './db/sync-runs.js';
export { runSafeQuery, assertSafeSelect, listTables, describeTable, UnsafeQueryError } from './db/query.js';
export type { StoredMedication } from './db/medications.js';
export type { StoredAppointment } from './db/appointments.js';
export type { SyncRun, SyncResource } from './db/sync-runs.js';

export { fetchFund, fetchFunds, fetchAppointmentsForFund } from './sync/fetch.js';
export type { FetchOutcome } from './sync/fetch.js';

export { allOperations, operationsFor, findOperation, configuredFunds } from './operations.js';
export type { Operation } from './operations.js';

export {
  PermissionEngine,
  PermissionDeniedError,
  ConfirmationRequiredError,
  RateLimitedError,
} from './permissions/engine.js';
export { loadPolicyFile, resolvePolicy, DEFAULT_POLICY } from './permissions/config.js';
export { scope, scopeMatches, anyScopeMatches, LOCAL } from './permissions/scopes.js';
export type { Scope, Resource, Capability } from './permissions/scopes.js';

export { appDataDir, databasePath } from './config/paths.js';
