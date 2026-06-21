// Feature: uberwal, Property 3: Namespace validity is exactly the known namespaces
// Validates: Requirements 2.6
//
// `isValidNamespace(value)` must return `true` if and only if `value` is one of
// the Uberwal namespaces (`sessions`, `skills`, `productivity`, `reports`,
// `transcripts`) and `false` for every other string. This property test
// exercises that biconditional across arbitrary strings, the valid namespaces
// themselves, and a handcrafted set of near-misses (different casing,
// surrounding whitespace, singularized forms, etc.) so both branches of the
// iff are sampled in every run.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { NAMESPACES, isValidNamespace } from "./validation";

describe("isValidNamespace — Property 3 (namespace validity)", () => {
  it("returns true iff value is exactly one of the known namespaces", () => {
    // Materialize the canonical set once so the oracle on the right-hand side
    // of the biconditional is a constant-time membership check.
    const validNamespaces = new Set<string>(NAMESPACES);

    // Near-misses: strings that share characters with the valid namespaces but
    // are not equal to any of them. They must all be rejected.
    const nearMisses: readonly string[] = [
      "",
      " ",
      "Sessions",
      "SESSIONS",
      "sessions ",
      " sessions",
      "session",
      "Skills",
      "SKILL",
      "skill",
      "Productivity",
      "productivity\n",
      "Reports",
      "report",
      "sessions/skills",
      "sessions,skills",
      "all",
      "default",
    ];

    fc.assert(
      fc.property(
        fc.oneof(
          // Arbitrary strings: dominate the input space and exercise the
          // false-branch of the iff (almost no random string equals a
          // namespace, but the property still holds when it accidentally
          // does).
          { weight: 6, arbitrary: fc.string() },
          // Bias the input toward the four valid namespaces so the
          // true-branch is sampled on every run.
          {
            weight: 3,
            arbitrary: fc.constantFrom<string>(...NAMESPACES),
          },
          // Handcrafted near-misses to exercise tricky rejection cases.
          { weight: 1, arbitrary: fc.constantFrom<string>(...nearMisses) },
        ),
        (value) => {
          expect(isValidNamespace(value)).toBe(validNamespaces.has(value));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("accepts each of the known namespaces deterministically", () => {
    // Anchor test: the set definition itself must be exactly the documented
    // namespaces. Without this, the property above would silently pass even
    // if `NAMESPACES` were ever broadened.
    expect([...NAMESPACES].sort()).toEqual(
      ["sessions", "skills", "productivity", "reports", "transcripts"].sort(),
    );

    for (const ns of NAMESPACES) {
      expect(isValidNamespace(ns)).toBe(true);
    }
  });
});
