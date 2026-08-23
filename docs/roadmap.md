# Roadmap — Maccabi resource coverage

Source: user manually browsed the real Maccabi site and listed every page under
their account, 2026-07-26. This is the ordered plan for turning each page into
a resource, following the pattern already proven by medications and
appointments: a scraper resource in `israeli-health-scrapers`
(`src/scrapers/maccabi.ts`, new `FetchTarget`), then in this repo an
`upsert*`/`list*` DB pair (`src/db/`), a `fetchXForFund` in `src/sync/fetch.ts`,
and an `x.list` / `x.refresh` operation pair in `src/operations.ts` — never a
generic "fetch everything" flag, because per-resource cost varies (list-only
vs. list-plus-per-row-detail-click, as appointments needed for clinic address).

Each phase assumes the previous one is merged. Do not jump ahead — later
phases assume the write-confirmation path has been proven on a real (low-
stakes) write first.

## Phase 1 — cheap reads, same shape as medications/appointments

Do these first, one at a time, live-calibrated the same way appointments was:
guess selectors → run against the real account → fix from the diagnostics
dump in `data/diagnostics/`, never guess blind.

- **testResults** — complete, with a second tier. `TestsResults/lobby/` (list)
  shipped as a list-only resource first; the "likely list-only" guess turned
  out to be wrong — the rendered timeline omits the ids and per-entry
  authorization pair the actual values and documents hang off, so the detail
  tier (`testResults.refreshDetails`/`.values`/`.exportDocument`, gated behind
  `sensitive_read`) reads the page's own JSON API instead of the DOM. Check a
  page's own data API before writing a DOM parser for the next resource —
  it's often cheaper and less brittle than the rendered rows.
- **vaccinations** — complete. `Vaccinations/Lobby/`; calibrated in
  israeli-health-scrapers v0.2.0 and wired here (storage, fetch, operations,
  CLI) against that release.
- **form17 (read half)** — complete, arrived early from Phase 4.
  `requestsAndApprovals/StatusRequest/Lobby/?caseFilter=53,1,2` — the status
  of existing commitment/refund requests turned out to be a plain read with
  no dependency on the write flows, so it moved up. The write half (new
  commitment requests) stays in Phase 4. Expensive like appointments: the
  timeline lazy-loads on scroll and every row must be expanded.
- **pastVisits** — next. `PastVisits/Lobby/`. List-only.
- **visitSummaries** — `VisitSummary/Lobby/`. May need a per-row detail click
  for the full summary text, same pattern as appointments' clinic/instructions
  — check the list view first before assuming a detail page is needed.

## Phase 2 — reads with more structure

- **referrals** — `medicalfile/documents/referrals/`. Likely has a
  used/unused/expired status; if so, funnel through the shared
  `deriveExpiry`/status helper in `src/helpers/dates.ts`
  (`israeli-health-scrapers`) rather than inventing a second status model.
- **approvals** — `medicalfile/documents/approvals/` (התחייבויות). Similar
  shape to referrals.
- **purchaseHistory** — `medicalfile/PatientDrugs/?tab=2` and
  `#expiredPrescriptions`. **Do not merge this into `medications`.** This is
  the same dispense-*history* view already documented in
  `israeli-health-scrapers/CLAUDE.md` as "wrong model for standing
  prescriptions" (`Lobby` tab) — same drug reappears per purchase event. It
  answers "what did I buy and when", a different question from "what's
  currently active", so it's its own resource with its own operation pair.
- **hospitalDischarges** — `medicalfile/mailingsfromhospitals/`.
- **billing** — `directorship/debitsandcredits/`. Read-only ledger, no write
  side planned here.

## Phase 3 — messages (first write)

- `communicationWithDoctor/Lobby/` → `messages.list` (`<fund>:messages:read`).
- `communicationWithDoctor/NewRequest/` → `messages.send`
  (`<fund>:messages:write`). This is the first real write operation in this
  repo — build it to prove out `requireConfirmation` + preview/token
  end-to-end (the permission engine already supports this per
  `CLAUDE.md`, but nothing exercises it yet). Every later write op should
  copy this one's shape rather than inventing its own confirmation flow.
- `messages` is already a declared `FetchTarget` in
  `israeli-health-scrapers` (unimplemented) — this phase is what finally
  implements it.

## Phase 4 — booking and request writes

Only start once phase 3's write path (confirmation token, preview text,
audit log entry) is working end to end against a real account.

- `appointmentOrder/NewAppointment/` — book/reschedule/cancel an appointment.
- `requestsAndApprovals/RefundRequest/TopicSelect/` — new refund request.
- `requestsAndApprovals/ObligationRequest/Triage/` — new commitment
  (טופס 17) request. (Reading the status of existing requests already
  shipped early in Phase 1 as `form17`.)

Expect each of these to be its own multi-screen calibration project, like the
login SPA and the password-link screen were — topic pickers, doctor
selection, and other fund-specific validation are unlikely to generalize
across funds the way a list-of-records resource does. Don't design a shared
abstraction for these ahead of building the first one.
