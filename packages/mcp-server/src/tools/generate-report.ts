/**
 * `generate_report` MCP tool.
 *
 * Aggregates the developer's stored skills and productivity entries into a
 * single prose report, persists the result in the `reports` namespace, and
 * returns the summary to the caller.
 *
 * Behaviour, in order:
 *
 *   1. **Per-tool relayer health gate (Requirements 14.3, 14.4).** Verifies
 *      MemWal connectivity via {@link MemWalClient.isHealthy} with a
 *      5-second timeout before any memory operation. A failed gate returns
 *      an error result and no recall, summarization, or write is attempted.
 *
 *   2. **Recall both namespaces concurrently (Requirement 5.1).** Issues
 *      `recall` against `skills` and `productivity` in parallel with
 *      `limit: 50`. The recall queries are fixed (`"skill highlights"` and
 *      `"productivity patterns"`) so the result is reproducible across
 *      invocations and produces a broad-but-bounded slice of each
 *      namespace.
 *
 *   3. **Not-enough-data gate (Requirement 5.5).** If the combined number
 *      of recalled entries is strictly less than 3, the tool returns a
 *      success-shaped response (no `isError`) carrying a human-readable
 *      message indicating insufficient data; nothing is summarized or
 *      stored.
 *
 *   4. **Summarization (Requirement 5.2).** Otherwise, calls
 *      {@link Extractor.summarizeReport} with the `text` field of every
 *      recalled entry. The extractor is responsible for using
 *      `claude-sonnet-4-20250514` and producing prose that covers skill
 *      highlights and productivity patterns.
 *
 *   5. **Summarization failure (Requirement 5.6).** Any failure raised by
 *      the extractor surfaces as an error result with a clear
 *      "report could not be generated" message. Per the requirement, no
 *      partial data is stored — the `reports` namespace is left
 *      untouched.
 *
 *   6. **Persist the report (Requirement 5.3).** On a successful summary,
 *      stores the summary text in the `reports` namespace via
 *      `rememberAndWait`. If the persistence call itself fails, the error
 *      is surfaced and the summary is *not* returned, since Requirement
 *      5.4 specifies "WHEN the report is stored". Returning a summary
 *      that did not actually land in MemWal would mislead the caller.
 *
 *   7. **Return the summary (Requirement 5.4).** On success the response
 *      carries the prose summary plus the stored entry's `blob_id` so the
 *      caller can cross-reference it later.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 14.3, 14.4
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { MemWalClient, RecallResult, StoredRef } from "@uberwal/shared";

import type { Extractor } from "../extraction/extractor.js";

import type { ToolDeps } from "./register.js";

/** Per-tool health-gate timeout (Requirement 14.3). */
const TOOL_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Number of entries recalled per namespace (Requirement 5.1: "up to 50").
 * Kept as a named constant so the design rationale is visible in one place
 * rather than inlined as a magic number.
 */
const REPORT_RECALL_LIMIT = 50;

/**
 * Minimum combined entry count required to attempt summarization
 * (Requirement 5.5: "fewer than 3 entries"). Combined means
 * `skills.length + productivity.length`, not unique entries — the
 * requirement does not call for de-duplication.
 */
const MIN_COMBINED_ENTRIES = 3;

/**
 * Recall queries used for the report aggregation. These are stable, broad
 * phrases that lean on MemWal's semantic search to surface a wide slice of
 * each namespace. Both recalls pass `maxDistance: 1` explicitly (no
 * upper-distance filtering) so the report aggregates every stored entry the
 * SDK ranks rather than dropping rows past a relevance threshold.
 */
const SKILLS_RECALL_QUERY = "developer skills tools techniques used";
const PRODUCTIVITY_RECALL_QUERY = "productivity patterns";

/**
 * Input schema for `generate_report`. The tool takes no parameters — it
 * always recalls from `skills` and `productivity` with the fixed queries
 * above. Declaring an empty Zod raw shape keeps the published JSON Schema
 * `{ "type": "object", "properties": {} }` so MCP clients still surface a
 * valid (empty) input form.
 */
