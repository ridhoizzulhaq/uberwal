/**
 * Integration test for the MCP server's startup health check.
 *
 * Validates the startup-phase contract documented on
 * `runStartupHealthCheck`:
 *
 *   - Requirement 14.1: at startup the server calls `MemWalClient.isHealthy`
 *     with a 5-second budget.
 *   - Requirement 14.2: on a failed health check the server logs a warning
 *     to stderr (`console.error`) and continues normally; on a successful
 *     health check no warning is emitted.
 *
 * The MemWal client is replaced with a lightweight stub that lets each test
 * decide what `isHealthy` resolves to. Going through `runStartupHealthCheck`
 * directly (rather than spawning the full `main()` bootstrap) keeps the
 * test free of credential loading, stdio transport setup, and tool
 * registration — none of which are part of the startup-health-check
 * contract under test here.
 *
 * Validates: Requirements 14.1, 14.2
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MemWalClient } from "@uberwal/shared";

import { runStartupHealthCheck } from "./index.js";

/**
 * Minimal stand-in for the {@link MemWalClient} used at startup.
 *
 * `runStartupHealthCheck` only reads `isHealthy` off the client, so the stub
 * implements just that one method. The test casts the stub through `unknown`
 * to satisfy the wrapper's nominal class type without instantiating a real
 * SDK (which would require valid hex credentials and a reachable relayer).
 */
interface MemWalClientStub {
  isHealthy: ReturnType<typeof vi.fn>;
}

function createMemWalStub(healthy: boolean): MemWalClientStub {
  return {
    // The real wrapper calls `isHealthy(5_000)` at startup; the stub
    // accepts and ignores the timeout so the call signature lines up.
    isHealthy: vi.fn().mockResolvedValue(healthy),
  };
}

/** Matches the exact warning runStartupHealthCheck emits on failure. */
const HEALTH_WARNING_PATTERN = /health check failed at startup/i;

describe("runStartupHealthCheck — startup behavior (Requirements 14.1, 14.2)", () => {
  // Typed via the spy's own return type so the test stays compatible with
  // any future refinements to vitest's `MockInstance` generic.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence the real stderr output during tests while still capturing
    // every call so assertions can inspect what would have been logged.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("logs no warning and returns normally when the relayer is healthy", async () => {
    const stub = createMemWalStub(true);

    await expect(
      runStartupHealthCheck(stub as unknown as MemWalClient),
    ).resolves.toBeUndefined();

    // The stub was consulted exactly once with a 5-second budget (Req 14.1).
    expect(stub.isHealthy).toHaveBeenCalledTimes(1);
    expect(stub.isHealthy).toHaveBeenCalledWith(5_000);

    // No warning — and more generally, no stderr logging — should occur.
    const matchingCalls = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
      args.some(
        (arg) => typeof arg === "string" && HEALTH_WARNING_PATTERN.test(arg),
      ),
    );
    expect(matchingCalls).toHaveLength(0);
  });

  it("logs a warning to stderr and continues when the relayer is unhealthy", async () => {
    const stub = createMemWalStub(false);

    // The function must resolve successfully even when health fails — the
    // server is required to keep starting (Req 14.2).
    await expect(
      runStartupHealthCheck(stub as unknown as MemWalClient),
    ).resolves.toBeUndefined();

    // Health was checked once with the documented startup budget (Req 14.1).
    expect(stub.isHealthy).toHaveBeenCalledTimes(1);
    expect(stub.isHealthy).toHaveBeenCalledWith(5_000);

    // Exactly one stderr log matching the documented warning text.
    const matchingCalls = consoleErrorSpy.mock.calls.filter((args: unknown[]) =>
      args.some(
        (arg) => typeof arg === "string" && HEALTH_WARNING_PATTERN.test(arg),
      ),
    );
    expect(matchingCalls).toHaveLength(1);

    // The full warning identifies the server and notes that startup
    // continues, matching the contract on `runStartupHealthCheck`.
    const warningText = matchingCalls[0]?.find(
      (arg: unknown): arg is string => typeof arg === "string",
    );
    expect(warningText).toMatch(/uberwal-mcp/);
    expect(warningText).toMatch(HEALTH_WARNING_PATTERN);
  });
});
