/**
 * `my_productivity` MCP tool — recall shortcut for the `productivity`
 * namespace.
 *
 * A thin convenience wrapper over `recall_memory` that pins the namespace
 * to `productivity` and the result limit to 10, and substitutes a broad
 * default query (`"productivity and output"`) when the caller omits one.
 * The response shape is identical to `recall_memory` so MCP clients can
 * render results uniformly across tools (Requirement 4.1).
 *
 * Behaviour, in order:
 *
 *   1. **Per-tool relayer health gate (Requirement 14.3, 14.4).** Verifies
 *      MemWal connectivity via {@link MemWalClient.isHealthy} with a
 *      5-second timeout before any memory operation. A failed gate returns
 *      a recall-failure error result; the recall is never attempted.
 *
 *   2. **Default query substitution (Requirement 4.2).** When the caller
 *      provides no `query` (omitted, empty, or whitespace-only), the tool
 *      uses the fixed broad-purpose query `"productivity and output"` so
 *      the shortcut behaves like a "show me my productivity" command
 *      without requiring the user to type anything.
 *
 *   3. **Recall (Requirement 4.1).** Forwards to
 *      {@link MemWalClient.recall} with `namespace: "productivity"`,
 *      `limit: 10`, and the resolved query. The wrapper validates the
 *      query, clamps the limit/maxDistance, and normalizes the response.
 *
 *   4. **Unified output (Requirement 4.1).** Returns the recall payload as
 *      the same `{results, total, message?}` shape used by `recall_memory`,
 *      including an empty-result message naming the `productivity`
 *      namespace when no entries match.
 *
 *   5. **Recall failure (Requirement 4.3).** If the health gate fails or
 *      the underlying SDK call rejects, the response is flagged as an
 *      error (`isError: true`) with a message that explicitly references
 *      the productivity recall so MCP clients can surface it to the user.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 14.3, 14.4
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { isValidQuery, type RecallParams } from "@uberwal/shared";

import type { ToolDeps } from "./register.js";

/** Per-tool health-gate timeout (Requirement 14.3). */
const TOOL_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Default broad-purpose query used when the caller omits `query`
 * (Requirement 4.2). The phrase is intentionally broad so semantic recall
 * surfaces a representative sample of stored productivity metrics.
 */
const DEFAULT_QUERY = "productivity and output";

/** Fixed result limit for the shortcut (Requirement 4.1, 4.2). */
const DEFAULT_LIMIT = 10;

/**
 * Input schema for `my_productivity`, expressed as a Zod raw shape.
 *
 * `query` is optional — when absent the handler substitutes
 * {@link DEFAULT_QUERY}. We intentionally accept whitespace-only strings at
 * the schema layer (no `min(1)`) so the handler can apply the same "treat
 * blank as missing" policy and substitute the default, matching
 * Requirement 4.2's wording.
 */
export const MY_PRODUCTIVITY_INPUT_SHAPE = {
  query: z
    .string()
    .optional()
    .describe(
      "Optional natural-language query. When omitted (or blank), the tool " +
        "uses the broad default query \"productivity and output\".",
    ),
} as const;

/**
 * Strongly-typed input expected by {@link myProductivityHandler}.
 *
 * Inferred from the Zod raw shape so the handler stays in lockstep with
 * the published input schema.
 */
export type MyProductivityInput = {
  query?: string;
};

/**
 * Build a successful tool response containing JSON-serialized recall data.
 *
 * The MCP `text` content type carries arbitrary text; we serialize the
 * response payload as JSON with two-space indentation so MCP clients (and
 * humans inspecting transcripts) can read it directly. The top-level shape
 * matches `RecallOutput` from `design.md`'s Data Models section so the
 * shortcut is wire-compatible with `recall_memory`.
 */