export const GENERATE_REPORT_INPUT_SHAPE = {} as const;

/**
 * Strongly-typed input expected by {@link generateReportHandler}. The tool
 * accepts no parameters, so the type is an empty record. Declaring it
 * explicitly (rather than `void`) keeps the handler signature uniform with
 * the other tools and lets future parameters land here without rewriting
 * the call sites.
 */
export type GenerateReportInput = Record<string, never>;

/**
 * Successful tool response. Carries the prose summary plus the `blob_id`
 * of the stored `reports` entry so callers can cross-reference it. Both
 * unstructured `content` (for human/text MCP clients) and
 * `structuredContent` (for clients that prefer typed output) are
 * populated.
 */
function successResult(payload: { summary: string; blob_id: string }): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: { result: payload } as unknown as { [key: string]: unknown },
  };
}

/**
 * Not-enough-data response. Returned as a *success*-shaped tool result (no
 * `isError`) per Requirement 5.5 — the operation completed without error,
 * there simply was not enough material to summarize. The structured
 * payload makes the gating decision machine-readable so a UI could, for
 * example, show a "store more sessions first" prompt.
 */
function notEnoughDataResult(combined: number): CallToolResult {
  const payload = {
    enoughData: false,
    combinedEntries: combined,
    minimumRequired: MIN_COMBINED_ENTRIES,
    message:
      `Not enough data to generate a report: found ${combined} combined entries across ` +
      `the skills and productivity namespaces, but at least ${MIN_COMBINED_ENTRIES} are required.`,
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: { result: payload } as unknown as { [key: string]: unknown },
  };
}

/**
 * Error tool response with `isError: true`. Used for the relayer-health
 * short-circuit (Requirement 14.4), recall failures, summarization
 * failures (Requirement 5.6), and persistence failures.
 */
function errorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

/**
 * Dependencies needed by {@link generateReportHandler}. Carved out of the
 * full {@link ToolDeps} bundle so unit and property tests can inject
 * narrow stubs (a fake `MemWalClient` and a fake `Extractor`) without
 * standing up the full server context.
 */
export interface GenerateReportDeps {
  readonly memwal: MemWalClient;
  readonly extractor: Extractor;
}

/**
 * Execute the `generate_report` tool.
 *
 * Exported separately from the registration helper so unit tests and
 * Property 7 (report gating by entry count) can call the handler directly
 * with stub dependencies instead of going through the MCP transport
 * layer.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 14.3, 14.4
 */
