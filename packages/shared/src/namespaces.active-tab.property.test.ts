// Feature: uberwal, Property 12: Active-tab resolution after role change stays visible
//
// Validates: Requirements 13.5
//
// `resolveActiveTab(role, activeTab)` is the function that the dashboard uses
// when the viewer changes role: if the previously active tab is still visible
// under the new role, the active tab is preserved; otherwise the dashboard
// redirects to the first visible tab for the new role. This property captures
// three invariants of that resolution:
//
//   (a) The resolved tab is always a member of `tabsForRole(role)` — the
//       viewer can never end up on a tab that is hidden by their role.
//   (b) When the previously active tab is still visible under `role`, the
//       resolution is the identity (no surprise navigation).
//   (c) When the previously active tab is not visible under `role`, the
//       resolution equals `defaultTabForRole(role)` (the documented redirect
//       target).
//
// We sample over the full input space — every role × every tab — biased to
// cover both the "still-visible" and "redirect" branches in every run.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import {
  defaultTabForRole,
  resolveActiveTab,
  tabsForRole,
  type Role,
  type Tab,
} from "./namespaces.js";

const NUM_RUNS = 200;

const ROLES: readonly Role[] = ["developer", "team-lead", "recruiter"];
const TABS: readonly Tab[] = ["skills", "productivity", "sessions", "reports"];

const roleArb = fc.constantFrom<Role>(...ROLES);
const tabArb = fc.constantFrom<Tab>(...TABS);

describe("Property 12: Active-tab resolution after role change stays visible", () => {
  test("the resolved tab is always visible under the selected role", () => {
    // (a) Closure under role visibility: regardless of the input pair, the
    //     resolved tab must lie in `tabsForRole(role)`. This is the most
    //     important guarantee — viewers never land on a hidden tab.
    fc.assert(
      fc.property(roleArb, tabArb, (role, activeTab) => {
        const resolved = resolveActiveTab(role, activeTab);
        const visible = tabsForRole(role);
        expect(visible).toContain(resolved);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("if the active tab is still visible under the role, it is returned unchanged", () => {
    // (b) Identity branch. We constrain the generator to (role, activeTab)
    //     pairs where `activeTab` is visible under `role` so the
    //     "still-visible" branch is exercised on every iteration. `fc.pre`
    //     filters non-matching pairs without failing the run.
    fc.assert(
      fc.property(roleArb, tabArb, (role, activeTab) => {
        fc.pre(tabsForRole(role).includes(activeTab));
        expect(resolveActiveTab(role, activeTab)).toBe(activeTab);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("if the active tab is not visible under the role, it falls back to the default tab", () => {
    // (c) Redirect branch. Symmetrically, constrain to pairs where
    //     `activeTab` is hidden under `role` so the redirect is exercised
    //     each iteration. The redirect target is fixed by spec to
    //     `defaultTabForRole(role)`.
    fc.assert(
      fc.property(roleArb, tabArb, (role, activeTab) => {
        fc.pre(!tabsForRole(role).includes(activeTab));
        expect(resolveActiveTab(role, activeTab)).toBe(defaultTabForRole(role));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("resolution agrees with the visibility-driven oracle on every (role, tab) pair", () => {
    // Conjunction of (a), (b), (c) expressed as a single oracle. This is the
    // primary property: for every role × tab pair sampled from the full
    // unconstrained space, the result equals what the spec-derived oracle
    // says it must equal.
    fc.assert(
      fc.property(roleArb, tabArb, (role, activeTab) => {
        const visible = tabsForRole(role);
        const expected: Tab = visible.includes(activeTab)
          ? activeTab
          : defaultTabForRole(role);
        expect(resolveActiveTab(role, activeTab)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
