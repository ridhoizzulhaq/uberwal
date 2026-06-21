/**
 * Unit tests for recipient-side manifest scoping.
 *
 * `recallByToken` recalls one namespace on a recipient's behalf and then
 * narrows the results to whatever the share's manifest allows. The narrowing
 * is the security-relevant part, so these tests exercise it two ways:
 *
 *   1. directly against the pure {@link filterByManifestScope} helper, pinning
 *      the blob-only / session-only / both / neither semantics; and
 *   2. through `recallByToken` itself with a mocked `getShareStore` and a fake
 *      `MemWalClient`, proving a manifest carrying `sessionIds` filters the
 *      recalled entries to those sessions while an empty manifest returns all.
 *
 * The share store and the shared `MemWalClient` are mocked so the test never
 * opens SQLite or talks to a relayer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecallEntry } from "@uberwal/shared";

const mocks = vi.hoisted(() => ({
  getByToken: vi.fn(),
  recall: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("../../server/share-store.js", () => ({
  getShareStore: () => ({ getByToken: mocks.getByToken }),
}));

// The action builds a per-request client via `MemWalClient.fromCredentials`.
// Stub it to hand back our recall spy so no network/SDK is touched.
vi.mock("@uberwal/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@uberwal/shared")>();
  return {
    ...actual,
    MemWalClient: {
      fromCredentials: () => ({ recall: mocks.recall }),
    },
  };
});

import { filterByManifestScope } from "../../server/manifest-scope.js";
import {
  recallByToken,
  listSessionsByToken,
  getSessionDetailByToken,
} from "./shared-access.js";

const ENTRIES: RecallEntry[] = [
  { blob_id: "b1", text: "one", distance: 0.1, sessionId: "s1" },
  { blob_id: "b2", text: "two", distance: 0.2, sessionId: "s2" },
  { blob_id: "b3", text: "three", distance: 0.3, sessionId: "s3" },
  { blob_id: "b4", text: "no session", distance: 0.4 },
];

describe("filterByManifestScope", () => {
  it("returns the input array unchanged when neither whitelist is set", () => {
    const out = filterByManifestScope(ENTRIES, {});
    expect(out).toBe(ENTRIES);
  });

  it("filters by blobIds only", () => {
    const out = filterByManifestScope(ENTRIES, { blobIds: ["b1", "b3"] });
    expect(out.map((e) => e.blob_id)).toEqual(["b1", "b3"]);
  });

  it("filters by sessionIds only (drops entries without a session)", () => {
    const out = filterByManifestScope(ENTRIES, { sessionIds: ["s2", "s3"] });
    expect(out.map((e) => e.blob_id)).toEqual(["b2", "b3"]);
  });

  it("requires an entry to pass BOTH when both whitelists are set", () => {
    const out = filterByManifestScope(ENTRIES, {
      blobIds: ["b1", "b2"],
      sessionIds: ["s2", "s3"],
    });
    expect(out.map((e) => e.blob_id)).toEqual(["b2"]);
  });
});

describe("recallByToken — session scoping", () => {
  beforeEach(() => {
    process.env["RELAYER_URL"] = "https://relayer.example";
    mocks.getByToken.mockReset();
    mocks.recall.mockReset();
    mocks.recall.mockResolvedValue({ results: ENTRIES, total: ENTRIES.length });
  });

  it("filters recalled results to the manifest's sessionIds", async () => {
    mocks.getByToken.mockReturnValueOnce({
      ownerAccountId: "0xowner",
      delegateKey: "key",
      revokedAt: null,
      manifest: {
        mode: "summary",
        namespaces: ["sessions", "skills", "productivity", "reports"],
        sessionIds: ["s1", "s3"],
      },
    });

    const result = await recallByToken({
      token: "tok",
      namespace: "skills",
      query: "anything",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.map((e) => e.blob_id)).toEqual(["b1", "b3"]);
      expect(result.total).toBe(2);
    }
  });

  it("returns all recalled results when no sessionIds/blobIds are set", async () => {
    mocks.getByToken.mockReturnValueOnce({
      ownerAccountId: "0xowner",
      delegateKey: "key",
      revokedAt: null,
      manifest: {
        mode: "summary",
        namespaces: ["sessions", "skills", "productivity", "reports"],
      },
    });

    const result = await recallByToken({
      token: "tok",
      namespace: "skills",
      query: "anything",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results).toHaveLength(ENTRIES.length);
      expect(result.total).toBe(ENTRIES.length);
    }
  });
});

describe("listSessionsByToken", () => {
  beforeEach(() => {
    process.env["RELAYER_URL"] = "https://relayer.example";
    mocks.getByToken.mockReset();
    mocks.recall.mockReset();
  });

  it("returns ok:false for an unknown token", async () => {
    mocks.getByToken.mockReturnValueOnce(null);
    const result = await listSessionsByToken({ token: "nope" });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for a revoked token", async () => {
    mocks.getByToken.mockReturnValueOnce({
      ownerAccountId: "0xowner",
      delegateKey: "key",
      revokedAt: 123,
      manifest: { mode: "summary", namespaces: ["sessions"] },
    });
    const result = await listSessionsByToken({ token: "tok" });
    expect(result.ok).toBe(false);
  });

  it("returns an empty list when 'sessions' is not in the manifest", async () => {
    mocks.getByToken.mockReturnValueOnce({
      ownerAccountId: "0xowner",
      delegateKey: "key",
      revokedAt: null,
      manifest: { mode: "summary", namespaces: ["skills", "productivity"] },
    });
    const result = await listSessionsByToken({ token: "tok" });
    expect(result).toEqual({ ok: true, sessions: [] });
    expect(mocks.recall).not.toHaveBeenCalled();
  });

  it("maps sessions and narrows by the manifest sessionIds whitelist", async () => {
    mocks.recall.mockResolvedValueOnce({
      results: [
        { blob_id: "b1", text: "Session 1", distance: 0.1, sessionId: "s1" },
        { blob_id: "b2", text: "Session 2", distance: 0.2, sessionId: "s2" },
        { blob_id: "b3", text: "Legacy", distance: 0.3 },
      ],
      total: 3,
    });
    mocks.getByToken.mockReturnValueOnce({
      ownerAccountId: "0xowner",
      delegateKey: "key",
      revokedAt: null,
      manifest: {
        mode: "summary",
        namespaces: ["sessions", "skills"],
        sessionIds: ["s1"],
      },
    });

    const result = await listSessionsByToken({ token: "tok" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions).toEqual([
        { sessionId: "s1", blob_id: "b1", text: "Session 1", repo: null },
      ]);
    }
  });
});

describe("getSessionDetailByToken", () => {
  beforeEach(() => {
    process.env["RELAYER_URL"] = "https://relayer.example";
    mocks.getByToken.mockReset();
    mocks.recall.mockReset();
  });

  it("rejects a session not on the manifest's sessionIds whitelist", async () => {
    mocks.getByToken.mockReturnValueOnce({
      ownerAccountId: "0xowner",
      delegateKey: "key",
      revokedAt: null,
      manifest: {
        mode: "full",
        namespaces: ["sessions", "skills", "productivity", "reports", "transcripts"],
        sessionIds: ["allowed"],
      },
    });

    const result = await getSessionDetailByToken({ token: "tok", sessionId: "other" });
    expect(result).toEqual({ ok: false, message: "This session is not shared." });
    expect(mocks.recall).not.toHaveBeenCalled();
  });

  it("only gathers namespaces present in the manifest (Summary => no transcripts)", async () => {
    mocks.recall.mockImplementation(async (params: { namespace: string }) => {
      const all = [
        { blob_id: `${params.namespace}-1`, text: "x", distance: 0.1, sessionId: "s1" },
        { blob_id: `${params.namespace}-2`, text: "y", distance: 0.2, sessionId: "s2" },
      ];
      return { results: all, total: all.length };
    });
    mocks.getByToken.mockReturnValueOnce({
      ownerAccountId: "0xowner",
      delegateKey: "key",
      revokedAt: null,
      manifest: {
        // Summary mode: transcripts NOT allowed.
        mode: "summary",
        namespaces: ["sessions", "skills", "productivity", "reports"],
      },
    });

    const result = await getSessionDetailByToken({ token: "tok", sessionId: "s1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary?.blob_id).toBe("sessions-1");
      expect(result.skills.map((e) => e.blob_id)).toEqual(["skills-1"]);
      expect(result.productivity.map((e) => e.blob_id)).toEqual(["productivity-1"]);
      // transcripts not in the manifest => never gathered.
      expect(result.transcripts).toEqual([]);
    }
    const recalledNamespaces = new Set(
      mocks.recall.mock.calls.map(
        (c) => (c[0] as { namespace: string }).namespace,
      ),
    );
    expect(recalledNamespaces.has("transcripts")).toBe(false);
  });
});
