# health-mcp

Local-first MCP server for Israeli health fund (kupat holim) accounts. Your medical data
is fetched to an encrypted database on your own machine and served to an AI agent
through a small, named set of tools.

Sits on top of [israeli-health-scrapers](https://github.com/YogevBokobza/israeli-health-scrapers)
the way [asher-mcp](https://github.com/shlomiuziel/asher-mcp) sits on top of
`israeli-bank-scrapers`: the library knows how to read a fund, this adds storage,
permissions, and the agent protocol.

Nothing is sent anywhere. There is no server, no account, no telemetry.

**Status:** early. Maccabi medications, appointments, and test results work end to end
against the local store. Vaccinations storage and access are implemented, but live calibration
and the remote scraper dependency lock are still pending. Other funds are declared in the
library but not implemented yet.

## Why not just give the agent a browser

Because then "what can it do with my medical account" is something you find out
afterwards, from a log. Here it is a decision you make once, in a policy file: which
funds, which data, read or write. An agent is never shown a tool it may not call, and a
hand-written call to one is refused anyway.

## Install

```bash
git clone https://github.com/YogevBokobza/health-mcp
cd health-mcp
npm install
npm run build
npm install -g .        # optional: puts `health-mcp` on your PATH
```

## Set up

**1. Make a database key.** It encrypts everything and is never written to disk — you
supply it per run.

```bash
export HEALTH_MCP_KEY="$(openssl rand -base64 32)"
```

Put it in your shell profile or a password manager. Lose it and the database is
unreadable; that is the point.

**2. Store your credentials.**

```json
[
  { "companyId": "maccabi", "id": "123456789", "password": "optional" }
]
```

```bash
health-mcp ingest-creds -f credentials.json
rm credentials.json        # it holds the same secrets in plain text
```

They go into the encrypted database, so there is one secret to protect rather than a key
plus a file someone forgets to delete.

**3. Log in once**, so an SMS is not needed on every fetch.

```bash
health-mcp login maccabi
```

This opens a real browser window and asks for your SMS code in the terminal. The session
is stored encrypted and reused. Headed on purpose: a first login is exactly when a
CAPTCHA or a consent screen shows up, and those need a human looking at the page.

**4. Fetch.**

```bash
health-mcp fetch
health-mcp medications
health-mcp fetch-test-results maccabi
health-mcp test-results maccabi
health-mcp fetch-vaccinations maccabi
health-mcp vaccinations maccabi
```

## Connect to Claude

```bash
health-mcp configure-claude
```

This merges an entry into Claude Desktop's config, leaving your other MCP servers alone.
It deliberately writes `HEALTH_MCP_KEY` **blank** — putting the key that protects the
database into a plaintext file beside it would defeat encrypting it. Fill it in yourself
and restart Claude.

Manual equivalent:

```json
{
  "mcpServers": {
    "health-mcp": {
      "command": "node",
      "args": ["/path/to/health-mcp/dist/mcp/server.js"],
      "env": {
        "HEALTH_MCP_KEY": "your-key",
        "HEALTH_MCP_MODE": "readonly"
      }
    }
  }
}
```

Inspect it locally first with `npm run start:mcp:inspector`.

## Tools

| Tool | What it does | Scope |
| --- | --- | --- |
| `auth_start` / `auth_complete` | Log in; SMS code arrives between the two calls | always available |
| `medications_list` | Prescriptions from the local store, with `lastSync` | `<fund>:medications:read` |
| `medications_refresh` | Log into the fund and refresh the local store | `<fund>:medications:read` |
| `appointments_list` | Upcoming appointments from the local store, with `lastSync` | `<fund>:appointments:read` |
| `appointments_refresh` | Log into the fund and refresh appointments (clinic address + pre-visit instructions included) | `<fund>:appointments:read` |
| `testResults_list` | Test results from the local store, with `lastSync` | `<fund>:testResults:read` |
| `testResults_refresh` | Log into the fund and refresh test results | `<fund>:testResults:read` |
| `vaccinations_list` | Vaccination history from the local store, with `lastSync` | `<fund>:vaccinations:read` |
| `vaccinations_refresh` | Log into the fund and refresh vaccinations | `<fund>:vaccinations:read` |
| `db_listTables` | Readable tables and row counts | `local:database:read` |
| `db_describeTable` | Columns, types, keys | `local:database:read` |
| `db_sqlQuery` | A single read-only SELECT | `local:database:read` |

`medications_list`/`appointments_list`/`testResults_list`/`vaccinations_list` return `lastSync` alongside the
data rather than hiding it behind another tool: a list is misleading without knowing how
old it is. `lastSync.at` is the most recent attempt's completion time (or start time if it
is still running), `success` says whether that attempt succeeded, and `errorType` records
why the attempt failed when available. Listing is local-only; use the matching `refresh`
operation to fetch newer results.

`appointments_refresh` is a separate operation rather than folded into
`medications_refresh` or a generic "fetch everything": appointments costs meaningfully
more, since the scraper clicks into every appointment's own detail page for its clinic
address and pre-visit instructions — a caller asking for medications shouldn't pay for
that.

The auth tools are always listed regardless of policy — logging in is the precondition
for everything else, and an agent that cannot see how to re-authenticate has no way to
recover from an expired session except by failing repeatedly.

With more than one fund configured, tool names gain a prefix
(`maccabi_medications_list`). The input schema is unchanged, so a prompt written against
one fund keeps working.

## Permissions

Scopes are `fund:resource:capability`. Operations that touch no fund use the reserved
`local` segment. Wildcards apply to whole segments only (`*:*:write`), never partial ones.

`policy.json`, in the app data directory:

```jsonc
{
  "defaultProfile": "reader",
  "profiles": {
    "reader": {
      "scopes": ["*:medications:read", "local:database:read"]
    },
    "assistant": {
      "scopes": ["maccabi:medications:read", "maccabi:messages:write"],
      "requireConfirmation": ["*:*:write"],
      "rateLimits": { "*:*:write": { "perHour": 5 } }
    }
  }
}
```

Enforcement happens at two points:

1. **Discovery** — an agent is never shown a tool it may not call, so it cannot report a
   capability you did not grant.
2. **Execution** — re-checked on every call. The tool list an agent holds is not
   evidence of anything.

Both matter. Filtering alone is presentation a hand-written call walks straight past;
checking alone leaks the shape of everything that exists.

**Write confirmation.** A write matching `requireConfirmation` does not execute on the
first call. It returns a human-readable preview and a one-shot token; only a second call
carrying that token runs. The token is bound to the exact operation *and* input it was
issued for — otherwise you could approve a preview of one message and have the token
redeemed against another.

**Kill switch.** `HEALTH_MCP_MODE=readonly` blocks every write regardless of the policy
file, and no policy edit can escalate past it.

**Audit.** Every attempt, refusals included, is appended to `audit.jsonl` with a hash of
the input — no names, no message bodies, no medical content.

## Security

- **Encrypted at rest.** SQLCipher via `better-sqlite3-multiple-ciphers`. A test asserts
  that credentials do not appear in the raw file.
- **Key never persisted.** Supplied per run through `HEALTH_MCP_KEY`.
- **`chmod 600`** on the database and its WAL sidecars.
- **Credentials are unreadable by the agent.** The `credentials` table is rejected by
  `db_sqlQuery`, as are `sqlite_master`, multiple statements, and every mutating
  keyword. The whole design is that an agent works from a stored session and never
  handles a credential; letting it `SELECT` them back would undo that.
- **Queries are bounded** by a row cap and a time budget — an agent writes an accidental
  cross join far more easily than it notices one.

You are responsible for your own key and your own machine.

## Where things live

| | |
| --- | --- |
| macOS | `~/Library/Application Support/HealthMCP` |
| Linux | `~/.local/share/HealthMCP` |
| Windows | `%APPDATA%/HealthMCP` |

Holds `database.db`, `policy.json`, `audit.jsonl`, and `scraper/` (login sessions and
diagnostics dumps). Override with `HEALTH_MCP_DATA_DIR`. Diagnostics dumps contain page
HTML from a logged-in medical account — treat that directory accordingly.

## CLI

```bash
health-mcp ingest-creds -f credentials.json
health-mcp list-creds
health-mcp remove-creds maccabi
health-mcp login maccabi [--headless]
health-mcp fetch [fund...]
health-mcp medications [fund]
health-mcp fetch-test-results [fund]
health-mcp test-results [fund]
health-mcp fetch-vaccinations [fund]
health-mcp vaccinations [fund]
health-mcp status
health-mcp configure-claude
```

`fetch-test-results [fund]` fetches and stores test results for one fund (defaulting to
Maccabi), while `test-results [fund]` prints the locally stored results newest first. The
MCP `testResults_list`/`testResults_refresh` tools provide the same local-list/remote-refresh
split for agents. `fetch-vaccinations [fund]` and `vaccinations [fund]` provide equivalent
vaccination refresh/list access, with `vaccinations_list`/`vaccinations_refresh` available
to agents. Appointments currently has no CLI path; use the
`appointments_list`/`appointments_refresh` MCP tools.

## Tests

```bash
npm test
npm run typecheck
```

Covers the SQL safety gate, the permission engine, and the encrypted store — including
that the database file holds no plaintext. No account or network needed.

## Scope and limits

- For **your own account**, with your own credentials. Not a multi-tenant service.
- Subject to your fund's terms of use.
- It reports what the fund shows. It does not interpret anything medically, and neither
  should an agent built on it.

## Roadmap

Appointments are read-only so far (list/refresh); search and booking are still open.
Messages to a doctor, commitment forms (טופס 17), background monitoring for expiring
prescriptions, and the remaining funds — each arriving as a scraper in the library and
an operation here. Full ordered plan, resource by resource: [docs/roadmap.md](docs/roadmap.md).

## License

MIT
