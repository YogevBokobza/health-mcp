import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthFundTypes, type Appointment, type Medication } from 'israeli-health-scrapers';

// The data dir and key must be set before anything opens the database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-test-'));
process.env.HEALTH_MCP_DATA_DIR = tempDir;
process.env.HEALTH_MCP_KEY = 'test-key-not-a-real-secret';
process.env.HEALTH_MCP_AUDIT = 'off';

const { closeDatabase, openDatabase } = await import('../../src/db/database.js');
const { saveCredentials, getCredentials, listCredentialedFunds, deleteCredentials } = await import(
  '../../src/db/credentials.js'
);
const { upsertMedications, listMedications } = await import('../../src/db/medications.js');
const { upsertAppointments, listAppointments } = await import('../../src/db/appointments.js');
const { startSyncRun, finishSyncRun, lastSyncRun } = await import('../../src/db/sync-runs.js');
const { runSafeQuery } = await import('../../src/db/query.js');

function medication(overrides: Partial<Medication> = {}): Medication {
  return {
    name: 'אומפרדקס 20 מ"ג',
    dosage: '20 מ"ג',
    form: 'קפסולות',
    prescribedBy: 'ד"ר כהן',
    lastDispensed: '2026-05-12',
    validUntil: '2026-08-12',
    refillsRemaining: 2,
    daysUntilExpiry: 17,
    status: 'expiring_soon',
    provider: HealthFundTypes.maccabi,
    ...overrides,
  };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'abc123',
    start: '2026-08-09T14:30:00+03:00',
    doctorName: 'ד"ר כהן רונית',
    specialty: 'עור | ביקור רגיל',
    clinic: 'רחוב הדוגמה 1, עיר בדיונית',
    provider: HealthFundTypes.maccabi,
    ...overrides,
  };
}

beforeAll(() => {
  openDatabase();
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('database', () => {
  it('creates the file with owner-only permissions', () => {
    const mode = fs.statSync(path.join(tempDir, 'database.db')).mode & 0o777;
    // Medical records: readable by this user and nobody else.
    expect(mode).toBe(0o600);
  });

  it('stores nothing in plaintext on disk', () => {
    saveCredentials(HealthFundTypes.maccabi, { id: '123456782', password: 'hunter2' });
    closeDatabase();

    const raw = fs.readFileSync(path.join(tempDir, 'database.db'));
    expect(raw.includes(Buffer.from('hunter2'))).toBe(false);
    expect(raw.includes(Buffer.from('123456782'))).toBe(false);

    openDatabase();
  });
});

describe('credentials', () => {
  it('round-trips and updates in place', () => {
    saveCredentials(HealthFundTypes.maccabi, { id: '123456782', password: 'first' });
    saveCredentials(HealthFundTypes.maccabi, { id: '123456782', password: 'second' });

    expect(getCredentials(HealthFundTypes.maccabi)).toEqual({
      id: '123456782',
      password: 'second',
    });
    expect(listCredentialedFunds()).toEqual([HealthFundTypes.maccabi]);
  });

  it('keeps a password-less account distinguishable from a missing one', () => {
    saveCredentials(HealthFundTypes.mock, { id: '000000000' });

    expect(getCredentials(HealthFundTypes.mock)).toEqual({ id: '000000000', password: undefined });
    expect(getCredentials(HealthFundTypes.clalit)).toBeNull();

    deleteCredentials(HealthFundTypes.mock);
  });

  it('is not reachable through the query tool', () => {
    expect(() => runSafeQuery('SELECT * FROM credentials')).toThrow();
  });
});

describe('medications', () => {
  it('upserts rather than duplicating on a re-fetch', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication()]);
    upsertMedications(HealthFundTypes.maccabi, [medication({ refillsRemaining: 1 })]);

    const rows = listMedications({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refills_remaining).toBe(1);
  });

  it('preserves first_seen_at across an update', () => {
    // Otherwise every fetch would erase when a prescription first appeared.
    const before = listMedications()[0]!.first_seen_at;
    upsertMedications(HealthFundTypes.maccabi, [medication({ status: 'active' })]);
    expect(listMedications()[0]?.first_seen_at).toBe(before);
  });

  it('treats a different validity period as a different prescription', () => {
    upsertMedications(HealthFundTypes.maccabi, [medication({ validUntil: '2027-01-03' })]);
    expect(listMedications({ companyId: HealthFundTypes.maccabi })).toHaveLength(2);
  });

  it('sorts soonest-to-expire first and puts unknown expiry last', () => {
    upsertMedications(HealthFundTypes.maccabi, [
      medication({ name: 'ונטולין', validUntil: '2026-04-20', daysUntilExpiry: -97, status: 'expired' }),
      medication({ name: 'לא ידוע', validUntil: null, daysUntilExpiry: null, status: 'unknown' }),
    ]);

    const rows = listMedications();
    expect(rows[0]?.name).toBe('ונטולין');
    expect(rows.at(-1)?.name).toBe('לא ידוע');
  });

  it('filters by expiry window and excludes expired on request', () => {
    expect(listMedications({ expiringWithinDays: 20 }).every((r) => r.days_until_expiry! <= 20)).toBe(
      true,
    );
    expect(listMedications({ includeExpired: false }).some((r) => r.status === 'expired')).toBe(
      false,
    );
  });
});

describe('appointments', () => {
  it('upserts on (company, appointment id) rather than duplicating on a re-fetch', () => {
    upsertAppointments(HealthFundTypes.maccabi, [appointment()]);
    upsertAppointments(HealthFundTypes.maccabi, [appointment({ clinic: 'כתובת אחרת' })]);

    const rows = listAppointments({ companyId: HealthFundTypes.maccabi });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clinic).toBe('כתובת אחרת');
  });

  it('treats a different appointment id as a different booking', () => {
    upsertAppointments(HealthFundTypes.maccabi, [appointment({ id: 'def456' })]);
    expect(listAppointments({ companyId: HealthFundTypes.maccabi })).toHaveLength(2);
  });

  it('sorts soonest first', () => {
    upsertAppointments(HealthFundTypes.maccabi, [
      appointment({ id: 'sooner', start: '2026-08-01T09:00:00+03:00' }),
    ]);

    const rows = listAppointments({ companyId: HealthFundTypes.maccabi });
    expect(rows[0]?.appointment_id).toBe('sooner');
  });
});

describe('sync runs', () => {
  it('records a failed fetch, not just successful ones', () => {
    // "Is this data stale, or did the last fetch fail?" cannot be answered from the
    // medications table alone.
    const id = startSyncRun(HealthFundTypes.maccabi, 'medications');
    finishSyncRun(id, { success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'nope' });

    const run = lastSyncRun(HealthFundTypes.maccabi, 'medications');
    expect(run?.success).toBe(0);
    expect(run?.error_type).toBe('INVALID_PASSWORD');
  });

  it('keeps medications and appointments history separate for the same fund', () => {
    const medId = startSyncRun(HealthFundTypes.maccabi, 'medications');
    finishSyncRun(medId, { success: true, recordCount: 3 });

    const apptId = startSyncRun(HealthFundTypes.maccabi, 'appointments');
    finishSyncRun(apptId, { success: true, recordCount: 1 });

    expect(lastSyncRun(HealthFundTypes.maccabi, 'medications')?.record_count).toBe(3);
    expect(lastSyncRun(HealthFundTypes.maccabi, 'appointments')?.record_count).toBe(1);
  });
});
