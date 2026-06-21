/**
 * Unit tests for the shared multi-pass session gather helper.
 *
 * These pin the coverage-widening behavior used by BOTH the owner's
 * `getSessionDetail` and the recipient's `getSessionDetailByToken`:
 *   - multiple recall passes are merged and deduped by `blob_id`;
 *   - the smallest-distance occurrence of a duplicate is kept;
 *   - only entries matching the requested `sessionId` survive;
 *   - empty/whitespace queries are skipped;
 *   - each pass is capped at limit 100 / maxDistance 1;
 *   - transcript sorting is index-ascending with index-less entries last.
 */

import { describe, expect, it, vi } from "vitest";

import type { RecallEntry } from "@uberwal/shared";

import {
  gatherSessionNamespace,
  queriesForNamespace,
  sortTranscriptsByIndex,
  type SessionRecallFn,
} from "./session-gather.js";

describe("gatherSessionNamespace", () => {
  it("merges + dedupes across passes and filters by sessionId", async () => {
    const broadPass: RecallEntry[] = [
      { blob_id: "a", text: "A", distance: 0.5, sessionId: "s1" },
      { blob_id: "b", text: "B", distance: 0.4, sessionId: "s2" },
    ];
    const summaryPass: RecallEntry[] = [
      // duplicate of "a" with a smaller distance -> should be kept
      { blob_id: "a", text: "A", distance: 0.2, sessionId: "s1" },
      { blob_id: "c", text: "C", distance: 0.3, sessionId: "s1" },
    ];
    const seenParams: { limit: number; maxDistance: number }[] = [];
    const recall: SessionRecallFn = vi.fn(async (p) => {
      seenParams.push({ limit: p.limit, maxDistance: p.maxDistance });
      return p.query === "broad" ? broadPass : summaryPass;
    });

    const out = await gatherSessionNamespace({
      recall,
      namespace: "skills",
      sessionId: "s1",
      queries: ["broad", "summary"],
    });

    // "b" belongs to s2 (dropped); "a" and "c" belong to s1.
    expect(out.map((e) => e.blob_id).sort()).toEqual(["a", "c"]);
    const a = out.find((e) => e.blob_id === "a");
    expect(a?.distance).toBe(0.2); // smallest-distance occurrence kept
    expect(recall).toHaveBeenCalledTimes(2);
    for (const p of seenParams) {
      expect(p.limit).toBe(100);
      expect(p.maxDistance).toBe(1.0);
    }
  });

  it("skips empty/whitespace queries", async () => {
    const queries: string[] = [];
    const recall: SessionRecallFn = vi.fn(async (p) => {
      queries.push(p.query);
      return [];
    });
    await gatherSessionNamespace({
      recall,
      namespace: "transcripts",
      sessionId: "s1",
      queries: ["", "   ", "real"],
    });
    expect(queries).toEqual(["real"]);
  });
});

describe("queriesForNamespace", () => {
  it("adds the summary text as a second pass when present", () => {
    expect(queriesForNamespace("skills", "  My session  ")).toEqual([
      "skill",
      "My session",
    ]);
  });

  it("uses only the broad query when the summary is empty/whitespace", () => {
    expect(queriesForNamespace("productivity", "   ")).toEqual(["productivity"]);
    expect(queriesForNamespace("transcripts", "")).toEqual(["transcript"]);
  });
});

describe("sortTranscriptsByIndex", () => {
  it("sorts by index ascending, index-less last (stable)", () => {
    const input: RecallEntry[] = [
      { blob_id: "t2", text: "2", distance: 0, index: 2 },
      { blob_id: "x1", text: "x", distance: 0 },
      { blob_id: "t0", text: "0", distance: 0, index: 0 },
      { blob_id: "x2", text: "x", distance: 0 },
      { blob_id: "t1", text: "1", distance: 0, index: 1 },
    ];
    expect(sortTranscriptsByIndex(input).map((e) => e.blob_id)).toEqual([
      "t0",
      "t1",
      "t2",
      "x1",
      "x2",
    ]);
  });
});
