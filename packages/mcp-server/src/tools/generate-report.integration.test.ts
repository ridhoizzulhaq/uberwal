/**
 * Integration tests for the `generate_report` MCP tool.
 *
 * These tests exercise `generateReportHandler` end-to-end with stub
 * `MemWalClient` and `Extractor` collaborators, covering the happy and
 * failure routing paths that the gating property test (Property 9 in
 * `generate-report.gating.property.test.ts`) does not assert directly:
 *
 *   1. Happy path — sufficient combined entries: both namespaces are
 *      recalled with `limit: 50`; the extractor's `summarizeReport` is
 *      called exactly once with the recalled texts; the resulting prose
 *      is persisted into the `reports` namespace via `remember`; and the
 *      tool response carries the summary plus the stored entry's
 *      `blob_id`. (Requirements 5.1, 5.2, 5.3, 5.4)
 *
 *   2. Summarization failure — `extractor.summarizeReport` throws; the
 *      tool returns an error result, `remember` is never called, and the
 *      `reports` namespace stays untouched. (Requirement 5.6)
 *
 *   3. Recall failure — `memwal.recall` throws; the tool returns an
 *      error result, summarization is never attempted, and no write
 *      occurs.
 *
 *   4. Health gate failure — `isHealthy` resolves `false`; the tool
 *      short-circuits with an error result and never recalls,
 *      summarizes, or writes. (Requirement 14.4)
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6
 */

import { describe, it, expect } from "vitest";

import type {
  MemWalClient,
  Namespace,
  RecallEntry,
  RecallParams,
  RecallResult,
  StoredRef,
} from "@uberwal/shared";

import type { ExtractedFacts, Extractor } from "../extraction/extractor.js";

import { generateReportHandler } from "./generate-report.js";

// ---------------------------------------------------------------------------
// Stub builders
// ---------------------------------------------------------------------------

/**
 * Build a list of synthetic recall entries with deterministic content. The
 * handler treats recall results opaquely (it forwards the `text` field to
 * the extractor) so the values just need to be distinguishable per
 * namespace.
 */
function fakeEntries(count: number, label: string): RecallEntry[] {
  const entries: RecallEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      blob_id: `${label}-blob-${i}`,
      text: `${label} entry #${i}`,
      distance: 0.3,
    });
  }
  return entries;
}

/** Captured arguments for one `MemWalClient.recall` invocation. */
interface RecallCall {
  namespace: Namespace;
  query: string;
  limit: number | undefined;
  maxDistance: number | undefined;
}

/** Captured arguments for one `MemWalClient.remember` invocation. */
interface RememberCall {
  text: string;
  namespace: Namespace;
  timeoutMs: number | undefined;
}

/**
 * Configuration knobs for {@link createMemWalStub}. Each property maps to
 * an arm of one of the four tested branches:
 *
 *  - `healthy` — flips the per-tool relayer health gate.
 *  - `recallShouldThrow` — makes both namespace recalls reject so the
 *    handler reaches its recall-failure path.
 *  - `rememberShouldThrow` — makes the persistence step reject (covered
 *    indirectly elsewhere; left here for completeness).
 *  - `skillsCount` / `productivityCount` — control the recall result
 *    sizes when recall does not throw.
 */
interface MemWalStubOptions {
  healthy?: boolean;
  recallShouldThrow?: boolean;
  rememberShouldThrow?: boolean;
  skillsCount?: number;
  productivityCount?: number;
}

interface MemWalStubHandle {
  client: MemWalClient;
  recallCalls: RecallCall[];
  rememberCalls: RememberCall[];
  healthChecks: () => number;
}

/**
 * Construct a `MemWalClient`-shaped stub that records every interaction so
 * tests can assert call counts, arguments, and ordering. The stub is cast
 * through `unknown` to satisfy the wrapper's nominal class type without
 * instantiating the real SDK (mirrors the pattern used in
 * `startup.test.ts` and `generate-report.gating.property.test.ts`).
 */
