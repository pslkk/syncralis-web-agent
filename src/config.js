import { z } from "zod";
import os from "node:os";
import path from "node:path";
import { loadOrCreateKeypair } from "./security/webBotAuth.js";

const schema = z.object({
  TRUST_THRESHOLD: z.coerce.number().min(0).max(100).default(80),
  DOWNLOAD_DIR: z.string().optional(),
  MAX_DOWNLOAD_BYTES: z.coerce.number().positive().default(50 * 1024 * 1024),
  EXTRA_ALLOWLIST: z.string().optional().default(""),
  CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  RESPECT_ROBOTS_TXT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  RATE_LIMIT_PER_DOMAIN_PER_MIN: z.coerce.number().int().positive().default(20),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  AUDIT_LOG_PATH: z.string().optional(),
  REDACT_QUERIES_IN_LOGS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ALLOW_PRIVATE_NETWORK_TARGETS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ALLOW_MACRO_OFFICE_DOWNLOADS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ALLOW_UNVERIFIED_EXTENSIONS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ALLOW_CLICK_ON_VISUALLY_HIDDEN_ELEMENTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  HTTP_PROXY: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/.+/i.test(v), {
      message: "must be a full http(s):// URL, e.g. http://proxy.company.com:8080",
    }),
  X_BEARER_TOKEN: z.string().optional(),
  INSTAGRAM_GRAPH_TOKEN: z.string().optional(),
  INSTAGRAM_BUSINESS_ACCOUNT_ID: z.string().optional(),
  VIRUSTOTAL_API_KEY: z.string().optional(),
  NAVIGATION_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  
  WEB_SEARCH_PROVIDER: z.enum(["auto", "tavily", "brave"]).default("auto"),
  TAVILY_API_KEY: z.string().optional(),
  BRAVE_API_KEY: z.string().optional(),
  WEB_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  WEB_SEARCH_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  WEB_SEARCH_SAFE_SEARCH: z.enum(["off", "moderate", "strict"]).default("moderate"),
  ALLOW_LEGACY_BROWSER_SEARCH_FALLBACK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  BOT_AUTH_AGENT_URL: z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/.+/i.test(v), {
      message:
        "must be the full https://your-domain URL where you will publish " +
        "/.well-known/http-message-signatures-directory (see buildDirectoryDocument())",
    }),
  BOT_AUTH_KEY_DIR: z.string().optional(),

  TRUST_MEMORY_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  TRUST_MEMORY_PATH: z.string().optional(),
  TRUST_MEMORY_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(1000).default(5),
  TRUST_MEMORY_MAX_AGE_DAYS: z.coerce.number().int().positive().default(90),
  TRUST_MEMORY_REJECTION_COOLDOWN_DAYS: z.coerce.number().int().positive().default(30),
});

