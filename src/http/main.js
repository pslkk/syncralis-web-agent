import { config } from "../config.js";
import { buildServer } from "../index.js";
import { shutdownBrowser, setBrowserConcurrency } from "../browser.js";
import { logEvent } from "../security/auditLog.js";
import { startDownloadSweeper, getDownload } from "../downloads.js";
import { quarantineDir } from "../quarantine.js";
import { parseTokens } from "./auth.js";
import { createApp } from "./app.js";

const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const int = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

export async function main() {
  let clients;
  try {
    clients = parseTokens(process.env.MCP_AUTH_TOKENS || process.env.MCP_AUTH_TOKEN);
  } catch (err) {
    console.error(
      `[syncralis-web-agent] refusing to start: ${err.message}. Set MCP_AUTH_TOKENS to ` +
        `"name:token[,name2:token2]" with tokens of 32+ characters (e.g. \`openssl rand -base64 36\`).`
    );
    process.exit(1);
  }

  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;
  const allowedHosts = list(process.env.ALLOWED_HOSTS);
  if (allowedHosts.length === 0 && renderHost) allowedHosts.push(renderHost, "localhost", "127.0.0.1");
  if (allowedHosts.length === 0) {
    console.error("[syncralis-web-agent] warning: ALLOWED_HOSTS is not set; Host header is not restricted.");
  }

  const app = createApp({
    buildServer: (client) => buildServer({ owner: client, remote: true }),
    clients,
    downloads: { getDownload },
    allowedHosts,
    allowedOrigins: list(process.env.ALLOWED_ORIGINS),
    trustProxyHops: int("TRUST_PROXY_HOPS", 1),
    maxSessions: int("MAX_SESSIONS", 50),
    maxSessionsPerClient: int("MAX_SESSIONS_PER_CLIENT", 10),
    sessionIdleMs: int("SESSION_IDLE_MINUTES", 30) * 60_000,
    ratePerMinute: int("RATE_LIMIT_PER_MINUTE", 120),
  });

  setBrowserConcurrency(config.MAX_CONCURRENT_BROWSER_TASKS);
  const stopSweeper = startDownloadSweeper(quarantineDir, config.DOWNLOAD_TTL_MINUTES * 60_000);

  const port = int("PORT", 10000);
  // Loopback unless hosting (PORT/RENDER set) or HOST given, so local dev is not exposed by accident.
  const host = process.env.HOST || (process.env.PORT || process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
  await new Promise((resolve, reject) => {
    app.httpServer.once("error", reject);
    app.httpServer.listen(port, host, resolve);
  });
  console.error(
    `[syncralis-web-agent] listening on ${host}:${port} — endpoints /mcp, /sse, /health; clients: ${clients.map((c) => c.name).join(", ")}`
  );
  await logEvent({ action: "http_server_started", port, clients: clients.map((c) => c.name) }).catch(() => {});

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`[syncralis-web-agent] ${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref?.();
    stopSweeper();
    await app.shutdown({ graceMs: 10_000 }).catch(() => {});
    await shutdownBrowser().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  process.on("unhandledRejection", async (reason) => {
    console.error("[syncralis-web-agent] unhandled rejection:", reason);
    await logEvent({ action: "unhandled_rejection", error: String(reason?.message || reason) }).catch(() => {});
  });
  process.on("uncaughtException", async (err) => {
    console.error("[syncralis-web-agent] uncaught exception, exiting:", err);
    await logEvent({ action: "uncaught_exception", error: String(err?.message || err) }).catch(() => {});
    await shutdownBrowser().catch(() => {});
    process.exit(1); // the platform restarts us into a clean state
  });
}
