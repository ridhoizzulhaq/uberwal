/**
 * Role-based tab visibility helpers.
 *
 * These pure functions back the dashboard's role selector. They decide which
 * tabs a viewer can see based on their role and which tab should become active
 * when the previously active tab is no longer visible under the selected role.
 *
 * Validates: Requirements 13.2, 13.3, 13.4, 13.5
 */

/** A non-empty readonly tuple of `T`. Used so index `[0]` is always defined. */
type NonEmpty<T> = readonly [T, ...T[]];

/** Viewer roles supported by the dashboard. */
export type Role = "developer" | "team-lead" | "recruiter";

/** Dashboard tabs corresponding to the four MemWal namespaces. */
export type Tab = "skills" | "productivity" | "sessions" | "reports";

/**
 * Tabs visible to each role, in display order.
 *
 * - `developer`  → all four tabs (Req 13.2)
 * - `team-lead`  → productivity and reports (Req 13.3)
 * - `recruiter`  → skills only (Req 13.4)
 */
const TABS_BY_ROLE: Record<Role, NonEmpty<Tab>> = {
  developer: ["skills", "productivity", "sessions", "reports"],
  "team-lead": ["productivity", "reports"],
  recruiter: ["skills"],
};

/**
 * Returns the tabs visible for the given role, in display order.
 *
 * The returned array is a fresh copy, so callers may mutate it without
 * affecting the canonical mapping.
 */
export function tabsForRole(role: Role): Tab[] {
  return [...TABS_BY_ROLE[role]];
}

/**
 * Returns the first visible tab for the given role.
 *
 * This is the tab the dashboard navigates to when the previously active tab
 * is no longer visible under the selected role (Req 13.5).
 */
export function defaultTabForRole(role: Role): Tab {
  return TABS_BY_ROLE[role][0];
}

/**
 * Resolves which tab should be active for the given role.
 *
 * If `activeTab` is still visible under `role`, it is returned unchanged.
 * Otherwise, the default tab for `role` is returned. This implements the
 * redirect-on-role-change behavior described in Req 13.5.
 */
export function resolveActiveTab(role: Role, activeTab: Tab): Tab {
  const visible: readonly Tab[] = TABS_BY_ROLE[role];
  return visible.includes(activeTab) ? activeTab : defaultTabForRole(role);
}
