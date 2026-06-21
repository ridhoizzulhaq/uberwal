/**
 * Public entry point for `@uberwal/shared`.
 *
 * The MCP server and the dashboard depend only on this barrel file, so
 * everything they need — namespaces, validation helpers, role-to-tab logic,
 * recall result types, and the `MemWalClient` wrapper — is re-exported here.
 *
 * Internal modules import each other directly (e.g. `./validation.js`) so the
 * barrel can stay a flat list of public re-exports.
 */

export {
  NAMESPACES,
  isValidNamespace,
  isValidQuery,
  isValidTranscript,
  isValidDelegateKey,
  isValidAccountId,
  clampLimit,
  clampMaxDistance,
} from "./validation.js";
export type { Namespace } from "./validation.js";

export {
  tabsForRole,
  defaultTabForRole,
  resolveActiveTab,
} from "./namespaces.js";
export type { Role, Tab } from "./namespaces.js";

export { normalizeRecall } from "./result.js";
export type { RecallEntry, RecallResult, StoredRef } from "./result.js";

export { encodeMemory, parseMemory, MEMORY_META_PREFIX } from "./memory-meta.js";
export type { MemoryMeta } from "./memory-meta.js";

export { MemWalClient } from "./memwal-client.js";
export type { MemWalCredentials, RecallParams } from "./memwal-client.js";
