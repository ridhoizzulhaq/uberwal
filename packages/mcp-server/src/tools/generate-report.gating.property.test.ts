// Feature: uberwal, Property 9: Report generation gating by entry count
// (design.md is canonical; tasks.md numbers this Property 7 — same property,
// different numbering scheme.)
//
// Validates: Requirements 5.5
//
// For any combination of skills-namespace and productivity-namespace entry
// counts, `generate_report` returns the not-enough-data outcome if and only
// if the combined count is fewer than 3, and otherwise proceeds to
// summarization (and persistence in the `reports` namespace).
//
// The MemWal SDK and Claude API are replaced with deterministic stubs so
// the property exercises only the gating decision inside
// `generateReportHandler`. The stubs let us count how many times
// `summarizeReport` and `remember` are invoked across both branches:
//
//   - combined < 3  → not-enough-data response, no summarization, no write.
//   - combined >= 3 → summarization called once, single write into `reports`.
//
// The handler's recall always runs (the gate sits *after* recall), so we
// also assert both namespaces are recalled exactly once on every iteration.

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

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

/** Constant prose returned by the stub `summarizeReport`. */
const STUB_SUMMARY = "aggregated prose summary used for stub testing";

/**
 * Build a fixed-size list of recall entries for a given namespace.
 *
 * The handler's gating decision is purely a function of the recall result
 * count, so the entries' content does not matter — we synthesize them
 * deterministically with a low (in-band) distance so they survive the
 * SDK's default `maxDistance` of 0.7 in case any future implementation
 * filters by distance after recall.
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

/** Captured arguments for a single `MemWalClient.remember` call. */
interface RememberCall {
  text: string;
  namespace: Namespace;
  timeoutMs: number | undefined;
}

/**
 * Build a `MemWalClient`-shaped stub that returns the given fixed entry
 * counts on recall and tracks every `remember` invocation.
 *
 * `isHealthy` always resolves to `true`, so the per-tool relayer health
 * gate never short-circuits this test — every iteration reaches the
 * gating decision.
 */
function createMemWalStub(
  skillsCount: number,
  productivityCount: number,
): {
  client: MemWalClient;
  rememberCalls: RememberCall[];
  recallNamespaces: Namespace[];
  healthChecks: number;
} {
  const rememberCalls: RememberCall[] = [];
  const recallNamespaces: Namespace[] = [];
  let healthChecks = 0;

  const stub = {
    async isHealthy(_timeoutMs?: number): Promise<boolean> {
      healthChecks += 1;
      return true;
    },

    async recall(params: RecallParams): Promise<RecallResult> {
      recallNamespaces.push(params.namespace);
      if (params.namespace === "skills") {
        const entries = fakeEntries(skillsCount, "skills");
        return { results: entries, total: skillsCount };
      }
      if (params.namespace === "productivity") {
        const entries = fakeEntries(productivityCount, "productivity");
        return { results: entries, total: productivityCount };
      }
      // The handler only ever recalls `skills` and `productivity`; any other
      // namespace would be a regression and should produce a visibly empty
      // result rather than silently passing.
      return { results: [], total: 0 };
    },

    async remember(
      text: string,
      namespace: Namespace,
      timeoutMs?: number,
    ): Promise<StoredRef> {
      rememberCalls.push({ text, namespace, timeoutMs });
      return {
        id: `stored-${rememberCalls.length}`,
        blob_id: `blob-${rememberCalls.length}`,
        namespace,
      };
    },
  };

  return {
    // Cast through `unknown` to satisfy the wrapper's nominal class type
    // without instantiating a real SDK (mirrors `startup.test.ts`).
    client: stub as unknown as MemWalClient,
    rememberCalls,
    recallNamespaces,
    get healthChecks() {
      return healthChecks;
    },
  };
}

/** Captured arguments for a single `Extractor.summarizeReport` call. */
interface SummarizeCall {
  skills: readonly string[];
  productivity: readonly string[];
}

