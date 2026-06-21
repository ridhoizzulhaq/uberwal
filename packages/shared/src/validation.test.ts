/**
 * Property tests for the blank-input behaviour of `isValidQuery` and
 * `isValidTranscript` in `validation.ts`.
 *
 * Validates: Requirements 1.4, 2.7
 *
 * Note: `tasks.md` originally cites Requirement 1.7 here; that requirement
 * was renumbered to 1.4 in the current `requirements.md`.
 */

import { describe, expect, test } from "vitest";
import fc from "fast-check";

import { isValidQuery, isValidTranscript } from "./validation";

/**
 * A representative sample of whitespace code points covering ASCII whitespace
 * and several distinct Unicode whitespace categories. Every character below
 * is matched by `\s` and is stripped by `String.prototype.trim`, so any
 * string composed solely of these characters must be treated as blank.
 */
const WHITESPACE_CHARS = [
  " ",       // U+0020 space
  "\t",      // U+0009 tab
  "\n",      // U+000A line feed
  "\r",      // U+000D carriage return
  "\f",      // U+000C form feed
  "\v",      // U+000B vertical tab
  "\u00A0",  // no-break space
  "\u1680",  // ogham space mark
  "\u2003",  // em space
  "\u2009",  // thin space
  "\u200A",  // hair space
  "\u2028",  // line separator
  "\u2029",  // paragraph separator
  "\u202F",  // narrow no-break space
  "\u205F",  // medium mathematical space
  "\u3000",  // ideographic space
  "\uFEFF",  // zero-width no-break space (BOM)
];

/** Single whitespace character drawn from the representative sample above. */
const whitespaceChar = fc.constantFrom(...WHITESPACE_CHARS);

/**
 * A possibly-empty run of whitespace characters of varying length. Covers
 * the empty-string case (empty array) and arbitrary mixed-whitespace strings
 * (e.g. " \t\n", "\u00A0\u3000", "").
 */
const blankString: fc.Arbitrary<string> = fc
  .array(whitespaceChar, { maxLength: 32 })
  .map((chars) => chars.join(""));

/**
 * A string guaranteed to contain at least one non-whitespace character.
 *
 * Strategy: take an arbitrary unicode string (which may itself be all
 * whitespace) and splice a guaranteed non-whitespace character into a
 * uniformly-chosen position. The resulting string therefore always contains
 * the inserted marker and so always satisfies `/\S/`.
 */
const nonBlankString: fc.Arbitrary<string> = fc
  .tuple(
    fc.string(),
    fc.string({ minLength: 1, maxLength: 1 }).filter((c) => /\S/.test(c)),
    fc.nat(),
  )
  .map(([prefix, marker, n]) => {
    const idx = prefix.length === 0 ? 0 : n % (prefix.length + 1);
    return prefix.slice(0, idx) + marker + prefix.slice(idx);
  });

/**
 * Mixed generator: undefined, null, empty string, whitespace-only string, or
 * a string guaranteed to contain at least one non-whitespace character. The
 * expected validation result is derived from the value itself, so the test
 * does not need to track which branch produced it.
 */
const mixedInput: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.constant<string | null | undefined>(undefined),
  fc.constant<string | null | undefined>(null),
  fc.constant<string | null | undefined>(""),
  blankString as fc.Arbitrary<string | null | undefined>,
  nonBlankString as fc.Arbitrary<string | null | undefined>,
);

describe("validation: blank-input rejection", () => {
  // Feature: uberwal, Property 1: Blank input is rejected, non-blank input is accepted.
  // Validates: Requirements 1.4, 2.7
  test("isValidQuery and isValidTranscript accept iff input has a non-whitespace character", () => {
    fc.assert(
      fc.property(mixedInput, (value) => {
        // The contract is identical for both helpers: accept iff the value
        // is a string containing at least one non-whitespace character.
        const expected = typeof value === "string" && value.trim().length > 0;
        expect(isValidQuery(value)).toBe(expected);
        expect(isValidTranscript(value)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});
