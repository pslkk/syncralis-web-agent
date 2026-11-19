// End-to-end MCP session test over Streamable HTTP. Needs the real SDK, so it is skipped
// when dependencies are not installed.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/http/app.js";
import { parseTokens } from "../src/http/auth.js";

let McpServer;
try {
  ({ McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js"));
} catch {
  /* SDK not installed */
}

const TA = "alice-token-".padEnd(40, "a");
const TB = "bob-token-".padEnd(40, "b");

test("full session lifecycle, cross-client isolation, per-client eviction", { skip: !McpServer && "MCP SDK not installed" }, async () => {
  const app = createApp({
    buildServer: () => {
      const s = new McpServer({ name: "t", version: "1" });
      s.registerTool("ping", { description: "ping", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));
      return s;
    },
    clients: parseTokens(`alice:${TA},bob:${TB}`),
    maxSessionsPerClient: 1,
    log: () => {},
  });
  await new Promise((r) => app.httpServer.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  const headers = (t, sid) => ({
    authorization: `Bearer ${t}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sid ? { "mcp-session-id": sid } : {}),
  });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

  try {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: headers(TA), body: JSON.stringify(init) });
    assert.equal(r.status, 200);
    const sid = r.headers.get("mcp-session-id");
    assert.ok(sid);
    await r.text();

    const note = await fetch(`${base}/mcp`, { method: "POST", headers: headers(TA, sid), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(note.status, 202);

    const list = await fetch(`${base}/mcp`, { method: "POST", headers: headers(TA, sid), body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    assert.equal(list.status, 200);
    assert.match(await list.text(), /ping/);

    const stolen = await fetch(`${base}/mcp`, { method: "POST", headers: headers(TB, sid), body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
    assert.equal(stolen.status, 404, "another client must not reach this session");

    // Per-client cap (1): a new session evicts this client's oldest one instead of failing.
    const second = await fetch(`${base}/mcp`, { method: "POST", headers: headers(TA), body: JSON.stringify(init) });
    assert.equal(second.status, 200);
    const sid2 = second.headers.get("mcp-session-id");
    assert.ok(sid2 && sid2 !== sid);
    await second.text();
    const evicted = await fetch(`${base}/mcp`, { method: "POST", headers: headers(TA, sid), body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }) });
    assert.equal(evicted.status, 404, "oldest session was evicted");

    const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: headers(TA, sid2) });
    assert.equal(del.status, 200);
    const gone = await fetch(`${base}/mcp`, { method: "POST", headers: headers(TA, sid2), body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) });
    assert.equal(gone.status, 404);
  } finally {
    await app.shutdown({ graceMs: 200 });
  }
});
