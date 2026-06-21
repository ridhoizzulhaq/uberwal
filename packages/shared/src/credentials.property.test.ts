// Feature: uberwal, Property 4: Credential format validation accepts exactly well-formed hex
// Validates: Requirements 7.4
//
// `isValidDelegateKey(value)` must return `true` iff `value` is exactly 64
// hexadecimal characters with no prefix; `isValidAccountId(value)` must return
// `true` iff `value` is `0x` followed by exactly 64 hexadecimal characters.
// Any wrong length, missing/extra prefix (including an uppercase `0X`),
// embedded non-hex character, or surrounding whitespace must yield `false`
// for the corresponding predicate. This property test draws from a labelled
// mix of well-formed hex (correct length, mixed/upper/lower case), off-by-one
// length variants (with and without a `0x` prefix), strings carrying a single
// non-hex character at a random position, and `0x`-prefix variants
// (lowercase prefix as a valid account id; uppercase `0X` prefix as a
// rejection case) so both branches of each biconditional are sampled on
// every run.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { isValidAccountId, isValidDelegateKey } from "./validation";

/** Lowercase hex digits. */
const HEX_LOWER = "0123456789abcdef";
/** Uppercase hex digits. */
const HEX_UPPER = "0123456789ABCDEF";
/** Mixed-case hex alphabet (the validators are case-insensitive on contents). */
const HEX_MIXED = HEX_LOWER + HEX_UPPER;

/** A single hex character drawn from the mixed-case alphabet. */
const hexChar: fc.Arbitrary<string> = fc.constantFrom(...HEX_MIXED.split(""));
/** A single hex character constrained to lowercase. */
const hexLowerChar: fc.Arbitrary<string> = fc.constantFrom(
  ...HEX_LOWER.split(""),
);
/** A single hex character constrained to uppercase. */
const hexUpperChar: fc.Arbitrary<string> = fc.constantFrom(
  ...HEX_UPPER.split(""),
);

/** Build a hex string of exactly `n` characters from the given alphabet. */
const hexStringOfLength = (
  n: number,
  alphabet: fc.Arbitrary<string> = hexChar,
): fc.Arbitrary<string> =>
  fc.array(alphabet, { minLength: n, maxLength: n }).map((a) => a.join(""));

/**
 * A single character that is NOT a hexadecimal digit. Sampled from printable
 * ASCII so the resulting test values stay readable in shrinking output and
 * cover common typos (`g`, `z`, punctuation, whitespace) without dragging in
 * surrogate-pair length quirks.
 */
const nonHexChar: fc.Arbitrary<string> = fc
  .char()
  .filter((c) => !/^[0-9a-fA-F]$/.test(c));

/** A single labelled credential test case with the expected predicate outcome. */
interface CredentialCase {
  /** Human-readable variant label used purely for failure diagnostics. */
  label: string;
  /** The candidate string fed to both predicates. */
  value: string;
  /** Expected result of `isValidDelegateKey(value)`. */
  expectedDelegate: boolean;
  /** Expected result of `isValidAccountId(value)`. */
  expectedAccount: boolean;
}

// ── Variant generators ────────────────────────────────────────────────────

/** Correct-length hex with mixed case → valid delegate, not an account id. */
const correctLengthMixedCase: fc.Arbitrary<CredentialCase> = hexStringOfLength(
  64,
).map((s) => ({
  label: "correct-length mixed-case hex (no prefix)",
  value: s,
  expectedDelegate: true,
  expectedAccount: false,
}));

/** Correct-length hex, all lowercase → valid delegate, not an account id. */
const correctLengthAllLower: fc.Arbitrary<CredentialCase> = hexStringOfLength(
  64,
  hexLowerChar,
).map((s) => ({
  label: "correct-length all-lowercase hex (no prefix)",
  value: s,
  expectedDelegate: true,
  expectedAccount: false,
}));

/** Correct-length hex, all uppercase → valid delegate, not an account id. */
const correctLengthAllUpper: fc.Arbitrary<CredentialCase> = hexStringOfLength(
  64,
  hexUpperChar,
).map((s) => ({
  label: "correct-length all-uppercase hex (no prefix)",
  value: s,
  expectedDelegate: true,
  expectedAccount: false,
}));

/** `0x` + 64 hex chars → valid account id, NOT a valid delegate key (length 66). */
const accountWithLowerPrefix: fc.Arbitrary<CredentialCase> = hexStringOfLength(
  64,
).map((s) => ({
  label: "0x-prefixed 64-hex (valid account id)",
  value: "0x" + s,
  expectedDelegate: false,
  expectedAccount: true,
}));

