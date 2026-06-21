// Feature: uberwal, Property 13: Health status maps to a boolean correctly
//
// Validates: Requirements 14.1
//
// `MemWalClient.isHealthy(timeoutMs)` is contractually a strict mapping from
// the SDK's `health()` response to a boolean: it resolves to `true` if and
// only if the SDK resolves with a `HealthResult` whose `status` field is
// exactly the string `"ok"`. Any other status — including case variants
// (`"OK"`, `"Ok"`), strings with surrounding whitespace (`"ok "`, `" ok"`),
// the empty string, well-known non-ok statuses (`"error"`, `"degraded"`,
// `"unknown"`), and arbitrary strings — must yield `false`.
//
// The SDK is stubbed via `MemWalClient.__createForTesting`, so this property
// exercises only the `status === "ok"` decision inside the wrapper without
// any network I/O. The stub's `health()` resolves immediately, so the
// internal 5s timeout race never fires; this test does not validate the
// timeout branch (covered separately by example tests).

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { HealthResult, MemWal } from "@mysten-incubation/memwal";

import { MemWalClient } from "./memwal-client.js";

/**
 * Build a `MemWal`-shaped stub whose `health()` resolves with the given
 * `status`. Only `health()` is exercised by `isHealthy()`, so the remaining
 * SDK surface is intentionally absent and the cast goes through `unknown`.
 *
 * `version` is required on `HealthResult`; we hand back a placeholder string
 * since the wrapper never reads it.
 */
function stubSdkWithHealthStatus(status: string): MemWal {
  const stub = {
    async health(): Promise<HealthResult> {
      return { status, version: "test" };
    },
  };
  return stub as unknown as MemWal;
}

/**
 * Generator over `status` strings.
 *
 * The unweighted `fc.string()` branch alone would almost never produce
 * `"ok"`, leaving the `true` branch of the biconditional under-sampled. The
 * explicit constants ensure both branches — and several deliberately tricky
 * near-misses — are hit on every run, while `fc.string()` keeps coverage of
 * arbitrary inputs broad.
 */
const statusGen: fc.Arbitrary<string> = fc.oneof(
  // Positive case (must map to true).
  { weight: 3, arbitrary: fc.constant("ok") },
  // Near-miss case variants (must map to false; the check is strict equality).
  { weight: 1, arbitrary: fc.constant("OK") },
  { weight: 1, arbitrary: fc.constant("Ok") },
  // Near-miss whitespace variants (must map to false).
  { weight: 1, arbitrary: fc.constant("ok ") },
  { weight: 1, arbitrary: fc.constant(" ok") },
  // Empty string and well-known non-ok statuses (must map to false).
  { weight: 1, arbitrary: fc.constant("") },
  { weight: 1, arbitrary: fc.constant("error") },
  { weight: 1, arbitrary: fc.constant("degraded") },
  { weight: 1, arbitrary: fc.constant("unknown") },
  // Arbitrary strings: keeps the negative branch broadly sampled and is
  // overwhelmingly unlikely to ever produce `"ok"`.
  { weight: 5, arbitrary: fc.string() },
);

describe("Property 13: Health status maps to a boolean correctly", () => {
  it("isHealthy() resolves to true iff the SDK reports status === 'ok'", async () => {
    await fc.assert(
      fc.asyncProperty(statusGen, async (status) => {
        const client = MemWalClient.__createForTesting(
          stubSdkWithHealthStatus(status),
        );
        const result = await client.isHealthy();
        expect(result).toBe(status === "ok");
      }),
      { numRuns: 200 },
    );
  });
});