function fromEnv() {
  const raw = {
    TRUST_THRESHOLD: process.env.SYNCRALIS_WEB_AGENT_TRUST_THRESHOLD,
    DOWNLOAD_DIR: process.env.SYNCRALIS_WEB_AGENT_DOWNLOAD_DIR,
    MAX_DOWNLOAD_BYTES: process.env.SYNCRALIS_WEB_AGENT_MAX_DOWNLOAD_BYTES,
    EXTRA_ALLOWLIST: process.env.SYNCRALIS_WEB_AGENT_EXTRA_ALLOWLIST,
    CONCURRENCY: process.env.SYNCRALIS_WEB_AGENT_CONCURRENCY,
    RESPECT_ROBOTS_TXT: process.env.SYNCRALIS_WEB_AGENT_RESPECT_ROBOTS_TXT,
    RATE_LIMIT_PER_DOMAIN_PER_MIN: process.env.SYNCRALIS_WEB_AGENT_RATE_LIMIT_PER_DOMAIN_PER_MIN,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: process.env.SYNCRALIS_WEB_AGENT_CB_FAILURE_THRESHOLD,
    CIRCUIT_BREAKER_COOLDOWN_MS: process.env.SYNCRALIS_WEB_AGENT_CB_COOLDOWN_MS,
    AUDIT_LOG_PATH: process.env.SYNCRALIS_WEB_AGENT_AUDIT_LOG_PATH,
    REDACT_QUERIES_IN_LOGS: process.env.SYNCRALIS_WEB_AGENT_REDACT_QUERIES_IN_LOGS,
    ALLOW_PRIVATE_NETWORK_TARGETS: process.env.SYNCRALIS_WEB_AGENT_ALLOW_PRIVATE_NETWORK_TARGETS,
    ALLOW_MACRO_OFFICE_DOWNLOADS: process.env.SYNCRALIS_WEB_AGENT_ALLOW_MACRO_OFFICE_DOWNLOADS,
    ALLOW_UNVERIFIED_EXTENSIONS: process.env.SYNCRALIS_WEB_AGENT_ALLOW_UNVERIFIED_EXTENSIONS,
    HTTP_PROXY: process.env.SYNCRALIS_WEB_AGENT_HTTP_PROXY || process.env.HTTP_PROXY,
    X_BEARER_TOKEN: process.env.SYNCRALIS_WEB_AGENT_X_BEARER_TOKEN,
    INSTAGRAM_GRAPH_TOKEN: process.env.SYNCRALIS_WEB_AGENT_INSTAGRAM_GRAPH_TOKEN,
    INSTAGRAM_BUSINESS_ACCOUNT_ID: process.env.SYNCRALIS_WEB_AGENT_INSTAGRAM_BUSINESS_ACCOUNT_ID,
    VIRUSTOTAL_API_KEY: process.env.SYNCRALIS_WEB_AGENT_VIRUSTOTAL_API_KEY,
    NAVIGATION_TIMEOUT_MS: process.env.SYNCRALIS_WEB_AGENT_NAVIGATION_TIMEOUT_MS,
    WEB_SEARCH_PROVIDER: process.env.SYNCRALIS_WEB_AGENT_WEB_SEARCH_PROVIDER,
    TAVILY_API_KEY: process.env.SYNCRALIS_WEB_AGENT_TAVILY_API_KEY,
    BRAVE_API_KEY: process.env.SYNCRALIS_WEB_AGENT_BRAVE_API_KEY,
    WEB_SEARCH_TIMEOUT_MS: process.env.SYNCRALIS_WEB_AGENT_WEB_SEARCH_TIMEOUT_MS,
    WEB_SEARCH_MAX_RETRIES: process.env.SYNCRALIS_WEB_AGENT_WEB_SEARCH_MAX_RETRIES,
    WEB_SEARCH_SAFE_SEARCH: process.env.SYNCRALIS_WEB_AGENT_WEB_SEARCH_SAFE_SEARCH,
    ALLOW_LEGACY_BROWSER_SEARCH_FALLBACK:
      process.env.SYNCRALIS_WEB_AGENT_ALLOW_LEGACY_BROWSER_SEARCH_FALLBACK,
    BOT_AUTH_AGENT_URL: process.env.SYNCRALIS_WEB_AGENT_BOT_AUTH_AGENT_URL,
    BOT_AUTH_KEY_DIR: process.env.SYNCRALIS_WEB_AGENT_BOT_AUTH_KEY_DIR,
    TRUST_MEMORY_ENABLED: process.env.SYNCRALIS_WEB_AGENT_TRUST_MEMORY_ENABLED,
    TRUST_MEMORY_PATH: process.env.SYNCRALIS_WEB_AGENT_TRUST_MEMORY_PATH,
    TRUST_MEMORY_MIN_CONFIRMATIONS: process.env.SYNCRALIS_WEB_AGENT_TRUST_MEMORY_MIN_CONFIRMATIONS,
    TRUST_MEMORY_MAX_AGE_DAYS: process.env.SYNCRALIS_WEB_AGENT_TRUST_MEMORY_MAX_AGE_DAYS,
    TRUST_MEMORY_REJECTION_COOLDOWN_DAYS:
      process.env.SYNCRALIS_WEB_AGENT_TRUST_MEMORY_REJECTION_COOLDOWN_DAYS,
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid mcp-web-agent configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = fromEnv();

function defaultAppDataDir() {
  return path.join(os.homedir(), ".syncralis-web-agent");
}

export function botAuthKeyDir() {
  return config.BOT_AUTH_KEY_DIR || path.join(defaultAppDataDir(), "keys");
}

export function trustMemoryPath() {
  return config.TRUST_MEMORY_PATH || path.join(defaultAppDataDir(), "trust-memory.json");
}

export const webBotAuthKeypair = config.BOT_AUTH_AGENT_URL
  ? {
      ...loadOrCreateKeypair(botAuthKeyDir(), {
        onPersistFailure: (err) => {
          console.error(
            "[syncralis-web-agent] could not persist Web Bot Auth keypair to " +
              `${botAuthKeyDir()} (${String(err?.message || err)}) — using an ` +
              "in-memory-only key for this process; requests will be signed with " +
              "a NEW key on every restart until this is fixed.",
          );
        },
      }),
      agentDirectoryUrl: config.BOT_AUTH_AGENT_URL,
    }
  : null;
