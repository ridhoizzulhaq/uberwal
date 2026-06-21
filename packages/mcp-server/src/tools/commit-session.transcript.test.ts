/**
 * Tests for the automatic transcript-storage behavior of `commit_session`.
 *
 * Skill/productivity facts stay review-first; transcript chunks supplied in
 * the commit input are stored automatically (no per-chunk review) into the
 * `transcripts` namespace. These tests verify routing, fail-soft per-chunk
 * reporting, and that omitting chunks is a clean no-op.
 */

import { describe, expect, it } from "vitest";

import type { MemWalClient, Namespace, StoredRef } from "@uberwal/shared";

import { commitSessionHandler } from "./commit-session.js";
import type { CommitSessionResult } from "./candidate.js";
import type { ToolDeps } from "./register.js";

interface RememberCall {
  text: string;
  namespace: Namespace;
}

function createMemWalStub(failTexts: ReadonlySet<string> = new Set()): {
  memwal: MemWalClient;
  calls: RememberCall[];
} {
  const calls: RememberCall[] = [];
  const stub = {
    async isHealthy(): Promise<boolean> {
      return true;
    },
    async remember(text: string, namespace: Namespace): Promise<StoredRef> {
      calls.push({ text, namespace });
      if (failTexts.has(text)) {
        throw new Error(`stub failure for "${text}"`);
      }
      return { id: `id-${calls.length}`, blob_id: `blob-${calls.length}`, namespace };
    },
  };
  return { memwal: stub as unknown as MemWalClient, calls };
}

function makeDeps(memwal: MemWalClient): ToolDeps {
  return {
    memwal,
    extractor: undefined as unknown as ToolDeps["extractor"],
    config: undefined as unknown as ToolDeps["config"],
  };
}

function readResult(structured: unknown): CommitSessionResult {
  return structured as CommitSessionResult;
}

describe("commit_session transcript storage", () => {
  it("stores each transcript chunk into the transcripts namespace alongside reviewed facts", async () => {
    const stub = createMemWalStub();
    const response = await commitSessionHandler(makeDeps(stub.memwal), {
      approved: [{ id: "s1", type: "session", text: "summary" }],
      transcriptChunks: [
        { index: 0, text: "User: do X" },
        { index: 1, text: "Assistant: done X" },
      ],
    });

    expect(response.isError).not.toBe(true);

    // 1 approved (sessions) + 2 transcript chunks (transcripts) = 3 writes.
    expect(stub.calls).toHaveLength(3);
    const transcriptCalls = stub.calls.filter((c) => c.namespace === "transcripts");
    expect(transcriptCalls.map((c) => c.text)).toEqual([
      "User: do X",
      "Assistant: done X",
    ]);

    const result = readResult(response.structuredContent);
    // Reviewed-candidate tallies cover approved only (Property 7 invariant).
    expect(result.outcomes).toHaveLength(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    // Transcript tallies are tracked separately.
    expect(result.transcriptOutcomes).toHaveLength(2);
    expect(result.transcriptsStored).toBe(2);
    expect(result.transcriptsFailed).toBe(0);
    expect(result.transcriptOutcomes.every((o) => o.ok)).toBe(true);
  });

  it("reports per-chunk failures without aborting the rest", async () => {
    const stub = createMemWalStub(new Set(["chunk-1"]));
    const response = await commitSessionHandler(makeDeps(stub.memwal), {
      approved: [{ id: "s1", type: "session", text: "summary" }],
      transcriptChunks: [
        { index: 0, text: "chunk-0" },
        { index: 1, text: "chunk-1" }, // designated to fail
        { index: 2, text: "chunk-2" },
      ],
    });

    const result = readResult(response.structuredContent);
    expect(result.transcriptOutcomes).toHaveLength(3);
    expect(result.transcriptsStored).toBe(2);
    expect(result.transcriptsFailed).toBe(1);
    const failed = result.transcriptOutcomes.filter((o) => !o.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.index).toBe(1);
    // Every chunk was attempted (no early abort).
    expect(stub.calls.filter((c) => c.namespace === "transcripts")).toHaveLength(3);
  });

  it("is a clean no-op for transcripts when no chunks are supplied", async () => {
    const stub = createMemWalStub();
    const response = await commitSessionHandler(makeDeps(stub.memwal), {
      approved: [{ id: "s1", type: "skill", text: "TypeScript" }],
    });

    const result = readResult(response.structuredContent);
    expect(result.transcriptOutcomes).toEqual([]);
    expect(result.transcriptsStored).toBe(0);
    expect(result.transcriptsFailed).toBe(0);
    expect(stub.calls.every((c) => c.namespace !== "transcripts")).toBe(true);
  });

  it("does not store transcripts when the health gate fails", async () => {
    const stub = createMemWalStub();
    // Force unhealthy by overriding isHealthy.
    const unhealthy = {
      ...(stub.memwal as unknown as Record<string, unknown>),
      isHealthy: async () => false,
    } as unknown as MemWalClient;

    const response = await commitSessionHandler(makeDeps(unhealthy), {
      approved: [{ id: "s1", type: "session", text: "summary" }],
      transcriptChunks: [{ index: 0, text: "chunk" }],
    });

    expect(response.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });
});
