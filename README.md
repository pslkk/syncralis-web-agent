# syncralis-web-agent 🌐

An MCP server that gives Claude (or any MCP client) a **real, isolated,
trust-checked browser**: search, read pages *and* official/social feeds,
click, and download files — with enterprise-grade safety controls in front
of every risky action.

See [`SECURITY.md`](./SECURITY.md) for the full threat model.

## ✨ What this does

- **API-based web search**: `web_search`/`research_query` use the Tavily and/or Brave
  Search APIs (with automatic failover, retry+backoff, circuit breaking, and rate
  limiting) instead of scraping a search engine's HTML through a browser — avoiding the
  "are you a bot" / CAPTCHA blocks that scraping-based search hits in production.
- Runs a real headless Chromium (Playwright) per task, isolated context per sub-agent
  for `open_page`, `click_on_page`, and downloads.
- **Trust-scores** every domain before acting (HTTPS, curated allowlist, gov/edu bonus,
  typosquat detection against brand names in your query, low-quality-domain flags) —
  auto-acts above your configured threshold, otherwise **stages the action and requires
  explicit user confirmation** before clicking or downloading.
- **SSRF-protected**: resolves and blocks any navigation to private/loopback/link-local
  addresses or cloud metadata endpoints, even via DNS rebinding.
- **robots.txt compliant** by default.
- **Rate-limited and circuit-broken** per domain — won't hammer a site or retry a
  failing one forever.
- **Verifies every download**: real file-signature check (not just the extension) for
  images, PDFs, and Office docs (docx/xlsx/pptx/doc/xls/ppt), blocks disguised
  executables (including double-extension tricks like `invoice.pdf.exe`), enforces a
  size cap, and returns a SHA-256 hash — with optional VirusTotal reputation lookup.
- **Reads official/social updates**: `fetch_updates` pulls from the open web (press
  releases, news) and, where you provide API credentials, official X and Instagram
  APIs — e.g. "what has the Ministry of External Affairs posted recently" fans out
  across web + X + Instagram in parallel.
- **Fully audited**: every navigation and trust decision is logged as structured JSON.
- **Fails fast on bad config**: the JSON config file is schema-validated at startup (wrong types and unknown keys are rejected).

## 🚫 What this deliberately does NOT do

- Does not guarantee any site is "100% genuine" — the scoring is a strong heuristic,
  not a legal/security guarantee.
- Does not bypass logins, CAPTCHAs, or platform anti-bot protections. For X/Instagram,
  without official API tokens it does a best-effort public web search and says so
  explicitly, rather than pretending to read a live feed it can't reliably access.
- Is not a sandboxed VM — see `SECURITY.md` for recommended container hardening.

## 🚀 Install

```bash

# Create and enter your new project folder
mkdir syncralis-web-agent
cd syncralis-web-agent

# Install the package locally (automatically downloads the Chromium binary)
npm install syncralis-web-agent

# Linux only (Ubuntu, WSL2, etc.): Chromium needs a few OS libraries. Install them with
# Playwright's own helper, run with the administrator rights your system requires:
#   npx playwright install-deps chromium


# OR via GitHub:
git clone https://github.com/pslkk/syncralis-web-agent.git

cd syncralis-web-agent
npm install        # also downloads a Chromium binary via Playwright

# Linux only (Ubuntu, WSL2, etc.): Chromium needs a few OS libraries. Install them with
# Playwright's own helper, run with the administrator rights your system requires:
#   npx playwright install-deps chromium

# Optional — defaults are secure without a config file. To set API keys or options:
mkdir -p ~/.syncralis-web-agent
cp config.example.json ~/.syncralis-web-agent/config.json   # short quick-start file
# or: cp config.full.example.json ~/.syncralis-web-agent/config.json   # all 35 keys
chmod 600 ~/.syncralis-web-agent/config.json
```

### 🔑 Configure web search

`web_search` (and `research_query`, which is built on it) needs at least one search
API key — get a free-tier key from either:

