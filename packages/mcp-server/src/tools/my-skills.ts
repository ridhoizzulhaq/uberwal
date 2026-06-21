/**
 * `my_skills` MCP tool — recall shortcut for the `skills` namespace.
 *
 * A thin convenience wrapper over `recall_memory` that pins the namespace
 * to `skills` and the result limit to 10, and substitutes a broad default
 * query (`"skills and technologies"`) when the caller omits one. The
 * response shape is identical to `recall_memory` so MCP clients can render
 * results uniformly across tools (Requirement 3.1).
 *
 * Behaviour, in order:
 *
 *   1. **Per-tool relayer health gate (Requirement 14.3, 14.4).** Verifies
 *      MemWal connectivity via {@link MemWalClient.isHealthy} with a
 *      5-second timeout before any memory operation. A failed gate returns
 *      a recall-failure error result; the recall is never attempted.
 *
 *   2. **Default query substitution (Requirement 3.2).** When the caller
 *      provides no `query` (omitted, empty, or whitespace-only), the tool
 *      uses the fixed broad-purpose query
 *      `"skills and technologies"` so the shortcut behaves like a "show me
 *      my skills" command without requiring the user to type anything.
 *
 *   3. **Recall (Requirement 3.1).** Forwards to
 *      {@link MemWalClient.recall} with `namespace: "skills"`,
 *      `limit: 10`, and the resolved query. The wrapper validates the
 *      query, clamps the limit/maxDistance, and normalizes the response.
 *
 *   4. **Unified output (Requirement 3.1).** Returns the recall payload as
 *      the same `{results, total, message?}` shape used by `recall_memory`,
 *      including an empty-result message naming the `skills` namespace
 *      when no entries match.
 *
 *   5. **Recall failure (Requirement 3.3).** If the health gate fails or
 *      the underlying SDK call rejects, the response is flagged as an
 *      error (`isError: true`) with a message that explicitly references
 *      the skills recall so MCP clients can surface it to the user.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 14.3, 14.4
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
 * (Requirement 3.2). The phrase is intentionally broad so semantic recall
 * surfaces a representative sample of stored skill facts.
 */
const DEFAULT_QUERY = "skills and technologies";

/** Fixed result limit for the shortcut (Requirement 3.1, 3.2). */
const DEFAULT_LIMIT = 10;

/**
 * Input schema for `my_skills`, expressed as a Zod raw shape.
 *
 * `query` is optional — when absent the handler substitutes
 * {@link DEFAULT_QUERY}. We intentionally accept whitespace-only strings at
 * the schema layer (no `min(1)`) so the handler can apply the same "treat
 * blank as missing" policy and substitute the default, matching
 * Requirement 3.2's wording.
 */
export const MY_SKILLS_INPUT_SHAPE = {
  query: z
    .string()
    .optional()
    .describe(
      "Optional natural-language query. When omitted (or blank), the tool " +
        "uses the broad default query \"skills and technologies\".",
    ),
} as const;

/**
 * Strongly-typed input expected by {@link mySkillsHandler}.
 *
 * Inferred from the Zod raw shape so the handler stays in lockstep with
 * the published input schema.
 */
export type MySkillsInput = {
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
 * SDK-side failure during the skills recall (Requirement 3.3).
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
 * {@link DEFAULT_QUERY} (Requirement 3.2). All other inputs are forwarded
 * verbatim to {@link MemWalClient.recall}, which will validate them again
 * before reaching the SDK.
 */
function resolveQuery(query: string | undefined): string {
  return isValidQuery(query) ? (query as string) : DEFAULT_QUERY;
}

/**
 * Execute the `my_skills` tool.
 *
 * Exported separately from the registration helper so unit tests can call
 * the handler directly with a stub {@link ToolDeps} without going through
 * the MCP transport layer.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 14.3, 14.4
 */
export async function mySkillsHandler(
  deps: ToolDeps,
  input: MySkillsInput,
): Promise<CallToolResult> {
  // 1. Per-tool relayer health gate (Requirement 14.3). The wrapper's
  //    `isHealthy` swallows network errors and timeouts and resolves to
  //    `false`, so a single boolean check is sufficient.
  const healthy = await deps.memwal.isHealthy(TOOL_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    // Requirements 3.3 / 14.4: surface a recall-failure error referencing
    // the skills namespace without attempting the recall.
    return errorResult(
      "Skills recall failed: the MemWal relayer is unavailable. Please try again once connectivity is restored.",
    );
  }

  // 2. Default-query substitution (Requirement 3.2). Blank inputs become
  //    the broad default query so the shortcut works without arguments.
  const query = resolveQuery(input.query);

  // 3. Build the recall params with the fixed namespace and limit
  //    (Requirement 3.1). `maxDistance` is intentionally omitted so the
  //    wrapper applies its default of 1 (no distance filtering) — the
  //    shortcut does not expose a relevance filter.
  const recallParams: RecallParams = {
    query,
    namespace: "skills",
    limit: DEFAULT_LIMIT,
  };

  // 4. Recall via the shared wrapper. Any thrown Error (validation,
  //    network, SDK-side) is surfaced as a recall-failure error result so
  //    Requirement 3.3 is honoured uniformly.
  let recallResult: Awaited<ReturnType<typeof deps.memwal.recall>>;
  try {
    recallResult = await deps.memwal.recall(recallParams);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Skills recall failed: ${message}`);
  }

  // 5. Empty-result message — still returned as a success payload (no
  //    `isError` flag) so callers can distinguish "no matches" from
  //    "operation failed". The shape mirrors `recall_memory` for unified
  //    rendering (Requirement 3.1).
  if (recallResult.results.length === 0) {
    return successResult({
      results: [],
      total: recallResult.total,
      message: `No relevant memories found in 'skills' for query "${query}".`,
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
 * Register `my_skills` against the supplied MCP server.
 *
 * Called from `registerTools` in `register.ts`. Kept as its own exported
 * helper so the central registration file stays a flat list of tool wires
 * and tests can register the tool against a stub server in isolation.
 */
export function registerMySkillsTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "my_skills",
    {
      title: "My skills",
      description:
        "Recall shortcut for the skills namespace. Returns up to 10 matching skill " +
        "facts with their blob_id, text, and distance score plus a total count. " +
        "When `query` is omitted, uses the broad default query \"skills and technologies\".",
      inputSchema: MY_SKILLS_INPUT_SHAPE,
    },
    async (args) => mySkillsHandler(deps, args as MySkillsInput),
  );
}
