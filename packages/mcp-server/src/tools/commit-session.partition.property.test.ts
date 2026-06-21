// Feature: uberwal, Property 7: Commit partitions every approved candidate into succeeded or failed
// (tasks.md labels this "Property 6"; design.md renumbers it to Property 7. The behaviour
//  under test is the partition contract of `commit_session` either way.)
//
// Validates: Requirements 15.4, 15.5 (per design.md; tasks.md cites Requirement 1.5,
// which is the same partitioning behaviour under the original requirement numbering).
//
// `commitSessionHandler`'s contract: for any non-empty set of approved
// candidates and any subset of those candidates whose underlying
// `rememberAndWait` write fails, the handler must
//
//   1. report each approved candidate exactly once in `outcomes`,
//   2. honour `outcomes.length === succeeded + failed` with both tallies
//      derived from the per-candidate `ok` flag,
//   3. mark exactly the designated failing subset as `ok: false` and the
//      complement as `ok: true`, and
//   4. attempt storage for every approved candidate — i.e. never short-
//      circuit on an earlier failure.
//
// The test wires `commitSessionHandler` against a stub MemWal client whose
// `remember()` throws when the current call index belongs to a designated
// failing subset and otherwise resolves with a fake `StoredRef`. The
// candidate list and the failing subset are generated together so the
// fail/success partition is known up-front and can be checked exactly.

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import type { MemWalClient, Namespace, StoredRef } from "@uberwal/shared";

import { commitSessionHandler, type CommitSessionInput } from "./commit-session.js";
import {
  CANDIDATE_TYPES,
  type CandidateType,
  type CommitSessionResult,
} from "./candidate.js";
import type { ToolDeps } from "./register.js";

/**
 * Joint generator: an array of approved candidates plus the set of indices
 * (within that array) whose write should fail. Generating both together
 * lets every property assertion compare against a precisely-known oracle
 * instead of re-deriving expectations from the handler's output.
 *
 * - 1..20 candidates so the loop is exercised with both single-item and
 *   multi-item inputs while keeping each test iteration cheap.
 * - Stable, unique ids of the form `id-0`, `id-1`, … so the "each candidate
 *   reported exactly once" invariant is straightforward to assert via a
 *   `Set` comparison.
 * - Types drawn uniformly from the three valid `CandidateType` values so
 *   `validateApprovedSet` always passes and the handler reaches the
 *   per-candidate write loop.
 * - Free-text `text` (no constraints), since partitioning behaviour is
 *   independent of payload contents.
 * - The failing subset is independent per index (each index fails with
 *   probability ~0.5), giving full coverage of the "all succeed", "all
 *   fail", and mixed partitions across 100 iterations.
 */
const approvedAndFailingIndicesGen = fc
  .integer({ min: 1, max: 20 })
  .chain((n) =>
    fc.tuple(
      fc.array(
        fc.tuple(
          fc.constantFrom<CandidateType>(...CANDIDATE_TYPES),
          fc.string(),
        ),
        { minLength: n, maxLength: n },
      ),
      // Independent boolean per index; the failing subset is the indices
      // where the boolean is `true`. This keeps the oracle trivial: an
      // outcome at index `i` should be `ok === false` iff `failFlags[i]`.
      fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    ),
  )
  .map(([typeAndText, failFlags]) => {
    const approved: CommitSessionInput["approved"] = typeAndText.map(
      ([type, text], i) => ({
        id: `id-${i}`,
        type,
        text,
      }),
    );
    return { approved, failFlags };
  });

/**
 * Stub MemWal client tracking the order in which `remember` is called and
 * throwing for the indices in `failingIndices`. Only the two methods
 * `commitSessionHandler` actually uses (`isHealthy` and `remember`) are
 * implemented; the rest of the `MemWalClient` surface is intentionally
 * absent and the cast goes through `unknown` to keep the stub minimal.
 */
