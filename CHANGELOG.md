# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-08-23

### Added
- Added `is_standing` to stored medications (schema v8, `addColumnIfMissing`
  migration), flagging whether a prescription is a standing one (תרופה קבועה) or a
  one-off, sourced from israeli-health-scrapers v0.3.0.

### Changed
- `medications.list` and `medications.refresh` now return **every** valid
  prescription instead of only standing ones — the one-off prescriptions the
  scraper previously discarded are now included, each row marked via
  `is_standing`. Filtering to standing prescriptions becomes the caller's
  choice. (#22, #23)
- The `medications` CLI command marks each printed prescription קבועה /
  חד-פעמית now that both appear.

## [0.2.1] - 2026-08-23

### Fixed
- Fixed OTP login challenges being indistinguishable from a real timeout when
  `auth_complete` lands on an MCP server process other than the one `auth_start` ran
  on (schema v7, `otp_challenges` table). The live `Scraper`/browser still cannot
  survive a process restart — that login still has to be redone — but the failure now
  reports distinctly as "server restarted mid-login" instead of a generic "unknown or
  expired", and `docs/AGENT-INSTALL.md` now calls out the one-long-lived-process
  assumption. (#19)

## [0.2.0] - 2026-08-23

### Added
- Added Form 17 (טופס התחייבות) commitment requests: `form17.list` and `form17.refresh`
  operations, a `form17` CLI command, and a `form17_requests` table (schema v6) storing
  each request's status, dates, provider, appointment, and documents.
- Added fetch-failure classification: failed refreshes and the `lastSync` field of every
  list operation now report a coarse `status` (`session_expired`, `credentials_rejected`,
  or `fetch_failed`) plus a `next` field telling an agent exactly how to recover
  (e.g. re-authenticate via `auth_start` + `auth_complete`).

### Fixed
- Fixed Maccabi SMS authentication stalling on the "how do you want to verify" screen
  with "The login did not resolve to a known outcome" (israeli-health-scrapers v0.2.1).

[0.3.0]: https://github.com/YogevBokobza/health-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/YogevBokobza/health-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/YogevBokobza/health-mcp/compare/v0.1.0...v0.2.0
