/**
 * `recall_memory` MCP tool.
 *
 * Performs a semantic search across one of the four Uberwal namespaces
 * (`sessions`, `skills`, `productivity`, `reports`) and returns the matching
 * entries with their `blob_id`, `text`, and `distance` score plus a `total`
 * count.
 *
 * Behaviour, in order:
 *
 *   1. **Per-tool relayer health gate (Requirement 14.3, 14.4).** Verifies
 *      MemWal connectivity via {@link MemWalClient.isHealthy} with a 5-second
 *      timeout before any memory operation. A failed gate returns an error
 *      result indicating the relayer is unavailable; the recall is never
 *      attempted.
 *
 *   2. **Validation (Requirement 2.6, 2.7) and clamping (2.2, 2.3).** Most
 *      validation is enforced by the input schema below — `query` must be a
 *      non-empty string, `namespace` must be one of the four allowed
 *      identifiers, `limit` is constrained to `[1, 100]`, and `maxDistance`
 *      to `[0, 1]`. The {@link MemWalClient.recall} call adds a second-line
 *      whitespace-only query check (which the `min(1)` schema rule cannot
 *      catch) and clamps `limit`/`maxDistance` with the documented defaults
 *      (10 and 1).
 *
 *   3. **Recall + normalization (Requirement 2.1, 2.4).** Forwards to the
 *      MemWal SDK and returns each entry as `{blob_id, text, distance}` plus
 *      `total`.
 *
 *   4. **Empty-result message (Requirement 2.5).** When no entries land
 *      within `maxDistance`, returns `{results: [], total, message}` with a
 *      human-readable message naming the namespace and query.
 *
 *   5. **Service-unavailable / failure messaging (Requirement 2.8).** If the
 *      health gate fails or the underlying SDK call rejects, the response is
 *      flagged as an error (`isError: true`) so MCP clients can surface it
 *      to the user without proceeding.
 *
 * The tool input schema is exported as a Zod raw shape; the MCP SDK
 * serializes it to JSON Schema for the wire protocol per the MCP spec, which
 * matches the JSON Schema shape documented in `design.md`'s Data Models
 * section.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 14.3, 14.4
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { NAMESPACES, type Namespace, type RecallParams } from "@uberwal/shared";

import type { ToolDeps } from "./register.js";

/** Per-tool health-gate timeout (Requirement 14.3). */
const TOOL_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Input schema for `recall_memory`, expressed as a Zod raw shape.
 *
 * The MCP SDK accepts either a Zod schema or a Zod raw shape on
 * `registerTool`'s `inputSchema` field, and converts it into JSON Schema
 * before publishing it to the client. The shape below mirrors the schema
 * documented in `design.md`:
 *
 * ```json
 * {
 *   "query":       { "type": "string", "minLength": 1 },
 *   "namespace":   { "type": "string", "enum": ["sessions","skills","productivity","reports"] },
 *   "limit":       { "type": "number", "minimum": 1, "maximum": 100, "default": 10 },
 *   "maxDistance": { "type": "number", "minimum": 0, "maximum": 1, "default": 1 }
 * }
 * ```
 *
 * `limit` and `maxDistance` remain optional at the schema level because the
 * `MemWalClient.recall` wrapper applies defaults (10 and 1) and clamps
 * out-of-band values via {@link clampLimit}/{@link clampMaxDistance}. The
 * `.describe(...)` calls become the JSON Schema `description` fields, which
 * is what MCP clients show users when documenting the tool.
 */
export const RECALL_MEMORY_INPUT_SHAPE = {
  query: z
    .string()
    .min(1, "Query is required and must contain at least one non-whitespace character.")
    .describe("Free-text recall query."),
  namespace: z
    .enum(NAMESPACES)
    .describe(
      "Namespace to search. One of sessions, skills, productivity, reports.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of results to return. Range 1–100; defaults to 10."),
  maxDistance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Distance threshold for filtering results. Range 0–1; defaults to 1 " +
        "(no upper-distance filtering — return all ranked matches). " +
        "Lower values keep only closer matches.",
    ),
} as const;

