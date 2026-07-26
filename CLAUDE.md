# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first MCP server for Israeli health fund (kupat holim) accounts. It sits on top
of [israeli-health-scrapers](https://github.com/YogevBokobza/israeli-health-scrapers)
the way [asher-mcp](https://github.com/shlomiuziel/asher-mcp) sits on top of
`israeli-bank-scrapers`: the library knows how to log into a fund and read its data; this
repo adds encrypted local storage, a scoped permission model, and the MCP agent protocol.
Nothing is sent anywhere — no server, no account, no telemetry.

**Status:** early. Maccabi medications work end to end (scraper calibrated against a live
account). Other funds are declared in the library but not implemented yet.

## Commands

```bash
npm run build              # tsc -p tsconfig.json → dist/
npm run typecheck          # tsc --noEmit
npm test                   # vitest run — no account or network needed
npm run test:watch
npm run cli -- <command>   # run the CLI from source, e.g. npm run cli -- status
npm run start:mcp          # run the MCP server from source (stdio transport)
npm run start:mcp:inspector # same, through the MCP inspector for manual poking
```

Run a single test file or case with vitest directly:

```bash
npx vitest run test/db/store.test.ts
npx vitest run -t "upserts rather than duplicating"
```

**Windows note:** `better-sqlite3-multiple-ciphers` ships prebuilt native binaries only
for Node LTS versions with published prebuilds — Node 24 commonly has none, causing an
`npm install` build failure. Use Node 22 if you hit this.

## Architecture

**The dependency chain is strict:** `israeli-health-scrapers` (the library) never knows
this repo exists. Everything here — storage, permissions, the MCP protocol, the CLI —
is a consumer of that library's `createScraper` / `SCRAPERS` / typed result shapes. When
a fund's scraping logic needs to change, that change belongs in the library repo, not
here; this repo only changes when what to *do* with fetched data changes.

**Operations are the single vocabulary an agent sees** (`src/operations.ts`). An
`Operation` bundles a name, a `Scope` (`fund:resource:capability`, e.g.
`maccabi:medications:read`), a Zod input schema, and a `run()`. Nothing about a fund or
a scraper leaks past this layer into the permission engine or the MCP server — the
engine reasons about scopes and capabilities, never about Maccabi or SQL. Each
data-collection has its own `list` (reads the local store, instant, no network) and
`refresh` (logs into the fund, writes the store) operation pair — kept separate rather
than one "sync everything" call, because different collections cost very differently
(fetching appointments means the scraper clicks into every appointment's *detail* page
for clinic/instructions, not just one list load) and a caller should be able to ask for
the cheap one without paying for the expensive one.

**`src/mcp/server.ts`** is a thin MCP transport shell: it lists tools via
`buildToolDescriptors` (`src/mcp/tools.ts`, which turns each visible `Operation` into an
MCP tool name/schema — unqualified while one fund is configured, fund-prefixed once more
than one is, so a prompt written against one fund keeps working when a second is added),
and on a call re-resolves the operation by name, runs `permissions.authorize()`, then
`operation.run()`. `auth_start`/`auth_complete` are hand-rolled outside the operation
list (login has to be discoverable regardless of policy — an agent that cannot see how
to re-authenticate has no way to recover from an expired session) and exist because MCP
tool calls can't block waiting for a member to read an SMS: `auth_start` calls the
library's `triggerTwoFactorAuth()` and keeps the scraper's browser alive in
`src/mcp/auth-challenges.ts` (TTL-bounded — an abandoned login doesn't leave a browser
running forever) until `auth_complete` redeems the code via
`getLongTermTwoFactorToken()`.

**Permissions enforce at two points, not one** (`src/permissions/engine.ts`):
*discovery* (`canDiscover` / `visibleOperations`, filters what a tool listing shows) and
*execution* (`authorize()`, re-checked on every call). Either alone is insufficient —
discovery-only filtering is a presentation detail a hand-written call walks straight
past; execution-only checking leaks the shape of everything that exists to anyone who
lists tools. A write matching a profile's `requireConfirmation` patterns doesn't run on
the first call: it returns a preview and a one-shot token bound to that *exact*
operation and input hash (`hashInput` in `src/permissions/audit.ts`), and only a second
call carrying that token executes — the binding is what stops a token issued for one
preview being redeemed against different input. `HEALTH_MCP_MODE=readonly` is a global
kill switch checked separately from the scope grants, so no policy file edit can
escalate past it. Every attempt — including refusals — is appended to `audit.jsonl`
with a hash of the input, never the input itself.

**The database is the only thing holding secrets** (`src/db/`). SQLCipher via
`better-sqlite3-multiple-ciphers`, keyed by `HEALTH_MCP_KEY` from the environment,
never written to disk (`src/db/database.ts`; a wrong key surfaces as a clear
`DatabaseKeyError` rather than SQLite's generic "not a database" message). Schema
(`src/db/schema.ts`) is intentionally flat — `sqlQuery` exposes these tables to an agent
directly, so column names are the contract, named for what a person would ask rather
than for scraper internals. Adding a table needs both a `CREATE TABLE IF NOT EXISTS` in
`STATEMENTS` *and*, for a column added to a table that may already exist on disk, an
explicit `addColumnIfMissing` migration — `IF NOT EXISTS` only helps a table that
doesn't exist yet, it does not add a column to one that does. `credentials` and
`schema_version` are hard-excluded from `sqlQuery` regardless of policy
(`FORBIDDEN_TABLES`) — the entire design is that an agent works from a stored session
and never handles a credential, so letting it `SELECT` credentials back would undo that
in one query. `src/db/query.ts`'s `assertSafeSelect` is the boundary between an agent's
free-text SQL and that database: single-statement, `SELECT`/`WITH`-only, string
literals and comments stripped before keyword matching (so a forbidden word hidden in
a quoted literal doesn't false-positive, and one hidden *outside* a literal can't hide
either), a hard row cap and time budget so an agent notices an accidental cross join
rather than hanging the server on it.

**Sync-run history is shared across resources, not resource-specific**
(`src/db/sync-runs.ts`): `startSyncRun`/`finishSyncRun`/`lastSyncRun` take a `resource`
argument and every fetch attempt — successful or not — gets a row, because "is this
data stale, or did the last three fetches fail?" can't be answered from the data table
alone. `src/sync/fetch.ts` shares one `runFetch` helper between resources; the only
things that differ per resource are which `FetchTarget` to ask the scraper for and
which `upsert*` function to hand the result to.

**Session/diagnostics environment variables are set once, at process entry**
(`src/cli/index.ts` and `src/mcp/server.ts` both do this): `IHS_DATA_DIR` points the
library's session store and diagnostics dumps inside this app's own data directory
(`scraperDataDir()`), and `IHS_SESSION_KEY` defaults to `HEALTH_MCP_KEY` so a member
manages one secret instead of two. Diagnostics dumps contain page HTML from a logged-in
medical account — they live under the app data directory and should be treated
accordingly, never uploaded anywhere.

**Where things live** (`src/config/paths.ts`): OS-conventional app data directory
(`~/Library/Application Support/HealthMCP`, `~/.local/share/HealthMCP`,
`%APPDATA%/HealthMCP`), overridable with `HEALTH_MCP_DATA_DIR`. Holds `database.db`,
`policy.json`, `audit.jsonl`, and `scraper/` (the library's sessions + diagnostics).

## Tests

`test/db/store.test.ts` opens a real (temp, disposable) encrypted database and exercises
credentials, medications, and sync-run storage together — including an explicit
assertion that the raw database file never contains a stored password or ID in
plaintext. `test/db/query.test.ts` covers `assertSafeSelect`'s adversarial cases
(literal-hidden keywords, multi-statement injection, forbidden tables). No test needs a
real fund account or network access.

## PII

Same rule as the library repo: never put real account data — real drug names, doctor
names, ID numbers, addresses, or dates from an actual logged-in session — into a test,
fixture, or committed file. Invent placeholder data with the same structural shape
instead. This repo is public.
