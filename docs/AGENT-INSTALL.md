# Agent runbook: install, upgrade, and uninstall health-mcp

You are an AI agent asked to install (or upgrade, or remove) the **health-mcp** server —
a local-first MCP server for Israeli health fund (kupat holim) accounts. This document
is your procedure. Follow it in order; do not improvise steps that touch secrets or
delete data.

What health-mcp is: a stdio MCP server that stores medical data in an **encrypted local
database** on the user's machine. Nothing is sent anywhere — no server, no account, no
telemetry. It is registered as an MCP server in the user's client (Claude Code, Codex,
Claude Desktop, or any MCP client).

Division of labor:

- **You (the agent) do:** cloning, building, key generation, client registration,
  verification, upgrades, unregistration.
- **The human does:** choosing the fund and auth method, supplying their ID number and
  password, reading the SMS code, approving data deletion. Never attempt to do these
  yourself or work around a user who is unavailable.

## Standing rule: ask the user bilingually, Hebrew first

Whenever you address the user, show Hebrew first, then the English equivalent. Never
English only. Ready-made wording for every required interaction is in
[User-facing wording](#user-facing-wording) — use it verbatim.

Commands, paths, code, and this runbook stay in English.

## Step 1 — Preflight

1. Check Node:
   ```bash
   node --version
   ```
   Requires Node **20 or 22 LTS**. If the major version is 24 (or newer) and the
   platform is Windows, `npm install` will likely fail building
   `better-sqlite3-multiple-ciphers` (no prebuilt binaries). Ask the user to switch to
   Node 22 (nvm/fnm/volta) before continuing. Node ≥ 24 on macOS/Linux usually builds
   fine, but 20/22 LTS is the supported path everywhere.
2. Check git: `git --version`.

## Step 2 — Install the latest release (never master)

The `master` branch is development state. Install a tagged release.

1. Resolve the latest release tag:
   ```bash
   curl -s https://api.github.com/repos/YogevBokobza/health-mcp/releases/latest | grep '"tag_name"'
   ```
   (e.g. `"tag_name": "v0.1.0"`). If the API is unavailable, fall back to
   `git ls-remote --tags https://github.com/YogevBokobza/health-mcp` and pick the
   highest semver tag.
2. Clone that tag, shallow, into a stable location — `~/mcp/health-mcp` (on Windows,
   `%USERPROFILE%\mcp\health-mcp`, which in Git Bash is `~/mcp/health-mcp` too):
   ```bash
   mkdir -p ~/mcp
   git clone --depth 1 --branch <tag> https://github.com/YogevBokobza/health-mcp ~/mcp/health-mcp
   ```
3. Build:
   ```bash
   cd ~/mcp/health-mcp
   npm install
   npm run build
   ```
   Assert `dist/mcp/server.js` exists afterwards. If it does not, `npm run build` failed —
   show the user the error, do not continue.

## Step 3 — Generate the database key

The database is SQLCipher-encrypted; `HEALTH_MCP_KEY` is the key. It is never written to
disk by health-mcp itself — it lives in the environment of each registered server
entry, which you are about to create.

Generate it with node (works everywhere, unlike `openssl` in PowerShell):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Rules:

- If the user already has a key (a previous install — check the client config, or an
  existing database in the app data directory), **reuse it**. A new key would make the
  existing database unreadable.
- Show the key to the user exactly once, with the "save this" wording from
  [User-facing wording](#user-facing-wording).

## Step 4 — Register with the client(s)

Ask which client(s) to register with (bilingual question). Use the absolute path to
`dist/mcp/server.js` with **forward slashes** on every platform — it goes into config
files where backslashes are escape characters. Below, `<install>` means that path's
directory (e.g. `C:/Users/name/mcp/health-mcp` or `/home/name/mcp/health-mcp`).

Register with `HEALTH_MCP_MODE=readonly` by default — a global kill switch that blocks
every write no matter what the policy file says. The user can relax it later.

### Claude Code

```bash
claude mcp add -s user health-mcp \
  -e HEALTH_MCP_KEY=<key> \
  -e HEALTH_MCP_MODE=readonly \
  -- node <install>/dist/mcp/server.js
```

`-s user` makes it available in all projects. Verify: `claude mcp list` shows
`health-mcp`.

### Codex

```bash
codex mcp add health-mcp \
  --env HEALTH_MCP_KEY=<key> \
  --env HEALTH_MCP_MODE=readonly \
  -- node <install>/dist/mcp/server.js
```

Verify: `codex mcp list`. Equivalent `~/.codex/config.toml` block, if editing by hand:

```toml
[mcp_servers.health-mcp]
command = "node"
args = ["<install>/dist/mcp/server.js"]

[mcp_servers.health-mcp.env]
HEALTH_MCP_KEY = "<key>"
HEALTH_MCP_MODE = "readonly"
```

### Claude Desktop

```bash
node <install>/dist/cli/index.js configure-claude
```

This merges a `health-mcp` entry into Claude Desktop's config, preserving other
servers. It deliberately writes `HEALTH_MCP_KEY` **blank** (it will not put the key in
a plaintext file itself). You then fill it in manually — this is the one client where
writing the key into the config is the documented path:

1. Open the config: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`,
   Windows `%APPDATA%\Claude\claude_desktop_config.json`, Linux
   `~/.config/Claude/claude_desktop_config.json`.
2. Set `"HEALTH_MCP_KEY": "<key>"` inside the `health-mcp` entry.
3. The user must restart Claude Desktop afterwards.

### Any other MCP client

Generic stdio registration:

```json
{
  "mcpServers": {
    "health-mcp": {
      "command": "node",
      "args": ["<install>/dist/mcp/server.js"],
      "env": {
        "HEALTH_MCP_KEY": "<key>",
        "HEALTH_MCP_MODE": "readonly"
      }
    }
  }
}
```

## Step 5 — Verify (no account needed)

From the install directory, run this handshake smoke test. It spawns the server over
stdio with a **throwaway data directory** — important: the server creates its encrypted
database on first use with whatever key it gets, and you must never create the real one
with a test key.

```bash
cd ~/mcp/health-mcp
cat > /tmp/health-mcp-smoke.cjs <<'EOF'
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-mcp-smoke-'));
const child = spawn(process.execPath, ['dist/mcp/server.js'], {
  env: { ...process.env, HEALTH_MCP_KEY: 'smoke-test-key', HEALTH_MCP_DATA_DIR: dir, HEALTH_MCP_MODE: 'readonly' },
});
let pending = '';
const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
child.stdout.on('data', (chunk) => {
  pending += chunk;
  let idx;
  while ((idx = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (msg.id === 2) {
      const names = msg.result.tools.map((t) => t.name);
      console.log('tools: ' + names.join(', '));
      const ok = names.includes('auth_start') && names.includes('auth_complete');
      console.log(ok ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED: auth tools missing');
      child.kill();
      process.exit(ok ? 0 : 1);
    }
  }
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.0' } } });
setTimeout(() => { console.error('SMOKE TEST FAILED: no response in 20s'); child.kill(); process.exit(1); }, 20000);
EOF
node /tmp/health-mcp-smoke.cjs && rm /tmp/health-mcp-smoke.cjs
```

Expected: a tool list containing `auth_start` and `auth_complete` (data tools appear
only after a fund is configured), then `SMOKE TEST PASSED`. Then check the client sees
it (`claude mcp list` / `codex mcp list` / restart Claude Desktop).

If the smoke test fails with a module or native-binary error, the Node version is wrong
— see Step 1.

## Step 6 — Hand over to the user (STOP: human steps)

The server is installed, but it has no fund account yet. You cannot complete setup
alone — credentials and SMS codes belong to the human. Walk through this with them:

1. **Which fund** — ask with the fund question from the wording section. Note honestly:
   today only **Maccabi** is implemented end to end; other funds are declared but not
   working yet.
2. **Auth method — password or SMS** — ask with the auth-method question and explain
   the trade-off in the wording. Both are supported for every fund.
3. **Collect the ID number** (and password, if they chose password auth).
4. **Store credentials.** Write a temporary JSON file containing exactly what they gave
   you (password field omitted for SMS auth):
   ```json
   [{ "companyId": "maccabi", "id": "<id-number>", "password": "<password>" }]
   ```
   ```bash
   HEALTH_MCP_KEY=<key> node <install>/dist/cli/index.js ingest-creds -f /tmp/creds.json
   rm /tmp/creds.json   # immediately — it is plaintext
   ```
   Pass `HEALTH_MCP_KEY` in the environment of every CLI call; the CLI never reads the
   client's config.
5. **First login.**
   - **Password auth:** usually nothing more is needed — the first refresh will use the
     stored password. Optionally verify now with a refresh (Step 7).
   - **SMS auth:** from the MCP client, call `auth_start` with
     `{"companyId": "maccabi"}`. It returns a `challengeId` and tells you an SMS was
     sent. Ask the user for the code (wording section), then call `auth_complete` with
     `{"challengeId": "...", "code": "..."}`. A long-term token is stored encrypted, so
     later refreshes need no SMS until the session expires.
     **This requires the MCP server to stay one long-lived process for the whole
     `auth_start` → `auth_complete` round trip** — the open browser tied to the
     challenge cannot survive a restart. Most clients guarantee this; if `auth_complete`
     reports the server process restarted mid-login, that is a distinct message from a
     real timeout — call `auth_start` again rather than retrying the same code (each
     `auth_start` also sends a real SMS, so don't loop on retries automatically).
6. **First refresh** (optional but a good end-to-end check): call `medications_refresh`
   from the client, or
   `HEALTH_MCP_KEY=<key> node <install>/dist/cli/index.js fetch`.

## Step 7 — Report back

Tell the user (bilingually for the summary lines is a nice touch, English acceptable
for the technical block):

- installed version (tag), install path
- client(s) registered and how to verify
- where the key lives (which client config) + reminder to save it in a password manager
- data directory (OS app data dir; `%APPDATA%/HealthMCP` on Windows,
  `~/Library/Application Support/HealthMCP` on macOS, `~/.local/share/HealthMCP` on
  Linux — overridable with `HEALTH_MCP_DATA_DIR`)
- that `HEALTH_MCP_MODE=readonly` is on and what it means
- what is configured (fund, auth method) and what remains (e.g. first login not done)

## When logins expire (read this now, act on it later)

Every failed refresh returns a `status` field with a `next` instruction for you:

- `status: "session_expired"` — the stored session/token stopped working. Tell the user
  (wording section), then re-authenticate: `auth_start` → get the code from the user →
  `auth_complete`. For password-auth funds, the equivalent is the user re-confirming
  the password; retry the refresh after re-auth.
- `status: "credentials_rejected"` — the fund refused the stored credentials. The `next`
  field says which case it is (wrong password / password change required / account
  blocked). Ask the user accordingly (wording section), then update credentials the
  same supervised way as Step 6.4: temp JSON → `ingest-creds -f` → delete the file.
  Credentials only ever enter through the CLI, never through an MCP tool.
- `status: "fetch_failed"` — operational failure (timeout, site changed). Check
  `errorMessage`, retry once, then report. Do not ask the user to re-authenticate for
  these.

## Upgrade

When the user asks to upgrade health-mcp:

1. Installed version: `HEALTH_MCP_KEY=x node <install>/dist/cli/index.js status | head -1`
   (or `git -C <install> describe --tags`).
2. Latest release: the Step 2 query. Compare (strip the leading `v`).
3. If identical, say so and stop. If newer, confirm with the user (wording section).
4. Upgrade in place — data, key, policy, and sessions live in the OS app data
   directory, not the repo, so they survive untouched:
   ```bash
   cd ~/mcp/health-mcp
   git fetch origin tag <new-tag> --depth 1
   git checkout tags/<new-tag>
   npm install
   npm run build
   ```
5. Re-run the Step 5 smoke test (with its throwaway data dir).
6. Tell the user to restart their MCP client(s); client configs need no changes.

## Uninstall

When the user asks to remove health-mcp, first ask **what** to remove (wording
section): registration only, registration + data, and whether to delete the clone.
Default to registration only. Perform data deletion only after the explicit second
confirmation — it permanently deletes fetched medical data.

1. **Deregister from every client it was registered with:**
   ```bash
   claude mcp remove health-mcp        # Claude Code (add -s user if it was user-scoped)
   codex mcp remove health-mcp         # Codex
   ```
   Claude Desktop: read `claude_desktop_config.json`, delete only the `health-mcp` key
   under `mcpServers`, write the file back, restart Claude Desktop.
2. **Delete local data** (only if the user confirmed):
   - Default location: `%APPDATA%/HealthMCP` (Windows), `~/Library/Application
     Support/HealthMCP` (macOS), `~/.local/share/HealthMCP` (Linux) — or
     `$HEALTH_MCP_DATA_DIR` if set. It contains `database.db` (encrypted medical data),
     `policy.json`, `audit.jsonl`, and `scraper/` (login sessions + diagnostics).
     Delete the whole directory.
3. **Delete the clone** (only if the user asked): `rm -rf ~/mcp/health-mcp`.
4. Report what was removed and what was deliberately kept. Remind the user that if they
   kept the data, the same `HEALTH_MCP_KEY` is required to ever read it again.

## User-facing wording (Hebrew first, English below)

Use these verbatim, filling in `<placeholders>`.

**Fund choice**

> באיזו קופת חולים אתה מבוטח? (כרגע רק מכבי נתמכת)
> Which health fund are you a member of? (currently only Maccabi is supported)

**Auth method**

> איך תרצה להתחבר לקופה?
> 1. סיסמה — רענון הנתונים יעבוד לבד, בלי מעורבות שלך. הסיסמה נשמרת מוצפנת במחשב שלך בלבד.
> 2. קוד SMS — מזינים קוד חד-פעמי פעם אחת, והמערכת שומרת אסימון כניסה כדי שרענונים עתידיים לא יצטרכו קוד.
>
> How would you like to authenticate to the fund?
> 1. Password — data refreshes run unattended. The password is stored encrypted on your machine only.
> 2. SMS code — you enter a one-time code once; a login token is stored so future refreshes need no code.

**ID number**

> מה מספר תעודת הזהות שאיתה נכנסים לאתר הקופה?
> What is the ID number you use to sign in to the fund's website?

**Password (password auth only)**

> מה הסיסמה לאתר הקופה? היא תישמר מוצפנת במחשב שלך ולא תישלח לשום מקום.
> What is the password for the fund's website? It will be stored encrypted on your machine and never sent anywhere.

**SMS code**

> נשלח אליך קוד ב-SMS. מה הקוד?
> A code was just sent to your phone by SMS. What is the code?

**Save the key** (show the key once)

> שמור את המפתח הזה במנהל סיסמאות — בלעדיו אין גישה למסד הנתונים: `<key>`
> Save this key in a password manager — without it the database cannot be opened: `<key>`

**Session expired**

> החיבור לקופה פג (התנתקת ממקום אחר או שתוקף האסימון הסתיים). אשלח אליך קוד חדש — הזן אותו כשיגיע.
> The connection to the fund has expired (you signed in elsewhere, or the token ran out). I'll send a new code — enter it when it arrives.

**Credentials rejected — wrong password**

> הקופה דחתה את הסיסמה השמורה. מה הסיסמה הנוכחית?
> The fund rejected the stored password. What is the current password?

**Credentials rejected — password change required**

> הקופה דורשת להחליף סיסמה. החלף אותה באתר הקופה, ואז תן לי את הסיסמה החדשה.
> The fund requires a password change. Change it on the fund's website first, then give me the new password.

**Credentials rejected — account blocked**

> החשבון נחסם בקופה. יש לשחרר אותו מול הקופה (אתר או אפליקציה), ואז נתחבר מחדש.
> The account is blocked at the fund. Unblock it with the fund (website or app), then we'll reconnect.

**Upgrade offer**

> יש גרסה חדשה של health-mcp (מותקנת `<installed>`, זמינה `<latest>`). לשדרג? הנתונים וההגדרות נשמרים.
> A new health-mcp version is available (installed `<installed>`, latest `<latest>`). Upgrade? Your data and settings are kept.

**Uninstall scope**

> מה להסיר?
> 1. רישום בלבד — הנתונים נשמרים להתקנה עתידית.
> 2. רישום + נתונים — מחיקה סופית של מסד הנתונים הרפואי, היסטוריית הסנכרונים ואסימוני הכניסה.
> 3. גם את תיקיית הקוד עצמה.
>
> What should I remove?
> 1. Registration only — data is kept for a future reinstall.
> 2. Registration + data — permanently deletes the medical database, sync history, and login tokens.
> 3. Also the cloned code directory.

**Data deletion final confirmation**

> אישור סופי: למחוק את כל הנתונים הרפואיים המקומיים? אין דרך חזרה.
> Final confirmation: delete all local medical data? This cannot be undone.

## Safety rules

- Never paste medical data, credentials, the ID number, or the database key into any
  external service, issue tracker, or commit. The temp credentials file must be deleted
  immediately after `ingest-creds`.
- Never run the server or CLI without `HEALTH_MCP_KEY` set to the user's real key
  (smoke tests use a throwaway data dir precisely to avoid this).
- Never clone or checkout `master` for installs — releases only.
- The `credentials` table is deliberately unreadable through the MCP tools; do not try
  to read credentials back through `db_sqlQuery`.
