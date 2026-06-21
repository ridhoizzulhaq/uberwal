/**
 * Client-safe re-exports of the shared role/tab helpers.
 *
 * The role-to-tabs mapping in `@uberwal/shared/namespaces` is a set of
 * pure functions with no server-only imports, so the dashboard's client
 * components (TabBar, layout, login) can import them through this barrel
 * without pulling in any server modules.
 *
 * Validates: Requirements 13.2, 13.3, 13.4, 13.5
 */

export {
  tabsForRole,
  defaultTabForRole,
  resolveActiveTab,
} from "@uberwal/shared";
export type { Role, Tab } from "@uberwal/shared";
