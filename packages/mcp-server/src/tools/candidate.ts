/**
 * Shared types for the two-phase session capture flow.
 *
 * `extract_session` produces a `Preview` of `CandidateFact`s for the
 * developer to review; `commit_session` consumes the approved subset and
 * reports a `CommitSessionResult` describing the outcome of each individual
 * write.
 *
 * These types are deliberately co-located so both tools — and any future
 * caller (tests, integration helpers) — refer to a single source of truth.
 *
 * Validates: Requirements 1.2, 1.3, 1.5 (preview shape),
 *            15.1, 15.4, 15.5, 15.8
 */

import type { Namespace } from "@uberwal/shared";

/**
 * Discriminator on a `CandidateFact` that controls which namespace it is
 * stored in at commit time.
 *
 * - `session`      → stored in the `sessions` namespace (Requirement 15.1).
 * - `skill`        → stored in the `skills` namespace (Requirement 15.1).
 * - `productivity` → stored in the `productivity` namespace (Requirement 15.1).
 *
 * Any other value is a validation error per Requirement 15.8.
 */
export type CandidateType = "session" | "skill" | "productivity";

/** The three valid `CandidateType` values, kept as a const tuple for runtime checks. */
export const CANDIDATE_TYPES = ["session", "skill", "productivity"] as const;

/**
 * A single item produced by `extract_session` and (after approval) consumed
 * by `commit_session`.
 *
 * Each candidate is uniquely identified inside its `Preview` so the
 * developer can approve or reject candidates individually, and so the
 * commit-time outcome report can be matched back to the original review
 * decision.
 *
 * Validates: Requirements 1.2, 1.3, 15.1, 15.3
 */
export interface CandidateFact {
  /** Stable, unique identifier assigned by `extract_session`. */
  id: string;
  /** Discriminator controlling commit-time namespace routing. */
  type: CandidateType;
  /** The candidate summary / skill fact / productivity metric text. */
  text: string;
  /**
   * Optional supporting snippet drawn from the source transcript that
   * grounds the candidate back to its origin session.
   *
   * Populated only for `skill`-type candidates (from the extractor's grounded
   * `skills` output) and surfaced at commit time: when present and non-empty,
   * `commit_session` appends it to the stored skill text so a recruiter can
   * verify the skill against the session it came from. Absent or empty for
   * `session` and `productivity` candidates, and for skills with no concrete
   * grounding in the transcript.
   */
  evidence?: string;
  /**
   * Optional id of the session this candidate was extracted from. Stamped by
   * `extract_session` on every candidate and, when present and non-empty,
   * embedded as a metadata header in the stored text at commit time so the
   * memory links back to its source session.
   */
  sessionId?: string;
  /**
   * Optional project/repository this candidate belongs to — a host-agnostic
   * grouping label supplied to `extract_session` (e.g. the workspace folder
   * name), stamped on every candidate and embedded in the metadata header at
   * commit time so many sessions can be grouped under one project.
   */
  repo?: string;
}

/**
 * A single chunk of the (already-sanitized) raw session transcript.
 *
 * Produced by `extract_session` alongside the candidate facts and stored
 * automatically — without per-chunk review — into the `transcripts`
 * namespace by `commit_session`. Chunks preserve full session context so a
 * developer's memory can be recalled in detail later, from any agent.
 */
export interface TranscriptChunk {
  /** Sequential position of the chunk within the transcript, starting at 0. */
  index: number;
  /** The chunk text (a conversation turn, or a size-split window of one). */
  text: string;
  /**
   * Optional id of the session this chunk belongs to. Stamped by
   * `extract_session` and, when present and non-empty, embedded as a metadata
   * header in the stored transcript text at commit time.
   */
  sessionId?: string;
  /**
   * Optional project/repository this chunk belongs to — the same grouping label
   * stamped on the session's candidates, embedded in the metadata header at
   * commit time.
   */
  repo?: string;
}

/**
 * The complete preview returned by `extract_session` — every Candidate_Fact
 * derived from the transcript (for review) plus the chunked transcript (for
 * automatic storage at commit). Nothing is stored in MemWal at this point.
 *
 * Validates: Requirements 1.3
 */