/**
 * Build an `Extractor` stub that counts summarization invocations and
 * always returns a non-empty constant summary so the persistence step in
 * the handler can run.
 *
 * `extractFacts` is unused by `generate_report`; we throw if it is ever
 * called so a regression that wires the wrong code path here surfaces
 * immediately.
 */
function createExtractorStub(): {
  extractor: Extractor;
  summarizeCalls: SummarizeCall[];
} {
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
      return STUB_SUMMARY;
    },
  };
  return { extractor, summarizeCalls };
}

describe("Property 9: Report generation gating by entry count", () => {
  it(
    "returns not-enough-data iff combined < 3, otherwise summarizes and stores",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Ranges deliberately cross the gating threshold (combined < 3) and
          // also cover the up-to-50-per-namespace recall ceiling so the test
          // exercises both halves of the if-and-only-if and the saturated
          // recall regime (60 > 50, but the stub returns whatever count we
          // ask for so we can probe behavior beyond the recall limit too).
          fc.integer({ min: 0, max: 60 }),
          fc.integer({ min: 0, max: 60 }),
          async (skillsCount, productivityCount) => {
            const memwal = createMemWalStub(skillsCount, productivityCount);
            const { extractor, summarizeCalls } = createExtractorStub();

            const result = await generateReportHandler({
              memwal: memwal.client,
              extractor,
            });

            const combined = skillsCount + productivityCount;

            // The health gate runs once on every invocation (Requirement 14.3).
            expect(memwal.healthChecks).toBe(1);

            // Recall always runs for both namespaces — the gate sits after
            // recall (Requirement 5.1). Order is unspecified because the
            // handler issues them in parallel via `Promise.all`.
            expect(memwal.recallNamespaces).toHaveLength(2);
            expect(new Set(memwal.recallNamespaces)).toEqual(
              new Set<Namespace>(["skills", "productivity"]),
            );

            // The handler wraps its payload under `result` to match the
            // tool's registered union output schema.
            const structured = result.structuredContent as
              | { result?: Record<string, unknown> }
              | undefined;
            expect(structured).toBeDefined();
            const payload = structured?.result;
            expect(payload).toBeDefined();

            if (combined < 3) {
              // ── Gating branch ──────────────────────────────────────────
              // Success-shaped (no `isError`) per Requirement 5.5; the
              // structured payload carries `enoughData: false` and the
              // observed combined count.
              expect(result.isError).toBeUndefined();
              expect(payload?.["enoughData"]).toBe(false);
              expect(payload?.["combinedEntries"]).toBe(combined);

              // No summarization, no write. The reports namespace stays
              // untouched.
              expect(summarizeCalls).toHaveLength(0);
              expect(memwal.rememberCalls).toHaveLength(0);
            } else {
              // ── Proceed branch ─────────────────────────────────────────
              // Summarization runs exactly once and is invoked with the
              // recalled texts (one entry per recalled item).
              expect(result.isError).toBeUndefined();
              expect(summarizeCalls).toHaveLength(1);
              const summarizeCall = summarizeCalls[0];
              expect(summarizeCall?.skills).toHaveLength(skillsCount);
              expect(summarizeCall?.productivity).toHaveLength(
                productivityCount,
              );

              // Persistence runs exactly once, into the `reports` namespace
              // (Requirement 5.3), with the summary text from the stub.
              expect(memwal.rememberCalls).toHaveLength(1);
              const rememberCall = memwal.rememberCalls[0];
              expect(rememberCall?.namespace).toBe("reports");
              expect(rememberCall?.text).toBe(STUB_SUMMARY);

              // Returned payload carries the summary plus the stored
              // entry's blob id (Requirement 5.4).
              expect(payload?.["summary"]).toBe(STUB_SUMMARY);
              expect(typeof payload?.["blob_id"]).toBe("string");
            }
          },
        ),
        // 100+ iterations per the task; 150 gives ample coverage of both
        // sides of the threshold without ballooning runtime.
        { numRuns: 150 },
      );
    },
  );
});
