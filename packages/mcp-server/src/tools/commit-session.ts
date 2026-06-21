/**
 * `commit_session` MCP tool — write phase of the two-phase session capture
 * flow.
 *
 * Behaviour, in order:
 *
 *   1. **Approved-set validation (Requirements 15.7, 15.8).** The set of
 *      approved candidates must be non-empty and every candidate must have
 *      a valid `type` (`session`, `skill`, or `productivity`). Empty or
 *      missing sets, and any candidate with an invalid type, short-circuit
 *      with a validation error and no storage is attempted at all. The
 *      error message identifies the offending candidate so the developer
 *      can correct the input.
 *
 *   2. **Per-tool relayer health gate (Requirements 14.3, 14.4, 15.6).**
 *      Verifies MemWal connectivity via {@link MemWalClient.isHealthy}
 *      with a 5-second timeout before any write. A failed gate returns an
 *      error result and stores **none** of the approved candidates.
 *
 *   3. **Per-candidate storage (Requirements 15.1, 15.2, 15.3, 15.4,
 *      15.5).** Each approved candidate is stored independently via
 *      `rememberAndWait` into the namespace matching its type
 *      (`session` → `sessions` with a 30000ms timeout, `skill` →
 *      `skills`, `productivity` → `productivity`). Failures are caught
 *      per-candidate; the loop never aborts early on individual errors.
 *      The result reports each candidate's outcome (success or error) in
 *      input order along with running success/failure tallies.
 *
 *   4. **Automatic transcript storage.** If `transcriptChunks` are
 *      supplied (from the `extract_session` preview), each chunk is stored
 *      into the `transcripts` namespace — without per-chunk review — using
 *      the same fail-soft, per-item-reporting behavior. Skill/productivity
 *      facts remain review-first; only transcript chunks bypass approval.
 *
 * Validates: Requirements 14.3, 14.4, 15.1, 15.2, 15.3, 15.4, 15.5,
 *            15.6, 15.7, 15.8
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { MemWalClient, Namespace } from "@uberwal/shared";
import { encodeMemory } from "@uberwal/shared";

import { scanForSecrets } from "../extraction/secret-scan.js";

import {
  CANDIDATE_TYPE_TO_NAMESPACE,
  CANDIDATE_TYPES,
  TRANSCRIPTS_NAMESPACE,
  isCandidateType,
  type CandidateFact,
  type CommitFactOutcome,
  type CommitSessionResult,
  type TranscriptChunk,
  type TranscriptStorageOutcome,
} from "./candidate.js";
import type { ToolDeps } from "./register.js";

/** Per-tool health-gate timeout (Requirements 14.3, 15.6). */
const TOOL_HEALTH_TIMEOUT_MS = 5_000;

/**
 * `rememberAndWait` timeout for `session`-type candidates per
 * Requirement 15.2. Skill and productivity writes use the SDK default
 * (omitted `timeoutMs`), which keeps the behavior consistent with
 * `recall_memory` and the rest of the wrapper surface.
 */
const SESSION_REMEMBER_TIMEOUT_MS = 30_000;

/**
 * Input schema for `commit_session`, expressed as a Zod raw shape.
 *
 * Mirrors the JSON Schema documented in `design.md`:
 *
 * ```json
 * {
 *   "approved": {
 *     "type": "array",
 *     "minItems": 1,
 *     "items": {
 *       "id":   { "type": "string", "minLength": 1 },
 *       "type": { "type": "string", "enum": ["session","skill","productivity"] },
 *       "text": { "type": "string" },
 *       "evidence": { "type": "string" }
 *     }
 *   }
 * }
 * ```
 *
 * Note: `type` is intentionally typed as a free string at the schema layer
 * rather than as `z.enum`. Defending against invalid types entirely at the
 * SDK layer would mask the per-candidate identification mandated by
 * Requirement 15.8 — the handler itself reports which candidate had the
 * invalid type. The schema's `min(1)` on `id` is preserved because an
 * empty id would make outcome reporting ambiguous.
 */
