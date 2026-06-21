/**
 * Unit tests for `MemWalClient.recall` input wiring.
 *
 * Validates that the wrapper enforces the contract documented on
 * `MemWalClient.recall` before calling the underlying SDK:
 *
 *   - `namespace` must be one of the four Uberwal namespaces; otherwise
 *     an `Error` is thrown and the SDK is never called.
 *   - `query` must contain at least one non-whitespace character; otherwise
 *     an `Error` is thrown and the SDK is never called.
 *   - `limit` is clamped into [1, 100] (default 10) before being forwarded.
 *   - `maxDistance` is clamped into [0, 1] (default 1) before being
 *     forwarded.
 *   - Values already in range are forwarded unchanged.
 *
 * The SDK is replaced with a lightweight stub via
 * `MemWalClient.__createForTesting`. The stub records the params it was
 * called with so each test can assert exactly what the SDK observed.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.7
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { MemWal, RecallParams as SdkRecallParams, RecallResult as SdkRecallResult } from "@mysten-incubation/memwal";

import { MemWalClient } from "./memwal-client";

/**
 * Minimal SDK stub: records every `recall` invocation so the test can assert
 * (a) whether the SDK was called at all and (b) the exact params it received.
 *
 * Returns a deterministic empty recall response — these tests care about the
 * inputs the wrapper forwards, not the SDK's output. (Output normalization is
 * covered by the property test in `result.property.test.ts`.)
 */
interface RecallStub {
  /** Params recorded for each `recall` call, in invocation order. */
  calls: SdkRecallParams[];
  /** SDK-shaped object suitable for `MemWalClient.__createForTesting`. */
  sdk: MemWal;
}

function createRecallStub(): RecallStub {
  const calls: SdkRecallParams[] = [];
  const sdkLike = {
    async recall(params: SdkRecallParams): Promise<SdkRecallResult> {
      calls.push(params);
      return { results: [], total: 0 };
    },
  };
  // Cast through `unknown` because the stub implements only the subset of
  // `MemWal` exercised by `MemWalClient.recall`. The wrapper never touches
  // any other SDK method on this code path.
  return { calls, sdk: sdkLike as unknown as MemWal };
}

describe("MemWalClient.recall — clamping and validation wiring", () => {
  let stub: RecallStub;
  let client: MemWalClient;

  beforeEach(() => {
    stub = createRecallStub();
    client = MemWalClient.__createForTesting(stub.sdk);
  });

  // ---------------------------------------------------------------------
  // Validation: invalid input rejects without ever calling the SDK.
  // ---------------------------------------------------------------------

  it("throws and skips the SDK when the namespace is invalid", async () => {
    await expect(
      client.recall({
        // Cast through `unknown` because the typed signature only accepts
        // the `Namespace` union; the runtime guard is what we want to test.
        namespace: "not-a-namespace" as unknown as "sessions",
        query: "anything",
      }),
    ).rejects.toThrow(/invalid namespace/i);

    expect(stub.calls).toHaveLength(0);
  });

  it("throws and skips the SDK when the query is empty", async () => {
    await expect(
      client.recall({
        namespace: "skills",
        query: "",
      }),
    ).rejects.toThrow(/query is required/i);

    expect(stub.calls).toHaveLength(0);
  });

  it("throws and skips the SDK when the query is whitespace-only", async () => {
    await expect(
      client.recall({
        namespace: "skills",
        query: "   \t\n  ",
      }),
    ).rejects.toThrow(/query is required/i);

    expect(stub.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Clamping: out-of-range values are normalized before the SDK sees them.
  // ---------------------------------------------------------------------

  it("clamps limit=0 up to 1 before calling the SDK", async () => {
    await client.recall({
      namespace: "skills",
      query: "typescript",
      limit: 0,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.limit).toBe(1);
  });

  it("clamps limit=200 down to 100 before calling the SDK", async () => {
    await client.recall({
      namespace: "skills",
      query: "typescript",
      limit: 200,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.limit).toBe(100);
  });

  it("clamps maxDistance=-0.5 up to 0 before calling the SDK", async () => {
    await client.recall({
      namespace: "skills",
      query: "typescript",
      maxDistance: -0.5,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.maxDistance).toBe(0);
  });

  it("clamps maxDistance=2 down to 1 before calling the SDK", async () => {
    await client.recall({
      namespace: "skills",
      query: "typescript",
      maxDistance: 2,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.maxDistance).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Defaults: omitted optional fields are filled in for the SDK.
  // ---------------------------------------------------------------------

  it("substitutes the default limit (10) when limit is undefined", async () => {
    await client.recall({
      namespace: "skills",
      query: "typescript",
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.limit).toBe(10);
  });

  it("substitutes the default maxDistance (1) when maxDistance is undefined", async () => {
    await client.recall({
      namespace: "skills",
      query: "typescript",
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.maxDistance).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Pass-through: in-range values reach the SDK exactly as supplied, and
  // namespace + query are forwarded verbatim.
  // ---------------------------------------------------------------------

  it("passes in-range limit and maxDistance through to the SDK unchanged", async () => {
    await client.recall({
      namespace: "productivity",
      query: "shipped features",
      limit: 25,
      maxDistance: 0.42,
    });

    expect(stub.calls).toHaveLength(1);
    const observed = stub.calls[0];
    expect(observed?.namespace).toBe("productivity");
    expect(observed?.query).toBe("shipped features");
    expect(observed?.limit).toBe(25);
    expect(observed?.maxDistance).toBe(0.42);
  });
});
