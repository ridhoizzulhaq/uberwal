/**
 * Unit tests for the dashboard `recallNamespace` server action.
 *
 * `recallNamespace` is the read-only proxy every dashboard tab uses to fetch
 * recall results. These tests exercise the discriminated-result contract:
 *
 *   - When there is no session (the factory returns `null`) the action
 *     surfaces a flat `Not authenticated` message rather than throwing.
 *   - When the per-request `MemWalClient` resolves a recall, the action
 *     forwards the normalized `{ results, total }` shape unchanged.
 *   - When the underlying recall throws, the action collapses the error
 *     into `{ ok: false, message }` so the calling React tab can keep its
 *     previous results displayed (Requirements 8.4, 9.3, 12.4).
 *
 * The factory is mocked so the test never touches `next/headers` or builds
 * a real SDK instance; the mocked client carries only the `recall` method
 * the action calls.
 *
 * Validates: Requirements 8.1, 9.1, 10.1, 11.1, 12.2
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hoisted handles for the mocked factory.
 *
 * `vi.mock` is hoisted above imports, so the factory body cannot close over
 * regular module-scope variables. `vi.hoisted` opts these handles into the
 * same hoisting pass, keeping the per-test reset at the bottom of the file.
 */
const mocks = vi.hoisted(() => ({
  /** Stub for `getMemWalClientFromSession`. */
  getMemWalClientFromSession: vi.fn(),
}));

vi.mock("../../server/memwal-factory.js", () => ({
  getMemWalClientFromSession: mocks.getMemWalClientFromSession,
}));

// Import the module under test *after* the mocks above are registered.
import { recallNamespace, listSessions, getSessionDetail } from "./recall.js";

describe("recallNamespace — proxy and error union", () => {
  beforeEach(() => {
    // The action does not read these directly, but downstream shared code
    // assumes they are set; mirroring login tests keeps the environment
    // consistent across the suite.
    process.env["RELAYER_URL"] = "https://relayer.example";
    process.env["SESSION_SECRET"] = "x".repeat(64);

    mocks.getMemWalClientFromSession.mockReset();
  });

  it("returns 'Not authenticated' when there is no session", async () => {
    // `null` is the documented "no session" signal from the factory.
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(null);

    const result = await recallNamespace({
      namespace: "skills",
      query: "typescript",
    });

    expect(result).toEqual({ ok: false, message: "Not authenticated" });
  });

  it("returns ok with normalized results when recall succeeds", async () => {
    // The client stub mirrors the subset of `MemWalClient` the action uses.
    // The shape returned here matches `RecallResult` exactly so the action
    // can forward it without further transformation.
    const recall = vi.fn().mockResolvedValueOnce({
      results: [
        { blob_id: "blob-1", text: "Implemented JWT middleware", distance: 0.31 },
        { blob_id: "blob-2", text: "Wrote integration tests", distance: 0.47 },
      ],
      total: 2,
    });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    const result = await recallNamespace({
      namespace: "skills",
      query: "typescript",
      limit: 5,
      maxDistance: 0.5,
    });

    expect(result).toEqual({
      ok: true,
      results: [
        { blob_id: "blob-1", text: "Implemented JWT middleware", distance: 0.31 },
        { blob_id: "blob-2", text: "Wrote integration tests", distance: 0.47 },
      ],
      total: 2,
    });
    // The action must forward the explicit options it received without
    // synthesising defaults — that responsibility belongs to the shared
    // `MemWalClient.recall` clamping helpers.
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith({
      namespace: "skills",
      query: "typescript",
      limit: 5,
      maxDistance: 0.5,
    });
  });

  it("defaults maxDistance to 1.0 and omits limit when not provided", async () => {
    // `recallNamespace` builds its `recall` payload conditionally so the
    // shared client sees "absent" for `limit` rather than `undefined`, but it
    // explicitly defaults `maxDistance` to 1.0 (no upper-distance filtering)
    // so viewers see their data immediately.
    const recall = vi.fn().mockResolvedValueOnce({ results: [], total: 0 });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    await recallNamespace({
      namespace: "sessions",
      query: "yesterday's session",
    });

    expect(recall).toHaveBeenCalledWith({
      namespace: "sessions",
      query: "yesterday's session",
      maxDistance: 1.0,
    });
  });

  it("returns failure with the error message when recall throws", async () => {
    const recall = vi
      .fn()
      .mockRejectedValueOnce(new Error("relayer unreachable"));
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    const result = await recallNamespace({
      namespace: "productivity",
      query: "shipped features",
    });

    expect(result).toEqual({ ok: false, message: "relayer unreachable" });
  });

  it("returns the generic 'Recall failed.' message for non-Error throws", async () => {
    // Some lower-level layers throw non-Error values; the action must still
    // produce a usable display string rather than `[object Object]`.
    const recall = vi.fn().mockRejectedValueOnce({ weird: true });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    const result = await recallNamespace({
      namespace: "reports",
      query: "weekly summary",
    });

    expect(result).toEqual({ ok: false, message: "Recall failed." });
  });
});