export interface Preview {
  /** Every candidate produced from the transcript. May be empty. */
  candidates: CandidateFact[];
  /**
   * The sanitized transcript split into ordered chunks. Passed back to
   * `commit_session` and stored automatically (no per-chunk review). May be
   * empty when the transcript is blank.
   */
  transcriptChunks: TranscriptChunk[];
}

/**
 * Per-candidate outcome from `commit_session`. Echoes the candidate's `id`
 * and `type` so callers can match outcomes back to their review decision,
 * records the namespace the candidate was routed to, and reports whether
 * the storage attempt succeeded.
 *
 * On failure, `error` carries a human-readable description of the SDK or
 * relayer error so downstream tooling can show a meaningful message
 * without re-deriving it.
 *
 * Validates: Requirements 15.4, 15.5
 */
export interface CommitFactOutcome {
  /** The approved candidate's id, echoed unchanged. */
  id: string;
  /** The approved candidate's type, echoed unchanged. */
  type: CandidateType;
  /** The namespace the candidate was routed to (matches its type). */
  namespace: Namespace;
  /** True iff the underlying `rememberAndWait` call resolved successfully. */
  ok: boolean;
  /** Human-readable error message when `ok` is `false`; absent on success. */
  error?: string;
}

/**
 * Per-chunk outcome from the automatic transcript storage step of
 * `commit_session`. Transcript chunks are stored without review, so unlike
 * {@link CommitFactOutcome} there is no `type` — they always route to the
 * `transcripts` namespace.
 */
export interface TranscriptStorageOutcome {
  /** The chunk's sequential index, echoed unchanged. */
  index: number;
  /** True iff the underlying `rememberAndWait` call resolved successfully. */
  ok: boolean;
  /** Human-readable error message when `ok` is `false`; absent on success. */
  error?: string;
}

/**
 * Aggregate result of `commit_session`. Reports one outcome per approved
 * candidate, in input order, and pre-computes the success/failure tallies
 * so callers do not have to re-derive them.
 *
 * Invariant: `outcomes.length === succeeded + failed` and the partition
 * exactly matches the `ok` flag on each outcome. This invariant is
 * exercised by Property 7. The transcript-storage tallies are tracked
 * separately so this invariant covers reviewed candidates only.
 *
 * Validates: Requirements 15.4, 15.5
 */
export interface CommitSessionResult {
  /** One outcome per approved candidate, in the input order. */
  outcomes: CommitFactOutcome[];
  /** Count of `outcomes` with `ok === true`. */
  succeeded: number;
  /** Count of `outcomes` with `ok === false`. */
  failed: number;
  /**
   * One outcome per transcript chunk stored (auto, no review), in input
   * order. Empty when no transcript chunks were supplied.
   */
  transcriptOutcomes: TranscriptStorageOutcome[];
  /** Count of transcript chunks stored successfully. */
  transcriptsStored: number;
  /** Count of transcript chunks that failed to store. */
  transcriptsFailed: number;
}

/**
 * Mapping from `CandidateType` to its destination `Namespace`.
 *
 * Centralized so both `commit_session` and any future routing-aware caller
 * (e.g. tests, audit tools) agree on the single mapping documented in
 * Requirement 15.1.
 */
export const CANDIDATE_TYPE_TO_NAMESPACE: Record<CandidateType, Namespace> = {
  session: "sessions",
  skill: "skills",
  productivity: "productivity",
};

/** Namespace that auto-committed transcript chunks are stored under. */
export const TRANSCRIPTS_NAMESPACE: Namespace = "transcripts";

/**
 * Type guard for `CandidateType`. Used by the `commit_session` validation
 * pass that runs before any storage is attempted, so an invalid type
 * short-circuits with a precise error naming the offending candidate
 * (Requirement 15.8).
 */
export function isCandidateType(value: unknown): value is CandidateType {
  return (
    typeof value === "string" &&
    (CANDIDATE_TYPES as readonly string[]).includes(value)
  );
}
