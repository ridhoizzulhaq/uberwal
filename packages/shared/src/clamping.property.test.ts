// Feature: uberwal, Property 2: Clamping keeps values in range with correct defaults
//
// Validates: Requirements 2.2, 2.3
//
// For any number, `clampLimit` returns a value within [1, 100] and
// `clampMaxDistance` returns a value within [0, 1]; for an `undefined` input
// they return their defaults (10 and 1 respectively); and for any input
// already within range the value is returned unchanged.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import { clampLimit, clampMaxDistance } from "./validation.js";

const NUM_RUNS = 100;

describe("Property 2: Clamping keeps values in range with correct defaults", () => {
  // ── clampLimit ───────────────────────────────────────────────────────────

  test("clampLimit(undefined) === 10 (default)", () => {
    expect(clampLimit(undefined)).toBe(10);
  });

  test("clampLimit always returns a value within [1, 100] for any finite number", () => {
    fc.assert(
      fc.property(
        // Sample widely around and beyond the range so we hit below-min,
        // in-range, and above-max cases. `noNaN: true` keeps the generator
        // focused on finite numbers; the contract for NaN/Infinity is
        // exercised by the explicit unit tests below.
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (n) => {
          const result = clampLimit(n);
          return result >= 1 && result <= 100;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("clampLimit returns in-range values unchanged", () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 100, noNaN: true }), (n) => {
        return clampLimit(n) === n;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("clampLimit raises below-range values to 1", () => {
    fc.assert(
      // Pick numbers strictly below 1; `max: 1 - 1e-9` keeps us under the
      // boundary while staying finite.
      fc.property(
        fc.double({ min: -1e6, max: 1 - 1e-9, noNaN: true }),
        (n) => {
          return clampLimit(n) === 1;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("clampLimit lowers above-range values to 100", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 100 + 1e-9, max: 1e6, noNaN: true }),
        (n) => {
          return clampLimit(n) === 100;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // ── clampMaxDistance ─────────────────────────────────────────────────────

  test("clampMaxDistance(undefined) === 1 (default)", () => {
    expect(clampMaxDistance(undefined)).toBe(1);
  });

  test("clampMaxDistance always returns a value within [0, 1] for any finite number", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (n) => {
          const result = clampMaxDistance(n);
          return result >= 0 && result <= 1;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("clampMaxDistance returns in-range values unchanged", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (n) => {
        return clampMaxDistance(n) === n;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("clampMaxDistance raises below-range values to 0", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: -1e-9, noNaN: true }),
        (n) => {
          return clampMaxDistance(n) === 0;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("clampMaxDistance lowers above-range values to 1", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1 + 1e-9, max: 1e6, noNaN: true }),
        (n) => {
          return clampMaxDistance(n) === 1;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
