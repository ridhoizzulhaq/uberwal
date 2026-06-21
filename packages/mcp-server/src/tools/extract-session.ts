/**
 * `extract_session` MCP tool — preview phase of the two-phase session
 * capture flow.
 *
 * Behaviour, in order:
 *
 *   1. **No relayer health gate.** Extraction never writes to MemWal, so
 *      the per-tool 5-second health check is intentionally skipped here
 *      (per the design's Error Handling table). Extraction depends only on
 *      the Claude API.
 *
 *   2. **Transcript validation (Requirement 1.4).** Empty, missing, or
 *      whitespace-only transcripts short-circuit with a validation error;
 *      the extractor is never invoked.
 *
 *   3. **Local secret redaction (best-effort), first in the pipeline.** The
 *      transcript is sanitized in-process (no network call) before it is
 *      sent to Claude or chunked, so neither the model nor Walrus sees
 *      detectable secrets. This is best-effort, not a guarantee — see the
 *      README "Security" note.
 *
 *   4. **Fact extraction (Requirement 1.1).** Calls
 *      {@link Extractor.extractFacts} on the sanitized transcript, returning
 *      a candidate session summary plus arrays of skill facts and
 *      productivity metrics.
 *
 *   5. **Candidate wrapping + transcript chunking (Requirements 1.2, 1.3).**
 *      Wraps every extracted item as a {@link CandidateFact} with a stable
 *      id and a type, and chunks the sanitized transcript for automatic
 *      storage at commit. Returns the `Preview` (candidates +
 *      transcriptChunks). Nothing is stored in any namespace here.
 *
 *   6. **Extraction failure (Requirement 1.5).** Any failure raised by the
 *      extractor is surfaced as an error result with a clear "extraction
 *      failed" message and no storage occurs anywhere — there is nothing to
 *      roll back since this tool never writes.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
 */

import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { isValidTranscript } from "@uberwal/shared";

import { chunkTranscript } from "../extraction/chunk.js";
import { sanitizeTranscript } from "../extraction/sanitize.js";
import type { Extractor, ExtractedFacts } from "../extraction/extractor.js";

import type { CandidateFact, Preview } from "./candidate.js";
import type { ToolDeps } from "./register.js";

/**
 * Input schema for `extract_session`, expressed as a Zod raw shape.
 *
 * Mirrors the JSON Schema documented in `design.md`:
 *
 * ```json
 * { "transcript": { "type": "string", "minLength": 1 } }
 * ```
 *
 * The schema-level `min(1)` rejects strictly empty strings; the handler
 * additionally rejects whitespace-only transcripts (which `min(1)` allows
 * through) via {@link isValidTranscript} so Requirement 1.4 is fully
 * enforced regardless of how the input is delivered.
 */
export const EXTRACT_SESSION_INPUT_SHAPE = {
  transcript: z
    .string()
    .min(1, "Transcript is required and must contain at least one non-whitespace character.")
    .describe(
      "The FULL, raw session dialogue between the developer and the AI coding " +
        "assistant — verbatim, from the session start up to now. This is the single " +
        "source from which the session summary, skill facts, and productivity metrics " +
        "are derived (each skill's evidence is quoted from it), so it MUST be the " +
        "complete conversation: NOT a summary and NOT truncated. Preserve turn markers " +
        '("User:" / "Assistant:") at the start of each turn so turns are chunked ' +
        "correctly. INCLUDE the technical substance of each turn, not just prose: the " +
        "file paths edited with a short code/diff snippet of each meaningful change, " +
        "the commands run with their key results, and any errors with how they were " +
        "fixed (quote the actual error text). This concrete detail is what makes the " +
        "stored skills verifiable back to real work. Do NOT include IDE scaffolding " +
        "(environment/context blocks, open-file lists, rule blocks) — those are not " +
        "conversation. Secrets are redacted server-side (best-effort) and storage is " +
        "permanent and append-only, so do NOT capture sessions containing real " +
        "credentials; never invent content.",
    ),
  repo: z
    .string()
    .optional()
    .describe(
      "Project/repository this session belongs to — a short, host-agnostic " +
        "grouping label (NOT a GitHub integration). ALWAYS set this when you can " +
        "determine the workspace: use the basename of the current workspace/" +
        "project folder (e.g. \"uberwal\"), or a git remote's last path segment. " +
        "It is normalized to a lowercase slug and stamped on every stored memory " +
        "so many sessions are automatically grouped, scoped, and shared as one " +
        "project. Only omit it when no workspace/project context is available.",
    ),
} as const;

