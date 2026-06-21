// Feature: uberwal, Property 10: Distance values are formatted to two decimals.
//
// Validates: Requirements 12.3
//
// For any number in [0, 1], `formatDistance` returns the input rounded to
// exactly two decimal places: the result matches the pattern `^\d\.\d{2}$`
// and round-tripping through `parseFloat` agrees with the input to within
// half a unit in the last place (i.e. the rounding step itself).

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import { formatDistance } from "./format";

const NUM_RUNS = 100;

// Recall distances are floats in [0, 1]. Within that range every two-decimal
// representation has exactly one digit before the decimal point ("0" or "1"),
// so the formatted output is fully described by the pattern below.
const TWO_DECIMAL = /^\d\.\d{2}$/;

describe("Property 10: Distance values are formatted to two decimals", () => {
  test("formatDistance(value) matches /^\\d\\.\\d{2}$/ for any value in [0, 1]", () => {
    fc.assert(
      fc.property(
        // `noNaN` keeps the generator on finite numbers; both endpoints are
        // included so the boundary cases 0 and 1 are exercised.
        fc.double({ min: 0, max: 1, noNaN: true }),
        (value) => {
          return TWO_DECIMAL.test(formatDistance(value));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("formatDistance(value) is the input rounded to two decimals", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        (value) => {
          // The output, parsed back as a number, must lie within half a
          // hundredth of the original value (the maximum error introduced
          // by a correct round-to-two-decimals operation).
          const parsed = Number.parseFloat(formatDistance(value));
          return Math.abs(parsed - value) <= 0.005 + 1e-9;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Concrete boundary cases, kept alongside the property to anchor intent
  // and guard against regressions at the endpoints of the documented range.
  test("formatDistance pins the documented endpoint values", () => {
    expect(formatDistance(0)).toBe("0.00");
    expect(formatDistance(1)).toBe("1.00");
    expect(TWO_DECIMAL.test(formatDistance(0))).toBe(true);
    expect(TWO_DECIMAL.test(formatDistance(1))).toBe(true);
  });
});