function createMemWalStub(options: MemWalStubOptions = {}): MemWalStubHandle {
  const {
    healthy = true,
    recallShouldThrow = false,
    rememberShouldThrow = false,
    skillsCount = 3,
    productivityCount = 3,
  } = options;

  const recallCalls: RecallCall[] = [];
  const rememberCalls: RememberCall[] = [];
  let healthChecks = 0;

  const stub = {
    async isHealthy(_timeoutMs?: number): Promise<boolean> {
      healthChecks += 1;
      return healthy;
    },

    async recall(params: RecallParams): Promise<RecallResult> {
      recallCalls.push({
        namespace: params.namespace,
        query: params.query,
        limit: params.limit,
        maxDistance: params.maxDistance,
      });
      if (recallShouldThrow) {
        throw new Error("simulated recall failure");
      }
      if (params.namespace === "skills") {
        const entries = fakeEntries(skillsCount, "skills");
        return { results: entries, total: skillsCount };
      }
      if (params.namespace === "productivity") {
        const entries = fakeEntries(productivityCount, "productivity");
        return { results: entries, total: productivityCount };
      }
      return { results: [], total: 0 };
    },

    async remember(
      text: string,
      namespace: Namespace,
      timeoutMs?: number,
    ): Promise<StoredRef> {
      rememberCalls.push({ text, namespace, timeoutMs });
      if (rememberShouldThrow) {
        throw new Error("simulated remember failure");
      }
      return {
        id: `stored-${rememberCalls.length}`,
        blob_id: `blob-${rememberCalls.length}`,
        namespace,
      };
    },
  };

  return {
    client: stub as unknown as MemWalClient,
    recallCalls,
    rememberCalls,
    healthChecks: () => healthChecks,
  };
}

/** Captured arguments for one `Extractor.summarizeReport` invocation. */
interface SummarizeCall {
  skills: readonly string[];
  productivity: readonly string[];
}

/** Configuration for {@link createExtractorStub}. */
interface ExtractorStubOptions {
  summary?: string;
  shouldThrow?: boolean;
}

interface ExtractorStubHandle {
  extractor: Extractor;
  summarizeCalls: SummarizeCall[];
}

/**
 * Build an `Extractor` stub that records every `summarizeReport` call.
 *
 * `extractFacts` is unused by `generate_report`; if it is ever called it
 * indicates a regression in the handler's wiring, so the stub throws.
 */
function createExtractorStub(
  options: ExtractorStubOptions = {},
): ExtractorStubHandle {
  const { summary = "aggregated prose summary", shouldThrow = false } = options;
  const summarizeCalls: SummarizeCall[] = [];
  const extractor: Extractor = {
    async extractFacts(_transcript: string): Promise<ExtractedFacts> {
      throw new Error(
        "extractFacts should not be called by generate_report — regression in handler wiring.",
      );
    },
    async summarizeReport(
      skills: readonly string[],
      productivity: readonly string[],
    ): Promise<string> {
      summarizeCalls.push({ skills, productivity });
      if (shouldThrow) {
        throw new Error("simulated summarization failure");
      }
      return summary;
    },
  };
  return { extractor, summarizeCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generate_report — happy path (Requirements 5.1, 5.2, 5.3, 5.4)", () => {
  it(
    "recalls 50 from each namespace, summarizes once, stores the summary in `reports`, and returns it",
    async () => {
      // 4 + 2 = 6 combined entries → over the gate of 3 → the proceed branch
      // of the handler executes end-to-end.
      const memwal = createMemWalStub({
        healthy: true,
        skillsCount: 4,
        productivityCount: 2,
      });
      const SUMMARY_TEXT = "skills + productivity prose for the report";
      const { extractor, summarizeCalls } = createExtractorStub({
        summary: SUMMARY_TEXT,
      });

      const result = await generateReportHandler({
        memwal: memwal.client,
        extractor,
      });

      // ── No error result ─────────────────────────────────────────────
      expect(result.isError).toBeUndefined();

      // ── Recall: both namespaces, limit 50 (Requirement 5.1) ─────────
      expect(memwal.recallCalls).toHaveLength(2);
      const skillsCall = memwal.recallCalls.find(
        (call) => call.namespace === "skills",
      );
      const productivityCall = memwal.recallCalls.find(
        (call) => call.namespace === "productivity",
      );
      expect(skillsCall).toBeDefined();
      expect(productivityCall).toBeDefined();
      expect(skillsCall?.limit).toBe(50);
      expect(productivityCall?.limit).toBe(50);

      // ── Summarization: called once with the recalled texts (Req 5.2) ─
      expect(summarizeCalls).toHaveLength(1);
      const call = summarizeCalls[0];
      expect(call?.skills).toEqual([
        "skills entry #0",
        "skills entry #1",
        "skills entry #2",
        "skills entry #3",
      ]);
      expect(call?.productivity).toEqual([
        "productivity entry #0",
        "productivity entry #1",
      ]);

      // ── Persistence: stored once in `reports` with the summary text
      //    (Requirement 5.3) ────────────────────────────────────────────
      expect(memwal.rememberCalls).toHaveLength(1);
      const rememberCall = memwal.rememberCalls[0];
      expect(rememberCall?.namespace).toBe("reports");
      expect(rememberCall?.text).toBe(SUMMARY_TEXT);

      // ── Response payload (Requirement 5.4) ──────────────────────────
      // The handler wraps the payload under `result` to match the tool's
      // registered union output schema (`{ result: success | notEnough }`).
      const structured = result.structuredContent as
        | { result?: Record<string, unknown> }
        | undefined;
      expect(structured).toBeDefined();
      const payload = structured?.result;
      expect(payload).toBeDefined();
      expect(payload?.["summary"]).toBe(SUMMARY_TEXT);
      expect(typeof payload?.["blob_id"]).toBe("string");
      expect((payload?.["blob_id"] as string).length).toBeGreaterThan(0);
    },
  );
});

