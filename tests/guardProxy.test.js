import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startGuardProxy } from "../src/security/guardProxy.js";

async function setup() {
  const seen = [];
  const origin = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(200, { "content-type": "text/plain" }).end("hello");
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = origin.address().port;

  const calls = [];
  // Stand-in for resolveSafeHost: "public.test" is a validated public name that happens to map to
  // loopback here; everything else is refused.
  const resolveHost = async (host) => {
    calls.push(host);
    if (host === "public.test") return { address: "127.0.0.1", family: 4 };
    throw new Error(`Blocked target: ${host}`);
  };
  const proxy = await startGuardProxy({ resolveHost, idleMs: 2000 });
  const auth = "Basic " + Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
  return {
    seen, calls, originPort, proxy, auth,
    close: async () => {
      await proxy.close();
      await new Promise((r) => origin.close(r));
    },
  };
}

const plain = (ctx, target, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: ctx.proxy.port, method: "GET", path: target, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });

const connect = (ctx, target, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: ctx.proxy.port, method: "CONNECT", path: target, headers });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on("error", reject);
    req.end();
  });

test("plain HTTP is forwarded to the validated address with the original Host header", async () => {
  const ctx = await setup();
  try {
    const r = await plain(ctx, `http://public.test:${ctx.originPort}/page?q=1`, { "proxy-authorization": ctx.auth, host: `public.test:${ctx.originPort}` });
    assert.equal(r.status, 200);
    assert.equal(r.body, "hello");
    assert.equal(ctx.seen[0].host, `public.test:${ctx.originPort}`);
    assert.equal(ctx.seen[0].url, "/page?q=1");
    assert.equal(ctx.calls.length, 1, "hostname resolved exactly once per request");
  } finally {
    await ctx.close();
  }
});

test("requests without the per-process proxy credentials are refused", async () => {
  const ctx = await setup();
  try {
    assert.equal((await plain(ctx, `http://public.test:${ctx.originPort}/`)).status, 407);
    assert.equal((await plain(ctx, `http://public.test:${ctx.originPort}/`, { "proxy-authorization": "Basic Zm9vOmJhcg==" })).status, 407);
    const c = await connect(ctx, `public.test:${ctx.originPort}`);
    assert.equal(c.status, 407);
    c.socket.destroy();
    assert.equal(ctx.calls.length, 0, "no DNS work is done for unauthenticated callers");
  } finally {
    await ctx.close();
  }
});

test("hosts rejected by the resolver (private/internal) are blocked for HTTP and CONNECT", async () => {
  const ctx = await setup();
  try {
    assert.equal((await plain(ctx, "http://internal.test/", { "proxy-authorization": ctx.auth })).status, 403);
    const c = await connect(ctx, "internal.test:443", { "proxy-authorization": ctx.auth });
    assert.equal(c.status, 403);
    c.socket.destroy();
  } finally {
    await ctx.close();
  }
});

test("well-known non-web ports are refused before any DNS lookup", async () => {
  const ctx = await setup();
  try {
    assert.equal((await plain(ctx, "http://public.test:25/", { "proxy-authorization": ctx.auth })).status, 403);
    const c = await connect(ctx, "public.test:6379", { "proxy-authorization": ctx.auth });
    assert.equal(c.status, 403);
    c.socket.destroy();
    assert.equal(ctx.calls.length, 0);
  } finally {
    await ctx.close();
  }
});

test("CONNECT tunnels bytes to the validated address", async () => {
  const ctx = await setup();
  try {
    const c = await connect(ctx, `public.test:${ctx.originPort}`, { "proxy-authorization": ctx.auth });
    assert.equal(c.status, 200);
    const reply = await new Promise((resolve) => {
      let data = "";
      c.socket.on("data", (d) => (data += d));
      c.socket.on("end", () => resolve(data));
      c.socket.write(`GET /t HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n`);
    });
    assert.match(reply, /200 OK/);
    assert.match(reply, /hello/);
    assert.equal(ctx.calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test("a resolver that changes its answer cannot redirect an established connection", async () => {
  // The proxy asks once and dials exactly what it was told; a later "rebinding" answer is never consulted.
  const ctx = await setup();
  try {
    const c = await connect(ctx, `public.test:${ctx.originPort}`, { "proxy-authorization": ctx.auth });
    assert.equal(c.status, 200);
    c.socket.destroy();
    assert.equal(ctx.calls.filter((h) => h === "public.test").length, 1);
  } finally {
    await ctx.close();
  }
});
