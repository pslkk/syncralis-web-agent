import { z } from "zod";

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