describe("listSessions — session-grouped listing", () => {
  beforeEach(() => {
    mocks.getMemWalClientFromSession.mockReset();
  });

  it("returns 'Not authenticated' with no session", async () => {
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(null);
    const result = await listSessions();
    expect(result).toEqual({ ok: false, message: "Not authenticated" });
  });

  it("maps sessions entries, defaulting a missing sessionId to null", async () => {
    const recall = vi.fn().mockResolvedValueOnce({
      results: [
        { blob_id: "b1", text: "Session A", distance: 0.1, sessionId: "s1" },
        { blob_id: "b2", text: "Legacy session", distance: 0.2 },
      ],
      total: 2,
    });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    const result = await listSessions();

    expect(result).toEqual({
      ok: true,
      sessions: [
        { sessionId: "s1", blob_id: "b1", text: "Session A", repo: null },
        { sessionId: null, blob_id: "b2", text: "Legacy session", repo: null },
      ],
    });
    expect(recall).toHaveBeenCalledWith({
      namespace: "sessions",
      query: "session summary",
      limit: 50,
      maxDistance: 1.0,
    });
  });
});

describe("getSessionDetail — filter by sessionId + sort transcripts", () => {
  beforeEach(() => {
    mocks.getMemWalClientFromSession.mockReset();
  });

  it("returns 'Not authenticated' with no session", async () => {
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(null);
    const result = await getSessionDetail({ sessionId: "s1" });
    expect(result).toEqual({ ok: false, message: "Not authenticated" });
  });

  it("filters each namespace to the session and sorts transcripts by index", async () => {
    // The gather now runs MULTIPLE passes per namespace (a broad query plus the
    // session summary text), so the mock answers by namespace rather than by a
    // fixed call sequence. Duplicate blobs across passes are deduped by the
    // gather helper.
    const byNamespace: Record<string, { results: unknown[]; total: number }> = {
      sessions: {
        results: [
          { blob_id: "sum1", text: "Summary for s1", distance: 0.1, sessionId: "s1" },
          { blob_id: "sum2", text: "Summary for s2", distance: 0.2, sessionId: "s2" },
        ],
        total: 2,
      },
      skills: {
        results: [
          { blob_id: "sk1", text: "Skill in s1", distance: 0.1, sessionId: "s1" },
          { blob_id: "sk2", text: "Skill in s2", distance: 0.2, sessionId: "s2" },
        ],
        total: 2,
      },
      productivity: {
        results: [
          { blob_id: "p1", text: "Prod in s1", distance: 0.1, sessionId: "s1" },
        ],
        total: 1,
      },
      transcripts: {
        results: [
          { blob_id: "t2", text: "chunk 2", distance: 0.1, sessionId: "s1", index: 2 },
          { blob_id: "tx", text: "no index", distance: 0.1, sessionId: "s1" },
          { blob_id: "t0", text: "chunk 0", distance: 0.1, sessionId: "s1", index: 0 },
          { blob_id: "t1", text: "chunk 1", distance: 0.1, sessionId: "s1", index: 1 },
          { blob_id: "other", text: "other session", distance: 0.1, sessionId: "s2", index: 0 },
        ],
        total: 5,
      },
    };
    const recall = vi.fn(
      async (params: {
        namespace: string;
        query: string;
        limit: number;
        maxDistance: number;
      }) => byNamespace[params.namespace] ?? { results: [], total: 0 },
    );
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    const result = await getSessionDetail({ sessionId: "s1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary?.blob_id).toBe("sum1");
      expect(result.skills.map((e) => e.blob_id)).toEqual(["sk1"]);
      expect(result.productivity.map((e) => e.blob_id)).toEqual(["p1"]);
      // sorted by index ascending; the index-less entry sorts last.
      expect(result.transcripts.map((e) => e.blob_id)).toEqual([
        "t0",
        "t1",
        "t2",
        "tx",
      ]);
    }

    // reports are intentionally not recalled for a session detail.
    const recalledNamespaces = new Set(
      recall.mock.calls.map((c) => c[0].namespace),
    );
    expect(recalledNamespaces).toEqual(
      new Set(["sessions", "skills", "productivity", "transcripts"]),
    );
    expect(recalledNamespaces.has("reports")).toBe(false);

    // Every pass is capped at limit 100 / maxDistance 1 (the 100/pass cap).
    for (const call of recall.mock.calls) {
      expect(call[0].limit).toBe(100);
      expect(call[0].maxDistance).toBe(1.0);
    }

    // With a non-empty summary, skills/productivity/transcripts run TWO passes
    // each: the broad query plus the session summary text.
    const skillQueries = recall.mock.calls
      .filter((c) => c[0].namespace === "skills")
      .map((c) => c[0].query);
    expect(skillQueries).toEqual(["skill", "Summary for s1"]);
  });

  it("returns a null summary when no sessions entry matches", async () => {
    const recall = vi.fn(async () => ({ results: [], total: 0 }));
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    const result = await getSessionDetail({ sessionId: "missing" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toBeNull();
      expect(result.skills).toEqual([]);
      expect(result.transcripts).toEqual([]);
    }
  });
});
