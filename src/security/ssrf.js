import dns from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

function ipToInt(ip) {
  return ip
    .split(".")
    .reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function ipInRange(ip, cidr) {
  const [range, bits] = cidr.split("/");
  const maskBits = Number(bits);
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

const PRIVATE_V4_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "0.0.0.0/8",
  "100.64.0.0/10",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

function isPrivateIPv4(ip) {
  return PRIVATE_V4_RANGES.some((cidr) => ipInRange(ip, cidr));
}

function expandIPv6Groups(ip) {
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];
  if (parts.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    return [...head, ...Array(missing).fill("0"), ...tail];
  }
  const full = ip.split(":");
  return full.length === 8 ? full : null;
}

function embeddedIPv4(ip) {
  const groups = expandIPv6Groups(ip.toLowerCase());
  if (!groups) return null;

  const isZero = (g) => /^0*$/.test(g);
  const last32 = () => {
    const hi = parseInt(groups[6], 16);
    const lo = parseInt(groups[7], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
  };

  if (groups.slice(0, 5).every(isZero) && groups[5] === "ffff") {
    return last32();
  }
  if (groups.slice(0, 6).every(isZero)) {
    return last32();
  }
  if (groups[0] === "64" && groups[1] === "ff9b" && groups.slice(2, 6).every(isZero)) {
    return last32();
  }
  return null;
}

function embedded6to4IPv4(groups) {
  if (groups[0] !== "2002") return null;
  const hi = parseInt(groups[1], 16);
  const lo = parseInt(groups[2], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

function embeddedTeredoIPv4(groups) {
  if (groups[0] !== "2001" || groups[1] !== "0") return null;
  const hi = parseInt(groups[6], 16);
  const lo = parseInt(groups[7], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  const xhi = hi ^ 0xffff;
  const xlo = lo ^ 0xffff;
  return [xhi >> 8, xhi & 0xff, xlo >> 8, xlo & 0xff].join(".");
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (
    lower === "::1" || // loopback
    lower === "::" || // unspecified
    lower.startsWith("fc") ||
    lower.startsWith("fd") || // unique local
    lower.startsWith("fe80") || // link-local
    lower.startsWith("ff") // multicast (ff00::/8) - not a routable destination host
  ) {
    return true;
  }

  const groups = expandIPv6Groups(lower);
  if (groups) {
    const tunneled = embedded6to4IPv4(groups) || embeddedTeredoIPv4(groups);
    if (tunneled && isPrivateIPv4(tunneled)) return true;
  }

  const mapped = embeddedIPv4(lower);
  if (mapped) return isPrivateIPv4(mapped);
  return false;
}

function stripBrackets(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function checkLiteralIP(bareHost) {
  const version = isIP(bareHost);
  if (version === 4 && isPrivateIPv4(bareHost)) {
    return `Blocked private/internal IPv4 target: ${bareHost}`;
  }
  if (version === 6 && isPrivateIPv6(bareHost)) {
    return `Blocked private/internal IPv6 target: ${bareHost}`;
  }
  return null;
}

export async function assertSafeTarget(rawUrl) {
  if (config.ALLOW_PRIVATE_NETWORK_TARGETS) return;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Blocked non-HTTP(S) protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();
  const bareHost = stripBrackets(hostname);

  if (BLOCKED_HOSTNAMES.has(bareHost)) {
    throw new Error(`Blocked hostname: ${bareHost}`);
  }

  if (isIP(bareHost)) {
    const blockReason = checkLiteralIP(bareHost);
    if (blockReason) throw new Error(blockReason);
    return;
  }

  let addresses;
  try {
    addresses = await dns.lookup(bareHost, { all: true });
  } catch (err) {
    throw new Error(
      `Blocked target: "${bareHost}" could not be resolved (${String(err?.code || err?.message || err)}) - refusing to navigate rather than assume it is safe`
    );
  }

  if (addresses.length === 0) {
    throw new Error(`Blocked target: "${bareHost}" resolved to no addresses`);
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      throw new Error(
        `Blocked target: "${bareHost}" resolves to private IPv4 address ${address}`
      );
    }
    if (family === 6 && isPrivateIPv6(address)) {
      throw new Error(
        `Blocked target: "${bareHost}" resolves to private IPv6 address ${address}`
      );
    }
  }
}

const ROUTE_GUARD_CACHE_TTL_MS = 5000;
const routeGuardCache = new Map(); // hostname -> { safe, error, expiresAt }

function sweepRouteGuardCache() {
  const now = Date.now();
  for (const [key, entry] of routeGuardCache) {
    if (entry.expiresAt <= now) routeGuardCache.delete(key);
  }
}

async function isSafeCached(rawUrl) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return { safe: false, error: new Error(`Invalid URL: ${rawUrl}`) };
  }

  const cached = routeGuardCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let result;
  try {
    await assertSafeTarget(rawUrl);
    result = { safe: true, error: null, expiresAt: Date.now() + ROUTE_GUARD_CACHE_TTL_MS };
  } catch (err) {
    result = { safe: false, error: err, expiresAt: Date.now() + ROUTE_GUARD_CACHE_TTL_MS };
  }
  routeGuardCache.set(hostname, result);
  if (routeGuardCache.size > 500) sweepRouteGuardCache();
  return result;
}

export async function installSsrfGuard(context) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const verdict = await isSafeCached(request.url());
    if (!verdict.safe) {
      route.abort("blockedbyclient").catch(() => {});
      return;
    }
    route.continue().catch(() => {});
  });
}
