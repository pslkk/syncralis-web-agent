# Deploying on Render (HTTP/SSE)

`npm start` runs the **stdio** server for local clients (Claude Desktop, Cursor). It has no HTTP
listener, so on a web host it starts, sees stdin close, and exits. For hosting use `bin/http.js`
(`npm run start:http`), which this repo's `Dockerfile` already runs.

## 1. Generate a lockfile (once, locally)

```bash
npm install --package-lock-only --ignore-scripts && git add package-lock.json
```

`--ignore-scripts` matters: without it npm runs this package's `postinstall` (`playwright install chromium`) before
any dependency exists and fails with `playwright: not found`. A normal `npm install` also creates the lockfile.
The Dockerfile uses `npm ci` when a lockfile exists, so builds are reproducible.

## 2. Create the service (Free or paid)

Create a **Docker** Web Service (or use a Blueprint). The same image runs on every plan.

| | Free | Paid |
|---|---|---|
| Blueprint | `render.yaml` | `render.paid.yaml` |
| Persistent disk | not available | 1 GB at `/var/data` |
| Audit file, trust memory, keys, downloads | reset on restart/redeploy | kept |
| Spin-down | after 15 min idle; the next request waits for a cold start | never |
| RAM | 512 MB: one browser at a time, may still be killed on heavy pages | 2 GB+ recommended |

Notes for the Free plan:
- The container detects that no disk is mounted and logs a notice; nothing needs to be changed.
- Request logs and audit events still go to stdout, so Render's log stream keeps them.
- Pending confirmations and sessions are in memory, so they reset on every spin-down; clients must
  reconnect. A client with a short timeout may fail its first request after a cold start. Retry it.
- Trust memory resets, which only means fewer domains are auto-approved (the safe direction).
- Web Bot Auth keys are regenerated on every restart. If you publish a key directory to a third party,
  use a paid plan with a disk.
- Health check path: `/health`. Run **exactly one instance**.

## 3. Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MCP_AUTH_TOKENS` | yes | `name:token[,name2:token2]`. Tokens: 32-256 chars `[A-Za-z0-9._~+/=-]`. Generate with `openssl rand -base64 36`. Several tokens may be live at once, which makes rotation zero-downtime: add the new one, switch clients, remove the old one. |
| `ALLOWED_HOSTS` | no | Comma-separated Host allow-list. Defaults to Render's `RENDER_EXTERNAL_HOSTNAME`. Set it if you use a custom domain. |
| `ALLOWED_ORIGINS` | no | Browser origins allowed to call the server. Empty (default) rejects any request carrying an `Origin` header. |
| `TRUST_PROXY_HOPS` | no | Reverse proxies in front of the app (default `1`). Only used to attribute failed logins to an IP. After deploying, check the `ip` field in the request logs: if every request shows the same proxy address instead of real client IPs, raise this to `2`. Valid tokens are never throttled by IP. |
| `MAX_SESSIONS`, `MAX_SESSIONS_PER_CLIENT` (when exceeded, that client's oldest session is closed), `SESSION_IDLE_MINUTES`, `RATE_LIMIT_PER_MINUTE` | no | Defaults 50, 10, 30, 120. |

Optional `HOST` (default `0.0.0.0` in Docker or when `PORT`/`RENDER` is set, otherwise `127.0.0.1`).

Search API keys and agent policy live in the agent's JSON config, not in env vars. Create a Render
**Secret File** named `config.json` (it appears at `/etc/secrets/config.json` and is picked up
automatically); start from `config.render.example.json`. Without a secret file the container writes a
safe default config that keeps all state on `/var/data`.

## 4. Connect a client

- Streamable HTTP (preferred): `https://<service>.onrender.com/mcp`
- Legacy SSE: `https://<service>.onrender.com/sse`
- Header: `Authorization: Bearer <token>`

Example (Claude Code): `claude mcp add --transport http syncralis https://<service>.onrender.com/mcp --header "Authorization: Bearer <token>"`

Note: a client must be able to send a custom bearer header. Check that your client supports this.

## 5. Downloads

`download_file` returns a `downloadId`. Retrieve it with the `fetch_download` tool (up to
`MAX_INLINE_DOWNLOAD_BYTES`, 5 MB by default) or `GET /downloads/<id>` with the same bearer token. Files
are deleted after `DOWNLOAD_TTL_MINUTES` (60 by default).

## 6. Operations

- Logs: every request and every audit event is a JSON line on stdout/stderr (visible in Render logs);
  the audit log is also written to `/var/data/audit.log` and rotated at 10 MB when `AUDIT_LOG_MAX_BYTES` is set (the generated default config sets it; one `.1` generation is kept).
  Authorization headers and tokens are never logged.
- Shutdown: SIGTERM drains sessions, closes Chromium, exits within ~20 s.
- Rotate a token: add the new `name2:token2`, redeploy, move clients, then remove the old entry.

## Known limitations

- Single instance only. Scaling out needs shared session and confirmation storage (not implemented).
- `open_page` / `web_search` trust scores shown to a remote client don't include that client's trust memory
  (display only). Auto-approval decisions for `click_on_page` and `download_file` do use it.
- Tool timeouts stop waiting for a slow call but cannot cancel it; the browser slot is held until the
  underlying Playwright operation finishes (bounded by its own 20 s timeouts).