/** Off-by-one length (no prefix): 63 or 65 hex chars. Rejected by both predicates. */
const offByOneNoPrefix: fc.Arbitrary<CredentialCase> = fc
  .oneof(hexStringOfLength(63), hexStringOfLength(65))
  .map((s) => ({
    label: `off-by-one length ${s.length} (no prefix)`,
    value: s,
    expectedDelegate: false,
    expectedAccount: false,
  }));

/** Off-by-one length with `0x` prefix: `0x` + 63 or 65 hex chars. Rejected by both. */
const offByOneWithPrefix: fc.Arbitrary<CredentialCase> = fc
  .oneof(hexStringOfLength(63), hexStringOfLength(65))
  .map((s) => ({
    label: `0x-prefixed off-by-one length ${2 + s.length}`,
    value: "0x" + s,
    expectedDelegate: false,
    expectedAccount: false,
  }));

/**
 * 64-character string with exactly one non-hex character inserted at a random
 * position. Length matches the delegate-key requirement but contents are not
 * pure hex, so both predicates must reject.
 */
const nonHexNoPrefix: fc.Arbitrary<CredentialCase> = fc
  .tuple(hexStringOfLength(63), nonHexChar, fc.integer({ min: 0, max: 63 }))
  .map(([hex, bad, idx]) => ({
    label: "64-char hex containing one non-hex character",
    value: hex.slice(0, idx) + bad + hex.slice(idx),
    expectedDelegate: false,
    expectedAccount: false,
  }));

/**
 * `0x` + 64-character string with exactly one non-hex character inserted at
 * a random position after the prefix. Length matches the account-id
 * requirement but the post-prefix contents are not pure hex, so both
 * predicates must reject.
 */
const nonHexWithPrefix: fc.Arbitrary<CredentialCase> = fc
  .tuple(hexStringOfLength(63), nonHexChar, fc.integer({ min: 0, max: 63 }))
  .map(([hex, bad, idx]) => ({
    label: "0x-prefixed 64-char containing one non-hex character",
    value: "0x" + hex.slice(0, idx) + bad + hex.slice(idx),
    expectedDelegate: false,
    expectedAccount: false,
  }));

/**
 * Uppercase `0X` prefix + 64 hex chars. The account-id validator's prefix is
 * case-sensitive, so this must be rejected by both predicates (and the
 * delegate-key validator additionally rejects it on length).
 */
const accountWithUpperPrefix: fc.Arbitrary<CredentialCase> = hexStringOfLength(
  64,
).map((s) => ({
  label: "0X-prefixed 64-hex (uppercase prefix)",
  value: "0X" + s,
  expectedDelegate: false,
  expectedAccount: false,
}));

/**
 * Combined variant generator. Each variant carries its own oracle so the
 * property is a precise biconditional check rather than a one-way assertion.
 */
const credentialCase: fc.Arbitrary<CredentialCase> = fc.oneof(
  correctLengthMixedCase,
  correctLengthAllLower,
  correctLengthAllUpper,
  accountWithLowerPrefix,
  offByOneNoPrefix,
  offByOneWithPrefix,
  nonHexNoPrefix,
  nonHexWithPrefix,
  accountWithUpperPrefix,
);

describe("Property 4: Credential format validation accepts exactly well-formed hex", () => {
  it("isValidDelegateKey and isValidAccountId match the well-formed-hex expectation", () => {
    fc.assert(
      fc.property(credentialCase, (c) => {
        expect(isValidDelegateKey(c.value)).toBe(c.expectedDelegate);
        expect(isValidAccountId(c.value)).toBe(c.expectedAccount);
      }),
      { numRuns: 200 },
    );
  });

  it("accepts canonical positive cases for both predicates", () => {
    // Anchor cases: the simplest possible well-formed values for each
    // predicate. Without these the property could silently degrade if
    // the generator weights ever drifted away from a valid case.
    const lowerHex64 = "a".repeat(64);
    const upperHex64 = "F".repeat(64);
    const mixedHex64 = "0123456789abcdefABCDEF".padEnd(64, "0");

    expect(isValidDelegateKey(lowerHex64)).toBe(true);
    expect(isValidDelegateKey(upperHex64)).toBe(true);
    expect(isValidDelegateKey(mixedHex64)).toBe(true);

    expect(isValidAccountId("0x" + lowerHex64)).toBe(true);
    expect(isValidAccountId("0x" + upperHex64)).toBe(true);
    expect(isValidAccountId("0x" + mixedHex64)).toBe(true);
  });
});
