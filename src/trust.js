import { URL } from "node:url";
import { isIP } from "node:net";
import { config } from "./config.js";
import { MULTI_LABEL_SUFFIXES } from "./security/publicSuffix.js";

const CURATED_ALLOWLIST = new Set([
  "wikipedia.org",
  "github.com",
  "githubusercontent.com",
  "unsplash.com",
  "pexels.com",
  "pixabay.com",
  "wikimedia.org",
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "nytimes.com",
  "nasa.gov",
  "who.int",
  "ferrari.com",
]);

const BRAND_DOMAINS = {
  ferrari: ["ferrari.com"],
  apple: ["apple.com"],
  microsoft: ["microsoft.com"],
  google: ["google.com"],
  amazon: ["amazon.com"],
};

function loadExtraAllowlist() {
  return config.EXTRA_ALLOWLIST.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function registrableDomain(hostname) {
  if (isIP(hostname)) return hostname;

  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");

  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }

  return lastTwo;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function scoreDomain(rawUrl, context = {}) {
  const reasons = [];
  let score = 50; // neutral baseline

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { score: 0, verdict: "low", reasons: ["Not a valid URL"], domain: rawUrl };
  }

  const hostname = url.hostname.toLowerCase();
  const domain = registrableDomain(hostname);
  const allowlist = new Set([...CURATED_ALLOWLIST, ...loadExtraAllowlist()]);

  if (url.protocol === "https:") {
    score += 10;
    reasons.push("Uses HTTPS");
  } else {
    score -= 25;
    reasons.push("Not using HTTPS");
  }

  if (allowlist.has(domain)) {
    score += 35;
    reasons.push(`Domain "${domain}" is on the curated trusted list`);
  }

  if (/\.(gov|edu|mil)$/.test(hostname)) {
    score += 15;
    reasons.push("Government/education domain");
  }

  const brands = (context.mentionedBrands || []).map((b) => b.toLowerCase());
  for (const brand of brands) {
    const officialDomains = BRAND_DOMAINS[brand];
    if (officialDomains && officialDomains.includes(domain)) {
      score += 20;
      reasons.push(`Matches official domain for "${brand}"`);
      continue;
    }

    const domainRoot = domain.split(".")[0];
    const tokens = domainRoot.split("-").filter(Boolean);
    const exactSubstringHit = domainRoot.includes(brand);
    const closeToken = tokens.find(
      (t) => t !== brand && levenshtein(t, brand) <= 2 && t.length >= brand.length - 2
    );

    if (exactSubstringHit) {
      score -= 10;
      reasons.push(
        `Domain contains "${brand}" but is not the official site — possible impersonation`
      );
    } else if (closeToken) {
      score -= 30;
      reasons.push(
        `Domain segment "${closeToken}" looks like a typosquat of "${brand}"`
      );
    }
  }

  const hyphenCount = (domain.match(/-/g) || []).length;
  if (hyphenCount >= 2) {
    score -= 10;
    reasons.push("Domain has multiple hyphens (common in low-quality sites)");
  }

  if (/\.(tk|ml|ga|cf)$/.test(hostname)) {
    score -= 20;
    reasons.push("Free TLD commonly associated with abuse");
  }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 80 ? "high" : score >= 50 ? "medium" : "low";

  return { score, verdict, reasons, domain };
}

export function trustThreshold() {
  return config.TRUST_THRESHOLD;
}
