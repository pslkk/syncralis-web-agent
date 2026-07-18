import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { config } from "./config.js";
import { webSearch } from "./tools/search.js";
import { openPage } from "./tools/openPage.js";
import { clickElement } from "./tools/clickElement.js";
import { downloadFile } from "./tools/downloadFile.js";
import { fetchUpdates } from "./tools/fetchUpdates.js";
import { researchQuery } from "./orchestrator.js";
import { trustThreshold, scoreDomain } from "./trust.js";
import { stageAction, confirmAction, listPending } from "./confirmations.js";
import { shutdownBrowser } from "./browser.js";
import { logEvent } from "./security/auditLog.js";

function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export async function startServer() {
  const server = new McpServer({
    name: "syncralis-web-agent",
    version: "1.2.4",
  });


  server.registerTool(
    "web_search",
    {
      title: "Web search",
      description:
        "Search the web and return candidate result URLs, each with a trust score (0-100) and reasons.",
      inputSchema: {
        query: z.string(),
        mentionedBrands: z.array(z.string()).optional(),
        maxResults: z.number().int().min(1).max(20).optional(),
      },
    },
    async (args) => json(await webSearch(args))
  );

  server.registerTool(
    "open_page",
    {
      title: "Open page and extract content",
      description:
        "Open a URL in a real browser, score its trust, and return the page title, visible text, and a list of clickable elements.",
      inputSchema: {
        url: z.string(),
        mentionedBrands: z.array(z.string()).optional(),
      },
    },
    async (args) => json(await openPage(args))
  );

  server.registerTool(
    "research_query",
    {
      title: "Multi-agent research",
      description:
        "Fan out multiple parallel sub-agents to search, trust-score, and read the top candidate sources for a query, returning a ranked bundle with each source's trust level and content preview. Use this for 'find and summarize' style requests.",
      inputSchema: {
        query: z.string(),
        mentionedBrands: z.array(z.string()).optional(),
        topN: z.number().int().min(1).max(10).optional(),
      },
    },
    async (args) => json(await researchQuery(args))
  );


  server.registerTool(
    "click_on_page",
    {
      title: "Click an element on a page",
      description:
        "Navigate to a URL and click a link/button matched by visible text or CSS selector. If the target domain's trust score is below the configured threshold, this stages the action and returns a confirmation id instead of acting — ask the user, then call confirm_action.",
      inputSchema: {
        url: z.string(),
        matchText: z.string().optional(),
        selector: z.string().optional(),
        mentionedBrands: z.array(z.string()).optional(),
      },
    },
    async ({ url, matchText, selector, mentionedBrands }) => {
      const trust = scoreDomain(url, { mentionedBrands });
      const threshold = trustThreshold();
      const run = () => clickElement({ url, matchText, selector });

      if (trust.score >= threshold) {
        await logEvent({ action: "click_auto_approved", url, trustScore: trust.score });
        return json({ autoApproved: true, trust, result: await run() });
      }
      const id = stageAction(`Click on ${url}`, run);
      await logEvent({ action: "click_staged_for_confirmation", url, trustScore: trust.score, confirmationId: id });
      return json({
        autoApproved: false,
        trust,
        confirmationId: id,
        message:
          `This site scored ${trust.score}/100 trust (${trust.verdict}): ${trust.reasons.join("; ")}. ` +
          `Ask the user for explicit confirmation, then call confirm_action with confirmationId="${id}".`,
      });
    }
  );

  server.registerTool(
    "download_file",
    {
      title: "Download a file",
      description:
        "Navigate to a URL and click a download trigger (or fetch a direct file URL), then verify the downloaded file's signature and size before returning its local path and hash. If the source domain's trust score is below threshold, this stages the action and returns a confirmation id instead of downloading — ask the user, then call confirm_action.",
      inputSchema: {
        url: z.string().optional(),
        directUrl: z.string().optional(),
        matchText: z.string().optional(),
        selector: z.string().optional(),
        mentionedBrands: z.array(z.string()).optional(),
      },
    },
    async ({ url, directUrl, matchText, selector, mentionedBrands }) => {
      const target = directUrl || url;
      const trust = scoreDomain(target, { mentionedBrands });
      const threshold = trustThreshold();
      const run = () => downloadFile({ url, directUrl, matchText, selector });

      if (trust.score >= threshold) {
        const result = await run();
        await logEvent({
          action: "download_auto_approved",
          url: target,
          trustScore: trust.score,
          fileOk: result.ok,
          sha256: result.sha256,
        });
        return json({ autoApproved: true, trust, result });
      }
      const id = stageAction(`Download from ${target}`, run);
      await logEvent({ action: "download_staged_for_confirmation", url: target, trustScore: trust.score, confirmationId: id });
      return json({
        autoApproved: false,
        trust,
        confirmationId: id,
        message:
          `This source scored ${trust.score}/100 trust (${trust.verdict}): ${trust.reasons.join("; ")}. ` +
          `Ask the user for explicit confirmation before downloading anything from it, then call confirm_action with confirmationId="${id}".`,
      });
    }
  );

  server.registerTool(
    "fetch_updates",
    {
      title: "Fetch official updates across platforms",
      description:
        "Fetch the latest updates/announcements from an entity (e.g. a government ministry, company, or organization) across the open web and, where configured, official X/Instagram APIs. " +
        "Without API tokens configured, X/Instagram results are best-effort web searches, not guaranteed live feed reads — the response says which method was used for each platform.",
      inputSchema: {
        entity: z.string(),
        platforms: z.array(z.enum(["web", "x", "instagram"])).optional(),
        mentionedBrands: z.array(z.string()).optional(),
      },
    },
    async (args) => json(await fetchUpdates(args))
  );

  server.registerTool(
    "confirm_action",
    {
      title: "Confirm a staged action",
      description:
        "Run a previously staged click/download action after the user has explicitly approved it.",
      inputSchema: { confirmationId: z.string() },
    },
    async ({ confirmationId }) => json(await confirmAction(confirmationId))
  );

  server.registerTool(
    "list_pending_actions",
    {
      title: "List actions awaiting confirmation",
      description: "List all staged actions currently awaiting user confirmation.",
      inputSchema: {},
    },
    async () => json(listPending())
  );

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
