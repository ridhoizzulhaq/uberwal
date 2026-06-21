/**
 * Unit / integration tests for the recall family of MCP tools:
 *
 *   - `recall_memory`     (`recallMemoryHandler`)
 *   - `my_skills`         (`mySkillsHandler`)
 *   - `my_productivity`   (`myProductivityHandler`)
 *
 * The handlers are exported separately from their MCP registrations so we
 * can exercise them directly with a stub {@link MemWalClient} dependency
 * — no MCP transport, no real SDK. Each test asserts on the
 * `CallToolResult` returned by the handler and, where relevant, on the
 * exact `RecallParams` the wrapper observed.
 *
 * Behaviours covered (per task 9.3):
 *
 *   1. Empty-result messaging for `recall_memory`            (Req 2.5).
 *   2. Invalid-namespace surfacing as a tool-level error     (Req 2.6).
 *      The MCP input schema rejects unknown enum values at the wire
 *      layer; this case bypasses the schema by calling the handler
 *      directly with an out-of-enum namespace cast as `Namespace`, so we
 *      verify the wrapper-level guard still produces an `isError` result.
 *   3. Empty/whitespace-only query surfacing as a tool-level
 *      error                                                  (Req 2.7).
 *   4. Successful recall payload shape and routing            (Req 2.1, 2.4).
 *   5. Health-gate failure short-circuits the recall          (Req 14.4).
 *   6. `my_skills` default-query substitution + correct routing (Req 3.2, 3.1).
 *   7. `my_skills` honours the caller's query when present     (Req 3.1).
 *   8. `my_productivity` default-query substitution + correct
 *      routing                                                 (Req 4.2, 4.1).
 *   9. `my_productivity` honours the caller's query when present (Req 4.1).
 *
 * Validates: Requirements 2.1, 2.5, 2.6, 2.7, 3.1, 3.2, 4.1, 4.2
 */

import { describe, it, expect } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  MemWalClient,
  Namespace,
  RecallParams,
  RecallResult,
} from "@uberwal/shared";

import { recallMemoryHandler, type RecallMemoryInput } from "./recall-memory.js";
import { mySkillsHandler } from "./my-skills.js";
import { myProductivityHandler } from "./my-productivity.js";
import type { ToolDeps } from "./register.js";

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/**
 * Configurable stub of the `MemWalClient` surface the recall handlers use.
 *
 * The stub implements only the two methods these handlers actually call —
 * `isHealthy` and `recall` — and records every invocation so tests can
 * assert on call counts and the params the wrapper observed. Anything
 * else on the real `MemWalClient` is intentionally absent and the cast
 * goes through `unknown` to keep the stub minimal.
 *
 * Behaviour can be overridden per test:
 *   - `healthy` (default `true`) controls what `isHealthy` resolves to.
 *   - `recallResponse` (default `{ results: [], total: 0 }`) is returned
 *     by `recall` on success.
 *   - `recallError`, when set, causes `recall` to reject with that error
 *     instead of returning `recallResponse`. Used to model wrapper-level
 *     validation failures (invalid namespace, empty query) without
 *     pulling in the real SDK.
 */
interface StubOptions {
  healthy?: boolean;
  recallResponse?: RecallResult;
  recallError?: Error;
}

interface MemWalStub {
  memwal: MemWalClient;
  recallCalls: RecallParams[];
  healthCallCount: () => number;
}

function createMemWalStub(opts: StubOptions = {}): MemWalStub {
  const recallCalls: RecallParams[] = [];
  let healthCalls = 0;

  const healthy = opts.healthy ?? true;
  const response: RecallResult =
    opts.recallResponse ?? { results: [], total: 0 };

  const stub = {
    async isHealthy(_timeoutMs?: number): Promise<boolean> {
      healthCalls += 1;
      return healthy;
    },
    async recall(params: RecallParams): Promise<RecallResult> {
      recallCalls.push(params);
      if (opts.recallError !== undefined) {
        throw opts.recallError;
      }
      return response;
    },
  };

  return {
    memwal: stub as unknown as MemWalClient,
    recallCalls,
    healthCallCount: () => healthCalls,
  };
}

/**
 * Build a `ToolDeps` value with only the `memwal` field populated. The
 * recall handlers never touch `extractor` or `config`, so leaving them as
 * `unknown` casts is safe and keeps the test from coupling to unrelated
 * module shapes.
 */
