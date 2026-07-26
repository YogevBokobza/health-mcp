import type { Appointment, HealthFundId } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';

export interface StoredAppointment {
  id: number;
  company_id: string;
  appointment_id: string;
  start: string;
  doctor_name: string | null;
  specialty: string | null;
  clinic: string | null;
  raw: string | null;
  first_seen_at: string;
  updated_at: string;
}

/**
 * Writes a fetch result into the table.
 *
 * Upserts on (company_id, appointment_id) — the scraper's id is already stable across
 * re-fetches of the same booking (see maccabi.ts), so a re-fetch updates the row it
 * already has instead of accumulating a duplicate.
 */
export function upsertAppointments(companyId: HealthFundId, appointments: Appointment[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();

  const statement = db.prepare(
    `INSERT INTO appointments (
       company_id, appointment_id, start, doctor_name, specialty, clinic, raw,
       first_seen_at, updated_at
     ) VALUES (
       @companyId, @appointmentId, @start, @doctorName, @specialty, @clinic, @raw, @now, @now
     )
     ON CONFLICT (company_id, appointment_id) DO UPDATE SET
       start         = @start,
       doctor_name   = @doctorName,
       specialty     = @specialty,
       clinic        = @clinic,
       raw           = @raw,
       updated_at    = @now`,
  );

  const writeAll = db.transaction((items: Appointment[]) => {
    for (const appointment of items) {
      statement.run({
        companyId,
        appointmentId: appointment.id,
        start: appointment.start,
        doctorName: appointment.doctorName,
        specialty: appointment.specialty,
        clinic: appointment.clinic,
        raw: appointment.raw ? JSON.stringify(appointment.raw) : null,
        now,
      });
    }
    return items.length;
  });

  return writeAll(appointments);
}

export function listAppointments(options: { companyId?: HealthFundId } = {}): StoredAppointment[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.companyId) {
    clauses.push('company_id = @companyId');
    params.companyId = options.companyId;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  return openDatabase()
    .prepare(`SELECT * FROM appointments ${where} ORDER BY start ASC`)
    .all(params) as StoredAppointment[];
}
