import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { config, trustMemoryPathFor } from "./config.js";
import { webSearch } from "./tools/search.js";
import { openPage } from "./tools/openPage.js";
import { clickElement } from "./tools/clickElement.js";
import { downloadFile } from "./tools/downloadFile.js";
import { fetchUpdates } from "./tools/fetchUpdates.js";
import { researchQuery } from "./orchestrator.js";
import { trustThreshold, scoreDomain } from "./trust.js";
import { stageAction, confirmAction, rejectAction, peekAction, listPending } from "./confirmations.js";
import { recordDecision } from "./trustMemory.js";
import { shutdownBrowser } from "./browser.js";
import { logEvent } from "./security/auditLog.js";
import { withTimeout } from "./runtime/limits.js";
import { registerDownload, getDownload, mimeFor } from "./downloads.js";

export const SERVER_VERSION = "2.2.0";

function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }] };
}

/**
 * Builds the MCP server.
 *
 * remote=false (stdio, the default): identical to the original project — same 9 tools, same
 * schemas and descriptions, errors propagate as before.
 *
 * remote=true (HTTP hosting): adds bounded inputs, a per-call timeout, errors reported as tool
 * errors, the fetch_download tool, and `owner`-scoped confirmations, trust memory and downloads.
 */
export function buildServer({ owner = "local", remote = false } = {}) {
  const server = new McpServer({ name: "syncralis-web-agent", version: SERVER_VERSION });

  // Remote clients get bounded inputs; local stdio keeps the original loose schemas.
  const str = (max) => (remote ? z.string().min(1).max(max) : z.string());
  const urlStr = str(2048);
  const queryStr = str(500);
  const shortStr = str(500);
  const idStr = str(100);
  const brandsArr = remote ? z.array(z.string().min(1).max(100)).max(10) : z.array(z.string());
  const platformsArr = z.array(z.enum(["web", "x", "instagram"]));
  const o = remote ? { owner } : {}; // extra audit-log fields, remote only

  async function recordTrustMemoryDecision(meta, decision, confirmationId) {
    if (!config.TRUST_MEMORY_ENABLED) return;
    const domain = meta?.domain;
    if (!domain) return;
    try {
      await recordDecision(trustMemoryPathFor(owner), domain, decision);
      await logEvent({ action: `trust_memory_${decision}`, ...o, domain, confirmationId }).catch(() => {});
    } catch (err) {
      await logEvent({
        action: "trust_memory_write_failed",
        ...o,
        domain,
        confirmationId,
        error: String(err?.message || err),
      }).catch(() => {});
    }
  }

  // Local: original behaviour. Remote: hard time cap, failures reported as MCP tool errors.
  const guarded = (name, fn) =>
    remote
      ? async (args) => {
          try {
            return json(await withTimeout(fn(args ?? {}), config.TOOL_TIMEOUT_MS, `Tool ${name}`));
          } catch (err) {
            const message = String(err?.message || err).slice(0, 500);
            await logEvent({ action: "tool_error", tool: name, owner, error: message }).catch(() => {});
            return errorResult(message);
          }
        }
      : async (args) => json(await fn(args));

  // Remote only: register a successful download for retrieval and hide server file paths.
  function finalizeDownload(result) {
    if (!remote || !result?.ok || !result.path) return result;
    const downloadId = registerDownload({ owner, filePath: result.path, bytes: result.bytes, sha256: result.sha256 });
    const { path: _localPath, ...rest } = result;
    return {
      ...rest,
      downloadId,
      retrieve:
        `Call fetch_download with downloadId="${downloadId}" (files up to ${config.MAX_INLINE_DOWNLOAD_BYTES} bytes), ` +
        `or GET /downloads/${downloadId} with your bearer token. Files are deleted after ${config.DOWNLOAD_TTL_MINUTES} minutes.`,
    };
  }

  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Search the web via an authenticated search API (Tavily and/or Brave — configure with " +
        "TAVILY_API_KEY / BRAVE_API_KEY in the config file) and return candidate " +
        "result URLs, each with a trust score (0-100) and reasons.",
      inputSchema: {
        query: queryStr,
        mentionedBrands: brandsArr.optional(),
        maxResults: z.number().int().min(1).max(20).optional(),
      },
    },
    guarded("web_search", (args) => webSearch(args))
  );

  server.registerTool(
    "open_page",
    {
      title: "Open page and extract content",
      description:
        "Open a URL in a real browser, score its trust, and return the page title, visible text, and a list of clickable elements.",
      inputSchema: { url: urlStr, mentionedBrands: brandsArr.optional() },
    },
    guarded("open_page", (args) => openPage(args))
  );

  server.registerTool(
    "research_query",
    {
      title: "Multi-agent research",
      description:
        "Fan out multiple parallel sub-agents to search, trust-score, and read the top candidate sources for a query, returning a ranked bundle with each source's trust level and content preview. Use this for 'find and summarize' style requests.",
      inputSchema: {
        query: queryStr,
        mentionedBrands: brandsArr.optional(),
        topN: z.number().int().min(1).max(10).optional(),
      },
    },
    guarded("research_query", (args) => researchQuery(args))
  );

  server.registerTool(
    "click_on_page",
    {
      title: "Click an element on a page",
      description:
        "Navigate to a URL and click a link/button matched by visible text or CSS selector. If the target domain's trust score is below the configured threshold, this stages the action and returns a confirmation id instead of acting — ask the user, then call confirm_action.",
      inputSchema: {
        url: urlStr,
        matchText: shortStr.optional(),
        selector: shortStr.optional(),
        mentionedBrands: brandsArr.optional(),
      },
    },
    guarded("click_on_page", async ({ url, matchText, selector, mentionedBrands }) => {
      const trust = await scoreDomain(url, { mentionedBrands, owner });
      const threshold = trustThreshold();
      const run = () => clickElement({ url, matchText, selector });

      if (trust.score >= threshold) {
        await logEvent({ action: "click_auto_approved", ...o, url, trustScore: trust.score });
        return { autoApproved: true, trust, result: await run() };
      }
      const id = stageAction(`Click on ${url}`, run, { domain: trust.domain, kind: "click", url }, owner);
      await logEvent({ action: "click_staged_for_confirmation", ...o, url, trustScore: trust.score, confirmationId: id });
      return {
        autoApproved: false,
        trust,
        confirmationId: id,
        message:
          `This site scored ${trust.score}/100 trust (${trust.verdict}): ${trust.reasons.join("; ")}. ` +
          `Ask the user for explicit confirmation, then call confirm_action with confirmationId="${id}" ` +
          `(or reject_action with the same id if they decline).`,
      };
    })
  );

  server.registerTool(
    "download_file",
    {
      title: "Download a file",
      description: remote
        ? "Navigate to a URL and click a download trigger (or fetch a direct file URL), then verify the downloaded file's signature and size before returning its hash and a downloadId (retrieve the bytes with fetch_download). If the source domain's trust score is below threshold, this stages the action and returns a confirmation id instead of downloading — ask the user, then call confirm_action."
        : "Navigate to a URL and click a download trigger (or fetch a direct file URL), then verify the downloaded file's signature and size before returning its local path and hash. If the source domain's trust score is below threshold, this stages the action and returns a confirmation id instead of downloading — ask the user, then call confirm_action.",
      inputSchema: {
        url: urlStr.optional(),
        directUrl: urlStr.optional(),
        matchText: shortStr.optional(),
        selector: shortStr.optional(),
        mentionedBrands: brandsArr.optional(),
      },
    },
    guarded("download_file", async ({ url, directUrl, matchText, selector, mentionedBrands }) => {
      const target = directUrl || url;
      if (remote && !target) throw new Error("Provide url or directUrl");
      const trust = await scoreDomain(target, { mentionedBrands, owner });
      const threshold = trustThreshold();
      const run = async () => finalizeDownload(await downloadFile({ url, directUrl, matchText, selector }));

      if (trust.score >= threshold) {
        const result = await run();
        await logEvent({
          action: "download_auto_approved",
          ...o,
          url: target,
          trustScore: trust.score,
          fileOk: result.ok,
          sha256: result.sha256,
        });
        return { autoApproved: true, trust, result };
      }
      const id = stageAction(`Download from ${target}`, run, { domain: trust.domain, kind: "download", url: target }, owner);
      await logEvent({ action: "download_staged_for_confirmation", ...o, url: target, trustScore: trust.score, confirmationId: id });
      return {
        autoApproved: false,
        trust,
        confirmationId: id,
        message:
          `This source scored ${trust.score}/100 trust (${trust.verdict}): ${trust.reasons.join("; ")}. ` +
          `Ask the user for explicit confirmation before downloading anything from it, then call ` +
          `confirm_action with confirmationId="${id}" (or reject_action with the same id if they decline).`,
      };
    })
  );

  if (remote) {
    server.registerTool(
      "fetch_download",
      {
        title: "Retrieve a downloaded file",
        description:
          "Return the content of a file previously saved by download_file (identified by downloadId) as an embedded resource. " +
          "Only files downloaded by this same client can be retrieved. Larger files must be fetched over HTTP at /downloads/<downloadId>.",
        inputSchema: { downloadId: idStr },
      },
      async ({ downloadId }) => {
        try {
          const entry = getDownload(downloadId, owner);
          if (!entry) return errorResult("Unknown or expired downloadId.");
          if (entry.bytes > config.MAX_INLINE_DOWNLOAD_BYTES) {
            return errorResult(
              `File is ${entry.bytes} bytes, above the inline limit of ${config.MAX_INLINE_DOWNLOAD_BYTES}. ` +
                `Fetch it over HTTP: GET /downloads/${downloadId} with your bearer token.`
            );
          }
          const buf = await readFile(entry.path);
          if (createHash("sha256").update(buf).digest("hex") !== entry.sha256) {
            return errorResult("Integrity check failed: file changed on disk after verification.");
          }
          const mimeType = mimeFor(entry.safeName);
          await logEvent({ action: "download_retrieved", owner, downloadId, bytes: buf.length });
          const meta = { type: "text", text: JSON.stringify({ filename: entry.safeName, mimeType, bytes: buf.length, sha256: entry.sha256 }) };
          const data = buf.toString("base64");
          return {
            content: [
              meta,
              mimeType.startsWith("image/")
                ? { type: "image", data, mimeType }
                : { type: "resource", resource: { uri: `syncralis-download://${downloadId}`, mimeType, blob: data } },
            ],
          };
        } catch (err) {
          return errorResult(String(err?.message || err).slice(0, 500));
        }
      }
    );
  }

  server.registerTool(
    "fetch_updates",
    {
      title: "Fetch official updates across platforms",
      description:
        "Fetch the latest updates/announcements from an entity (e.g. a government ministry, company, or organization) across the open web and, where configured, official X/Instagram APIs. " +
        "Without API tokens configured, X/Instagram results are best-effort web searches, not guaranteed live feed reads — the response says which method was used for each platform.",
      inputSchema: {
        entity: shortStr,
        platforms: (remote ? platformsArr.max(3) : platformsArr).optional(),
        mentionedBrands: brandsArr.optional(),
      },
    },
    guarded("fetch_updates", (args) => fetchUpdates(args))
  );

  server.registerTool(
    "confirm_action",
    {
      title: "Confirm a staged action",
      description:
        "Run a previously staged click/download action after the user has explicitly approved it. " +
        "This also records the approval in local trust memory, so a domain the user repeatedly and " +
        "explicitly approves may eventually be auto-approved without asking again (see SECURITY.md).",
      inputSchema: { confirmationId: idStr },
    },
    guarded("confirm_action", async ({ confirmationId }) => {
      const result = await confirmAction(confirmationId, owner);
      if (result.ok) {
        await recordTrustMemoryDecision(result.meta, "confirmed", confirmationId);
      }
      return result;
    })
  );

  server.registerTool(
    "reject_action",
    {
      title: "Reject a staged action",
      description:
        "Explicitly decline a previously staged click/download action so it will never run. Use this " +
        "whenever the user says no to a confirmation request, rather than simply letting it expire — " +
        "an explicit rejection is recorded in local trust memory and makes this domain LESS likely to " +
        "be auto-approved in the future, whereas an expired-but-never-answered request has no effect " +
        "either way.",
      inputSchema: { confirmationId: idStr },
    },
    guarded("reject_action", async ({ confirmationId }) => {
      const staged = peekAction(confirmationId, owner);
      const removed = rejectAction(confirmationId, owner);
      if (removed && staged?.meta) {
        await recordTrustMemoryDecision(staged.meta, "rejected", confirmationId);
      }
      await logEvent({ action: "action_rejected", ...o, confirmationId, removed }).catch(() => {});
      return { ok: removed, confirmationId };
    })
  );

  server.registerTool(
    "list_pending_actions",
    {
      title: "List actions awaiting confirmation",
      description: "List all staged actions currently awaiting user confirmation.",
      inputSchema: {},
    },
    guarded("list_pending_actions", async () => listPending(owner))
  );

  return server;
}

/** stdio entrypoint (local MCP clients such as Claude Desktop / Cursor). */
export async function startServer() {
  const server = buildServer({ owner: "local", remote: false });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = async () => {
    await shutdownBrowser();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("unhandledRejection", async (reason) => {
    console.error("[syncralis-web-agent] unhandled rejection:", reason);
    await logEvent({
      action: "unhandled_rejection",
      error: String(reason?.message || reason),
    }).catch(() => {});
  });

  process.on("uncaughtException", async (err) => {
    console.error("[syncralis-web-agent] uncaught exception, shutting down:", err);
    await logEvent({ action: "uncaught_exception", error: String(err?.message || err) }).catch(
      () => {}
    );
    await shutdownBrowser().catch(() => {});
    process.exit(1);
  });
}