function createDeps(memwal: MemWalClient): ToolDeps {
  return {
    memwal,
    extractor: undefined as unknown as ToolDeps["extractor"],
    config: undefined as unknown as ToolDeps["config"],
  };
}

/**
 * Read the JSON payload out of a successful recall tool response. The
 * handlers serialize their structured payload into a `text` content
 * block; falling back to throw on a missing/unexpected shape surfaces
 * accidental contract changes loudly instead of silently passing.
 */
function readSuccessPayload(result: CallToolResult): {
  results: { blob_id: string; text: string; distance: number }[];
  total: number;
  message?: string;
} {
  expect(result.isError).not.toBe(true);
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("recall tool result is missing a text content block.");
  }
  return JSON.parse(first.text) as {
    results: { blob_id: string; text: string; distance: number }[];
    total: number;
    message?: string;
  };
}

/**
 * Read the error message out of a failed tool response. Asserts that
 * `isError` is set so we never confuse a success payload that happens to
 * mention "error" with an actual tool-level failure.
 */
function readErrorMessage(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("recall tool error result is missing a text content block.");
  }
  return first.text;
}

// ---------------------------------------------------------------------------
// recall_memory
// ---------------------------------------------------------------------------

describe("recallMemoryHandler", () => {
  it("returns an empty-result message naming the namespace and query when no entries match (Req 2.5)", async () => {
    const stub = createMemWalStub({
      // The wrapper resolves a missing-result recall as `{results: [], total: 0}`.
      recallResponse: { results: [], total: 0 },
    });
    const deps = createDeps(stub.memwal);

    const input: RecallMemoryInput = {
      query: "vector databases",
      namespace: "skills",
    };
    const response = await recallMemoryHandler(deps, input);

    const payload = readSuccessPayload(response);
    expect(payload.results).toEqual([]);
    expect(payload.total).toBe(0);
    // The message must explicitly name both the queried namespace and the
    // user's query so MCP clients can render an actionable empty state.
    expect(payload.message).toBe(
      `No relevant memories found in 'skills' for query "vector databases".`,
    );

    // The recall went through to the wrapper exactly once and was routed
    // to the requested namespace (Req 2.1 spot-check).
    expect(stub.recallCalls).toHaveLength(1);
    expect(stub.recallCalls[0]?.namespace).toBe("skills");
    expect(stub.recallCalls[0]?.query).toBe("vector databases");
  });

  it("surfaces an invalid-namespace error from the wrapper as an isError result (Req 2.6)", async () => {
    // Model the real `MemWalClient.recall` behaviour: when handed a
    // namespace outside the four allowed values it rejects with
    // `Error("Invalid namespace: ...")` before reaching the SDK. The MCP
    // input schema enforces the same enum at the wire layer; we bypass
    // it here by casting to `Namespace` to verify the handler still
    // produces a tool-level error if a malformed value ever sneaked
    // through.
    const stub = createMemWalStub({
      recallError: new Error(
        'Invalid namespace: "not-a-namespace". Expected one of sessions, skills, productivity, reports.',
      ),
    });
    const deps = createDeps(stub.memwal);

    const response = await recallMemoryHandler(deps, {
      query: "anything",
      namespace: "not-a-namespace" as unknown as Namespace,
    });

    const message = readErrorMessage(response);
    expect(message).toMatch(/invalid namespace/i);
    // The handler must have actually called the wrapper — otherwise the
    // "wrapper threw" path is not the one being exercised.
    expect(stub.recallCalls).toHaveLength(1);
  });

  it("surfaces an empty/whitespace query error from the wrapper as an isError result (Req 2.7)", async () => {
    // The MCP input schema rejects empty strings (`min(1)`), but a
    // whitespace-only query slips past it; the wrapper's secondary guard
    // raises `Error("Query is required ...")` before the SDK is touched.
    const stub = createMemWalStub({
      recallError: new Error(
        "Query is required and must contain at least one non-whitespace character.",
      ),
    });
    const deps = createDeps(stub.memwal);

    const response = await recallMemoryHandler(deps, {
      query: "   \t\n  ",
      namespace: "skills",
    });

    const message = readErrorMessage(response);
    expect(message).toMatch(/query is required/i);
    expect(stub.recallCalls).toHaveLength(1);
  });

  it("returns a success payload with the wrapper's results and total on the happy path (Req 2.1, 2.4)", async () => {
    const wrapperResult: RecallResult = {
      results: [
        { blob_id: "blob-1", text: "knows TypeScript", distance: 0.12 },
        { blob_id: "blob-2", text: "knows Rust", distance: 0.34 },
      ],
      total: 2,
    };
    const stub = createMemWalStub({ recallResponse: wrapperResult });
    const deps = createDeps(stub.memwal);

    const response = await recallMemoryHandler(deps, {
      query: "languages",
      namespace: "skills",
      limit: 5,
      maxDistance: 0.5,
    });

    const payload = readSuccessPayload(response);
    // The handler must forward the entries verbatim — no truncation, no
    // re-ordering, and no `message` field on a non-empty result.
    expect(payload.results).toEqual(wrapperResult.results);
    expect(payload.total).toBe(2);
    expect(payload.message).toBeUndefined();

    // Every optional input must reach the wrapper unchanged so its
    // clamping and defaulting logic stays the single source of truth
    // (Req 2.1: the recall is performed on the requested namespace).
    expect(stub.recallCalls).toHaveLength(1);
    expect(stub.recallCalls[0]).toEqual({
      query: "languages",
      namespace: "skills",
      limit: 5,
      maxDistance: 0.5,
    });
  });

  it("returns an isError result and skips recall when the health gate fails (Req 14.4)", async () => {
    const stub = createMemWalStub({ healthy: false });
    const deps = createDeps(stub.memwal);

    const response = await recallMemoryHandler(deps, {
      query: "anything",
      namespace: "skills",
    });

    const message = readErrorMessage(response);
    // Message must signal "service unavailable" so MCP clients show a
    // retry-friendly error rather than a generic failure.
    expect(message).toMatch(/relayer is unavailable/i);
    // Health gate ran exactly once, and recall was never attempted.
    expect(stub.healthCallCount()).toBe(1);
    expect(stub.recallCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// my_skills shortcut
// ---------------------------------------------------------------------------

describe("mySkillsHandler", () => {
  it("substitutes the broad default query, namespace, and limit when query is absent (Req 3.2, 3.1)", async () => {
    const stub = createMemWalStub();
    const deps = createDeps(stub.memwal);

    const response = await mySkillsHandler(deps, {});

    // Successful (empty) recall — what we care about is the params the
    // wrapper observed.
    readSuccessPayload(response);

    expect(stub.recallCalls).toHaveLength(1);
    expect(stub.recallCalls[0]).toEqual({
      query: "skills and technologies",
      namespace: "skills",
      limit: 10,
    });
  });

  it("forwards the caller's query unchanged when one is provided (Req 3.1)", async () => {
    const stub = createMemWalStub();
    const deps = createDeps(stub.memwal);

    const response = await mySkillsHandler(deps, { query: "rust async" });

    readSuccessPayload(response);

    expect(stub.recallCalls).toHaveLength(1);
    expect(stub.recallCalls[0]).toEqual({
      query: "rust async",
      namespace: "skills",
      limit: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// my_productivity shortcut
// ---------------------------------------------------------------------------

describe("myProductivityHandler", () => {
  it("substitutes the broad default query, namespace, and limit when query is absent (Req 4.2, 4.1)", async () => {
    const stub = createMemWalStub();
    const deps = createDeps(stub.memwal);

    const response = await myProductivityHandler(deps, {});

    readSuccessPayload(response);

    expect(stub.recallCalls).toHaveLength(1);
    expect(stub.recallCalls[0]).toEqual({
      query: "productivity and output",
      namespace: "productivity",
      limit: 10,
    });
  });

  it("forwards the caller's query unchanged when one is provided (Req 4.1)", async () => {
    const stub = createMemWalStub();
    const deps = createDeps(stub.memwal);

    const response = await myProductivityHandler(deps, {
      query: "weekly throughput",
    });

    readSuccessPayload(response);

    expect(stub.recallCalls).toHaveLength(1);
    expect(stub.recallCalls[0]).toEqual({
      query: "weekly throughput",
      namespace: "productivity",
      limit: 10,
    });
  });
});
