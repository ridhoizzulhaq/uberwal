/**
 * Feature: uberwal, Property 5: Recall normalization preserves the required shape.
 *
 * For any raw recall response the SDK might return — including completely
 * malformed payloads — `normalizeRecall` must produce a result where every
 * entry has a string `blob_id`, a string `text`, and a finite numeric
 * `distance`, and where `total` is a non-negative finite number.
 *
 * `normalizeRecall` is documented as never throwing; this property exercises
 * that contract across a wide variety of inputs (well-formed, partially
 * formed, and arbitrary `unknown` values).
 *
 * Validates: Requirements 2.4
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { normalizeRecall } from "./result";
import { encodeMemory } from "./memory-meta";

describe("normalizeRecall — Property 5: Recall normalization preserves the required shape", () => {
  // A "wild" field generator that mixes legitimate types (string, number) with
  // values the SDK should never return but we want to defend against
  // (booleans, null/undefined, NaN, objects, arrays).
  const wildField = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(Number.NEGATIVE_INFINITY),
    fc.object(),
    fc.array(fc.anything()),
  );

  // A structured-looking entry: an object that may or may not carry each of
  // the three expected fields, with each field independently "wild". This
  // exercises the per-field coercion paths inside `normalizeEntry`.
  const structuredEntry = fc.record(
    {
      blob_id: wildField,
      text: wildField,
      distance: wildField,
    },
    { requiredKeys: [] },
  );

  // An entry can be either a structured record OR truly anything (numbers,
  // strings, arrays, null, etc.) — covering the "non-record items in the
  // results array" branch where `normalizeEntry` returns null and the entry
  // is dropped.
  const wildEntry = fc.oneof(structuredEntry, fc.anything());

  // The `results` field can be a proper array, something that is not an
  // array at all, or missing entirely.
  const resultsGen = fc.oneof(
    fc.array(wildEntry),
    fc.anything(),
    fc.constant(undefined),
  );

  // The `total` field can be any number (including NaN/Infinity/negative),
  // a string, null/undefined, or missing entirely.
  const totalGen = fc.oneof(
    fc.integer(),
    fc.double(),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(Number.NEGATIVE_INFINITY),
    fc.integer({ max: -1 }),
    fc.string(),
    fc.constant(null),
    fc.constant(undefined),
  );

  // The raw response is either a structured "looks like a recall response"
  // record or any arbitrary value the SDK could conceivably return.
  const rawResponseGen = fc.oneof(
    fc.record(
      {
        results: resultsGen,
        total: totalGen,
      },
      { requiredKeys: [] },
    ),
    fc.anything(),
  );

  it("every entry has blob_id/text/numeric distance and total is non-negative", () => {
    fc.assert(
      fc.property(rawResponseGen, (raw) => {
        const result = normalizeRecall(raw);

        // Top-level shape: results is an array, total is a non-negative
        // finite number.
        expect(Array.isArray(result.results)).toBe(true);
        expect(typeof result.total).toBe("number");
        expect(Number.isFinite(result.total)).toBe(true);
        expect(result.total).toBeGreaterThanOrEqual(0);

        // Per-entry shape: every entry must carry the three normalized fields
        // with the documented types, regardless of how malformed the raw
        // entry was.
        for (const entry of result.results) {
          expect(typeof entry.blob_id).toBe("string");
          expect(typeof entry.text).toBe("string");
          expect(typeof entry.distance).toBe("number");
          expect(Number.isFinite(entry.distance)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("normalizeRecall — per-session metadata header parsing", () => {
  it("strips the header from text and populates sessionId/index/factType", () => {
    const encoded = encodeMemory(
      { sessionId: "sess-9", type: "transcript", index: 3 },
      "User: do X\nAssistant: done",
    );
    const result = normalizeRecall({
      results: [{ blob_id: "b1", text: encoded, distance: 0.2 }],
      total: 1,
    });

    expect(result.results).toHaveLength(1);
    const entry = result.results[0]!;
    expect(entry.text).toBe("User: do X\nAssistant: done");
    expect(entry.sessionId).toBe("sess-9");
    expect(entry.index).toBe(3);
    expect(entry.factType).toBe("transcript");
    expect(entry.distance).toBe(0.2);
  });

  it("attaches only sessionId when type/index are absent", () => {
    const encoded = encodeMemory({ sessionId: "sess-1" }, "TypeScript");
    const result = normalizeRecall({
      results: [{ blob_id: "b1", text: encoded, distance: 0.1 }],
    });

    const entry = result.results[0]!;
    expect(entry.text).toBe("TypeScript");
    expect(entry.sessionId).toBe("sess-1");
    expect("index" in entry).toBe(false);
    expect("factType" in entry).toBe(false);
  });

  it("leaves header-free entries unchanged with no metadata fields", () => {
    const result = normalizeRecall({
      results: [{ blob_id: "b1", text: "plain stored memory", distance: 0.5 }],
    });

    const entry = result.results[0]!;
    expect(entry.text).toBe("plain stored memory");
    expect("sessionId" in entry).toBe(false);
    expect("index" in entry).toBe(false);
    expect("factType" in entry).toBe(false);
  });
});
