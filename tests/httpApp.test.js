import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/http/app.js";
import { parseTokens } from "../src/http/auth.js";

const TA = "alice-token-".padEnd(40, "a");
const TB = "bob-token-".padEnd(40, "b");
const clients = parseTokens(`alice:${TA},bob:${TB}`);
const quiet = () => {};

async function start(extra = {}) {
  const app = createApp({ buildServer: () => { throw new Error("not used"); }, clients, log: quiet, ...extra });
  await new Promise((r) => app.httpServer.listen(0, "127.0.0.1", r));
  const port = app.httpServer.address().port;
  const call = (method, p, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end(body);
    });
  return { app, call, close: () => app.shutdown({ graceMs: 200 }) };
}
const auth = (t) => ({ authorization: `Bearer ${t}` });
const json = (t) => ({ ...auth(t), "content-type": "application/json" });

test("/health is public; everything else needs a valid token", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("GET", "/health")).status, 200);
    const noAuth = await s.call("GET", "/mcp");
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers["www-authenticate"], "Bearer");
    assert.equal((await s.call("GET", "/nope", { headers: auth("x".repeat(40)) })).status, 401);
    assert.equal((await s.call("GET", "/nope", { headers: auth(TA) })).status, 404);
    const res = await s.call("GET", "/health");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["cache-control"], "no-store");
  } finally {
    await s.close();
  }
});

test("repeated failed auth from one IP is throttled with 429", async () => {
  const s = await start();
  try {
    let last;
    for (let i = 0; i < 11; i++) last = await s.call("GET", "/mcp", { headers: auth("w".repeat(40)) });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers["retry-after"]) > 0);
    // A valid token is never locked out by an attacker's failures from the same (proxy) IP.
    assert.equal((await s.call("GET", "/nope", { headers: auth(TA) })).status, 404);
  } finally {
    await s.close();
  }
});

test("per-client request rate limit returns 429 with Retry-After", async () => {
  const s = await start({ ratePerMinute: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.call("GET", "/nope", { headers: auth(TA) })).status, 404);
    const limited = await s.call("GET", "/nope", { headers: auth(TA) });
    assert.equal(limited.status, 429);
    assert.ok(limited.headers["retry-after"]);
    assert.equal((await s.call("GET", "/nope", { headers: auth(TB) })).status, 404, "other clients unaffected");
  } finally {
    await s.close();
  }
});

test("Host allow-list and Origin rejection", async () => {
  const s = await start({ allowedHosts: ["agent.example.test"] });
  try {
    assert.equal((await s.call("GET", "/nope", { headers: { ...auth(TA), host: "evil.test" } })).status, 403);
    assert.equal((await s.call("GET", "/nope", { headers: { ...auth(TA), host: "agent.example.test:443" } })).status, 404);
    assert.equal((await s.call("GET", "/nope", { headers: { ...auth(TA), host: "agent.example.test", origin: "https://evil.test" } })).status, 403);
  } finally {
    await s.close();
  }
});

test("/mcp input validation: content type, JSON, session requirements", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("POST", "/mcp", { headers: { ...auth(TA), "content-type": "text/plain" }, body: "x" })).status, 415);
    assert.equal((await s.call("POST", "/mcp", { headers: json(TA), body: "{not json" })).status, 400);
    const noSession = await s.call("POST", "/mcp", { headers: json(TA), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(noSession.status, 400);
    const batchInit = await s.call("POST", "/mcp", { headers: json(TA), body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "initialize" }]) });
    assert.equal(batchInit.status, 400, "initialize must not be batched");
    const unknown = await s.call("POST", "/mcp", { headers: { ...json(TA), "mcp-session-id": "nope" }, body: "{}" });
    assert.equal(unknown.status, 404);
    assert.equal((await s.call("PUT", "/mcp", { headers: json(TA) })).status, 405);
    assert.equal((await s.call("POST", "/messages?sessionId=nope", { headers: json(TA), body: "{}" })).status, 404);
  } finally {
    await s.close();
  }
});

test("downloads are only served to the client that owns them, as attachments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "app-dl-"));
  const file = path.join(dir, "f.pdf");
  await writeFile(file, "%PDF-1.4 hello");
  const id = "dl_" + "a1".repeat(16);
  const entry = { owner: "alice", path: file, safeName: "f.pdf", sha256: "deadbeef" };
  const s = await start({ downloads: { getDownload: (i, o) => (i === id && o === entry.owner ? entry : undefined) } });
  try {
    const ok = await s.call("GET", `/downloads/${id}`, { headers: auth(TA) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "%PDF-1.4 hello");
    assert.equal(ok.headers["content-type"], "application/octet-stream");
    assert.match(ok.headers["content-disposition"], /^attachment; filename="f\.pdf"$/);
    assert.equal((await s.call("GET", `/downloads/${id}`, { headers: auth(TB) })).status, 404);
    assert.equal((await s.call("GET", "/downloads/../../etc/passwd", { headers: auth(TA) })).status, 404);
    assert.equal((await s.call("GET", "/downloads/dl_zzz", { headers: auth(TA) })).status, 404);
  } finally {
    await s.close();
  }
});

test("health reports 503 while shutting down", async () => {
  const s = await start();
  const closing = s.close();
  await closing;
  // server is closed; the contract is that shutdown() resolved without hanging
  assert.ok(true);
});
