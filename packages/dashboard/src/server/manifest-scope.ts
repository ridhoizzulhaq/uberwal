/**
 * Pure manifest-scoping helper shared by the recipient-side access actions.
 *
 * Kept out of the `"use server"` action module because a Server Actions file
 * may only export async functions — this synchronous, dependency-free helper
 * lives here so it can be imported by the action and unit-tested directly.
 */

/**
 * Apply a manifest's optional `blobIds` / `sessionIds` / `repo` whitelists to a
 * recall result set.
 *
 * Semantics:
 *   - no whitelist present/non-empty → returns the input array unchanged
 *     (referential identity preserved, so callers can keep the recall `total`);
 *   - `blobIds` → keep entries whose `blob_id` is whitelisted;
 *   - `sessionIds` → keep entries whose `sessionId` is whitelisted
 *     (entries without a `sessionId` are dropped);
 *   - `repo` → keep entries whose `repo` matches (entries without a `repo` are
 *     dropped);
 *   - when several are present an entry must pass ALL of them.
 */
export function filterByManifestScope<
  T extends { blob_id: string; sessionId?: string; repo?: string },
>(
  entries: T[],
  manifest: { blobIds?: string[]; sessionIds?: string[]; repo?: string },
): T[] {
  const blobIds = manifest.blobIds;
  const sessionIds = manifest.sessionIds;
  const repo = manifest.repo;
  const hasBlob = blobIds !== undefined && blobIds.length > 0;
  const hasSession = sessionIds !== undefined && sessionIds.length > 0;
  const hasRepo = typeof repo === "string" && repo.length > 0;
  if (!hasBlob && !hasSession && !hasRepo) return entries;

  const allowedBlobs = hasBlob ? new Set(blobIds) : null;
  const allowedSessions = hasSession ? new Set(sessionIds) : null;

  return entries.filter((entry) => {
    if (allowedBlobs !== null && !allowedBlobs.has(entry.blob_id)) return false;
    if (
      allowedSessions !== null &&
      (entry.sessionId === undefined || !allowedSessions.has(entry.sessionId))
    ) {
      return false;
    }
    if (hasRepo && entry.repo !== repo) return false;
    return true;
  });
}
