# Changelog

All notable changes to this project will be documented in this file.

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

[0.2.0]: https://github.com/YogevBokobza/health-mcp/compare/v0.1.0...v0.2.0