/**
 * Strongly-typed input expected by {@link recallMemoryHandler}.
 *
 * Inferred from the Zod raw shape so the handler stays in lockstep with the
 * published input schema.
 */
export type RecallMemoryInput = {
  query: string;
  namespace: Namespace;
  limit?: number;
  maxDistance?: number;
};

/**
 * Build a successful tool response containing JSON-serialized recall data.
 *
 * The MCP `text` content type carries arbitrary text; we serialize the
 * response payload as JSON with two-space indentation so MCP clients (and
 * humans inspecting transcripts) can read it directly. The top-level shape
 * matches `RecallOutput` from `design.md`'s Data Models section.
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
 * result. Used for the relayer-unavailable case (Requirement 2.8) and for
 * any unexpected SDK-side failure during recall.
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
 * Execute the `recall_memory` tool.
 *
 * Exported separately from the registration helper so unit tests can call
 * the handler directly with a stub {@link ToolDeps} without going through
 * the MCP transport layer.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 14.3, 14.4
 */
export async function recallMemoryHandler(
  deps: ToolDeps,
  input: RecallMemoryInput,
): Promise<CallToolResult> {
  // 1. Per-tool relayer health gate (Requirement 14.3). The wrapper's
  //    `isHealthy` swallows network errors and timeouts and resolves to
  //    `false`, so a single boolean check is sufficient.
  const healthy = await deps.memwal.isHealthy(TOOL_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    // Requirement 2.8 / 14.4: surface a clear "service unavailable" error
    // without attempting the recall.
    return errorResult(
      "The MemWal relayer is unavailable. Please try again once connectivity is restored.",
    );
  }

  // 2. Build the recall params, omitting optional fields when absent so
  //    `exactOptionalPropertyTypes` is satisfied and the wrapper's defaults
  //    (limit=10, maxDistance=1) take effect cleanly.
  const recallParams: RecallParams = {
    query: input.query,
    namespace: input.namespace,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.maxDistance !== undefined ? { maxDistance: input.maxDistance } : {}),
  };

  // 3. Recall via the shared wrapper. The wrapper validates namespace +
  //    query (Requirements 2.6, 2.7) and clamps limit + maxDistance
  //    (Requirements 2.2, 2.3) before reaching the SDK. Any thrown Error is
  //    surfaced as a tool-level error result instead of crashing the
  //    server.
  let recallResult: Awaited<ReturnType<typeof deps.memwal.recall>>;
  try {
    recallResult = await deps.memwal.recall(recallParams);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Recall failed: ${message}`);
  }

  // 4. Empty-result message (Requirement 2.5). Still returned as a
  //    success payload (no `isError` flag) so callers can distinguish "no
  //    matches" from "operation failed".
  if (recallResult.results.length === 0) {
    return successResult({
      results: [],
      total: recallResult.total,
      message: `No relevant memories found in '${input.namespace}' for query "${input.query}".`,
    });
  }

  // 5. Normal results (Requirement 2.4). The wrapper has already
  //    normalized each entry into `{blob_id, text, distance}`.
  return successResult({
    results: recallResult.results,
    total: recallResult.total,
  });
}

/**
 * Register `recall_memory` against the supplied MCP server.
 *
 * Called from `registerTools` in `register.ts`. Kept as its own exported
 * helper so the central registration file stays a flat list of tool wires
 * and tests can register the tool against a stub server in isolation.
 */
export function registerRecallMemoryTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "recall_memory",
    {
      title: "Recall memory",
      description:
        "Semantic search across a Uberwal namespace (sessions, skills, productivity, reports). " +
        "Returns up to `limit` matches whose distance score is below `maxDistance`, plus the total count. " +
        "Returns an empty-result message when no entries match.",
      inputSchema: RECALL_MEMORY_INPUT_SHAPE,
    },
    async (args) => recallMemoryHandler(deps, args as RecallMemoryInput),
  );
}
