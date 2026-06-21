"use server";

/**
 * Server action proxying namespace recalls from dashboard client components
 * to the shared `MemWalClient`.
 *
 * The dashboard never recalls directly from the browser — every tab page and
 * search box submits through this action so the delegate key stays on the
 * server boundary. The action:
 *
 *   1. Reads and decrypts the session cookie via the per-request
 *      `MemWalClient` factory (`getMemWalClientFromSession`). When there is
 *      no session, returns `{ ok: false, message: "Not authenticated" }` so
 *      the calling tab can route the user back to login without leaking
 *      whether the cookie was missing, malformed, or expired.
 *   2. Delegates namespace + query validation and `limit` / `maxDistance`
 *      clamping to `MemWalClient.recall`, which is the single source of
 *      truth for those rules across the MCP server and the dashboard.
 *   3. Surfaces validation, network, and SDK errors as
 *      `{ ok: false, message }` rather than throwing, so the React tab can
 *      keep the previous results displayed (Requirements 8.4, 9.3, 12.4).
 *
 * Validates: Requirements 8.1, 9.1, 10.1, 11.1, 12.2
 */

import type { Namespace, RecallEntry } from "@uberwal/shared";

import { getMemWalClientFromSession } from "../../server/memwal-factory.js";
import {
  gatherSessionNamespace,
  queriesForNamespace,
  sortTranscriptsByIndex,
  type SessionRecallFn,
} from "../../server/session-gather.js";

/**
 * Default recall distance threshold for the dashboard.
 *
 * The shared `MemWalClient.recall` already defaults `maxDistance` to **1.0**
 * ("no upper-distance filtering"); the dashboard passes the same value
 * explicitly so viewers (especially share-link recipients) see their data
 * immediately rather than having a relevance threshold silently filter rows
 * out. `MemWalClient.recall` clamps to [0, 1]. Always overridable via the
 * `maxDistance` input.
 */
const DEFAULT_MAX_DISTANCE = 1.0;

/**
 * Input accepted by {@link recallNamespace}.
 *
 * `limit` and `maxDistance` are optional; when omitted, the shared
 * `MemWalClient.recall` applies its documented defaults (10 and 1) and
 * clamps any out-of-range values into their valid ranges.
 */
export interface RecallNamespaceInput {
  /** One of the four Uberwal namespaces. */
  namespace: Namespace;
  /** Free-text query; rejected if empty or whitespace-only. */
  query: string;
  /** Maximum number of results, clamped to [1, 100]; defaults to 10. */
  limit?: number;
  /** Distance threshold, clamped to [0, 1]; defaults to 1.0 (no filtering). */
  maxDistance?: number;
}

/**
 * Result returned to the calling client component.
 *
 * The discriminated union lets tab pages branch with a single `result.ok`
 * check rather than threading separate error/data fields through state.
 */
export type RecallNamespaceResult =
  | { ok: true; results: RecallEntry[]; total: number }
  | { ok: false; message: string };

/**
 * Extract a human-readable message from a thrown value.
 *
 * The MemWal SDK and Node `fetch` both throw `Error` instances with useful
 * messages, so we forward `.message` whenever it is a non-empty string.
 * Anything else (string throws, plain objects) collapses to a generic
 * "Recall failed" so the dashboard never renders `[object Object]` or an
 * empty error banner.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Recall failed.";
}

/**
 * Recall memories from a Uberwal namespace on behalf of a logged-in viewer.
 *
 * Returns a discriminated union so callers branch on `result.ok`:
 *   - `{ ok: true, results, total }` — recall completed; `results` is the
 *     normalized entry list (`blob_id` / `text` / numeric `distance`) and
 *     `total` is the non-negative reported count.
 *   - `{ ok: false, message }` — either the viewer is not authenticated or
 *     the recall failed (validation, network, SDK, or configuration error).
 *
 * This function is the dashboard's read-only gateway into MemWal: it never
 * writes anything, never persists results, and never returns the underlying
 * SDK error object — only a flat string message safe for client display.
 */
