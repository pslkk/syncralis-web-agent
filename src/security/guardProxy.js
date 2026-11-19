import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Loopback-only forward proxy that Chromium is forced through. It resolves every hostname
// exactly once, validates the result, and dials that validated IP directly. Because the browser
// never does its own DNS, a hostile DNS server cannot answer "public" for the check and
// "internal" for the connection (DNS rebinding / TOCTOU). HTTPS is tunnelled with CONNECT, so
// TLS (and certificate validation against the hostname) remains end-to-end inside Chromium.

// Well-known non-web ports: refused so the browser cannot be used as a port scanner / mail relay.
const DENIED_PORTS = new Set([
  22, 23, 25, 110, 135, 139, 143, 445, 465, 587, 993, 995, 1433, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017,
]);

const HOP_BY_HOP = ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "upgrade"];

export async function startGuardProxy({ resolveHost, log = () => {}, maxSockets = 256, idleMs = 60_000 }) {
  const username = "guard";
  const password = randomBytes(24).toString("hex");
  const expected = Buffer.from("Basic " + Buffer.from(`${username}:${password}`).toString("base64"));

  const authorized = (header) => {
    const given = Buffer.from(String(header || ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const sockets = new Set();
  const track = (sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    sock.setTimeout(idleMs, () => sock.destroy());
  };

  const deny = (socket, status, text) => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req.headers["proxy-authorization"])) {
        res.writeHead(407, { "proxy-authenticate": 'Basic realm="guard"', "content-length": 0 }).end();
        return;
      }
      let target;
      try {
        target = new URL(req.url);
      } catch {
        res.writeHead(400, { "content-length": 0 }).end();
        return;
      }
      if (target.protocol !== "http:") return void res.writeHead(400, { "content-length": 0 }).end();
      const port = Number(target.port || 80);
      if (DENIED_PORTS.has(port)) return void res.writeHead(403, { "content-length": 0 }).end();
      if (sockets.size >= maxSockets) return void res.writeHead(503, { "content-length": 0 }).end();

      let resolved;
      try {
        resolved = await resolveHost(target.hostname);
      } catch (err) {
        log({ msg: "egress_blocked", host: target.hostname, reason: String(err.message).slice(0, 200) });
        return void res.writeHead(403, { "content-length": 0 }).end();
      }

      const headers = { ...req.headers, host: target.host };
      for (const h of HOP_BY_HOP) delete headers[h];
      const upstream = http.request(
        { host: resolved.address, port, method: req.method, path: target.pathname + target.search, headers, agent: false, timeout: idleMs },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        }
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-length": 0 });
        res.end();
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-length": 0 });
      res.end();
    }
  });

  server.on("connect", async (req, clientSocket, head) => {
    track(clientSocket);
    clientSocket.on("error", () => clientSocket.destroy());
    try {
      if (!authorized(req.headers["proxy-authorization"])) {
        clientSocket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="guard"\r\nContent-Length: 0\r\n\r\n'
        );
        return;
      }
      let target;
      try {
        target = new URL(`http://${req.url}`);
      } catch {
        return deny(clientSocket, 400, "Bad Request");
      }
      const port = Number(target.port || 443);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || DENIED_PORTS.has(port)) {
        return deny(clientSocket, 403, "Forbidden");
      }
      if (sockets.size >= maxSockets) return deny(clientSocket, 503, "Service Unavailable");

      let resolved;
      try {
        resolved = await resolveHost(target.hostname);
      } catch (err) {
        log({ msg: "egress_blocked", host: target.hostname, reason: String(err.message).slice(0, 200) });
        return deny(clientSocket, 403, "Forbidden");
      }

      const upstream = net.connect({ host: resolved.address, port });
      track(upstream);
      upstream.once("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => {
        if (!clientSocket.writableEnded && clientSocket.bytesWritten === 0) deny(clientSocket, 502, "Bad Gateway");
        clientSocket.destroy();
      });
      clientSocket.on("close", () => upstream.destroy());
      upstream.on("close", () => clientSocket.destroy());
    } catch {
      clientSocket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    username,
    password,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
