import { config } from "../config.js";
import { assertSafeTarget } from "./ssrf.js";

const cache = new Map(); // origin -> { rules, fetchedAt }
const CACHE_TTL_MS = 15 * 60 * 1000;
const AGENT_TOKEN = "syncralis-web-agent";

function parseRobots(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const groups = []; // { agents: [], rules: [{type, path}] }
  let current = null;

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [value.toLowerCase()], rules: [] };
        groups.push(current);
      } else {
        current.agents.push(value.toLowerCase());
      }
    } else if (key === "disallow" && current) {
      current.rules.push({ type: "disallow", path: value });
    } else if (key === "allow" && current) {
      current.rules.push({ type: "allow", path: value });
    }
  }
  return groups;
}

function ruleToRegExp(rulePath) {
  const endAnchored = rulePath.endsWith("$");
  const body = endAnchored ? rulePath.slice(0, -1) : rulePath;
  const escaped = body
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${endAnchored ? "$" : ""}`);
}

function ruleMatches(rulePath, pathname) {
  if (rulePath.includes("*") || rulePath.endsWith("$")) {
    return ruleToRegExp(rulePath).test(pathname);
  }
  return pathname.startsWith(rulePath);
}

function ruleSpecificity(rulePath) {
  return rulePath.replace(/[*$]/g, "").length;
}

function selectGroup(groups) {
  const specific = groups.find((g) => g.agents.includes(AGENT_TOKEN));
  if (specific) return specific;
  return groups.find((g) => g.agents.includes("*"));
}

async function fetchRobots(origin) {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rules;
  }
  let rules = [];
  try {
    await assertSafeTarget(`${origin}/robots.txt`);
    const resp = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const text = await resp.text();
      rules = parseRobots(text);
    }
  } catch {
    rules = [];
  }
  cache.set(origin, { rules, fetchedAt: Date.now() });
  return rules;
}

export async function isAllowedByRobots(rawUrl) {
  if (!config.RESPECT_ROBOTS_TXT) return { allowed: true };

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }

  const origin = `${url.protocol}//${url.host}`;
  const groups = await fetchRobots(origin);
  if (groups.length === 0) return { allowed: true };

  const group = selectGroup(groups);
  if (!group) return { allowed: true };

  let best = { type: "allow", path: "", length: -1 };
  for (const rule of group.rules) {
    if (rule.path === "") continue;
    if (ruleMatches(rule.path, url.pathname)) {
      const length = ruleSpecificity(rule.path);
      if (length > best.length) {
        best = { ...rule, length };
      }
    }
  }

  if (best.type === "disallow" && best.length >= 0) {
    return {
      allowed: false,
      reason: `robots.txt disallows path "${best.path}" for this agent`,
    };
  }
  return { allowed: true };
}
