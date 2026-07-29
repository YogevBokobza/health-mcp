import { z } from 'zod';
import { SCRAPERS, type HealthFundId } from 'israeli-health-scrapers';

import { scope, type Capability, type Resource, type Scope } from './permissions/scopes.js';
import { listCredentialedFunds } from './db/credentials.js';
import { listMedications } from './db/medications.js';
import { listAppointments } from './db/appointments.js';
import { listTestResults } from './db/test-results.js';
import { lastSyncRun } from './db/sync-runs.js';
import { describeTable, listTables, runSafeQuery } from './db/query.js';
import {
  fetchAppointmentsForFund,
  fetchFund,
  fetchTestResultsForFund,
} from './sync/fetch.js';

/**
 * An operation is one thing an agent can ask for, declared rather than implied.
 *
 * The scrapers know how to talk to a fund and the database knows how to store what
 * they return; operations are the vocabulary exposed to an agent. Keeping them
 * separate is what lets the permission engine reason about "read prescriptions at
 * Maccabi" without knowing anything about Maccabi or about SQLite.
 */
export interface Operation<TIn = unknown, TOut = unknown> {
  name: string;
  companyId: HealthFundId | null;
  resource: Resource;
  capability: Capability;
  scope: Scope;
  title: string;
  input: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Write operations only: what executing would do, rendered before anything is sent. */
  preview?(input: TIn): Promise<string>;
  run(input: TIn): Promise<TOut>;
}

