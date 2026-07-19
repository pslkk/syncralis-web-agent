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
- Runs a real headless Chromium (Playwright) per task, isolated context per sub-agent.
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
- **Fails fast on bad config**: environment variables are schema-validated at startup.

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

# 🐧 Linux only (Ubuntu, WSL2, etc.) Securely install required OS graphics libraries
sudo npx playwright install-deps chromium


# OR via GitHub:
git clone https://github.com/pslkk/syncralis-web-agent.git

cd syncralis-web-agent
npm install        # also downloads a Chromium binary via Playwright

# 🐧 Linux only (Ubuntu, WSL2, etc.) Securely install required OS graphics libraries
sudo npx playwright install-deps chromium

cp .env.example .env   # optional — defaults are secure without it
```

### 🔑 Configure web search

`web_search` (and `research_query`, which is built on it) needs at least one search
API key — get a free-tier key from either:

- [Tavily](https://tavily.com) → `SYNCRALIS_WEB_AGENT_TAVILY_API_KEY`
- [Brave Search API](https://brave.com/search/api) → `SYNCRALIS_WEB_AGENT_BRAVE_API_KEY`

Set one (or both, for automatic failover) in `.env`. Without a key configured,
`web_search` fails fast with a clear error rather than falling back to unreliable
scraping. See `.env.example` for the full list of search-related options (provider
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
      "args": ["/absolute/path/to/syncralis-web-agent/bin/cli.js"],
      "env": {
        "SYNCRALIS_WEB_AGENT_TRUST_THRESHOLD": "80"
      }
    }
  }
}
```

🔄 Restart the client. Tools exposed: `web_search`, `open_page`, `research_query`,
`fetch_updates`, `click_on_page`, `download_file`, `confirm_action`, `list_pending_actions`.

## ⚙️ Configuration

All variables are optional with secure defaults. Full list with descriptions in
[`.env.example`](./.env.example). Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `SYNCRALIS_WEB_AGENT_TRUST_THRESHOLD` | `80` | Min trust score (0-100) to auto-act. |
| `SYNCRALIS_WEB_AGENT_RESPECT_ROBOTS_TXT` | `true` | Enforce robots.txt. |
| `SYNCRALIS_WEB_AGENT_RATE_LIMIT_PER_DOMAIN_PER_MIN` | `20` | Per-domain request cap. |
| `SYNCRALIS_WEB_AGENT_MAX_DOWNLOAD_BYTES` | 50MB | Download size cap. |
| `SYNCRALIS_WEB_AGENT_X_BEARER_TOKEN` | — | Enables reliable official X API reads. |
| `SYNCRALIS_WEB_AGENT_INSTAGRAM_GRAPH_TOKEN` + `..._INSTAGRAM_BUSINESS_ACCOUNT_ID` | — | Enables Instagram Business Discovery reads. |
| `SYNCRALIS_WEB_AGENT_VIRUSTOTAL_API_KEY` | — | Extra download reputation check. |
| `SYNCRALIS_WEB_AGENT_AUDIT_LOG_PATH` | stderr only | Also write JSON audit log to a file. |
| `SYNCRALIS_WEB_AGENT_ALLOW_MACRO_OFFICE_DOWNLOADS` | `false` | Allow `.docm`/`.xlsm`/`.pptm`/etc (macro-capable Office files). Refused by default. |
| `SYNCRALIS_WEB_AGENT_ALLOW_UNVERIFIED_EXTENSIONS` | `false` | Allow downloads of file types with no defined signature check. Refused by default. |

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
