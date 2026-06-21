/**
 * Pure validation and clamping helpers shared by the MCP server and dashboard.
 *
 * Every function in this module is total, side-effect free, and deterministic —
 * which makes them the primary target for property-based testing in tasks 2.2
 * through 2.5. They never throw on bad input; they return a boolean, a clamped
 * number, or a type predicate so that callers can shape their own errors.
 *
 * Validates: Requirements 1.4, 2.2, 2.3, 2.6, 2.7, 7.4
 */

/**
 * The MemWal namespaces Uberwal uses, in display order.
 *
 * The first four (`sessions`, `skills`, `productivity`, `reports`) back the
 * dashboard tabs and the two-phase capture flow. `transcripts` holds the
 * chunked raw session transcript (auto-committed, no per-chunk review) so a
 * developer's memory retains full context that can be recalled later from any
 * agent; it is not surfaced as a dashboard tab.
 *
 * Declared as a readonly const tuple so the `Namespace` type is the union of
 * its literal members and so callers can iterate exhaustively.
 */
export const NAMESPACES = [
  "sessions",
  "skills",
  "productivity",
  "reports",
  "transcripts",
] as const;

/** Union of the MemWal namespaces Uberwal writes to and recalls from. */
export type Namespace = (typeof NAMESPACES)[number];

/**
 * Returns `true` iff `value` is exactly one of the Uberwal namespaces.
 *
 * Acts as a type predicate so callers can narrow `string` to `Namespace`
 * after a successful check.
 *
 * Validates: Requirement 2.6
 */
export function isValidNamespace(value: string): value is Namespace {
  // Cast to `readonly string[]` so `.includes(value)` accepts an arbitrary
  // string while still preserving the `Namespace` narrowing on the return.
  return (NAMESPACES as readonly string[]).includes(value);
}

/**
 * Returns `true` iff `value` contains at least one non-whitespace character.
 *
 * `undefined` and `null` are treated as missing input and rejected. Strings
 * that are empty or composed entirely of whitespace (spaces, tabs, newlines,
 * and any other code point treated as whitespace by `String.prototype.trim`)
 * are rejected so the recall tools can return a "query is required" error.
 *
 * Validates: Requirement 2.7
 */
export function isValidQuery(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

/**
 * Returns `true` iff `value` contains at least one non-whitespace character.
 *
 * Identical contract to `isValidQuery` — defined as a separate symbol so the
 * `extract_session` tool can reject empty/whitespace-only transcripts with a
 * transcript-specific error message without coupling to query validation.
 *
 * Validates: Requirement 1.4
 */
export function isValidTranscript(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

/** Matches exactly 64 hexadecimal characters (case-insensitive), no prefix. */
const DELEGATE_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Returns `true` iff `value` is exactly 64 hexadecimal characters with no prefix.
 *
 * Matches the Ed25519 private-key encoding used by MemWal's delegate key. Any
 * wrong length, surrounding whitespace, embedded `0x` prefix, or non-hex
 * character causes rejection.
 *
 * Validates: Requirement 7.4
 */
export function isValidDelegateKey(value: string): boolean {
  if (typeof value !== "string") return false;
  return DELEGATE_KEY_PATTERN.test(value);
}

/** Matches `0x` followed by exactly 64 hexadecimal characters. */
const ACCOUNT_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Returns `true` iff `value` is `0x` followed by exactly 64 hexadecimal characters.
 *
 * Matches the Sui account object id encoding used by MemWal. The `0x` prefix
 * is mandatory; any wrong length or non-hex character after the prefix causes
 * rejection.
 *
 * Validates: Requirement 7.4
 */
export function isValidAccountId(value: string): boolean {
  if (typeof value !== "string") return false;
  return ACCOUNT_ID_PATTERN.test(value);
}

/** Default `limit` when callers omit it. */
const DEFAULT_LIMIT = 10;
/** Inclusive lower bound for `limit`. */
const MIN_LIMIT = 1;
/** Inclusive upper bound for `limit`. */
const MAX_LIMIT = 100;

/**
 * Clamps a recall `limit` into `[1, 100]`, defaulting to `10`.
 *
 * - `undefined` → `10`
 * - `NaN` or any non-finite value → `10` (treated as missing)
 * - in-range values are returned unchanged
 * - values below the range are raised to `1`; values above are lowered to `100`
 *
 * Validates: Requirement 2.2
 */
export function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  if (limit < MIN_LIMIT) return MIN_LIMIT;
  if (limit > MAX_LIMIT) return MAX_LIMIT;
  return limit;
}

/** Default `maxDistance` when callers omit it. */
const DEFAULT_MAX_DISTANCE = 1;
/** Inclusive lower bound for `maxDistance`. */
const MIN_MAX_DISTANCE = 0;
/** Inclusive upper bound for `maxDistance`. */
const MAX_MAX_DISTANCE = 1;

/**
 * Clamps a recall `maxDistance` into `[0, 1]`, defaulting to `1`.
 *
 * - `undefined` → `1`
 * - `NaN` or any non-finite value → `1` (treated as missing)
 * - in-range values are returned unchanged
 * - values below the range are raised to `0`; values above are lowered to `1`
 *
 * Defaulting to `1` means "no upper-distance filtering": when a caller omits
 * `maxDistance`, recall returns every match the SDK ranks rather than dropping
 * rows past a relevance threshold. Callers that want a stricter cut pass an
 * explicit value.
 *
 * Validates: Requirement 2.3
 */
export function clampMaxDistance(maxDistance?: number): number {
  if (maxDistance === undefined || !Number.isFinite(maxDistance)) {
    return DEFAULT_MAX_DISTANCE;
  }
  if (maxDistance < MIN_MAX_DISTANCE) return MIN_MAX_DISTANCE;
  if (maxDistance > MAX_MAX_DISTANCE) return MAX_MAX_DISTANCE;
  return maxDistance;
}