describe("generate_report — summarization failure (Requirement 5.6)", () => {
  it(
    "returns an error result and does not write to the `reports` namespace",
    async () => {
      const memwal = createMemWalStub({
        healthy: true,
        skillsCount: 5,
        productivityCount: 5,
      });
      const { extractor, summarizeCalls } = createExtractorStub({
        shouldThrow: true,
      });

      const result = await generateReportHandler({
        memwal: memwal.client,
        extractor,
      });

      // Error-shaped tool response.
      expect(result.isError).toBe(true);
      const text = result.content[0];
      expect(text?.type).toBe("text");
      expect((text as { text: string }).text.toLowerCase()).toContain(
        "summarization",
      );

      // Summarization was attempted exactly once …
      expect(summarizeCalls).toHaveLength(1);

      // … but persistence never ran — the `reports` namespace is untouched.
      expect(memwal.rememberCalls).toHaveLength(0);
    },
  );
});

describe("generate_report — recall failure", () => {
  it(
    "returns an error result and skips summarization and persistence",
    async () => {
      const memwal = createMemWalStub({
        healthy: true,
        recallShouldThrow: true,
      });
      const { extractor, summarizeCalls } = createExtractorStub();

      const result = await generateReportHandler({
        memwal: memwal.client,
        extractor,
      });

      // Error-shaped tool response.
      expect(result.isError).toBe(true);
      const text = result.content[0];
      expect(text?.type).toBe("text");
      expect((text as { text: string }).text.toLowerCase()).toContain(
        "recall",
      );

      // Recall was attempted (the handler issues both in parallel; either or
      // both may have been recorded before `Promise.all` rejected).
      expect(memwal.recallCalls.length).toBeGreaterThanOrEqual(1);

      // Neither summarization nor persistence ran.
      expect(summarizeCalls).toHaveLength(0);
      expect(memwal.rememberCalls).toHaveLength(0);
    },
  );
});

describe("generate_report — health gate failure (Requirement 14.4)", () => {
  it(
    "returns an error result and never recalls, summarizes, or writes",
    async () => {
      const memwal = createMemWalStub({ healthy: false });
      const { extractor, summarizeCalls } = createExtractorStub();

      const result = await generateReportHandler({
        memwal: memwal.client,
        extractor,
      });

      // Error-shaped tool response with a relayer-unavailable message.
      expect(result.isError).toBe(true);
      const text = result.content[0];
      expect(text?.type).toBe("text");
      expect((text as { text: string }).text.toLowerCase()).toContain(
        "relayer",
      );

      // Health was checked once …
      expect(memwal.healthChecks()).toBe(1);

      // … and nothing else ran.
      expect(memwal.recallCalls).toHaveLength(0);
      expect(summarizeCalls).toHaveLength(0);
      expect(memwal.rememberCalls).toHaveLength(0);
    },
  );
});
