import { createHash, timingSafeEqual } from "node:crypto";

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{32,256}$/;

const sha256 = (s) => createHash("sha256").update(s).digest();

/**
 * Parses MCP_AUTH_TOKENS: comma-separated "name:token" pairs (or a single bare token,
 * which is named "default"). Several tokens may be active at once, which allows
 * zero-downtime rotation. Returns [{ name, hash }]; throws on any invalid entry.
 */
export function parseTokens(raw) {
  const entries = String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error("no auth tokens configured");

  const seenNames = new Set();
  const seenHashes = new Set();
  return entries.map((entry) => {
    const idx = entry.indexOf(":");
    const name = (idx === -1 ? "default" : entry.slice(0, idx)).toLowerCase();
    const token = idx === -1 ? entry : entry.slice(idx + 1);
    if (!NAME_RE.test(name)) throw new Error(`invalid client name "${name}" (use a-z, 0-9, _ or -, max 32)`);
    if (!TOKEN_RE.test(token)) {
      throw new Error(`token for client "${name}" must be 32-256 chars of [A-Za-z0-9._~+/=-]`);
    }
    if (seenNames.has(name)) throw new Error(`duplicate client name "${name}"`);
    const hash = sha256(token);
    const hex = hash.toString("hex");
    if (seenHashes.has(hex)) throw new Error("duplicate token value");
    seenNames.add(name);
    seenHashes.add(hex);
    return { name, hash };
  });
}

/** Returns the client name for a valid "Authorization: Bearer <token>" header, else null. */
export function authenticate(authorizationHeader, clients) {
  const header = typeof authorizationHeader === "string" ? authorizationHeader : "";
  const m = /^Bearer ([^\s]+)$/.exec(header);
  const given = sha256(m ? m[1] : "");
  let found = null;
  for (const c of clients) {
    // Compare against every client so timing does not reveal which one matched.
    if (timingSafeEqual(given, c.hash) && m) found = c.name;
  }
  return found;
}

/**
 * Client IP behind `hops` trusted reverse proxies: the entry `hops` places from the right of
 * X-Forwarded-For (entries to the left are client-supplied and spoofable).
 */
export function clientIp(req, hops = 1) {
  const xff = req.headers["x-forwarded-for"];
  if (hops > 0 && typeof xff === "string") {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[Math.max(0, parts.length - hops)];
  }
  return req.socket?.remoteAddress || "unknown";
}