export const COMMIT_SESSION_INPUT_SHAPE = {
  approved: z
    .array(
      z.object({
        id: z
          .string()
          .min(1, "Each approved candidate must carry a non-empty id."),
        type: z
          .string()
          .describe(
            `One of "${CANDIDATE_TYPES.join('", "')}"; controls which namespace the candidate is stored in.`,
          ),
        text: z.string(),
        evidence: z
          .string()
          .optional()
          .describe(
            "Optional transcript-grounded snippet carried over from extract_session. " +
              "For skill candidates with non-empty evidence, it is appended to the stored " +
              "text (as an \"Evidence:\" line) so recall surfaces the grounding.",
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Optional id of the source session, carried over from extract_session. " +
              "When non-empty, a metadata header linking the stored memory to this " +
              "session is embedded in the stored text.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Optional normalized project/repository label carried over from " +
              "extract_session. When present it is embedded in the metadata header so " +
              "the stored memory is grouped under its project.",
          ),
      }),
    )
    .min(1, "At least one approved candidate is required.")
    .describe(
      "The candidates the developer approved from the most recent extract_session preview. " +
        "Each candidate is stored independently into the namespace matching its type.",
    ),
  transcriptChunks: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        text: z.string(),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Optional id of the source session, carried over from extract_session. " +
              "When non-empty, a metadata header linking the chunk to this session is " +
              "embedded in the stored text.",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Optional normalized project/repository label carried over from " +
              "extract_session, embedded in the chunk's metadata header.",
          ),
      }),
    )
    .optional()
    .describe(
      "The transcriptChunks returned by extract_session, passed back unchanged. Stored " +
        "automatically into the transcripts namespace without per-chunk review. Optional.",
    ),
  acknowledgeSecrets: z
    .boolean()
    .optional()
    .describe(
      "Override for the secret gate. commit_session refuses to write content that " +
        "looks like it contains credentials to append-only storage. Set this to true " +
        "ONLY after confirming the flagged content is safe; the commit then proceeds.",
    ),
} as const;

/**
 * Strongly-typed input expected by {@link commitSessionHandler}.
 *
 * `approved` is typed permissively for `type` (free string) so the handler
 * can run defensive validation and report which specific candidate was
 * malformed (Requirement 15.8). Property tests calling the handler
 * directly can pass arbitrary `type` values without going through SDK
 * input validation. `transcriptChunks` is optional — when present, each
 * chunk is stored automatically (no review) into the transcripts namespace.
 */
export type CommitSessionInput = {
  approved: {
    id: string;
    type: string;
    text: string;
    evidence?: string;
    sessionId?: string;
    repo?: string;
  }[];
  transcriptChunks?: TranscriptChunk[];
  /** When true, bypass the secret gate (caller has confirmed content is safe). */
  acknowledgeSecrets?: boolean;
};

/**
 * Build a successful tool response containing the JSON-serialized
 * commit-session result. Both unstructured `content` (for human/text MCP
 * clients) and `structuredContent` (for clients that prefer typed output)
 * are returned.
 */
function successResult(payload: CommitSessionResult): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload as unknown as { [key: string]: unknown },
  };
}

/**
 * Build an error tool response with `isError: true`. Used for both
 * validation failures (Requirements 15.7, 15.8) and the relayer-health
 * short-circuit (Requirement 15.6).
 */
