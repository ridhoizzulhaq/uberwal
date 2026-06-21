/**
 * Unit tests for transcript chunking.
 *
 * Cover: turn-boundary splitting, size-splitting of oversized turns with
 * overlap, sequential contiguous indices, no-marker fallback, and the blank
 * input case.
 */

import { describe, expect, it } from "vitest";

import { chunkTranscript } from "./chunk";

describe("chunkTranscript", () => {
  it("splits on conversation-turn boundaries", () => {
    const transcript = [
      "User: add a login form",
      "Assistant: sure, here is the component",
      "User: now add validation",
      "Assistant: added zod validation",
    ].join("\n");

    const chunks = chunkTranscript(transcript);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.text).toContain("add a login form");
    expect(chunks[1]?.text).toContain("here is the component");
    expect(chunks[2]?.text).toContain("now add validation");
    expect(chunks[3]?.text).toContain("added zod validation");
  });

  it("numbers chunks sequentially from 0 and keeps indices contiguous", () => {
    const transcript = "User: a\nAssistant: b\nUser: c";
    const chunks = chunkTranscript(transcript);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("treats a transcript with no role markers as a single turn", () => {
    const transcript = "just some freeform notes about the session, no markers here";
    const chunks = chunkTranscript(transcript);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(transcript);
    expect(chunks[0]?.index).toBe(0);
  });

  it("size-splits an oversized turn into overlapping windows", () => {
    // One giant turn well over the (overridden) max so it must split.
    const body = "x".repeat(1000);
    const transcript = `User: ${body}`;
    const chunks = chunkTranscript(transcript, { maxChars: 300, overlap: 50 });

    // More than one window, each at or under the max.
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(300);
    }
    // Indices stay contiguous across the split windows.
    expect(chunks.map((c) => c.index)).toEqual(
      chunks.map((_, i) => i),
    );

    // Overlap: the end of window N reappears at the start of window N+1.
    const first = chunks[0]!.text;
    const second = chunks[1]!.text;
    const overlapTail = first.slice(first.length - 50);
    expect(second.startsWith(overlapTail)).toBe(true);
  });

  it("supports angle-bracket and markdown-decorated turn markers", () => {
    const transcript = [
      "<user>do X</user>",
      "**Assistant:** done X",
    ].join("\n");
    const chunks = chunkTranscript(transcript);
    expect(chunks).toHaveLength(2);
  });

  it("returns an empty array for blank input", () => {
    expect(chunkTranscript("")).toEqual([]);
    expect(chunkTranscript("   \n\t ")).toEqual([]);
  });
});
