/**
 * Unit tests for the memory metadata codec (`memory-meta.ts`).
 *
 * The codec is the backbone of per-session linkage: it embeds a structured
 * header into the single TEXT slot MemWal stores per memory and strips it back
 * out at recall. These tests pin down the round-trip contract and — crucially —
 * the backward-compatibility guarantees: arbitrary text without the prefix and
 * malformed headers must pass through untouched, and parsing must never throw.
 */

import { describe, it, expect } from "vitest";

import {
  encodeMemory,
  parseMemory,
  MEMORY_META_PREFIX,
  type MemoryMeta,
} from "./memory-meta";

describe("memory-meta codec", () => {
  it("round-trips meta + body (encode → parse recovers both)", () => {
    const meta: MemoryMeta = { sessionId: "sess-123", type: "skill", index: 4 };
    const body = "TypeScript\n\nEvidence: typed the middleware.";

    const encoded = encodeMemory(meta, body);
    expect(encoded.startsWith(MEMORY_META_PREFIX)).toBe(true);

    const parsed = parseMemory(encoded);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toBe(body);
  });

  it("preserves a body that contains newlines and prefix-like text", () => {
    const meta: MemoryMeta = { sessionId: "s1" };
    // A body that itself looks like a header and has multiple lines.
    const body = `${MEMORY_META_PREFIX}not-really-a-header\nline two\nline three`;

    const parsed = parseMemory(encodeMemory(meta, body));
    expect(parsed.meta).toEqual({ sessionId: "s1" });
    expect(parsed.body).toBe(body);
  });

  it("returns {meta:null, body:text} for non-prefixed text", () => {
    const text = "just a plain stored memory with no header";
    expect(parseMemory(text)).toEqual({ meta: null, body: text });
  });

  it("treats a prefixed-but-malformed header as plain body (never throws)", () => {
    // Prefix present but no newline terminator.
    const noNewline = `${MEMORY_META_PREFIX}eyJzZXNzaW9uSWQiOiJ4In0`;
    expect(parseMemory(noNewline)).toEqual({ meta: null, body: noNewline });

    // Prefix + bad base64/JSON segment + newline → header decode fails.
    const badPayload = `${MEMORY_META_PREFIX}!!!not-base64-json!!!\nbody here`;
    expect(parseMemory(badPayload)).toEqual({ meta: null, body: badPayload });

    // Valid base64url+JSON but missing the required string sessionId.
    const missingSession = `${MEMORY_META_PREFIX}${Buffer.from(
      JSON.stringify({ type: "skill" }),
      "utf8",
    ).toString("base64url")}\nbody`;
    expect(parseMemory(missingSession)).toEqual({ meta: null, body: missingSession });

    // sessionId present but wrong type.
    const wrongType = `${MEMORY_META_PREFIX}${Buffer.from(
      JSON.stringify({ sessionId: 42 }),
      "utf8",
    ).toString("base64url")}\nbody`;
    expect(parseMemory(wrongType)).toEqual({ meta: null, body: wrongType });
  });

  it("preserves optional fields when present and omits them when absent", () => {
    // Only sessionId.
    const minimal = parseMemory(encodeMemory({ sessionId: "only" }, "body"));
    expect(minimal.meta).toEqual({ sessionId: "only" });
    expect(minimal.meta && "type" in minimal.meta).toBe(false);
    expect(minimal.meta && "index" in minimal.meta).toBe(false);

    // sessionId + type only.
    const withType = parseMemory(
      encodeMemory({ sessionId: "s", type: "transcript" }, "body"),
    );
    expect(withType.meta).toEqual({ sessionId: "s", type: "transcript" });
    expect(withType.meta && "index" in withType.meta).toBe(false);

    // sessionId + index only (including index 0).
    const withIndex = parseMemory(encodeMemory({ sessionId: "s", index: 0 }, "body"));
    expect(withIndex.meta).toEqual({ sessionId: "s", index: 0 });
    expect(withIndex.meta && "type" in withIndex.meta).toBe(false);
  });

  it("does not treat a non-finite index as a valid field", () => {
    // Manually craft a header carrying a non-finite index (which JSON encodes
    // as null); parseMemory must drop the index but keep the rest.
    const encoded = `${MEMORY_META_PREFIX}${Buffer.from(
      JSON.stringify({ sessionId: "s", index: null }),
      "utf8",
    ).toString("base64url")}\nbody`;
    const parsed = parseMemory(encoded);
    expect(parsed.meta).toEqual({ sessionId: "s" });
    expect(parsed.body).toBe("body");
  });
});
