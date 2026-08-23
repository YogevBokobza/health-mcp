import { z } from 'zod';
import { SCRAPERS, type HealthFundId } from 'israeli-health-scrapers';

import { scope, type Capability, type Resource, type Scope } from './permissions/scopes.js';
import { listCredentialedFunds } from './db/credentials.js';
import { listMedications } from './db/medications.js';
import { listAppointments } from './db/appointments.js';
import { listTestResults } from './db/test-results.js';
import { listVaccinations } from './db/vaccinations.js';
import { listForm17Requests } from './db/form17.js';
import { lastSyncRun, type SyncResource } from './db/sync-runs.js';
import { describeTable, listTables, runSafeQuery } from './db/query.js';
import {
  classifyFetchFailure,
  fetchAppointmentsForFund,
  fetchForm17ForFund,
  fetchFund,
  fetchTestResultsForFund,
  fetchVaccinationsForFund,
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

/**
 * The `lastSync` object returned by every list operation. The classification turns a
 * failed attempt's errorType into the same status/next pair the refresh operations
 * return, so an agent reading stale data sees "session_expired — re-authenticate"
 * rather than a raw error code it must interpret.
 */
function lastSyncPayload(companyId: HealthFundId, resource: SyncResource) {
  const sync = lastSyncRun(companyId, resource);
  if (!sync) return null;

  const success = sync.success === 1;

  return {
    at: sync.finished_at ?? sync.started_at,
    success,
    errorType: sync.error_type,
    ...(success ? {} : classifyFetchFailure(companyId, sync.error_type ?? undefined)),
  };
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
    title: `רשימת כל התרופות שיש להן מרשם תקף ב${SCRAPERS[companyId].name} מהאחסון המקומי, עם סימון אילו מהן תרופות קבועות (העמודה is_standing: 1 = תרופה קבועה, 0 = חד-פעמית), כולל תוקף המרשם וכמה ימים נותרו. לא ניגש לאתר — הרץ medications.refresh כדי לעדכן.`,
    input: listMedicationsInput,

    async run(input) {
      const parsed = input as z.infer<typeof listMedicationsInput>;
      return {
        items: listMedications({ companyId, ...parsed }),
        lastSync: lastSyncPayload(companyId, 'medications'),
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
    title: `התחברות ל${SCRAPERS[companyId].name} ורענון רשימת כל התרופות שיש להן מרשם תקף (קבועות וחד-פעמיות) באחסון המקומי.`,
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
      return {
        items: listAppointments({ companyId }),
        lastSync: lastSyncPayload(companyId, 'appointments'),
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
      return {
        items: listTestResults({ companyId }),
        lastSync: lastSyncPayload(companyId, 'testResults'),
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

function vaccinationsListOperation(companyId: HealthFundId): Operation {
  return {
    name: 'vaccinations.list',
    companyId,
    resource: 'vaccinations',
    capability: 'read',
    scope: scope(companyId, 'vaccinations', 'read'),
    title: `רשימת החיסונים ב${SCRAPERS[companyId].name} מהאחסון המקומי, כולל תאריך, מנה ומיקום. לא ניגש לאתר — הרץ vaccinations.refresh כדי לעדכן.`,
    input: z.object({}).default({}),

    async run() {
      return {
        items: listVaccinations({ companyId }),
        lastSync: lastSyncPayload(companyId, 'vaccinations'),
      };
    },
  };
}

function vaccinationsRefreshOperation(companyId: HealthFundId): Operation {
  return {
    name: 'vaccinations.refresh',
    companyId,
    resource: 'vaccinations',
    capability: 'read',
    scope: scope(companyId, 'vaccinations', 'read'),
    title: `התחברות ל${SCRAPERS[companyId].name} ורענון רשימת החיסונים באחסון המקומי.`,
    input: z.object({}).default({}),

    async run() {
      return fetchVaccinationsForFund(companyId);
    },
  };
}

function form17ListOperation(companyId: HealthFundId): Operation {
  return {
    name: 'form17.list',
    companyId,
    resource: 'form17',
    capability: 'read',
    scope: scope(companyId, 'form17', 'read'),
    title: `רשימת בקשות טופס 17 (התחייבויות) ב${SCRAPERS[companyId].name} מהאחסון המקומי, כולל סטטוס הבקשה, תאריכים, גורם מטפל ומסמכים. לא ניגש לאתר — הרץ form17.refresh כדי לעדכן.`,
    input: z.object({}).default({}),

    async run() {
      return {
        items: listForm17Requests({ companyId }),
        lastSync: lastSyncPayload(companyId, 'form17'),
      };
    },
  };
}

function form17RefreshOperation(companyId: HealthFundId): Operation {
  return {
    name: 'form17.refresh',
    companyId,
    resource: 'form17',
    capability: 'read',
    scope: scope(companyId, 'form17', 'read'),
    title: `התחברות ל${SCRAPERS[companyId].name} ורענון רשימת בקשות טופס 17 באחסון המקומי. איטי יותר מ-medications.refresh: גולל את כל רשימת הבקשות ופותח כל שורה לפרטיה.`,
    input: z.object({}).default({}),

    async run() {
      // Kept as its own operation for the same reason as appointments.refresh: the
      // list lazy-loads on scroll and every row must be expanded for its details, so
      // this costs meaningfully more than a list-only fetch.
      return fetchForm17ForFund(companyId);
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
    vaccinationsListOperation(companyId),
    vaccinationsRefreshOperation(companyId),
    form17ListOperation(companyId),
    form17RefreshOperation(companyId),
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