/**
 * Strongly-typed input expected by {@link extractSessionHandler}. Inferred
 * from the input shape so the handler stays in lockstep with the wire
 * schema published to MCP clients.
 */
export type ExtractSessionInput = {
  transcript: string;
  repo?: string;
};

/**
 * Normalize a caller-supplied repo label into a stable, host-agnostic slug.
 *
 * The label is a grouping key, NOT a GitHub integration: callers pass the
 * workspace folder name or a git remote URL/path and we reduce it to a clean
 * slug so the same project always lands under the same tag. Rules:
 *   - trim; strip any `?query`/`#fragment` and trailing slashes;
 *   - take the last path segment (handles `git@host:org/repo.git`, `https://…/repo`,
 *     and filesystem paths);
 *   - drop a trailing `.git`;
 *   - lowercase and collapse internal whitespace to single hyphens;
 *   - cap length at 100 chars.
 *
 * Returns `undefined` for missing/blank input so callers can treat the repo as
 * absent (no header tag) rather than stamping an empty string.
 */
export function normalizeRepo(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.trim();
  if (s.length === 0) return undefined;
  // Drop query/fragment if a URL was passed.
  const cut = s.split(/[?#]/)[0];
  s = cut ?? s;
  // Drop trailing slashes so the last segment isn't empty.
  s = s.replace(/[/\\]+$/, "");
  // Take the last path segment (works for URLs, scp-style git, and paths).
  const lastSep = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"), s.lastIndexOf(":"));
  if (lastSep >= 0) s = s.slice(lastSep + 1);
  // Strip a trailing `.git`.
  s = s.replace(/\.git$/i, "");
  // Lowercase + collapse whitespace runs to single hyphens.
  s = s.trim().toLowerCase().replace(/\s+/g, "-");
  if (s.length === 0) return undefined;
  return s.length > 100 ? s.slice(0, 100) : s;
}

/**
 * Build a successful tool response. The MCP SDK accepts both an unstructured
 * `content` array (text blocks) and an optional `structuredContent` object;
 * we provide the JSON-serialized preview as text for human inspection and
 * the typed `Preview` as structured content for clients that prefer it.
 */
function successResult(payload: Preview): CallToolResult {
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
 * Build an error tool response with `isError: true` so MCP clients surface
 * the failure to the user instead of treating an empty preview as success.
 * Used for both validation errors (Requirement 1.4) and extraction failures
 * (Requirement 1.5).
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
 * ID generator type — exposed so unit and property tests can inject a
 * deterministic generator (e.g. counter-based) instead of `randomUUID`.
 */
export type IdGenerator = () => string;

/**
 * Default identifier generator — Node 19+ exposes `crypto.randomUUID` which
 * gives RFC 4122 v4 UUIDs. Stable, sufficiently unique, and available
 * without an extra runtime dependency.
 */
const defaultIdGenerator: IdGenerator = () => randomUUID();

/**
 * Build the ordered candidate list from raw {@link ExtractedFacts}.
 *
 * Order of candidates, by design:
 *
 *   1. The single `session`-type candidate carrying `sessionSummary`.
 *   2. Each `skill`-type candidate, in extractor order.
 *   3. Each `productivity`-type candidate, in extractor order.
 *
 * Every candidate receives a fresh id from `nextId`, so even when the
 * extractor returns duplicate text the candidates remain individually
 * addressable. Skill candidates additionally carry the extractor's optional
 * `evidence` snippet (when present) so the grounding survives to commit time.
 * Exported (with an injectable `nextId`) so tests can exercise the wrapping
 * rules directly without standing up a Claude mock.
 *
 * Validates: Requirements 1.2, 1.3
 */
export function buildCandidates(
  facts: ExtractedFacts,
  nextId: IdGenerator = defaultIdGenerator,
  sessionId?: string,
  repo?: string,
): CandidateFact[] {
  const candidates: CandidateFact[] = [];

  candidates.push({
    id: nextId(),
    type: "session",
    text: facts.sessionSummary,
    ...(sessionId ? { sessionId } : {}),
    ...(repo ? { repo } : {}),
  });

  for (const skill of facts.skills) {
    candidates.push({
      id: nextId(),
      type: "skill",
      text: skill.text,
      // Carry the transcript-grounded evidence through to commit when the
      // extractor supplied a non-empty snippet, so the stored skill stays
      // verifiable. Skills without grounding stay evidence-free.
      ...(skill.evidence ? { evidence: skill.evidence } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(repo ? { repo } : {}),
    });
  }

  for (const metric of facts.productivity) {
    candidates.push({
      id: nextId(),
      type: "productivity",
      text: metric,
      ...(sessionId ? { sessionId } : {}),
      ...(repo ? { repo } : {}),
    });
  }

  return candidates;
}

/**
 * Dependencies needed by {@link extractSessionHandler} beyond the standard
 * {@link ToolDeps} bundle. Carved out so tests can inject a fake extractor
 * and a deterministic id generator without depending on the global tool
 * dependency container.
 */
export interface ExtractSessionDeps {
  /** Claude-backed extractor. Injected so tests can use an in-memory fake. */
  readonly extractor: Extractor;
  /** Identifier generator — defaults to `crypto.randomUUID`. */
  readonly nextId?: IdGenerator;
  /**
   * Session id generator — defaults to `crypto.randomUUID`. Injected so tests
   * can assert a deterministic per-call session id. One id is generated per
   * `extract_session` call and stamped on every candidate and transcript chunk.
   */
  readonly sessionId?: () => string;
}

/**
 * Execute the `extract_session` tool.
 *
 * Exported separately from the registration helper so unit and property
 * tests can call the handler directly with a stub extractor without going
 * through the MCP transport layer.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
 */
export async function extractSessionHandler(
  deps: ExtractSessionDeps,
  input: ExtractSessionInput,
): Promise<CallToolResult> {
  // 2. Transcript validation (Requirement 1.4). The input schema's
  //    `min(1)` rejects empty strings, but a whitespace-only transcript
  //    would still satisfy the schema; `isValidTranscript` covers both
  //    cases so this handler is safe even when called outside the SDK
  //    (e.g. from a property test).
  if (!isValidTranscript(input.transcript)) {
    return errorResult(
      "Transcript is required and must contain at least one non-whitespace character.",
    );
  }

  // 3. Local secret redaction (best-effort) — FIRST in the pipeline so both
  //    the Claude extraction and the stored transcript chunks operate on the
  //    sanitized text. Runs entirely in-process, no network call.
  const sanitized = sanitizeTranscript(input.transcript);

  // 4. Fact extraction (Requirement 1.1) over the sanitized transcript. The
  //    extractor either returns structured `ExtractedFacts` or throws on any
  //    failure (network, malformed JSON, empty response). We translate any
  //    throw into the extraction-failed error result mandated by Req 1.5.
  let facts: ExtractedFacts;
  try {
    facts = await deps.extractor.extractFacts(sanitized);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Requirement 1.5: extraction failure stores nothing in any namespace.
    // This tool never writes regardless, so there is nothing to roll back —
    // we simply surface the failure and leave MemWal untouched.
    return errorResult(`Extraction failed: ${reason}`);
  }

  // 5 + 6. Wrap every extracted item into a uniquely-identified, well-typed
  //        `CandidateFact`, chunk the sanitized transcript for automatic
  //        storage at commit, and return the Preview. Nothing is stored here
  //        (Requirements 1.2, 1.3).
  //
  //        Generate ONE sessionId per extract_session call and stamp it on
  //        every candidate and transcript chunk so the downstream commit can
  //        embed the per-session linkage in the stored memory.
  const sessionId = (deps.sessionId ?? defaultIdGenerator)();
  const repo = normalizeRepo(input.repo);
  const candidates = buildCandidates(facts, deps.nextId ?? defaultIdGenerator, sessionId, repo);
  const transcriptChunks = chunkTranscript(sanitized).map((chunk) => ({
    ...chunk,
    sessionId,
    ...(repo ? { repo } : {}),
  }));
  return successResult({ candidates, transcriptChunks });
}

/**
 * Register `extract_session` against the supplied MCP server.
 *
 * Called from `registerTools` in `register.ts`. Kept as its own exported
 * helper so the central registration file stays a flat list of tool wires
 * and tests can register the tool against a stub server in isolation.
 *
 * The output schema below mirrors the `Preview` data model documented in
 * `design.md`. Publishing it lets MCP clients surface structured candidate
 * data without parsing the text payload.
 */
export function registerExtractSessionTool(server: McpServer, deps: ToolDeps): void {
  // Output schema published to clients as JSON Schema. Matches the typed
  // `Preview` shape consumed by `commit_session`.
  const previewOutputShape = {
    candidates: z
      .array(
        z.object({
          id: z.string().min(1),
          type: z.enum(["session", "skill", "productivity"]),
          text: z.string(),
          evidence: z
            .string()
            .optional()
            .describe(
              "Optional transcript-grounded supporting snippet. Present for skill " +
                "candidates that have concrete grounding; surfaced at commit so the " +
                "stored skill is verifiable back to its source session.",
            ),
          sessionId: z
            .string()
            .optional()
            .describe(
              "Id of the session this candidate was extracted from. Pass it back to " +
                "commit_session so the stored memory links to its source session.",
            ),
          repo: z
            .string()
            .optional()
            .describe(
              "Normalized project/repository label this candidate belongs to, when a " +
                "repo was supplied. Pass it back to commit_session so the stored memory " +
                "is grouped under its project.",
            ),
        }),
      )
      .describe(
        "Every candidate fact derived from the transcript. Each carries a stable id, " +
          "a type that controls commit-time namespace routing, and the candidate text. " +
          "Skill candidates may also carry an evidence snippet grounding them to the " +
          "transcript. The developer reviews these before invoking commit_session.",
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
              "Id of the session this transcript chunk belongs to. Pass it back to " +
                "commit_session so the stored chunk links to its source session.",
            ),
          repo: z
            .string()
            .optional()
            .describe(
              "Normalized project/repository label this chunk belongs to, when a repo " +
                "was supplied. Pass it back to commit_session unchanged.",
            ),
        }),
      )
      .describe(
        "The sanitized transcript split into ordered chunks. Pass these back to " +
          "commit_session unchanged; they are stored automatically into the transcripts " +
          "namespace without per-chunk review.",
      ),
  } as const;

  server.registerTool(
    "extract_session",
    {
      title: "Extract session (preview)",
      description:
        "Phase 1 of two-phase session capture. Pass the FULL, raw session " +
        "transcript (the complete verbatim dialogue, NOT a summary and NOT " +
        "truncated) — every derived fact and its evidence comes from it. Include the " +
        "technical substance of each turn: file paths with key code/diff snippets, " +
        "commands with their results, and errors with how they were fixed. Locally " +
        "redacts secrets from the transcript (best-effort), then extracts a candidate " +
        "session summary, candidate skill facts, and candidate productivity metrics " +
        "via the configured LLM, and chunks the sanitized transcript. Returns a " +
        "Preview (candidates + transcriptChunks) for the developer to review. Stores " +
        "nothing in MemWal — no relayer health check is performed. Approved candidates " +
        "and the transcript chunks are passed to `commit_session` to store them. " +
        "Optionally pass `repo` (a workspace/project label) to group every stored " +
        "memory from this session under one project.",
      inputSchema: EXTRACT_SESSION_INPUT_SHAPE,
      outputSchema: previewOutputShape,
    },
    async (args) =>
      extractSessionHandler({ extractor: deps.extractor }, args as ExtractSessionInput),
  );
}
