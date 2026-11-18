import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateKeypair } from "./security/webBotAuth.js";

// Configuration comes from a single JSON file, never from the process
// environment. Location, in order of precedence:
//   1. the path given as `--config <path>` on the command line
//   2. ~/.syncralis-web-agent/config.json
// Every key is optional; the defaults below are the secure choices.
// See config.example.json for the full list.

const bool = (defaultValue) => z.boolean().default(defaultValue);

const httpUrl = (what) =>
  z
    .string()
    .optional()
    .refine((v) => !v || /^https?:\/\/.+/i.test(v), {
      message: `${what} must be a full http(s):// URL`,
    });

const schema = z.strictObject({
  TRUST_THRESHOLD: z.coerce.number().min(0).max(100).default(80),
  DOWNLOAD_DIR: z.string().optional(),
  MAX_DOWNLOAD_BYTES: z.coerce.number().positive().default(50 * 1024 * 1024),
  EXTRA_ALLOWLIST: z.string().optional().default(""),
  CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  RESPECT_ROBOTS_TXT: bool(true),
  RATE_LIMIT_PER_DOMAIN_PER_MIN: z.coerce.number().int().positive().default(20),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  AUDIT_LOG_PATH: z.string().optional(),
  REDACT_QUERIES_IN_LOGS: bool(false),
  ALLOW_PRIVATE_NETWORK_TARGETS: bool(false),
  ALLOW_MACRO_OFFICE_DOWNLOADS: bool(false),
  ALLOW_UNVERIFIED_EXTENSIONS: bool(false),
  ALLOW_CLICK_ON_VISUALLY_HIDDEN_ELEMENTS: bool(false),
  HTTP_PROXY: httpUrl("HTTP_PROXY"),
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
  ALLOW_LEGACY_BROWSER_SEARCH_FALLBACK: bool(false),
  BOT_AUTH_AGENT_URL: httpUrl("BOT_AUTH_AGENT_URL"),
  BOT_AUTH_KEY_DIR: z.string().optional(),

  TRUST_MEMORY_ENABLED: bool(true),
  TRUST_MEMORY_PATH: z.string().optional(),
  TRUST_MEMORY_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(1000).default(5),
  TRUST_MEMORY_MAX_AGE_DAYS: z.coerce.number().int().positive().default(90),
  TRUST_MEMORY_REJECTION_COOLDOWN_DAYS: z.coerce.number().int().positive().default(30),
});

function defaultAppDataDir() {
  return path.join(os.homedir(), ".syncralis-web-agent");
}

function resolveConfigPath() {
  const flagIndex = process.argv.indexOf("--config");
  if (flagIndex !== -1) {
    const value = process.argv[flagIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--config requires a file path");
    }
    return { file: path.resolve(value), explicit: true };
  }
  return { file: path.join(defaultAppDataDir(), "config.json"), explicit: false };
}

function readConfigFile({ file, explicit }) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && !explicit) return {};
    throw new Error(`Cannot read config file ${file}: ${err.message}`);
  }

  // The file may hold API keys, so warn if other users on this machine can read it.
  if (process.platform !== "win32") {
    try {
      if ((fs.statSync(file).mode & 0o077) !== 0) {
        console.error(
          `[syncralis-web-agent] warning: ${file} is readable by other users; ` +
            "run `chmod 600` on it because it may contain API keys.",
        );
      }
    } catch {
      // Permission check is best-effort only.
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config file ${file} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${file} must contain a JSON object at the top level.`);
  }
  return parsed;
}

function loadConfig() {
  const source = resolveConfigPath();
  const parsed = schema.safeParse(readConfigFile(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid syncralis-web-agent configuration in ${source.file}:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();

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
