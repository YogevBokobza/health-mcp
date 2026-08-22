import type { Form17Request, HealthFundId } from 'israeli-health-scrapers';

import { openDatabase } from './database.js';

export interface StoredForm17Request {
  id: number;
  company_id: string;
  request_id: string;
  request_type: string;
  status: string;
  submitted_on: string | null;
  status_updated_on: string | null;
  provider_name: string | null;
  appointment_on: string | null;
  document_labels: string | null;
  can_change_appointment: number | null;
  requires_additional_info: number | null;
  raw: string | null;
  first_seen_at: string;
  updated_at: string;
}

/**
 * Reconciles the stored rows with the scraper's complete Form 17 request snapshot.
 *
 * Scraper snapshots are expected to have unique IDs, but malformed or merged
 * account results can repeat one. We keep the last occurrence for each ID,
 * preserving the first-seen order of IDs, and return the number of unique rows
 * actually stored (matching the sync run's record count).
 */
export function upsertForm17Requests(companyId: HealthFundId, requests: Form17Request[]): number {
  const db = openDatabase();
  const now = new Date().toISOString();
  const uniqueRequests = new Map<string, Form17Request>();
  for (const request of requests) uniqueRequests.set(request.id, request);
  const items = [...uniqueRequests.values()];
  const statement = db.prepare(
    `INSERT INTO form17_requests (
       company_id, request_id, request_type, status, submitted_on, status_updated_on,
       provider_name, appointment_on, document_labels, can_change_appointment,
       requires_additional_info, raw,
       first_seen_at, updated_at
     ) VALUES (
       @companyId, @requestId, @requestType, @status, @submittedOn, @statusUpdatedOn,
       @providerName, @appointmentOn, @documentLabels, @canChangeAppointment,
       @requiresAdditionalInfo, @raw,
       @now, @now
     )
     ON CONFLICT (company_id, request_id) DO UPDATE SET
       request_type            = @requestType,
       status                  = @status,
       submitted_on            = @submittedOn,
       status_updated_on       = @statusUpdatedOn,
       provider_name           = @providerName,
       appointment_on          = @appointmentOn,
       document_labels         = @documentLabels,
       can_change_appointment  = @canChangeAppointment,
       requires_additional_info = @requiresAdditionalInfo,
       raw                     = @raw,
       updated_at              = @now`,
  );

  return db.transaction(() => {
    const ids = new Set<string>();
    for (const request of items) {
      ids.add(request.id);
      statement.run({
        companyId,
        requestId: request.id,
        requestType: request.requestType,
        status: request.status,
        submittedOn: request.submittedOn,
        statusUpdatedOn: request.statusUpdatedOn,
        providerName: request.providerName,
        appointmentOn: request.appointmentOn,
        documentLabels: JSON.stringify(request.documentLabels),
        canChangeAppointment: toNullableInt(request.canChangeAppointment),
        requiresAdditionalInfo: toNullableInt(request.requiresAdditionalInfo),
        raw: request.raw ? JSON.stringify(request.raw) : null,
        now,
      });
    }

    if (ids.size === 0) {
      db.prepare('DELETE FROM form17_requests WHERE company_id = ?').run(companyId);
    } else {
      const placeholders = [...ids].map(() => '?').join(', ');
      db.prepare(
        `DELETE FROM form17_requests WHERE company_id = ? AND request_id NOT IN (${placeholders})`,
      ).run(companyId, ...ids);
    }
    return items.length;
  })();
}

function toNullableInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

export function listForm17Requests(
  options: { companyId?: HealthFundId } = {},
): StoredForm17Request[] {
  const where = options.companyId ? 'WHERE company_id = @companyId' : '';
  return openDatabase()
    .prepare(`SELECT * FROM form17_requests ${where} ORDER BY submitted_on DESC`)
    .all(options.companyId ? { companyId: options.companyId } : {}) as StoredForm17Request[];
}
