import http from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { authenticate, clientIp } from "./auth.js";
import { FixedWindowLimiter } from "../runtime/limits.js";

const MAX_BODY_BYTES = 1_000_000;
const HEARTBEAT_MS = 25_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

const rpcError = (res, status, code, message, headers) =>
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);

async function readJsonBody(req) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (!type.startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

// The MCP SDK validates the full message; this only decides whether a sessionless POST may
// create a session. Per the spec an initialize request is never batched.
const isInitialize = (body) => body && !Array.isArray(body) && typeof body === "object" && body.method === "initialize";

function startHeartbeat(res) {
  // SSE comment lines keep proxies from closing idle streams; clients ignore them.
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  timer.unref?.();
  res.on("close", () => clearInterval(timer));
}

/**
 * Creates (but does not start listening) the HTTP server.
 *
 * opts:
 *   buildServer(clientName) -> McpServer            required
 *   clients                 -> [{ name, hash }]     required (see auth.parseTokens)
 *   downloads               -> { getDownload(id, owner) }  optional
 *   allowedHosts / allowedOrigins -> string[]       Host allow-list (empty = any) / Origin allow-list (empty = none)
 *   trustProxyHops, maxSessions, maxSessionsPerClient, sessionIdleMs, ratePerMinute, log
 */
export function createApp(opts) {
  const {
    buildServer,
    clients,
    downloads = null,
    allowedHosts = [],
    allowedOrigins = [],
    trustProxyHops = 1,
    maxSessions = 50,
    maxSessionsPerClient = 10,
    sessionIdleMs = 30 * 60 * 1000,
    ratePerMinute = 120,
    log = (entry) => console.error(JSON.stringify({ ts: new Date().toISOString(), ...entry })),
  } = opts;

  const hostSet = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const originSet = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  const authFailures = new FixedWindowLimiter({ limit: 10, windowMs: 60_000 });
  const requestRate = new FixedWindowLimiter({ limit: ratePerMinute, windowMs: 60_000 });

  /** id -> { id, kind, transport, server, client, createdAt, lastSeen } */
  const sessions = new Map();
  let pendingCreates = 0;
  let shuttingDown = false;

  const countFor = (client) => [...sessions.values()].filter((s) => s.client === client).length;

  async function closeSession(id, reason) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id); // delete first: transport.onclose re-enters this function
    log({ level: "info", msg: "session_closed", session: id.slice(0, 8), client: s.client, reason });
    await s.transport.close().catch(() => {});
    await s.server.close().catch(() => {});
  }

  function registerSession(id, kind, transport, server, client) {
    const now = Date.now();
    sessions.set(id, { id, kind, transport, server, client, createdAt: now, lastSeen: now });
    // Chain onto any handler the MCP Protocol layer already installed instead of replacing it.
    const previous = transport.onclose;
    transport.onclose = () => {
      previous?.();
      void closeSession(id, "transport_closed");
    };
    log({ level: "info", msg: "session_opened", session: id.slice(0, 8), client, kind });
  }

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const s of [...sessions.values()]) if (s.lastSeen < cutoff) void closeSession(s.id, "idle");
  }, 60_000);
  sweeper.unref?.();

  // Clients that reconnect without closing their old session would otherwise lock themselves out
  // until the idle timeout; evict that client's least-recently-used session instead.
  async function makeRoomFor(client) {
    while (countFor(client) >= maxSessionsPerClient) {
      const mine = [...sessions.values()].filter((x) => x.client === client).sort((a, b) => a.lastSeen - b.lastSeen);
      await closeSession(mine[0].id, "evicted_per_client_cap");
    }
  }

  function capacityError() {
    return shuttingDown ? "Server is shutting down" : null;
  }

  async function handle(req, res, ctx) {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    ctx.route = route;

    if (route === "/health" && (req.method === "GET" || req.method === "HEAD")) {
      return sendJson(res, shuttingDown ? 503 : 200, { status: shuttingDown ? "shutting_down" : "ok" });
    }

    // DNS-rebinding / cross-origin protection.
    if (hostSet.size > 0) {
      const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
      if (!hostSet.has(host)) throw new HttpError(403, "Host not allowed");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !originSet.has(String(origin).toLowerCase())) {
      throw new HttpError(403, "Origin not allowed");
    }

    // Authentication, with brute-force throttling per source IP.
    const ip = clientIp(req, trustProxyHops);
    ctx.ip = ip;
    // Valid tokens are never throttled by IP: behind a shared proxy address an attacker's bad guesses
    // must not be able to lock legitimate clients out. Only invalid attempts are counted.
    const client = authenticate(req.headers.authorization, clients);
    if (!client) {
      const failure = authFailures.hit(ip);
      if (!failure.allowed) {
        throw Object.assign(new HttpError(429, "Too many failed authentication attempts"), {
          retryAfter: Math.ceil(failure.retryAfterMs / 1000),
        });
      }
      throw Object.assign(new HttpError(401, "Unauthorized"), { wwwAuthenticate: true });
    }
    ctx.client = client;

    const rate = requestRate.hit(client);
    if (!rate.allowed) {
      throw Object.assign(new HttpError(429, "Rate limit exceeded"), { retryAfter: Math.ceil(rate.retryAfterMs / 1000) });
    }

    // ---- Streamable HTTP: /mcp -------------------------------------------------------------
    if (route === "/mcp") {
      if (!["POST", "GET", "DELETE"].includes(req.method)) throw new HttpError(405, "Method not allowed");
      const sid = req.headers["mcp-session-id"];
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;

      if (typeof sid === "string") {
        const s = sessions.get(sid);
        // Another client's session is reported as unknown, never as forbidden.
        if (!s || s.kind !== "streamable" || s.client !== client) return rpcError(res, 404, -32001, "Session not found");
        s.lastSeen = Date.now();
        await s.transport.handleRequest(req, res, body);
        if (req.method === "GET") startHeartbeat(res);
        return;
      }

      if (req.method !== "POST" || !isInitialize(body)) {
        return rpcError(res, 400, -32000, "Bad Request: missing Mcp-Session-Id (send an initialize request first)");
      }
      const refused = capacityError();
      if (refused) return rpcError(res, 503, -32000, refused, { "retry-after": "5" });
      if (sessions.size + pendingCreates >= maxSessions) {
        return rpcError(res, 503, -32000, "Too many active sessions", { "retry-after": "30" });
      }
      await makeRoomFor(client);

      const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
      pendingCreates += 1;
      try {
        const server = buildServer(client);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          // Plain JSON responses: no long-lived POST streams for proxies to cut.
          enableJsonResponse: true,
          onsessioninitialized: (id) => registerSession(id, "streamable", transport, server, client),
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        // The SDK rejected the initialize request: no session exists, so do not leak the server.
        if (!transport.sessionId) await server.close().catch(() => {});
      } finally {
        pendingCreates -= 1;
      }
      return;
    }

    // ---- Legacy SSE: GET /sse + POST /messages ---------------------------------------------
    if (route === "/sse") {
      if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
      const refused = capacityError();
      if (refused) return rpcError(res, 503, -32000, refused, { "retry-after": "5" });
      if (sessions.size + pendingCreates >= maxSessions) {
        return rpcError(res, 503, -32000, "Too many active sessions", { "retry-after": "30" });
      }
      await makeRoomFor(client);
      const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
      pendingCreates += 1;
      try {
        const server = buildServer(client);
        const transport = new SSEServerTransport("/messages", res);
        registerSession(transport.sessionId, "sse", transport, server, client);
        res.on("close", () => void closeSession(transport.sessionId, "stream_closed"));
        await server.connect(transport);
        startHeartbeat(res);
      } finally {
        pendingCreates -= 1;
      }
      return;
    }

    if (route === "/messages") {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      const s = sessions.get(url.searchParams.get("sessionId") || "");
      if (!s || s.kind !== "sse" || s.client !== client) throw new HttpError(404, "Session not found");
      s.lastSeen = Date.now();
      const body = await readJsonBody(req);
      await s.transport.handlePostMessage(req, res, body);
      return;
    }

    // ---- Verified downloads -----------------------------------------------------------------
    const dl = /^\/downloads\/(dl_[0-9a-f]{32})$/.exec(route);
    if (dl && downloads) {
      if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
      const entry = downloads.getDownload(dl[1], client);
      if (!entry) throw new HttpError(404, "Not found");
      const info = await stat(entry.path).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404, "Not found");
      res.writeHead(200, {
        "content-type": "application/octet-stream", // never rendered inline by a browser
        "content-length": info.size,
        "content-disposition": `attachment; filename="${entry.safeName}"`,
        "x-sha256": entry.sha256,
      });
      createReadStream(entry.path).on("error", () => res.destroy()).pipe(res);
      return;
    }

    throw new HttpError(404, "Not found");
  }

  const httpServer = http.createServer(async (req, res) => {
    const ctx = { id: randomUUID().slice(0, 8), started: Date.now(), route: "", client: undefined, ip: undefined };
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-request-id", ctx.id);
    res.on("close", () =>
      log({
        level: "info",
        msg: "request",
        reqId: ctx.id,
        method: req.method,
        path: ctx.route || req.url?.split("?")[0],
        status: res.statusCode,
        ms: Date.now() - ctx.started,
        client: ctx.client,
        ip: ctx.ip,
      })
    );
    try {
      await handle(req, res, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = {};
        if (err.wwwAuthenticate) headers["www-authenticate"] = "Bearer";
        if (err.retryAfter) headers["retry-after"] = String(err.retryAfter);
        return sendJson(res, err.status, { error: err.message }, headers);
      }
      log({ level: "error", msg: "unhandled_request_error", reqId: ctx.id, error: String(err?.stack || err) });
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
      else res.destroy();
    }
  });

  // Render's load balancer keeps connections for up to 60 s; stay above that.
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.requestTimeout = 60_000;

  async function shutdown({ graceMs = 15_000 } = {}) {
    shuttingDown = true;
    clearInterval(sweeper);
    const closed = new Promise((resolve) => httpServer.close(() => resolve()));
    await Promise.all([...sessions.keys()].map((id) => closeSession(id, "shutdown")));
    const timer = setTimeout(() => httpServer.closeAllConnections?.(), graceMs);
    timer.unref?.();
    httpServer.closeIdleConnections?.();
    await closed;
    clearTimeout(timer);
  }

  return { httpServer, shutdown, sessions, closeSession };
}