export async function recallNamespace(
  input: RecallNamespaceInput,
): Promise<RecallNamespaceResult> {
  try {
    const client = await getMemWalClientFromSession();
    if (client === null) {
      return { ok: false, message: "Not authenticated" };
    }

    // Build recall params conditionally so we never pass `limit: undefined`
    // or `maxDistance: undefined`, which `exactOptionalPropertyTypes` would
    // reject against the shared `RecallParams` shape and which the shared
    // client could conceivably treat differently than "absent".
    const params: {
      namespace: Namespace;
      query: string;
      limit?: number;
      maxDistance?: number;
    } = {
      namespace: input.namespace,
      query: input.query,
    };
    if (input.limit !== undefined) params.limit = input.limit;
    params.maxDistance =
      input.maxDistance !== undefined ? input.maxDistance : DEFAULT_MAX_DISTANCE;

    const result = await client.recall(params);
    return { ok: true, results: result.results, total: result.total };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

/**
 * The five Uberwal namespaces fanned out by {@link recallWorkspace}, in the
 * stable display order the consolidated workspace renders them. Used as the
 * default when the caller does not narrow the set via a filter chip.
 */
const WORKSPACE_NAMESPACES: readonly Namespace[] = [
  "skills",
  "productivity",
  "sessions",
  "reports",
  "transcripts",
];

/** Per-namespace result cap for the workspace fan-out. */
const WORKSPACE_RECALL_LIMIT = 20;

/**
 * Input accepted by {@link recallWorkspace}.
 */
export interface RecallWorkspaceInput {
  /** Free-text query applied to every requested namespace. */
  query: string;
  /**
   * Namespaces to recall. When omitted (or empty) the action fans out across
   * all five Uberwal namespaces. Any subset is reordered into the canonical
   * display order so callers get a stable, predictable group sequence.
   */
  namespaces?: Namespace[];
}

/** One namespace's slice of a workspace recall. */
export interface RecallWorkspaceGroup {
  namespace: Namespace;
  results: RecallEntry[];
}

/**
 * Result returned to the consolidated workspace page.
 *
 * `{ ok: true, groups }` always carries one entry per requested namespace in
 * canonical order; a namespace whose individual recall failed simply comes
 * back with an empty `results` array so the rest of the workspace still
 * renders. `{ ok: false, message }` is reserved for whole-request failures —
 * most importantly "Not authenticated", which the page turns into a redirect
 * to `/login`.
 */
export type RecallWorkspaceResult =
  | { ok: true; groups: RecallWorkspaceGroup[] }
  | { ok: false; message: string };

/**
 * Recall across multiple namespaces in one round trip for the consolidated
 * owner workspace.
 *
 * The workspace replaced the old seven-tab dashboard, so instead of each tab
 * issuing its own recall this action fans out a single query across the
 * requested namespaces in parallel, applying the same `maxDistance` of 1.0
 * (no upper-distance filtering) the rest of the dashboard uses so owners see
 * their data immediately.
 *
 * Failure policy: authentication is checked once up front — no session yields
 * `{ ok: false, message: "Not authenticated" }`. After that the fan-out is
 * resilient: a single namespace's recall throwing does not fail the whole
 * request, it just returns an empty group for that namespace so the remaining
 * groups still display. Only an unexpected error around the fan-out itself
 * (e.g. missing `RELAYER_URL`) collapses to `{ ok: false, message }`.
 */
export async function recallWorkspace(
  input: RecallWorkspaceInput,
): Promise<RecallWorkspaceResult> {
  try {
    const client = await getMemWalClientFromSession();
    if (client === null) {
      return { ok: false, message: "Not authenticated" };
    }

    // Normalize the requested set into canonical order so groups are stable
    // regardless of the order the caller listed namespaces in.
    const requested =
      input.namespaces !== undefined && input.namespaces.length > 0
        ? input.namespaces
        : WORKSPACE_NAMESPACES;
    const ordered = WORKSPACE_NAMESPACES.filter((ns) => requested.includes(ns));

    const groups = await Promise.all(
      ordered.map(async (namespace): Promise<RecallWorkspaceGroup> => {
        try {
          const result = await client.recall({
            namespace,
            query: input.query,
            limit: WORKSPACE_RECALL_LIMIT,
            maxDistance: DEFAULT_MAX_DISTANCE,
          });
          return { namespace, results: result.results };
        } catch {
          // A single namespace failing must not blank the whole workspace.
          return { namespace, results: [] };
        }
      }),
    );

    return { ok: true, groups };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

/**
 * Broad recall distance used by the session-grouping actions. Mirrors the rest
 * of the dashboard's `maxDistance` of 1.0 (no upper-distance filtering) so the
 * owner sees every captured entry, with grouping/filtering done in this module
 * rather than by relevance scoring.
 */
const SESSION_MAX_DISTANCE = 1.0;

/**
 * A lightweight, list-friendly view of one captured session.
 *
 * `sessionId` is `null` for entries captured before per-session linkage (M1)
 * existed — those rows are still listed, they just cannot be grouped or shared
 * by session.
 */
export interface SessionSummary {
  sessionId: string | null;
  blob_id: string;
  text: string;
  /**
   * Project/repository this session was captured under, or `null` when the
   * session predates the repo axis (or was captured without a repo). Used by
   * the workspace to group/filter sessions by project.
   */
  repo: string | null;
}

/** Result of {@link listSessions}. */
export type ListSessionsResult =
  | { ok: true; sessions: SessionSummary[] }
  | { ok: false; message: string };

/** Result of {@link getSessionDetail}. */
export type GetSessionDetailResult =
  | {
      ok: true;
      summary: RecallEntry | null;
      skills: RecallEntry[];
      productivity: RecallEntry[];
      transcripts: RecallEntry[];
    }
  | { ok: false; message: string };

/** Broad query + high limit used to gather the `sessions` namespace summaries. */
const SESSIONS_LIST_LIMIT = 50;

/**
 * List the owner's captured sessions for session-grouped browsing.
 *
 * Recalls the `sessions` namespace with a broad query so the result is a
 * best-effort enumeration of session summaries (recall is semantic, not a
 * guaranteed-exhaustive listing), then maps each entry to a compact
 * {@link SessionSummary}. Requires an owner session.
 */
export async function listSessions(): Promise<ListSessionsResult> {
  try {
    const client = await getMemWalClientFromSession();
    if (client === null) {
      return { ok: false, message: "Not authenticated" };
    }

    const result = await client.recall({
      namespace: "sessions",
      query: "session summary",
      limit: SESSIONS_LIST_LIMIT,
      maxDistance: SESSION_MAX_DISTANCE,
    });

    const sessions: SessionSummary[] = result.results.map((entry) => ({
      sessionId: entry.sessionId ?? null,
      blob_id: entry.blob_id,
      text: entry.text,
      repo: entry.repo ?? null,
    }));

    return { ok: true, sessions };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

/**
 * Gather one session's linked memories across the per-session namespaces.
 *
 * Uses the shared multi-pass {@link gatherSessionNamespace} helper: it recalls
 * `sessions` first to find the matching summary, then for each of `skills` /
 * `productivity` / `transcripts` runs TWO passes — the namespace's generic
 * broad query and (when present) the session summary text — merging + deduping
 * by `blob_id` before filtering to entries whose `sessionId` matches. `reports`
 * are excluded by design (generated by aggregation, not per-session).
 * `transcripts` are sorted by `index` ascending with index-less entries last.
 *
 * Because recall is semantic and each pass is capped at 100, this is BEST-EFFORT
 * coverage, NOT a guaranteed-exhaustive listing of every entry in the session.
 * Requires an owner session.
 */
export async function getSessionDetail(input: {
  sessionId: string;
}): Promise<GetSessionDetailResult> {
  try {
    const client = await getMemWalClientFromSession();
    if (client === null) {
      return { ok: false, message: "Not authenticated" };
    }

    // Wrap the session client as an injected recall fn for the shared helper.
    const recall: SessionRecallFn = async (params) => {
      const result = await client.recall(params);
      return result.results;
    };

    // 1. Recall `sessions` first and pick the matching summary; capture its text
    //    so it can seed the second pass for the other namespaces.
    const sessions = await gatherSessionNamespace({
      recall,
      namespace: "sessions",
      sessionId: input.sessionId,
      queries: queriesForNamespace("sessions", ""),
    });
    const summary = sessions[0] ?? null;
    const summaryText = summary?.text ?? "";

    // 2. Gather the per-session namespaces with two passes each (broad + summary).
    const [skills, productivity, transcripts] = await Promise.all([
      gatherSessionNamespace({
        recall,
        namespace: "skills",
        sessionId: input.sessionId,
        queries: queriesForNamespace("skills", summaryText),
      }),
      gatherSessionNamespace({
        recall,
        namespace: "productivity",
        sessionId: input.sessionId,
        queries: queriesForNamespace("productivity", summaryText),
      }),
      gatherSessionNamespace({
        recall,
        namespace: "transcripts",
        sessionId: input.sessionId,
        queries: queriesForNamespace("transcripts", summaryText),
      }),
    ]);

    return {
      ok: true,
      summary,
      skills,
      productivity,
      transcripts: sortTranscriptsByIndex(transcripts),
    };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}
