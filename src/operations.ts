import { z } from 'zod';
import { SCRAPERS, type HealthFundId } from 'israeli-health-scrapers';

import { scope, type Capability, type Resource, type Scope } from './permissions/scopes.js';
import { listCredentialedFunds } from './db/credentials.js';
import { listMedications } from './db/medications.js';
import { listAppointments } from './db/appointments.js';
import {
  countTestResultValues,
  findTestResultForExport,
  listTestResultValues,
  listTestResults,
} from './db/test-results.js';
import { exportDocument } from './store/documents.js';
import { listVaccinations } from './db/vaccinations.js';
import { listForm17Requests } from './db/form17.js';
import { lastSyncRun, type SyncResource } from './db/sync-runs.js';
import { describeTable, listTables, runSafeQuery } from './db/query.js';
import {
  classifyFetchFailure,
  fetchAppointmentsForFund,
  fetchForm17ForFund,
  fetchFund,
  fetchTestResultDetailsForFund,
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

const isoDateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date (YYYY-MM-DD)');

/**
 * Row bounds for the analyte-level view.
 *
 * A decade of results is a few thousand measurements, so the default is generous
 * enough that an ordinary question is answered in full, and the operation says when it
 * was not.
 */
const DEFAULT_VALUE_ROWS = 1_000;
const MAX_VALUE_ROWS = 5_000;

const listTestResultsInput = z
  .object({
    from: isoDateInput.optional().describe('Only results performed on or after this date.'),
    to: isoDateInput.optional().describe('Only results performed on or before this date.'),
    kind: z
      .enum(['lab', 'document', 'imaging', 'other'])
      .optional()
      .describe(
        'lab = measured values; document = a report file; imaging = films held in the fund viewer.',
      ),
    withDocument: z.boolean().optional().describe('Only results whose file is stored locally.'),
  })
  .default({});

function testResultsListOperation(companyId: HealthFundId): Operation {
  return {
    name: 'testResults.list',
    companyId,
    resource: 'testResults',
    capability: 'read',
    scope: scope(companyId, 'testResults', 'read'),
    title: `רשימת רשומות בדיקות ב${SCRAPERS[companyId].name} מהאחסון המקומי: שם הבדיקה, מועד הביצוע, הרופא המפנה, כמה ערכי מעבדה נשמרו לכל רשומה, והאם קיים קובץ תוצאה מקומי. לא ניגש לאתר — הרץ testResults.refresh לעדכון הרשימה, או testResults.refreshDetails (דורש הרשאת sensitive_read) כדי להוריד ערכים ומסמכים.`,
    input: listTestResultsInput,

    async run(input) {
      const parsed = input as z.infer<typeof listTestResultsInput>;
      const items = listTestResults({ companyId, ...parsed });
      const valueCounts = countTestResultValues({ companyId });

      return {
        items: items.map((item) => ({
          ...item,
          value_count: valueCounts.get(item.test_result_id) ?? 0,
        })),
        lastSync: lastSyncPayload(companyId, 'testResults'),
        // Reported separately: the timeline can be fresh while the results behind it
        // are old, and only one of those two dates is about the numbers.
        lastDetailSync: lastSyncPayload(companyId, 'testResultDetails'),
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
    title: `התחברות ל${SCRAPERS[companyId].name} ורענון רשימת רשומות הבדיקות באחסון המקומי. מהיר — בקשה אחת, ללא ערכים וללא מסמכים.`,
    input: z.object({}).default({}),

    async run() {
      return fetchTestResultsForFund(companyId);
    },
  };
}

const refreshTestResultDetailsInput = z
  .object({
    since: isoDateInput
      .optional()
      .describe('Only fetch values and documents for results performed on or after this date.'),
  })
  .default({});

function testResultsRefreshDetailsOperation(companyId: HealthFundId): Operation {
  return {
    name: 'testResults.refreshDetails',
    companyId,
    resource: 'testResults',
    capability: 'sensitive_read',
    scope: scope(companyId, 'testResults', 'sensitive_read'),
    title: `התחברות ל${SCRAPERS[companyId].name} והורדת התוצאות עצמן: כל ערכי המעבדה (ערך, יחידה וטווח ייחוס) וכל מסמכי התוצאה, מוצפנים באחסון המקומי. איטי — בקשה לכל בדיקה בנפרד; העבר since כדי לעדכן רק בדיקות מתאריך מסוים.`,
    input: refreshTestResultDetailsInput,

    async run(input) {
      const { since } = input as z.infer<typeof refreshTestResultDetailsInput>;
      return fetchTestResultDetailsForFund(companyId, since ? { since } : {});
    },
  };
}

const listTestResultValuesInput = z
  .object({
    name: z.string().optional().describe('Substring of the analyte name, case-insensitive, e.g. "ferritin".'),
    from: isoDateInput.optional(),
    to: isoDateInput.optional(),
    outOfRangeOnly: z.boolean().optional().describe('Only values that fell below or above their reference range.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_VALUE_ROWS)
      .optional()
      .describe(`Maximum rows to return. Defaults to ${DEFAULT_VALUE_ROWS}.`),
  })
  .default({});

function testResultValuesOperation(companyId: HealthFundId): Operation {
  return {
    name: 'testResults.values',
    companyId,
    resource: 'testResults',
    capability: 'sensitive_read',
    scope: scope(companyId, 'testResults', 'sensitive_read'),
    title: `ערכי בדיקות מעבדה בודדים מהאחסון המקומי, מהחדש לישן: שם הבדיקה, הערך, היחידה, טווח הייחוס והאם הערך חרג ממנו. מיועד למעקב אחרי בדיקה לאורך זמן (name) או לאיתור חריגות (outOfRangeOnly).`,
    input: listTestResultValuesInput,

    async run(input) {
      const parsed = input as z.infer<typeof listTestResultValuesInput>;
      const limit = parsed.limit ?? DEFAULT_VALUE_ROWS;
      const items = listTestResultValues({ companyId, ...parsed, limit });

      return {
        items,
        // Said out loud rather than left to be inferred from a round number: a caller
        // reasoning about a trend needs to know it is looking at a truncated series.
        truncated: items.length === limit,
        lastDetailSync: lastSyncPayload(companyId, 'testResultDetails'),
      };
    },
  };
}

const exportTestResultDocumentInput = z.object({
  resultId: z.string().min(1).describe('The test_result_id from testResults.list or .values.'),
  destinationPath: z.string().min(1).describe('Where to write the decrypted PDF.'),
  overwrite: z.boolean().default(false).describe('Replace destinationPath if it already exists.'),
});

function testResultExportDocumentOperation(companyId: HealthFundId): Operation {
  return {
    name: 'testResults.exportDocument',
    companyId,
    resource: 'testResults',
    capability: 'sensitive_read',
    scope: scope(companyId, 'testResults', 'sensitive_read'),
    title: `פענוח מסמך תוצאה מוצפן (שהורד ע"י testResults.refreshDetails) לנתיב שנבחר, כקובץ קריא רגיל. מסרב לדרוס קובץ קיים אלא אם overwrite הוא true.`,
    input: exportTestResultDocumentInput,

    async run(input) {
      const { resultId, destinationPath, overwrite } = input as z.infer<
        typeof exportTestResultDocumentInput
      >;

      const result = findTestResultForExport(companyId, resultId);
      if (!result || !result.document_path || !result.document_sha256) {
        throw new Error(
          `No stored document for ${resultId}. Run testResults.refreshDetails first, or check ` +
            'testResults.list for document_available.',
        );
      }

      exportDocument(result.document_path, result.document_sha256, destinationPath, { overwrite });
      return { exported: true, destinationPath };
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
    testResultValuesOperation(companyId),
    testResultsRefreshOperation(companyId),
    testResultsRefreshDetailsOperation(companyId),
    testResultExportDocumentOperation(companyId),
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
