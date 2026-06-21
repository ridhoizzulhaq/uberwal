// Feature: uberwal, Property 11: Role-to-tabs mapping is exact
// Validates: Requirements 13.2, 13.3, 13.4
//
// `tabsForRole(role)` must return exactly the documented set of tabs for each
// role, in display order:
//
//   - `developer`  → [skills, productivity, sessions, reports]   (Req 13.2)
//   - `team-lead`  → [productivity, reports]                     (Req 13.3)
//   - `recruiter`  → [skills]                                    (Req 13.4)
//
// This property test samples roles uniformly and asserts deep equality with
// the canonical expected mapping on every run, so any drift in either the
// membership of a role's tab set or the display order is caught immediately.
// Mutation-resistance is also checked: callers must not be able to mutate the
// returned array and corrupt subsequent calls.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { type Role, type Tab, tabsForRole } from "./namespaces";

/**
 * Canonical expected mapping copied verbatim from the requirements. Defined
 * here (not imported from the module under test) so the property has an
 * independent oracle.
 */
const EXPECTED_TABS_BY_ROLE: Record<Role, readonly Tab[]> = {
  developer: ["skills", "productivity", "sessions", "reports"],
  "team-lead": ["productivity", "reports"],
  recruiter: ["skills"],
};

describe("tabsForRole — Property 11 (role-to-tabs mapping is exact)", () => {
  it("returns exactly the canonical tab list for every role, in display order", () => {
    fc.assert(
      fc.property(
        // Sample uniformly across all three roles so each branch of the
        // mapping is exercised on every run.
        fc.constantFrom<Role>("developer", "team-lead", "recruiter"),
        (role) => {
          const expected = EXPECTED_TABS_BY_ROLE[role];
          // Deep equality enforces both membership and display order, so any
          // reordering, addition, or omission of a tab fails the property.
          expect(tabsForRole(role)).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns a fresh array so callers cannot corrupt the canonical mapping", () => {
    // Mutating the result of one call must not affect a subsequent call for
    // the same role. Without this, the "exact" mapping would be exact only on
    // the first call.
    fc.assert(
      fc.property(
        fc.constantFrom<Role>("developer", "team-lead", "recruiter"),
        (role) => {
          const first = tabsForRole(role);
          first.length = 0;
          expect(tabsForRole(role)).toEqual(EXPECTED_TABS_BY_ROLE[role]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("anchors the canonical expected mapping itself", () => {
    // Without this anchor, the property above would silently pass if the
    // expected mapping in this test file were ever changed in lockstep with
    // a regression in the implementation. Pin the requirements verbatim.
    expect(EXPECTED_TABS_BY_ROLE.developer).toEqual([
      "skills",
      "productivity",
      "sessions",
      "reports",
    ]);
    expect(EXPECTED_TABS_BY_ROLE["team-lead"]).toEqual([
      "productivity",
      "reports",
    ]);
    expect(EXPECTED_TABS_BY_ROLE.recruiter).toEqual(["skills"]);
  });
});