/** Funds that have credentials stored — the only ones any operation can act on. */
export function configuredFunds(): HealthFundId[] {
  try {
    return listCredentialedFunds();
  } catch {
    // No database yet (first run, or no key). The CLI is what fixes that.
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Per-fund operations                                                         */
/* -------------------------------------------------------------------------- */

const listMedicationsInput = z
  .object({
    expiringWithinDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only prescriptions expiring within this many days.'),
    includeExpired: z.boolean().default(true),
  })
  .default({ includeExpired: true });

function medicationsListOperation(companyId: HealthFundId): Operation {
  return {
    name: 'medications.list',
    companyId,
    resource: 'medications',
    capability: 'read',
    scope: scope(companyId, 'medications', 'read'),
    title: `רשימת התרופות הקבועות ב${SCRAPERS[companyId].name} מהאחסון המקומי, כולל תוקף המרשם וכמה ימים נותרו. לא ניגש לאתר — הרץ medications.refresh כדי לעדכן.`,
    input: listMedicationsInput,

    async run(input) {
      const parsed = input as z.infer<typeof listMedicationsInput>;
      const items = listMedications({ companyId, ...parsed });
      const sync = lastSyncRun(companyId, 'medications');

      return {
        items,
        // Returned alongside the data, not buried in another tool: a list of
        // prescriptions is misleading without knowing how old it is.
        lastSync: sync
          ? {
              at: sync.finished_at ?? sync.started_at,
              success: sync.success === 1,
              errorType: sync.error_type,
            }
          : null,
      };
    },
  };
}

function medicationsRefreshOperation(companyId: HealthFundId): Operation {
  return {
    name: 'medications.refresh',
    companyId,
    resource: 'medications',
    capability: 'read',
    scope: scope(companyId, 'medications', 'read'),
    title: `התחברות ל${SCRAPERS[companyId].name} ורענון רשימת התרופות באחסון המקומי.`,
    input: z.object({}).default({}),

    async run() {
      // Classified `read`: it touches the fund's site but only reads from it, and
      // nothing about the member's account changes.
      return fetchFund(companyId);
    },
  };
}

function appointmentsListOperation(companyId: HealthFundId): Operation {
  return {
    name: 'appointments.list',
    companyId,
    resource: 'appointments',
    capability: 'read',
    scope: scope(companyId, 'appointments', 'read'),
    title: `רשימת התורים הקרובים ב${SCRAPERS[companyId].name} מהאחסון המקומי, כולל רופא, התמחות, כתובת המרפאה והנחיות לפני ביקור. לא ניגש לאתר — הרץ appointments.refresh כדי לעדכן.`,
    input: z.object({}).default({}),

    async run() {
      const items = listAppointments({ companyId });
      const sync = lastSyncRun(companyId, 'appointments');

      return {
        items,
        lastSync: sync
          ? {
              at: sync.finished_at ?? sync.started_at,
              success: sync.success === 1,
              errorType: sync.error_type,
            }
          : null,
      };
    },
  };
}

function appointmentsRefreshOperation(companyId: HealthFundId): Operation {
  return {
    name: 'appointments.refresh',
    companyId,
    resource: 'appointments',
    capability: 'read',
    scope: scope(companyId, 'appointments', 'read'),
    title: `התחברות ל${SCRAPERS[companyId].name} ורענון רשימת התורים הקרובים באחסון המקומי. איטי יותר מ-medications.refresh: נכנס לעמוד הפרטים של כל תור בנפרד.`,
    input: z.object({}).default({}),

    async run() {
      // Kept as its own operation rather than folded into medications.refresh: this one
      // clicks into every appointment's detail page for clinic/instructions, so it is
      // meaningfully slower and a caller should be able to ask for one without the other.
      return fetchAppointmentsForFund(companyId);
    },
  };
}

function testResultsListOperation(companyId: HealthFundId): Operation {
  return {
    name: 'testResults.list',
    companyId,
    resource: 'testResults',
    capability: 'read',
    scope: scope(companyId, 'testResults', 'read'),
    title: `רשימת רשומות בדיקות ב${SCRAPERS[companyId].name} מהאחסון המקומי, כולל שם הבדיקה, מועד הביצוע והרופא המפנה כשזמינים. לא ניגש לאתר — הרץ testResults.refresh כדי לעדכן.`,
    input: z.object({}).default({}),

    async run() {
      const items = listTestResults({ companyId });
      const sync = lastSyncRun(companyId, 'testResults');

      return {
        items,
        lastSync: sync
          ? {
              at: sync.finished_at ?? sync.started_at,
              success: sync.success === 1,
              errorType: sync.error_type,
            }
          : null,
      };
    },
  };
}

function testResultsRefreshOperation(companyId: HealthFundId): Operation {
  return {
    name: 'testResults.refresh',
    companyId,
    resource: 'testResults',
    capability: 'read',
    scope: scope(companyId, 'testResults', 'read'),
    title: `התחברות ל${SCRAPERS[companyId].name} ורענון רשימת רשומות הבדיקות באחסון המקומי.`,
    input: z.object({}).default({}),

    async run() {
      return fetchTestResultsForFund(companyId);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Database operations, following asher-mcp's shape                            */
/* -------------------------------------------------------------------------- */

const databaseOperations: Operation[] = [
  {
    name: 'db.listTables',
    companyId: null,
    resource: 'database',
    capability: 'read',
    scope: 'local:database:read',
    title: 'רשימת הטבלאות הזמינות לשאילתה, עם מספר השורות בכל אחת.',
    input: z.object({}).default({}),
    run: async () => ({ tables: listTables() }),
  },
  {
    name: 'db.describeTable',
    companyId: null,
    resource: 'database',
    capability: 'read',
    scope: 'local:database:read',
    title: 'סכמת טבלה: עמודות, טיפוסים ומפתחות.',
    input: z.object({ table: z.string() }),
    run: async (input) => describeTable((input as { table: string }).table),
  },
  {
    name: 'db.sqlQuery',
    companyId: null,
    resource: 'database',
    capability: 'read',
    scope: 'local:database:read',
    title:
      'שאילתת SELECT בלבד על המידע הרפואי באחסון המקומי. שימושי לשאלות מורכבות שאין להן כלי ייעודי.',
    input: z.object({
      sql: z.string().describe('A single read-only SELECT statement.'),
      params: z.array(z.union([z.string(), z.number(), z.null()])).default([]),
    }),
    run: async (input) => {
      const { sql, params } = input as { sql: string; params: unknown[] };
      return runSafeQuery(sql, params);
    },
  },
];

/* -------------------------------------------------------------------------- */

/** Every operation for a fund. */
export function operationsFor(companyId: HealthFundId): Operation[] {
  return [
    medicationsListOperation(companyId),
    medicationsRefreshOperation(companyId),
    appointmentsListOperation(companyId),
    appointmentsRefreshOperation(companyId),
    testResultsListOperation(companyId),
    testResultsRefreshOperation(companyId),
  ];
}

/**
 * All operations: one set per configured fund, plus the fund-independent database
 * tools.
 *
 * Operations exist only for funds with stored credentials — an agent should not see a
 * tool for an account that was never set up, and then have to discover that by failing.
 */
export function allOperations(funds: HealthFundId[] = configuredFunds()): Operation[] {
  return [...funds.flatMap((companyId) => operationsFor(companyId)), ...databaseOperations];
}

export function findOperation(name: string, companyId?: HealthFundId | null): Operation | null {
  return (
    allOperations().find(
      (operation) =>
        operation.name === name &&
        (companyId === undefined || operation.companyId === companyId),
    ) ?? null
  );
}