function successResult(payload: {
  results: { blob_id: string; text: string; distance: number }[];
  total: number;
  message?: string;
}): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Build an error tool response with `isError: true` so MCP clients surface
 * the failure to the user instead of treating it as a successful empty
 * result. Used for the relayer-unavailable case and for any unexpected
 * SDK-side failure during the productivity recall (Requirement 4.3).
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
 * Resolve the effective query for the shortcut.
 *
 * Applies the spec's "blank counts as missing" policy: any input that is
 * `undefined`, empty, or whitespace-only is replaced with
 * {@link DEFAULT_QUERY} (Requirement 4.2). All other inputs are forwarded
 * verbatim to {@link MemWalClient.recall}, which will validate them again
 * before reaching the SDK.
 */
function resolveQuery(query: string | undefined): string {
  return isValidQuery(query) ? (query as string) : DEFAULT_QUERY;
}

/**
 * Execute the `my_productivity` tool.
 *
 * Exported separately from the registration helper so unit tests can call
 * the handler directly with a stub {@link ToolDeps} without going through
 * the MCP transport layer.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 14.3, 14.4
 */
export async function myProductivityHandler(
  deps: ToolDeps,
  input: MyProductivityInput,
): Promise<CallToolResult> {
  // 1. Per-tool relayer health gate (Requirement 14.3). The wrapper's
  //    `isHealthy` swallows network errors and timeouts and resolves to
  //    `false`, so a single boolean check is sufficient.
  const healthy = await deps.memwal.isHealthy(TOOL_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    // Requirements 4.3 / 14.4: surface a recall-failure error referencing
    // the productivity namespace without attempting the recall.
    return errorResult(
      "Productivity recall failed: the MemWal relayer is unavailable. Please try again once connectivity is restored.",
    );
  }

  // 2. Default-query substitution (Requirement 4.2). Blank inputs become
  //    the broad default query so the shortcut works without arguments.
  const query = resolveQuery(input.query);

  // 3. Build the recall params with the fixed namespace and limit
  //    (Requirement 4.1). `maxDistance` is intentionally omitted so the
  //    wrapper applies its default of 1 (no distance filtering) — the
  //    shortcut does not expose a relevance filter.
  const recallParams: RecallParams = {
    query,
    namespace: "productivity",
    limit: DEFAULT_LIMIT,
  };

  // 4. Recall via the shared wrapper. Any thrown Error (validation,
  //    network, SDK-side) is surfaced as a recall-failure error result so
  //    Requirement 4.3 is honoured uniformly.
  let recallResult: Awaited<ReturnType<typeof deps.memwal.recall>>;
  try {
    recallResult = await deps.memwal.recall(recallParams);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Productivity recall failed: ${message}`);
  }

  // 5. Empty-result message — still returned as a success payload (no
  //    `isError` flag) so callers can distinguish "no matches" from
  //    "operation failed". The shape mirrors `recall_memory` for unified
  //    rendering (Requirement 4.1).
  if (recallResult.results.length === 0) {
    return successResult({
      results: [],
      total: recallResult.total,
      message: `No relevant memories found in 'productivity' for query "${query}".`,
    });
  }

  // 6. Normal results — already normalized to `{blob_id, text, distance}`
  //    by the wrapper.
  return successResult({
    results: recallResult.results,
    total: recallResult.total,
  });
}

/**
 * Register `my_productivity` against the supplied MCP server.
 *
 * Called from `registerTools` in `register.ts`. Kept as its own exported
 * helper so the central registration file stays a flat list of tool wires
 * and tests can register the tool against a stub server in isolation.
 */
export function registerMyProductivityTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "my_productivity",
    {
      title: "My productivity",
      description:
        "Recall shortcut for the productivity namespace. Returns up to 10 matching " +
        "productivity facts with their blob_id, text, and distance score plus a total count. " +
        "When `query` is omitted, uses the broad default query \"productivity and output\".",
      inputSchema: MY_PRODUCTIVITY_INPUT_SHAPE,
    },
    async (args) => myProductivityHandler(deps, args as MyProductivityInput),
  );
}