function createMemWalStub(failingIndices: ReadonlySet<number>): {
  memwal: MemWalClient;
  rememberCallCount: () => number;
  rememberedIds: () => string[];
} {
  let callIndex = 0;
  const remembered: string[] = [];

  const stub = {
    async isHealthy(_timeoutMs?: number): Promise<boolean> {
      return true;
    },
    async remember(
      _text: string,
      namespace: Namespace,
      _timeoutMs?: number,
    ): Promise<StoredRef> {
      const i = callIndex++;
      if (failingIndices.has(i)) {
        throw new Error(`stub failure at index ${i}`);
      }
      const ref: StoredRef = {
        id: `stored-${i}`,
        blob_id: `blob-${i}`,
        namespace,
      };
      remembered.push(ref.id);
      return ref;
    },
  };

  return {
    memwal: stub as unknown as MemWalClient,
    rememberCallCount: () => callIndex,
    rememberedIds: () => remembered.slice(),
  };
}

/**
 * Build a `ToolDeps` value satisfying the handler's type contract while only
 * actually populating the `memwal` field. `commit_session` does not touch
 * `extractor` or `config`, so leaving them as `unknown` casts is safe and
 * keeps the test from coupling to unrelated module shapes.
 */
function createDeps(memwal: MemWalClient): ToolDeps {
  return {
    memwal,
    extractor: undefined as unknown as ToolDeps["extractor"],
    config: undefined as unknown as ToolDeps["config"],
  };
}

/**
 * Extract the `CommitSessionResult` from a successful tool response. The
 * handler attaches the structured payload to `structuredContent`; falling
 * back to parsing the text payload guards against an accidental contract
 * change without masking it.
 */
function readResult(structured: unknown, text: string | undefined): CommitSessionResult {
  if (structured && typeof structured === "object") {
    return structured as CommitSessionResult;
  }
  if (typeof text === "string") {
    return JSON.parse(text) as CommitSessionResult;
  }
  throw new Error("commit_session result is missing both structuredContent and text payload.");
}

describe("Property 7: commit_session partitions every approved candidate into succeeded or failed", () => {
  it("reports each candidate exactly once with the correct partition and attempts every write", async () => {
    await fc.assert(
      fc.asyncProperty(approvedAndFailingIndicesGen, async ({ approved, failFlags }) => {
        const failingIndices = new Set<number>(
          failFlags.map((flag, i) => (flag ? i : -1)).filter((i) => i >= 0),
        );

        const stub = createMemWalStub(failingIndices);
        const deps = createDeps(stub.memwal);

        const response = await commitSessionHandler(deps, { approved });

        // The handler should never short-circuit to an error path on a
        // valid approved set with a healthy relayer; if it does, the
        // partition assertions below would silently pass on an empty
        // `outcomes` list. Surface that explicitly.
        expect(response.isError).not.toBe(true);

        const firstContent = response.content?.[0];
        const text =
          firstContent && firstContent.type === "text" ? firstContent.text : undefined;
        const result = readResult(response.structuredContent, text);

        // 1. One outcome per approved candidate.
        expect(result.outcomes).toHaveLength(approved.length);

        // 2. Each approved id appears exactly once in `outcomes`. Comparing
        //    via sets catches both duplicates (set size mismatch) and
        //    missing/extra ids (membership mismatch).
        const approvedIds = approved.map((c) => c.id);
        const outcomeIds = result.outcomes.map((o) => o.id);
        expect(new Set(outcomeIds).size).toBe(outcomeIds.length); // no duplicates
        expect(new Set(outcomeIds)).toEqual(new Set(approvedIds));

        // 3. `succeeded + failed === outcomes.length`, and both tallies
        //    match the per-outcome `ok` flag.
        const okCount = result.outcomes.filter((o) => o.ok).length;
        const notOkCount = result.outcomes.filter((o) => !o.ok).length;
        expect(result.succeeded).toBe(okCount);
        expect(result.failed).toBe(notOkCount);
        expect(result.succeeded + result.failed).toBe(result.outcomes.length);

        // 4. The set of failed outcome ids equals exactly the designated
        //    failing subset (by input index → id mapping).
        const expectedFailedIds = new Set(
          [...failingIndices].map((i) => approved[i]!.id),
        );
        const actualFailedIds = new Set(
          result.outcomes.filter((o) => !o.ok).map((o) => o.id),
        );
        expect(actualFailedIds).toEqual(expectedFailedIds);

        // 5. No early abort: storage was attempted for every approved
        //    candidate, regardless of intervening failures.
        expect(stub.rememberCallCount()).toBe(approved.length);
      }),
      { numRuns: 100 },
    );
  });
});