- [Tavily](https://tavily.com) → `TAVILY_API_KEY`
- [Brave Search API](https://brave.com/search/api) → `BRAVE_API_KEY`

Set one (or both, for automatic failover) in your config file (`~/.syncralis-web-agent/config.json`, or the path passed with `--config`). Without a key configured,
`web_search` fails fast with a clear error rather than falling back to unreliable
scraping. See `config.example.json` for the full list of search-related options (provider
selection, timeout, retries, safe-search level).

## 🛠️ Run tests (GitHub Clone installs only)

```bash
npm test
```

## 🔌 Add it as an MCP Server (Claude, Cursor, etc.)

```json
{
  "mcpServers": {
    "syncralis-web-agent": {
      "command": "node",
      "args": [
        "/absolute/path/to/syncralis-web-agent/bin/cli.js",
        "--config",
        "/absolute/path/to/config.json"
      ]
    }
  }
}
```

Set at least one of `TAVILY_API_KEY` / `BRAVE_API_KEY` in the config file
for `web_search`/`research_query` to work — see [Configure web search](#-configure-web-search) above.

🔄 Restart the client. Tools exposed: `web_search`, `open_page`, `research_query`,
`fetch_updates`, `click_on_page`, `download_file`, `confirm_action`, `reject_action`, `list_pending_actions`.

## ⚙️ Configuration

Settings are read from a JSON config file (`--config <path>`, default
`~/.syncralis-web-agent/config.json`); the server does **not** read environment
variables. All 35 keys are optional with secure defaults, and unknown keys are
rejected at startup. Booleans must be real JSON `true`/`false` (not `"true"`).
Two example files ship with the project:

- [`config.example.json`](./config.example.json) — short quick-start file.
- [`config.full.example.json`](./config.full.example.json) — every key, set to its default.

JSON has no comments, so every key is documented here. Leave a key out (or `""` for
optional text values) to use its default. Run `chmod 600` on the file once it holds API keys.

### Trust, limits and logging

| Key | Default | Purpose |
|---|---|---|
| `TRUST_THRESHOLD` | `80` | Min trust score (0-100) to auto-act (click/download) without asking. Lower = more autonomous, less safe. |
| `RESPECT_ROBOTS_TXT` | `true` | Enforce robots.txt (recommended). |
| `CONCURRENCY` | `4` | Max parallel sub-agents in `research_query` (1-16). |
| `RATE_LIMIT_PER_DOMAIN_PER_MIN` | `20` | Per-domain requests per minute before the agent backs off. |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | Consecutive failures before a domain is paused. |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `300000` | How long a paused domain stays paused (5 min). |
| `NAVIGATION_TIMEOUT_MS` | `20000` | Per-navigation timeout. |
| `EXTRA_ALLOWLIST` | `""` | Extra domains to always trust, comma-separated. |
| `HTTP_PROXY` | none | Outbound proxy for the browser, full URL e.g. `http://proxy.company.com:8080`. The system `HTTP_PROXY` variable is **not** used. |
| `AUDIT_LOG_PATH` | stderr only | Also write the JSON-Lines audit log to this file. |
| `REDACT_QUERIES_IN_LOGS` | `false` | Redact query text in logs (use if queries may hold sensitive info). |

### Downloads

| Key | Default | Purpose |
|---|---|---|
| `DOWNLOAD_DIR` | OS temp dir, `syncralis-web-agent-downloads` | Where verified downloads are saved. |
| `MAX_DOWNLOAD_BYTES` | `52428800` | Download size cap (50 MB). |
| `VIRUSTOTAL_API_KEY` | none | Enables an extra hash-reputation check on downloads. |

### Web search

`web_search` and `research_query` need at least one of the two keys below.

| Key | Default | Purpose |
|---|---|---|
| `WEB_SEARCH_PROVIDER` | `auto` | `tavily`, `brave`, or `auto` (use whichever key(s) are set, with failover). |
| `TAVILY_API_KEY` | none | Tavily key ([tavily.com](https://tavily.com), free tier). |
| `BRAVE_API_KEY` | none | Brave Search key ([brave.com/search/api](https://brave.com/search/api), free tier). |
| `WEB_SEARCH_TIMEOUT_MS` | `10000` | Per-request timeout for the search API call. |
| `WEB_SEARCH_MAX_RETRIES` | `2` | Retries (0-5) on 429/5xx/network/timeout, with backoff and jitter. |
| `WEB_SEARCH_SAFE_SEARCH` | `moderate` | `off`, `moderate` or `strict`. |

Do not put placeholder text in a key field: a non-empty value is treated as a real key and
the provider call will fail with an auth error. Use `""` or remove the key.

### Social and official updates (`fetch_updates`)

| Key | Default | Purpose |
|---|---|---|
| `X_BEARER_TOKEN` | none | X (Twitter) API v2 bearer token for reliable official-API reads. |
| `INSTAGRAM_GRAPH_TOKEN` | none | Instagram Graph API token (used with the account ID below). |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | none | Your connected Business/Creator account ID; enables Business Discovery reads of other public Business/Creator accounts. |

### Adaptive trust memory

When you explicitly confirm or reject a staged action, the decision is recorded locally per
domain. Enough repeated confirmations can raise a domain to the auto-approve threshold (never
past it, and never for a domain the scorer hard-flagged, e.g. a typosquat). One rejection
immediately blocks promotion for a cooldown period.

| Key | Default | Purpose |
|---|---|---|
| `TRUST_MEMORY_ENABLED` | `true` | Turn off for fully stateless, heuristic-only behavior. |
| `TRUST_MEMORY_PATH` | `~/.syncralis-web-agent/trust-memory.json` | Where the trust-memory store is saved. |
| `TRUST_MEMORY_MIN_CONFIRMATIONS` | `5` | Explicit confirmations needed before promotion (1-1000). |
| `TRUST_MEMORY_MAX_AGE_DAYS` | `90` | A promotion expires if the latest confirmation is older than this. Nothing is deleted. |
| `TRUST_MEMORY_REJECTION_COOLDOWN_DAYS` | `30` | Days promotion is blocked after a rejection, regardless of confirmations. |

### Web Bot Auth (optional, off by default)

Lets the agent sign its own outbound requests (RFC 9421, Ed25519) so supporting sites can
identify it as an honestly-declared agent. It proves this agent's own identity; it does not
verify the sites it visits. Signing only activates once `BOT_AUTH_AGENT_URL` is set, because an
unverifiable signature can look more suspicious than none.

| Key | Default | Purpose |
|---|---|---|
| `BOT_AUTH_AGENT_URL` | none | `https://` URL where you publish the directory JSON from `buildDirectoryDocument()` (see `src/security/webBotAuth.js`) at `<url>/.well-known/http-message-signatures-directory`. |
| `BOT_AUTH_KEY_DIR` | `~/.syncralis-web-agent/keys` | Where the agent's Ed25519 keypair is stored (created once, private key `0600`). |

### ⚠️ Danger switches (all `false` by default; leave them off)

| Key | Purpose when set to `true` |
|---|---|
| `ALLOW_PRIVATE_NETWORK_TARGETS` | Allow navigating to private/internal addresses. Only for testing against your own staging targets; disables SSRF protection. |
| `ALLOW_MACRO_OFFICE_DOWNLOADS` | Allow `.docm`/`.xlsm`/`.pptm`/`.xlsb`/`.dotm`/`.xltm`/`.potm`. These can run embedded VBA on open and are a common malware vector. |
| `ALLOW_UNVERIFIED_EXTENSIONS` | Allow downloads whose type has no file-signature check. Plain text formats (`.txt/.csv/.json/.xml/.md`) are always allowed. |
| `ALLOW_CLICK_ON_VISUALLY_HIDDEN_ELEMENTS` | Allow clicking elements a human cannot see (near-zero opacity, off-screen, clipped, or text matching its background). A real page has no legitimate reason to hide the element an agent is told to click. |
| `ALLOW_LEGACY_BROWSER_SEARCH_FALLBACK` | Fall back to scraping DuckDuckGo when no search API is reachable. Degraded, best-effort, weaker defenses; not a fix for a missing key. |

## 🌊 Example flows

**"Download the Ferrari top model 4K picture"**
1. `research_query` → ranked, trust-scored candidate pages.
2. `open_page` on the top candidate → finds the actual image/download link (also
   surfaced automatically as `downloadableLinks` on every `open_page` call).
3. `download_file` with `matchText: "Download"` or a direct image URL.
   - High-trust source (e.g. official site, major stock-photo site): downloads,
     verifies, returns local path + SHA-256 immediately.
   - Lower-trust source: returns a `confirmationId` and the specific trust reasons;
     Claude relays this to you, and only proceeds after you approve via `confirm_action`.

**"What has the Ministry of External Affairs posted recently?"**
1. `fetch_updates` with `entity: "Ministry of External Affairs India"`.
2. Runs `web` (press releases/news), `x`, and `instagram` sub-fetches in parallel.
3. Response tells you, per platform, whether it used a reliable official API or a
   best-effort web search — so you know exactly how much to trust each part.

## 🧩 Extending trust rules

Edit `src/trust.js` — add domains to `CURATED_ALLOWLIST`, or brand→official-domain
mappings to `BRAND_DOMAINS` for better typosquat detection on brands you care about.

## 🗑️ Uninstall

```bash
npm uninstall syncralis-web-agent

# For Playwright browsers
npx playwright uninstall --all
```

  ### 🧹 Final Cleanup (Both Environments):

  *For linux (Ubuntu, WSL2, etc.)*
  
  ```bash
  rm -ri ~/.cache/ms-playwright
  ```

  *For Windows  (PowerShell)*
  
  ```bash
  Remove-Item -Path "$env:USERPROFILE\AppData\Local\ms-playwright" -Recurse -Confirm
  ```