export async function generateReportHandler(
  deps: GenerateReportDeps,
): Promise<CallToolResult> {
  // 1. Per-tool relayer health gate (Requirement 14.3). The wrapper's
  //    `isHealthy` swallows network errors and timeouts and resolves to a
  //    boolean, so a single check is sufficient.
  const healthy = await deps.memwal.isHealthy(TOOL_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    return errorResult(
      "The MemWal relayer is unavailable. The report could not be generated — please " +
        "retry once connectivity is restored.",
    );
  }

  // 2. Recall both namespaces concurrently (Requirement 5.1). `Promise.all`
  //    propagates the first rejection; either failure is surfaced as a
  //    recall error without attempting summarization.
  let skillsResult: RecallResult;
  let productivityResult: RecallResult;
  try {
    [skillsResult, productivityResult] = await Promise.all([
      deps.memwal.recall({
        namespace: "skills",
        query: SKILLS_RECALL_QUERY,
        limit: REPORT_RECALL_LIMIT,
        maxDistance: 1,
      }),
      deps.memwal.recall({
        namespace: "productivity",
        query: PRODUCTIVITY_RECALL_QUERY,
        limit: REPORT_RECALL_LIMIT,
        maxDistance: 1,
      }),
    ]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Recall failed while gathering report inputs: ${reason}`);
  }

  // 3. Not-enough-data gate (Requirement 5.5). The requirement counts
  //    combined entries across both namespaces; we do not deduplicate,
  //    since two near-identical entries still represent two stored
  //    memories.
  const combined = skillsResult.results.length + productivityResult.results.length;
  if (combined < MIN_COMBINED_ENTRIES) {
    return notEnoughDataResult(combined);
  }

  // 4. Summarize via Claude (Requirement 5.2). The extractor receives the
  //    `text` field of each recalled entry, in recall order, so the prompt
  //    sees the most semantically relevant items first.
  const skillsTexts = skillsResult.results.map((entry) => entry.text);
  const productivityTexts = productivityResult.results.map((entry) => entry.text);

  let summary: string;
  try {
    summary = await deps.extractor.summarizeReport(skillsTexts, productivityTexts);
  } catch (err) {
    // 5. Summarization failure (Requirement 5.6). No storage is attempted —
    //    the `reports` namespace stays untouched.
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(
      `The report could not be generated due to a summarization failure: ${reason}`,
    );
  }

  // The extractor already trims its output and rejects empty summaries, but
  // a defensive check here keeps the contract local: we never write a blank
  // entry into `reports`.
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return errorResult(
      "The report could not be generated due to a summarization failure: " +
        "the summarizer returned an empty result.",
    );
  }

  // 6. Persist the report (Requirement 5.3). Failures here are surfaced
  //    rather than swallowed — the caller relies on the returned
  //    `blob_id` to find the stored entry, and Requirement 5.4 phrases
  //    the return as "WHEN the report is stored". A summary returned
  //    despite a failed write would mislead the caller.
  let stored: StoredRef;
  try {
    stored = await deps.memwal.remember(summary, "reports");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`The report was generated but could not be stored: ${reason}`);
  }

  // 7. Return the prose summary alongside the stored entry's blob id.
  return successResult({ summary, blob_id: stored.blob_id });
}

/**
 * Register `generate_report` against the supplied MCP server.
 *
 * Called from `registerTools` in `register.ts`. Kept as its own exported
 * helper so the central registration file stays a flat list of tool wires
 * and tests can register the tool against a stub server in isolation.
 *
 * The output schema below is intentionally permissive: a successful run
 * returns `{ summary, blob_id }`; the not-enough-data branch returns
 * `{ enoughData, combinedEntries, minimumRequired, message }`. Both
 * shapes are valid tool outputs, so we publish a discriminated union via
 * `z.union`. Clients that only care about the prose summary can read the
 * unstructured `content[0].text` payload, which mirrors the structured
 * content as JSON.
 */
export function registerGenerateReportTool(server: McpServer, deps: ToolDeps): void {
  const successOutput = z.object({
    summary: z
      .string()
      .describe("Prose report covering skill highlights and productivity patterns."),
    blob_id: z
      .string()
      .describe("Identifier of the stored entry in the `reports` namespace."),
  });

  const notEnoughDataOutput = z.object({
    enoughData: z.literal(false),
    combinedEntries: z.number().int().nonnegative(),
    minimumRequired: z.number().int().positive(),
    message: z.string(),
  });

  // Publishing the union as the top-level output schema keeps the MCP
  // client able to validate either branch without resorting to ad-hoc
  // discrimination on the unstructured text payload.
  const generateReportOutputShape = {
    result: z
      .union([successOutput, notEnoughDataOutput])
      .describe(
        "Either the generated report (summary + stored blob_id) or a not-enough-data " +
          "response when fewer than three combined entries are available.",
      ),
  } as const;

  server.registerTool(
    "generate_report",
    {
      title: "Generate report",
      description:
        "Aggregate up to 50 entries each from the `skills` and `productivity` namespaces " +
        "and summarize them into a single prose report covering skill highlights and " +
        "productivity patterns. Stores the result in the `reports` namespace and returns " +
        "the summary. When fewer than 3 combined entries are available, returns a " +
        "not-enough-data message and stores nothing. Performs a 5-second MemWal relayer " +
        "health gate before any memory operation.",
      inputSchema: GENERATE_REPORT_INPUT_SHAPE,
      outputSchema: generateReportOutputShape,
    },
    async () => generateReportHandler({ memwal: deps.memwal, extractor: deps.extractor }),
  );
}
