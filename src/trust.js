import { URL } from "node:url";
import { isIP } from "node:net";
import { config, trustMemoryPath } from "./config.js";
import { MULTI_LABEL_SUFFIXES } from "./security/publicSuffix.js";
import { getMemoryEntry, evaluatePromotion } from "./trustMemory.js";

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

export async function scoreDomain(rawUrl, context = {}) {
  const reasons = [];
  let score = 50; // neutral baseline
  let hardFlag = false;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { score: 0, verdict: "low", hardFlag: true, reasons: ["Not a valid URL"], domain: rawUrl };
  }

  const hostname = url.hostname.toLowerCase();
  const domain = registrableDomain(hostname);
  const allowlist = new Set([...CURATED_ALLOWLIST, ...loadExtraAllowlist()]);

  if (url.protocol === "https:") {
    score += 10;
    reasons.push("Uses HTTPS");
  } else {
    score -= 25;
    hardFlag = true;
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
      hardFlag = true;
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
    hardFlag = true;
    reasons.push("Free TLD commonly associated with abuse");
  }

  score = Math.max(0, Math.min(100, score));
  let verdict = score >= 80 ? "high" : score >= 50 ? "medium" : "low";

  if (config.TRUST_MEMORY_ENABLED && !hardFlag && score < config.TRUST_THRESHOLD) {
    try {
      const entry = await getMemoryEntry(trustMemoryPath(), domain);
      const promotion = evaluatePromotion(entry, {
        minConfirmations: config.TRUST_MEMORY_MIN_CONFIRMATIONS,
        maxAgeDays: config.TRUST_MEMORY_MAX_AGE_DAYS,
        rejectionCooldownDays: config.TRUST_MEMORY_REJECTION_COOLDOWN_DAYS,
      });
      if (promotion.promoted) {
        score = config.TRUST_THRESHOLD;
        verdict = score >= 80 ? "high" : score >= 50 ? "medium" : "low";
        reasons.push(promotion.reason);
      } else if (promotion.reason) {
        reasons.push(promotion.reason);
      }
    } catch {
      // Trust memory is best-effort; any failure here must never affect the heuristic score already computed above.
    }
  }

  return { score, verdict, hardFlag, reasons, domain };
}

export function trustThreshold() {
  return config.TRUST_THRESHOLD;
}
