/**
 * Multi-pass session gathering — the shared core behind both the owner's
 * `getSessionDetail` and the recipient's `getSessionDetailByToken`.
 *
 * Kept out of the `"use server"` action modules because a Server Actions file
 * may only export async functions; this helper is plain (dependency-light) so
 * it can be imported by both actions and unit-tested directly.
 *
 * Coverage note: a single semantic recall with a generic query + the 100/pass
 * cap (`clampLimit` in `@uberwal/shared` caps `limit` at 100) can miss a
 * session's entries when a namespace holds many entries. To widen coverage we
 * run MULTIPLE recall passes per namespace — typically a generic broad query
 * plus the session's own summary text (its items are most semantically similar
 * to it) — then merge + dedupe by `blob_id` before filtering to the session.
 *
 * This is BEST-EFFORT coverage (semantic recall + 100/pass cap), NOT a
 * guaranteed-exhaustive listing of every entry in a session.
 */

import type { Namespace, RecallEntry } from "@uberwal/shared";

/** Per-pass result cap. `clampLimit` caps `limit` at 100, so we can't exceed it. */
export const SESSION_PASS_LIMIT = 100;
/** Per-pass distance threshold — 1.0 means no upper-distance filtering. */
export const SESSION_PASS_MAX_DISTANCE = 1.0;

/**
 * Generic broad query per per-session namespace, used as the first recall pass.
 * The session summary text (when present) is added as a second pass by callers.
 */
export const NAMESPACE_BROAD_QUERY: Record<Namespace, string> = {
  sessions: "session summary",
  skills: "skill",
  productivity: "productivity",
  reports: "report",
  transcripts: "transcript",
};

/**
 * Injected recall function. The helper supplies the namespace, query, and the
 * fixed `limit` / `maxDistance` per pass; the caller decides HOW to recall
 * (session client vs. token client) and returns the normalized entries.
 */
export type SessionRecallFn = (params: {
  namespace: Namespace;
  query: string;
  limit: number;
  maxDistance: number;
}) => Promise<RecallEntry[]>;

/** Input to {@link gatherSessionNamespace}. */
export interface GatherSessionNamespaceInput {
  /** How to recall — wraps the session or token `MemWalClient`. */
  recall: SessionRecallFn;
  /** Namespace to gather. */
  namespace: Namespace;
  /** The session id every returned entry must match. */
  sessionId: string;
  /**
   * One or more queries to run as separate recall passes. Empty/whitespace
   * queries are skipped. Results are merged and deduped by `blob_id` (keeping
   * the smallest-distance occurrence) before filtering by `sessionId`.
   */
  queries: string[];
}

/**
 * Gather one session's entries from one namespace via multiple recall passes.
 *
 * Runs each non-empty query as its own recall pass (limit 100, maxDistance 1),
 * merges the results, dedupes by `blob_id` keeping the occurrence with the
 * smallest `distance`, then filters to entries whose `sessionId` matches.
 *
 * Best-effort coverage only (semantic recall + 100/pass cap) — not guaranteed
 * to be exhaustive.
 */
export async function gatherSessionNamespace({
  recall,
  namespace,
  sessionId,
  queries,
}: GatherSessionNamespaceInput): Promise<RecallEntry[]> {
  const byBlob = new Map<string, RecallEntry>();
  for (const query of queries) {
    if (query.trim().length === 0) continue;
    const results = await recall({
      namespace,
      query,
      limit: SESSION_PASS_LIMIT,
      maxDistance: SESSION_PASS_MAX_DISTANCE,
    });
    for (const entry of results) {
      const existing = byBlob.get(entry.blob_id);
      // Keep the first occurrence, but prefer a strictly smaller distance if a
      // later pass surfaces the same blob nearer the top.
      if (existing === undefined || entry.distance < existing.distance) {
        byBlob.set(entry.blob_id, entry);
      }
    }
  }
  return Array.from(byBlob.values()).filter(
    (entry) => entry.sessionId === sessionId,
  );
}

/**
 * Build the per-namespace query list for a session gather: the namespace's
 * generic broad query, plus the session summary text as a second pass when it
 * is present and non-empty (the session's items are most semantically similar
 * to its own summary, surfacing them near the top of that pass).
 */
export function queriesForNamespace(
  namespace: Namespace,
  summaryText: string,
): string[] {
  const broad = NAMESPACE_BROAD_QUERY[namespace];
  const trimmed = summaryText.trim();
  return trimmed.length > 0 ? [broad, trimmed] : [broad];
}

/**
 * Sort transcript chunks by their per-session `index` ascending. Entries
 * without an `index` sort last while preserving their relative order (stable).
 */
export function sortTranscriptsByIndex(transcripts: RecallEntry[]): RecallEntry[] {
  return transcripts
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => {
      const ai = a.entry.index;
      const bi = b.entry.index;
      if (ai === undefined && bi === undefined) return a.position - b.position;
      if (ai === undefined) return 1;
      if (bi === undefined) return -1;
      if (ai !== bi) return ai - bi;
      return a.position - b.position;
    })
    .map(({ entry }) => entry);
}
