/**
 * Share manifest model — the "what is allowed" half of a server-mediated share.
 *
 * In the token model, a share link carries only a random opaque token. The
 * server stores, alongside the minted delegate key, a *manifest* describing
 * exactly what the recipient may see. When a recipient opens a token, the
 * server consults this manifest to decide which namespaces (and optionally
 * which specific entries) to expose — the recipient never receives the key,
 * so access is enforced server-side.
 *
 * This module is pure and dependency-free (no `server-only`, no I/O) so it can
 * be unit-tested directly and reused by both the owner-side actions and the
 * recipient-side access actions.
 */

import type { Namespace } from "@uberwal/shared";

/**
 * Share modes.
 *
 * - `summary` shares the four dashboard-surfaced namespaces.
 * - `full` shares those plus `transcripts` (the raw chunked transcript), i.e.
 *   everything Uberwal stores.
 */
export type ShareMode = "full" | "summary";

/**
 * The manifest persisted per share.
 *
 * - `mode` records which preset the owner chose (for display + auditing).
 * - `namespaces` is the resolved allow-list the server enforces on every
 *   recipient recall. It is derived from `mode` at creation time and stored
 *   explicitly so the enforced set is stable even if `namespacesForMode`
 *   changes later.
 * - `blobIds` is an OPTIONAL whitelist of specific entries to share. When
 *   present and non-empty, recall results are filtered down to these blob
 *   ids; when absent or empty, the whole of each allowed namespace is shared.
 * - `sessionIds` is an OPTIONAL whitelist of specific sessions to share. When
 *   present and non-empty, recall results are filtered down to entries whose
 *   `sessionId` is in this set (in addition to any `blobIds` filter); when
 *   absent or empty, sessions are not used to narrow the share.
 * - `repo` is an OPTIONAL project/repository tag. When present, recall results
 *   are additionally filtered to entries whose `repo` matches, so a share can
 *   be scoped to one project even if its individual sessions aren't enumerated.
 */
export interface ShareManifest {
  mode: ShareMode;
  namespaces: Namespace[];
  blobIds?: string[];
  sessionIds?: string[];
  repo?: string;
}

/** Namespaces shared in `summary` mode (the four dashboard tabs). */
const SUMMARY_NAMESPACES: readonly Namespace[] = [
  "sessions",
  "skills",
  "productivity",
  "reports",
];

/**
 * Resolve the namespace allow-list for a share mode.
 *
 * `summary` → `["sessions", "skills", "productivity", "reports"]`.
 * `full` → those four PLUS `"transcripts"`.
 *
 * Returns a fresh array each call so callers can store or mutate the result
 * without aliasing a shared constant.
 */
export function namespacesForMode(mode: ShareMode): Namespace[] {
  if (mode === "full") {
    return [...SUMMARY_NAMESPACES, "transcripts"];
  }
  return [...SUMMARY_NAMESPACES];
}
