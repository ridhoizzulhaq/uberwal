/**
 * Unit tests for the dashboard `login` and `logout` server actions.
 *
 * Covers the discriminated-result branching documented on `login`:
 *   - format-rejection (`invalid-credentials`) without any SDK call,
 *   - successful health probe writing the encrypted session,
 *   - SDK rejection with an auth-style message classified as
 *     `invalid-credentials`,
 *   - SDK rejection with a generic network message classified as
 *     `connectivity`,
 *   - 10-second timeout exercised under fake timers,
 *   - non-`"ok"` health status classified as `connectivity`,
 *   - `logout` clearing the session.
 *
 * The MemWal SDK is replaced by `vi.mock("@mysten-incubation/memwal", ...)`
 * so we can drive `health()` deterministically. The cookie layer is mocked
 * via `vi.mock("../../server/session.js", ...)` so the test environment
 * never touches `next/headers`, which is unavailable outside of a Next.js
 * request context.
 *
 * Validates: Requirements 7.1, 7.2, 7.5
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hoisted mock state.
 *
 * Vitest hoists `vi.mock(...)` calls above the module imports, so the mock
 * factories cannot reference module-scope variables defined below them.
 * `vi.hoisted` opts those variables into the same hoisting pass, giving
 * the factories a stable handle that the per-test setup can reset.
 */
const mocks = vi.hoisted(() => ({
  /** Stub for `MemWal.create(...).health()`. */
  health: vi.fn(),
  /** Stub for `setSession` writing the encrypted cookie. */
  setSession: vi.fn(),
  /** Stub for `clearSession` deleting the cookie. */
  clearSession: vi.fn(),
}));

vi.mock("@mysten-incubation/memwal", () => ({
  MemWal: {
    /**
     * `MemWal.create` returns a stub object exposing only the methods the
     * `login` action calls — currently just `health()`.
     */
    create: vi.fn(() => ({
      health: mocks.health,
    })),
  },
}));

vi.mock("../../server/session.js", () => ({
  setSession: mocks.setSession,
  clearSession: mocks.clearSession,
}));

// `auth.ts` must be imported *after* the `vi.mock` calls above so the
// mocked modules are wired into its module graph.
import { login, logout } from "./auth.js";

/** A 64-char hex string accepted by `isValidDelegateKey`. */
const VALID_DELEGATE_KEY = "a".repeat(64);
/** A `0x`-prefixed 64-char hex string accepted by `isValidAccountId`. */
const VALID_ACCOUNT_ID = "0x" + "b".repeat(64);

describe("login — discriminated branching", () => {
  beforeEach(() => {
    // The action requires `RELAYER_URL` to construct the SDK and reads
    // `SESSION_SECRET` only via the mocked `setSession`, so a placeholder
    // value here is enough to satisfy any defensive reads in shared code.
    process.env["RELAYER_URL"] = "https://relayer.example";
    process.env["SESSION_SECRET"] = "x".repeat(64);

    mocks.health.mockReset();
    mocks.setSession.mockReset();
    mocks.clearSession.mockReset();
  });

  afterEach(() => {
    // `useFakeTimers` is opt-in per test; restore real timers so the next
    // test starts from a clean slate regardless of which branch ran.
    vi.useRealTimers();
  });

  it("returns ok and writes the session on healthy login", async () => {
    mocks.health.mockResolvedValueOnce({ status: "ok", version: "test" });

    const result = await login({
      delegateKey: VALID_DELEGATE_KEY,
      accountId: VALID_ACCOUNT_ID,
      role: "developer",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.health).toHaveBeenCalledTimes(1);
    expect(mocks.setSession).toHaveBeenCalledTimes(1);
    expect(mocks.setSession).toHaveBeenCalledWith({
      accountId: VALID_ACCOUNT_ID,
      delegateKey: VALID_DELEGATE_KEY,
      role: "developer",
    });
  });

  it("returns invalid-credentials format error without calling the SDK", async () => {
    const result = await login({
      delegateKey: "not-hex", // rejected by `isValidDelegateKey`
      accountId: VALID_ACCOUNT_ID,
      role: "developer",
    });

    expect(result).toEqual({
      ok: false,
      kind: "invalid-credentials",
      message: "Invalid credentials format",
    });
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("classifies an auth-style rejection as invalid-credentials", async () => {
    // The SDK throws this exact shape when `/health` responds 401/403; the
    // login action must recognise it via the auth heuristic.
    mocks.health.mockRejectedValueOnce(
      new Error("Health check failed: 401 unauthorized"),
    );

    const result = await login({
      delegateKey: VALID_DELEGATE_KEY,
      accountId: VALID_ACCOUNT_ID,
      role: "team-lead",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid-credentials");
      expect(result.message).toBe("Invalid credentials");
    }
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("classifies a generic network error as connectivity", async () => {
    mocks.health.mockRejectedValueOnce(
      new Error("ECONNREFUSED 127.0.0.1:443"),
    );

    const result = await login({
      delegateKey: VALID_DELEGATE_KEY,
      accountId: VALID_ACCOUNT_ID,
      role: "developer",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("connectivity");
    }
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("returns connectivity when health() never resolves within 10 seconds", async () => {
    vi.useFakeTimers();

    // Pending forever — only the internal timeout race can settle the call.
    mocks.health.mockReturnValueOnce(new Promise(() => undefined));

    const promise = login({
      delegateKey: VALID_DELEGATE_KEY,
      accountId: VALID_ACCOUNT_ID,
      role: "recruiter",
    });

    // Advance just past the 10-second budget to fire the internal timer.
    await vi.advanceTimersByTimeAsync(10_001);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("connectivity");
    }
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("classifies a non-ok health status as connectivity", async () => {
    // The relayer is reachable but reporting a degraded state. We surface
    // this as a connectivity issue so the user can retry rather than
    // re-enter their credentials.
    mocks.health.mockResolvedValueOnce({
      status: "degraded",
      version: "test",
    });

    const result = await login({
      delegateKey: VALID_DELEGATE_KEY,
      accountId: VALID_ACCOUNT_ID,
      role: "developer",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("connectivity");
    }
    expect(mocks.setSession).not.toHaveBeenCalled();
  });
});

describe("logout — clears the session", () => {
  beforeEach(() => {
    process.env["RELAYER_URL"] = "https://relayer.example";
    process.env["SESSION_SECRET"] = "x".repeat(64);
    mocks.clearSession.mockReset();
  });

  it("delegates to clearSession", async () => {
    await logout();
    expect(mocks.clearSession).toHaveBeenCalledTimes(1);
  });
});