function errorResult(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

/**
 * Secret gate (P1): scan everything bound for append-only storage — each
 * approved candidate's `text` and `evidence`, plus every transcript chunk —
 * for likely secrets via {@link scanForSecrets}. Returns a human-readable,
 * MASKED summary (one line per offending item; never the raw secret), or
 * `null` when nothing tripped. The handler blocks the whole commit on a hit
 * unless the caller passed `acknowledgeSecrets: true`.
 */
function collectSecretFindings(input: CommitSessionInput): string | null {
  const lines: string[] = [];

  for (const candidate of input.approved) {
    const found = [
      ...scanForSecrets(candidate.text),
      ...(typeof candidate.evidence === "string" ? scanForSecrets(candidate.evidence) : []),
    ];
    if (found.length > 0) {
      const label = candidate.id ? `candidate "${candidate.id}"` : "candidate";
      lines.push(`  - ${label}: ${found.map((f) => `${f.kind} ${f.sample}`).join("; ")}`);
    }
  }

  for (const chunk of input.transcriptChunks ?? []) {
    const found = scanForSecrets(chunk.text);
    if (found.length > 0) {
      lines.push(
        `  - transcript #${chunk.index}: ${found.map((f) => `${f.kind} ${f.sample}`).join("; ")}`,
      );
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Validate the approved set up-front. Returns `null` on success, otherwise
 * the human-readable validation error message.
 *
 * Empty/missing approved sets and invalid types are both checked here so
 * the handler can short-circuit with a precise message before any write
 * is attempted, matching Requirements 15.7 and 15.8.
 */
function validateApprovedSet(approved: CommitSessionInput["approved"]): string | null {
  if (!Array.isArray(approved) || approved.length === 0) {
    // Requirement 15.7: empty or missing set is rejected without any storage.
    return "At least one approved candidate is required.";
  }

  for (let i = 0; i < approved.length; i++) {
    const candidate = approved[i];
    if (candidate === undefined) {
      // Defensive: array holes shouldn't reach us through the SDK, but a
      // direct caller (or a property test) could construct one.
      return `Approved candidate at index ${i} is missing.`;
    }
    if (!isCandidateType(candidate.type)) {
      // Requirement 15.8: invalid type rejects the entire commit and
      // identifies the offending candidate so the developer knows what
      // to fix without trial-and-error.
      const idLabel = candidate.id ? `id="${candidate.id}"` : `index=${i}`;
      return (
        `Approved candidate (${idLabel}) has invalid type "${String(candidate.type)}". ` +
        `Expected one of session, skill, productivity.`
      );
    }
  }
  return null;
}

/**
 * Attempt a single `rememberAndWait` write and translate its outcome into a
 * {@link CommitFactOutcome}. Errors are caught and recorded on the outcome
 * so the calling loop can keep going (Requirement 15.5).
 *
 * The candidate's `type` is assumed to have been validated by the caller —
 * `validateApprovedSet` runs first and rejects the whole commit if any
 * type is invalid, so this helper can dereference
 * `CANDIDATE_TYPE_TO_NAMESPACE` safely.
 */
async function commitOne(
  memwal: MemWalClient,
  candidate: CandidateFact,
  capturedAt: number,
): Promise<CommitFactOutcome> {
  const namespace: Namespace = CANDIDATE_TYPE_TO_NAMESPACE[candidate.type];

  // Grounding: for skill candidates carrying non-empty evidence, append the
  // transcript snippet as an "Evidence:" line so the stored memory keeps the
  // verifiable link to its source session and recall surfaces it. Session and
  // productivity candidates are stored verbatim — evidence is a skill concept.
  const trimmedEvidence =
    typeof candidate.evidence === "string" ? candidate.evidence.trim() : "";
  const baseText =
    candidate.type === "skill" && trimmedEvidence.length > 0
      ? `${candidate.text}\n\nEvidence: ${trimmedEvidence}`
      : candidate.text;

  // Per-session linkage: when the candidate carries a non-empty sessionId,
  // embed a metadata header so the stored memory points back to its source
  // session. A non-empty repo rides along in the same header so the memory is
  // grouped under its project. Without a sessionId the text is stored verbatim
  // (backward compatible with memories captured before this feature).
  const repo =
    typeof candidate.repo === "string" && candidate.repo.length > 0
      ? candidate.repo
      : undefined;
  const textToStore =
    typeof candidate.sessionId === "string" && candidate.sessionId.length > 0
      ? encodeMemory(
          {
            sessionId: candidate.sessionId,
            type: candidate.type,
            ...(repo ? { repo } : {}),
            capturedAt,
          },
          baseText,
        )
      : baseText;

  // Requirement 15.2: session-type writes use a 30000ms timeout. Other
  // types fall through to the SDK default by omitting the parameter.
  const timeoutMs = candidate.type === "session" ? SESSION_REMEMBER_TIMEOUT_MS : undefined;

  try {
    if (timeoutMs !== undefined) {
      await memwal.remember(textToStore, namespace, timeoutMs);
    } else {
      await memwal.remember(textToStore, namespace);
    }
    return {
      id: candidate.id,
      type: candidate.type,
      namespace,
      ok: true,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      id: candidate.id,
      type: candidate.type,
      namespace,
      ok: false,
      error: reason,
    };
  }
}

/**
 * Attempt a single transcript-chunk write into the `transcripts` namespace
 * and translate the outcome into a {@link TranscriptStorageOutcome}. Errors
 * are caught per-chunk so the loop never aborts early — matching the
 * partial-failure behavior used for approved candidates.
 */
async function commitTranscriptChunk(
  memwal: MemWalClient,
  chunk: TranscriptChunk,
  capturedAt: number,
): Promise<TranscriptStorageOutcome> {
  // Per-session linkage: embed a metadata header (type "transcript", plus the
  // chunk index, and the repo tag when present) when the chunk carries a
  // non-empty sessionId; otherwise store verbatim for backward compatibility.
  const repo =
    typeof chunk.repo === "string" && chunk.repo.length > 0 ? chunk.repo : undefined;
  const textToStore =
    typeof chunk.sessionId === "string" && chunk.sessionId.length > 0
      ? encodeMemory(
          {
            sessionId: chunk.sessionId,
            type: "transcript",
            index: chunk.index,
            ...(repo ? { repo } : {}),
            capturedAt,
          },
          chunk.text,
        )
      : chunk.text;

  try {
    await memwal.remember(textToStore, TRANSCRIPTS_NAMESPACE);
    return { index: chunk.index, ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { index: chunk.index, ok: false, error: reason };
  }
}

/**
 * Execute the `commit_session` tool.
 *
 * Exported separately from the registration helper so unit and property
 * tests can call the handler directly with a stub {@link MemWalClient}
 * without going through the MCP transport layer.
 *
 * Validates: Requirements 14.3, 14.4, 15.1, 15.2, 15.3, 15.4, 15.5,
 *            15.6, 15.7, 15.8
 */
export async function commitSessionHandler(
  deps: ToolDeps,
  input: CommitSessionInput,
): Promise<CallToolResult> {
  // 1. Validate the approved set up-front (Requirements 15.7, 15.8).
  //    Validation runs before the health gate so a malformed input
  //    surfaces a precise error without spending a network round-trip.
  const validationError = validateApprovedSet(input.approved);
  if (validationError !== null) {
    return errorResult(validationError);
  }

  // 2. Secret gate (P1). Everything below is written to append-only storage,
  //    so a likely secret blocks the WHOLE commit — blocking beats silently
  //    storing a best-effort-redacted copy that can never be deleted. The
  //    caller overrides with `acknowledgeSecrets: true` once verified safe.
  if (input.acknowledgeSecrets !== true) {
    const secrets = collectSecretFindings(input);
    if (secrets !== null) {
      return errorResult(
        "Refused to commit: potential secret(s) detected in content bound for " +
          "permanent, append-only storage. Remove them, or pass " +
          "acknowledgeSecrets: true to store anyway.\n" +
          secrets,
      );
    }
  }

  // 3. Per-tool relayer health gate (Requirements 14.3, 14.4, 15.6). A
  //    failed gate stores none of the approved candidates.
  const healthy = await deps.memwal.isHealthy(TOOL_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    return errorResult(
      "The MemWal relayer is unavailable. No candidates were stored — please retry " +
        "once connectivity is restored.",
    );
  }

  // 3. Per-candidate storage (Requirements 15.1–15.5). Validation has
  //    already confirmed every candidate's type is valid, so the cast to
  //    `CandidateFact` here is sound.
  // One capture timestamp for the whole commit, so every memory written in
  // this call shares the same sortable "when" (embedded in the metadata header).
  const capturedAt = Date.now();

  const outcomes: CommitFactOutcome[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const raw of input.approved) {
    const candidate: CandidateFact = {
      id: raw.id,
      // Safe cast — `validateApprovedSet` rejected any non-CandidateType.
      type: raw.type as CandidateFact["type"],
      text: raw.text,
      // Carry the optional grounding through; `commitOne` decides whether to
      // append it (skill candidates with non-empty evidence only).
      ...(raw.evidence ? { evidence: raw.evidence } : {}),
      // Carry the optional per-session linkage through; `commitOne` embeds it
      // as a metadata header when present and non-empty.
      ...(raw.sessionId ? { sessionId: raw.sessionId } : {}),
      // Carry the optional repo tag through; `commitOne` embeds it in the same
      // metadata header so the stored memory is grouped under its project.
      ...(raw.repo ? { repo: raw.repo } : {}),
    };

    // Awaited sequentially rather than `Promise.all`-ed so failures of
    // earlier writes do not get unhandled rejections, and so the overall
    // ordering of outcomes matches the input order — both useful for
    // human review and for Property 7's "no early abort, every approved
    // candidate attempted" assertion.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await commitOne(deps.memwal, candidate, capturedAt);
    outcomes.push(outcome);
    if (outcome.ok) succeeded++;
    else failed++;
  }

  // 4. Automatic transcript storage (no per-chunk review). Each chunk is
  //    written to the `transcripts` namespace; per-chunk failures are
  //    recorded and never abort the loop. When no chunks are supplied this
  //    is a no-op and the tallies stay at zero.
  const transcriptOutcomes: TranscriptStorageOutcome[] = [];
  let transcriptsStored = 0;
  let transcriptsFailed = 0;

  const transcriptChunks = input.transcriptChunks ?? [];
  for (const chunk of transcriptChunks) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await commitTranscriptChunk(deps.memwal, chunk, capturedAt);
    transcriptOutcomes.push(outcome);
    if (outcome.ok) transcriptsStored++;
    else transcriptsFailed++;
  }

  return successResult({
    outcomes,
    succeeded,
    failed,
    transcriptOutcomes,
    transcriptsStored,
    transcriptsFailed,
  });
}

/**
 * Register `commit_session` against the supplied MCP server.
 *
 * Called from `registerTools` in `register.ts`. Kept as its own exported
 * helper so the central registration file stays a flat list of tool wires
 * and tests can register the tool against a stub server in isolation.
 *
 * The output schema below mirrors the `CommitSessionResult` data model
 * documented in `design.md`; publishing it lets MCP clients render the
 * per-candidate outcomes without parsing the text payload.
 */
export function registerCommitSessionTool(server: McpServer, deps: ToolDeps): void {
  const commitOutputShape = {
    outcomes: z
      .array(
        z.object({
          id: z.string(),
          type: z.enum(["session", "skill", "productivity"]),
          namespace: z.enum([
            "sessions",
            "skills",
            "productivity",
            "reports",
            "transcripts",
          ]),
          ok: z.boolean(),
          error: z.string().optional(),
        }),
      )
      .describe("One outcome per approved candidate, in input order."),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    transcriptOutcomes: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          ok: z.boolean(),
          error: z.string().optional(),
        }),
      )
      .describe("One outcome per auto-stored transcript chunk, in input order."),
    transcriptsStored: z.number().int().nonnegative(),
    transcriptsFailed: z.number().int().nonnegative(),
  } as const;

  server.registerTool(
    "commit_session",
    {
      title: "Commit session (review approved candidates)",
      description:
        "Phase 2 of two-phase session capture. Stores each approved Candidate_Fact from " +
        "the most recent extract_session preview into the namespace matching its type " +
        "(session→sessions, skill→skills, productivity→productivity). Session-type writes " +
        "use a 30000ms timeout. If transcriptChunks are supplied, they are stored " +
        "automatically into the transcripts namespace without per-chunk review. " +
        "Per-item failures do not abort the operation; the response reports each " +
        "candidate and transcript chunk individually. Performs a 5-second MemWal relayer " +
        "health gate before any write — a failed gate stores nothing. A secret gate also " +
        "refuses the commit if the content looks like it contains credentials (append-only " +
        "storage is permanent); pass acknowledgeSecrets: true to override once verified safe.",
      inputSchema: COMMIT_SESSION_INPUT_SHAPE,
      outputSchema: commitOutputShape,
    },
    async (args) => commitSessionHandler(deps, args as CommitSessionInput),
  );
}
