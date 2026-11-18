import { appendFile } from "node:fs/promises";
import { config } from "../config.js";

function redact(value) {
  if (!config.REDACT_QUERIES_IN_LOGS) return value;
  if (typeof value !== "string") return value;
  return value.length > 8 ? `${value.slice(0, 4)}…(redacted)` : "(redacted)";
}

export async function logEvent(event) {
  const entry = {
    ts: new Date().toISOString(),
    ...event,
    query: event.query !== undefined ? redact(event.query) : undefined,
  };
  const line = JSON.stringify(entry);

  console.error(`[audit] ${line}`);

  if (config.AUDIT_LOG_PATH) {
    try {
      await appendFile(config.AUDIT_LOG_PATH, line + "\n");
    } catch (err) {
      console.error(`[audit] failed to write audit log file: ${err.message}`);
    }
  }
}
