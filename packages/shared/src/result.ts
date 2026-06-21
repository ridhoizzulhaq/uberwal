/**
 * Recall result types and defensive normalization for the MemWal SDK.
 *
 * The MemWal SDK's `recall(...)` returns `{ results: [{ blob_id, text, distance }], total }`,
 * but Uberwal normalizes whatever the SDK gives us into that shape so the
 * MCP server tools and dashboard server actions can rely on a single,
 * predictable contract regardless of upstream changes or partial responses.
 *
 * This module is intentionally pure (no I/O) so it can be exercised by
 * property-based tests with arbitrary raw inputs.
 *
 * Validates: Requirements 2.4
 */

import { parseMemory } from "./memory-meta.js";

/**
 * A single recalled entry, normalized to the shape Uberwal consumers depend on.
 *
 * When the stored text carries a per-session metadata header (see
 * `memory-meta.ts`), normalization strips the header from `text` and surfaces
 * the parsed metadata via the optional `sessionId`, `index`, `factType`, and
 * `repo` fields. Entries stored without a header leave these fields absent and
 * `text` unchanged, preserving full backward compatibility.
 */
export interface RecallEntry {
  /** Walrus blob id of the stored memory. */
  blob_id: string;
  /** Decrypted memory text, with any metadata header stripped. */
  text: string;
  /** Semantic distance score (lower = more relevant). Always finite. */
  distance: number;
  /** Session this memory was captured from, when a metadata header was present. */
  sessionId?: string;
  /** Sequential index within the session (e.g. transcript chunk), when present. */
  index?: number;
  /** Stored type from the metadata header (e.g. "skill", "transcript"), when present. */
  factType?: string;
  /** Project/repository grouping label from the metadata header, when present. */
  repo?: string;
  /** Capture time (epoch ms) from the metadata header, when present. */
  capturedAt?: number;
}

/** Normalized recall result returned by `MemWalClient.recall(...)`. */
export interface RecallResult {
  /** Recalled entries, each with `blob_id`, `text`, and a finite numeric `distance`. */
  results: RecallEntry[];
  /** Non-negative total count of recalled entries. */
  total: number;
}

/**
 * Reference to a stored memory returned by `MemWalClient.remember(...)`.
 *
 * Mirrors the subset of MemWal's `RememberResult` we surface to callers —
 * enough to identify the entry on the relayer (`id`) and on Walrus
 * (`blob_id`) and to know which namespace it landed in.
 */
export interface StoredRef {
  /** Stable server job/vector row id for the stored memory. */
  id: string;
  /** Walrus blob id assigned once the remember job completes. */
  blob_id: string;
  /** Namespace the memory was stored under. */
  namespace: string;
}

// ---------------------------------------------------------------------------
// Internal coercion helpers — kept private so the public surface stays small.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Coerce an arbitrary value into a string field.
 * `undefined`/`null` become `""`; everything else passes through `String(...)`.
 */
function toStringField(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  // Avoid stringifying objects/arrays/symbols/functions into noise like "[object Object]".
  return "";
}

/**
 * Coerce an arbitrary value into a finite number, falling back to `fallback`
 * when the value is missing, non-numeric, NaN, or non-finite.
 */
function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeEntry(raw: unknown): RecallEntry | null {
  if (!isRecord(raw)) return null;

  const rawText = toStringField(raw["text"]);
  // Strip and parse any per-session metadata header embedded at commit time.
  // `parseMemory` is a no-op for text without the header, so entries stored
  // before this feature (or arbitrary transcripts) pass through unchanged.
  const { meta, body } = parseMemory(rawText);

  const entry: RecallEntry = {
    blob_id: toStringField(raw["blob_id"]),
    text: body,
    // 1.0 corresponds to the "unrelated" band in MemWal's distance taxonomy,
    // which is the safest fallback for a missing/non-numeric distance.
    distance: toFiniteNumber(raw["distance"], 1),
  };

  // Attach metadata only when present, so `exactOptionalPropertyTypes` stays
  // happy and header-free entries behave exactly as before.
  if (meta !== null) {
    entry.sessionId = meta.sessionId;
    if (meta.index !== undefined) {
      entry.index = meta.index;
    }
    if (meta.type !== undefined) {
      entry.factType = meta.type;
    }
    if (meta.repo !== undefined) {
      entry.repo = meta.repo;
    }
    if (meta.capturedAt !== undefined) {
      entry.capturedAt = meta.capturedAt;
    }
  }

  return entry;
}

/**
 * Map an arbitrary SDK response to a `RecallResult` with the guaranteed shape:
 *
 *   - `results` is an array where every entry has `blob_id` (string),
 *     `text` (string), and `distance` (finite number).
 *   - `total` is a non-negative integer; when the raw payload's `total` is
 *     missing or invalid, it defaults to `results.length`.
 *
 * The function never throws; any malformed input collapses to `{ results: [], total: 0 }`.
 *
 * Validates: Requirements 2.4
 */
export function normalizeRecall(raw: unknown): RecallResult {
  if (!isRecord(raw)) {
    return { results: [], total: 0 };
  }

  const rawResults = raw["results"];
  const results: RecallEntry[] = [];
  if (Array.isArray(rawResults)) {
    for (const item of rawResults) {
      const normalized = normalizeEntry(item);
      if (normalized !== null) {
        results.push(normalized);
      }
    }
  }

  const rawTotal = raw["total"];
  let total: number;
  if (typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0) {
    total = Math.floor(rawTotal);
  } else {
    // Fall back to the length of the normalized results so `total` remains
    // a meaningful non-negative count even when the SDK omits it.
    total = results.length;
  }

  return { results, total };
}
