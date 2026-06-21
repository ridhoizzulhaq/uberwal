/**
 * Integration tests for the two-phase session capture flow:
 * `extract_session` (preview, no storage, no health gate) and
 * `commit_session` (write path, health gated, per-candidate routing).
 *
 * These tests wire the real handlers (`extractSessionHandler` /
 * `commitSessionHandler`) against in-memory stubs of `Extractor` and
 * `MemWalClient`, so the full validation → extraction/health → routing →
 * outcome pipeline is exercised end-to-end without touching Claude or the
 * MemWal relayer. The unit-level `commit-session.partition.property.test.ts`
 * covers Property 7 in isolation; this file complements it by checking the
 * routing, preservation, and health-gate contracts that the original task
 * 8.3 was scoped against.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5 (extraction-failure
 * preservation, originally numbered 1.6), 15.1, 15.2, 15.6 (health gate,
 * originally numbered 14.4), 15.7, 15.8.
 *
 * Spec-evolution note: tasks.md 8.3 references the legacy single-tool
 * `save_session` flow. The current design replaces that with
 * `extract_session` (returns Preview, no health gate) plus
 * `commit_session` (the only writer, health gated). This test mirrors that
 * split — there is no "summary stored before extraction" step to verify
 * because extraction never writes; instead we verify that an approved
 * `session`-type candidate is routed to the `sessions` namespace with the
 * 30000ms timeout at commit time. "Extraction failure preserves session"
 * becomes "extraction failure stores nothing anywhere" since nothing is
 * stored before the developer reviews.
 */

import { describe, it, expect, vi } from "vitest";

import type { MemWalClient, Namespace, StoredRef } from "@uberwal/shared";
import { parseMemory } from "@uberwal/shared";

import type {
  Extractor,
  ExtractedFacts,
} from "../extraction/extractor.js";

import {
  extractSessionHandler,
  type ExtractSessionDeps,
} from "./extract-session.js";
import { commitSessionHandler } from "./commit-session.js";
import type {
  CommitSessionResult,
  Preview,
} from "./candidate.js";
import type { ToolDeps } from "./register.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Records of every `remember` call the stub MemWal client received, in the
 * exact order they happened. Tests inspect this array to assert correct
 * routing (per-call namespace) and per-call options (timeout for session
 * writes).
 */
interface RememberCall {
  text: string;
  namespace: Namespace;
  timeoutMs?: number;
}

/**
 * Configurable stub for the subset of {@link MemWalClient} the two tools
 * actually consume — `isHealthy`, `remember`, and (transitively, via the
 * commit-session deps) nothing else. The unused methods are intentionally
 * absent; the cast through `unknown` keeps the stub minimal without
 * leaking the wider client surface into the test.
 */
function createMemWalStub(options: {
  /** What `isHealthy` should resolve to. Defaults to `true`. */
  healthy?: boolean;
  /**
   * Optional id-based override that forces a specific `remember` call to
   * throw, simulating a per-fact storage failure for routing tests that
   * also want to exercise the partial-failure path. Defaults to no
   * failures.
   */
  failOnText?: ReadonlySet<string>;
}): {
  memwal: MemWalClient;
  isHealthy: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
  calls: RememberCall[];
} {
  const calls: RememberCall[] = [];
  const failOnText = options.failOnText ?? new Set<string>();

  const isHealthy = vi.fn(async (_timeoutMs?: number): Promise<boolean> => {
    return options.healthy ?? true;
  });

  const remember = vi.fn(
    async (
      text: string,
      namespace: Namespace,
      timeoutMs?: number,
    ): Promise<StoredRef> => {
      // Capture the call shape before any failure path so test assertions
      // can prove a write was attempted even when it ultimately threw.
      const call: RememberCall = { text, namespace };
      if (timeoutMs !== undefined) call.timeoutMs = timeoutMs;
      calls.push(call);

      if (failOnText.has(text)) {
        throw new Error(`stub failure for text="${text}"`);
      }

      return {
        id: `stored-${calls.length}`,
        blob_id: `blob-${calls.length}`,
        namespace,
      };
    },
  );

  const stub = { isHealthy, remember };

  return {
    memwal: stub as unknown as MemWalClient,
    isHealthy,
    remember,
    calls,
  };
}

/**
 * Stub for the {@link Extractor} interface. Only `extractFacts` is used by
 * `extract_session`; `summarizeReport` is included for type-completeness
 * but is never expected to be called from this flow.
 */
function createExtractorStub(behaviour:
  | { kind: "ok"; facts: ExtractedFacts }
  | { kind: "throw"; message: string }
): {
  extractor: Extractor;
  extractFacts: ReturnType<typeof vi.fn>;
} {
  const extractFacts = vi.fn(async (_transcript: string): Promise<ExtractedFacts> => {
    if (behaviour.kind === "throw") {
      throw new Error(behaviour.message);
    }
    return behaviour.facts;
  });

  const summarizeReport = vi.fn(async (): Promise<string> => {
    throw new Error("summarizeReport must not be called by the capture flow.");
  });

  return {
    extractor: { extractFacts, summarizeReport } as Extractor,
    extractFacts,
  };
}

/**
 * Build a `ToolDeps` value populating only the fields `commit_session`
 * actually reads. `extractor` and `config` are never touched by
 * `commitSessionHandler`, so leaving them as opaque casts keeps this test
 * decoupled from those module shapes.
 */
function makeCommitDeps(memwal: MemWalClient): ToolDeps {
  return {
    memwal,
    extractor: undefined as unknown as ToolDeps["extractor"],
    config: undefined as unknown as ToolDeps["config"],
  };
}

/**
 * Build the narrow `ExtractSessionDeps` the extract handler accepts. The
 * deterministic id generator makes Preview ids predictable so the tests
 * can assert exact routing later without re-deriving ids from the handler
 * output.
 */
function makeExtractDeps(extractor: Extractor): ExtractSessionDeps {
  let counter = 0;
  return { extractor, nextId: () => `cand-${counter++}`, sessionId: () => "sess-fixed" };
}

/**
 * Pull the structured payload off a successful tool response, falling back
 * to parsing the text content if `structuredContent` is omitted. Both
 * handlers populate `structuredContent`, so the fallback is purely
 * defensive — it ensures a refactor that drops the structured field would
 * fail loudly here rather than silently masking the test.
 */
function readStructured<T>(structured: unknown, text: string | undefined): T {
  if (structured && typeof structured === "object") return structured as T;
  if (typeof text === "string") return JSON.parse(text) as T;
  throw new Error("tool response missing both structuredContent and text payload.");
}

// ---------------------------------------------------------------------------
// extract_session tests
// ---------------------------------------------------------------------------

describe("extract_session integration", () => {
  it("happy path: returns a Preview with one session + n skill + m productivity candidates and unique ids", async () => {
    // Validates: Requirements 1.1, 1.2, 1.3
    const facts: ExtractedFacts = {
      sessionSummary: "Built JWT auth middleware in Express and added unit tests.",
      skills: [
        { text: "TypeScript", evidence: "Typed the middleware with Request/Response generics." },
        { text: "Express middleware", evidence: "Registered app.use(authMiddleware)." },
        { text: "JWT handling", evidence: "Called jwt.verify(token, secret)." },
      ],
      productivity: ["Closed 2 tasks", "Wrote 14 unit tests"],
    };
    const { extractor, extractFacts } = createExtractorStub({ kind: "ok", facts });

    const response = await extractSessionHandler(
      makeExtractDeps(extractor),
      { transcript: "user: implemented auth\nassistant: ..." },
    );

    expect(response.isError).not.toBe(true);
    expect(extractFacts).toHaveBeenCalledTimes(1);

    const firstContent = response.content?.[0];
    const text = firstContent && firstContent.type === "text" ? firstContent.text : undefined;
    const preview = readStructured<Preview>(response.structuredContent, text);

    // 1 session + 3 skills + 2 productivity = 6 candidates.
    expect(preview.candidates).toHaveLength(1 + facts.skills.length + facts.productivity.length);

    // First candidate is the session summary (Requirement 1.2 type label).
    // Every candidate now also carries the per-call sessionId stamp.
    expect(preview.candidates[0]).toEqual({
      id: expect.any(String),
      type: "session",
      text: facts.sessionSummary,
      sessionId: "sess-fixed",
    });

    // Every candidate is stamped with the same per-call sessionId.
    expect(preview.candidates.every((c) => c.sessionId === "sess-fixed")).toBe(true);
    // Transcript chunks carry the same sessionId too.
    expect(preview.transcriptChunks.every((c) => c.sessionId === "sess-fixed")).toBe(true);

    // Remaining candidates partition into skill / productivity in extractor order.
    const skillCandidates = preview.candidates.filter((c) => c.type === "skill");
    const productivityCandidates = preview.candidates.filter((c) => c.type === "productivity");
    expect(skillCandidates.map((c) => c.text)).toEqual(facts.skills.map((s) => s.text));
    expect(productivityCandidates.map((c) => c.text)).toEqual(facts.productivity);

    // Grounding: every skill candidate carries the transcript-evidence snippet
    // from the extractor so it survives to commit and stays verifiable.
    expect(skillCandidates.map((c) => c.evidence)).toEqual(facts.skills.map((s) => s.evidence));
    expect(skillCandidates.every((c) => typeof c.evidence === "string" && c.evidence.length > 0)).toBe(
      true,
    );
    // Session/productivity candidates are not grounded — no evidence attached.
    expect(preview.candidates.find((c) => c.type === "session")?.evidence).toBeUndefined();
    for (const c of productivityCandidates) {
      expect(c.evidence).toBeUndefined();
    }

    // Every candidate has a non-empty id and ids are unique within the Preview.
    const ids = preview.candidates.map((c) => c.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    // Every candidate carries a valid type (Requirement 1.2).
    for (const c of preview.candidates) {
      expect(["session", "skill", "productivity"]).toContain(c.type);
    }
  });

  it("extraction failure: returns isError result and stores nothing (no health-check, no remember)", async () => {
    // Validates: Requirements 1.5 (preservation/no-storage on extraction
    // failure; originally numbered 1.6 in the legacy save_session flow).
    const { extractor, extractFacts } = createExtractorStub({
      kind: "throw",
      message: "claude API timed out",
    });
    // The MemWal stub should never be touched on this path. We still build
    // it so we can assert that fact concretely.
    const memStub = createMemWalStub({});

    const response = await extractSessionHandler(
      // Note: `extract_session` does not depend on the MemWal client, so
      // wiring `memStub.memwal` into commit deps is not relevant here.
      // The interesting assertion is that no health/remember calls occur.
      makeExtractDeps(extractor),
      { transcript: "non-trivial transcript" },
    );

    expect(response.isError).toBe(true);
    expect(extractFacts).toHaveBeenCalledTimes(1);

    const firstContent = response.content?.[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent && "text" in firstContent ? firstContent.text : "").toMatch(
      /Extraction failed/i,
    );

    // No write attempted, no health check (extract_session has no health gate).
    expect(memStub.isHealthy).not.toHaveBeenCalled();
    expect(memStub.remember).not.toHaveBeenCalled();
    expect(memStub.calls).toHaveLength(0);
  });

  it.each([
    ["empty string", ""],
    ["spaces only", "   "],
    ["tabs and newlines", "\t\n  \t"],
  ])("validation: rejects whitespace-only transcript (%s) without invoking the extractor", async (
    _label,
    transcript,
  ) => {
    // Validates: Requirement 1.4
    const { extractor, extractFacts } = createExtractorStub({
      kind: "ok",
      facts: { sessionSummary: "n/a", skills: [], productivity: [] },
    });
    const memStub = createMemWalStub({});

    const response = await extractSessionHandler(
      makeExtractDeps(extractor),
      { transcript },
    );

    expect(response.isError).toBe(true);
    expect(extractFacts).not.toHaveBeenCalled();
    expect(memStub.isHealthy).not.toHaveBeenCalled();
    expect(memStub.remember).not.toHaveBeenCalled();

    const firstContent = response.content?.[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent && "text" in firstContent ? firstContent.text : "").toMatch(
      /transcript/i,
    );
  });
});

// ---------------------------------------------------------------------------
// commit_session tests
// ---------------------------------------------------------------------------

describe("commit_session integration", () => {
  it("routes each approved candidate to the namespace matching its type with a 30000ms timeout for session writes", async () => {
    // Validates: Requirements 15.1, 15.2, 15.4
    const memStub = createMemWalStub({ healthy: true });

    const approved = [
      { id: "s1", type: "session", text: "Session summary text." },
      { id: "k1", type: "skill", text: "TypeScript" },
      { id: "k2", type: "skill", text: "JWT handling" },
      { id: "p1", type: "productivity", text: "Closed 2 tasks" },
    ];

    const response = await commitSessionHandler(makeCommitDeps(memStub.memwal), {
      approved,
    });

    expect(response.isError).not.toBe(true);
    expect(memStub.isHealthy).toHaveBeenCalledTimes(1);
    // Per-tool health gate uses a 5s timeout per the wrapper contract.
    expect(memStub.isHealthy).toHaveBeenCalledWith(5_000);

    // Every approved candidate triggers exactly one `remember` call, in
    // input order.
    expect(memStub.calls).toHaveLength(approved.length);

    // Routing: each candidate's text was sent to the correct namespace.
    const expectedRouting: Array<{ text: string; namespace: Namespace; timeoutMs?: number }> = [
      { text: "Session summary text.", namespace: "sessions", timeoutMs: 30_000 },
      { text: "TypeScript", namespace: "skills" },
      { text: "JWT handling", namespace: "skills" },
      { text: "Closed 2 tasks", namespace: "productivity" },
    ];
    for (let i = 0; i < expectedRouting.length; i++) {
      const expected = expectedRouting[i]!;
      const actual = memStub.calls[i]!;
      expect(actual.text).toBe(expected.text);
      expect(actual.namespace).toBe(expected.namespace);
      // Session writes carry a 30000ms timeout; non-session writes omit it
      // so the SDK applies its own default. The stub records `timeoutMs`
      // only when the handler passed one, so a missing key on the actual
      // call is the correct contract for skill/productivity writes.
      if (expected.timeoutMs === undefined) {
        expect(actual.timeoutMs).toBeUndefined();
      } else {
        expect(actual.timeoutMs).toBe(expected.timeoutMs);
      }
    }

    // Per-candidate outcomes are reported back to the caller in input order.
    const firstContent = response.content?.[0];
    const text = firstContent && firstContent.type === "text" ? firstContent.text : undefined;
    const result = readStructured<CommitSessionResult>(response.structuredContent, text);

    expect(result.outcomes).toHaveLength(approved.length);
    expect(result.outcomes.map((o) => o.id)).toEqual(approved.map((c) => c.id));
    expect(result.outcomes.map((o) => o.namespace)).toEqual([
      "sessions",
      "skills",
      "skills",
      "productivity",
    ]);
    expect(result.outcomes.every((o) => o.ok)).toBe(true);
    expect(result.succeeded).toBe(approved.length);
    expect(result.failed).toBe(0);
  });

  it("grounds skill writes: appends the evidence snippet to the stored skill text, leaving session/productivity verbatim", async () => {
    // Validates: Grounding Skill Facts — a skill candidate's evidence is
    // surfaced at commit so the stored memory is verifiable back to its
    // source session.
    const memStub = createMemWalStub({ healthy: true });

    const approved = [
      { id: "s1", type: "session", text: "Session summary text." },
      {
        id: "k1",
        type: "skill",
        text: "JWT handling",
        evidence: "Called jwt.verify(token, secret) to validate the bearer token.",
      },
      // A skill with no evidence is stored verbatim (no trailing Evidence line).
      { id: "k2", type: "skill", text: "TypeScript" },
      { id: "p1", type: "productivity", text: "Closed 2 tasks" },
    ];

    const response = await commitSessionHandler(makeCommitDeps(memStub.memwal), {
      approved,
    });

    expect(response.isError).not.toBe(true);
    expect(memStub.calls).toHaveLength(approved.length);

    const byNamespaceText = memStub.calls.map((c) => ({ text: c.text, namespace: c.namespace }));

    // The grounded skill is stored as `${text}\n\nEvidence: ${evidence}`.
    expect(byNamespaceText[1]).toEqual({
      text: "JWT handling\n\nEvidence: Called jwt.verify(token, secret) to validate the bearer token.",
      namespace: "skills",
    });
    // A skill without evidence is stored unchanged.
    expect(byNamespaceText[2]).toEqual({ text: "TypeScript", namespace: "skills" });
    // Session and productivity writes never get an Evidence line.
    expect(byNamespaceText[0]).toEqual({ text: "Session summary text.", namespace: "sessions" });
    expect(byNamespaceText[3]).toEqual({ text: "Closed 2 tasks", namespace: "productivity" });
    expect(memStub.calls[0]?.text).not.toContain("Evidence:");
    expect(memStub.calls[3]?.text).not.toContain("Evidence:");

    // Outcomes still report per-candidate success in input order.
    const firstContent = response.content?.[0];
    const text = firstContent && firstContent.type === "text" ? firstContent.text : undefined;
    const result = readStructured<CommitSessionResult>(response.structuredContent, text);
    expect(result.succeeded).toBe(approved.length);
    expect(result.failed).toBe(0);
  });

  it("round-trips a sessionId from extract through commit: stored text parses back to the source session", async () => {
    // End-to-end per-session linkage: extract_session stamps one sessionId on
    // every candidate + chunk; commit_session embeds it as a metadata header
    // in the stored text; parseMemory recovers it (with the body stripped).
    const facts: ExtractedFacts = {
      sessionSummary: "Built JWT auth middleware.",
      skills: [{ text: "JWT handling", evidence: "Called jwt.verify(token, secret)." }],
      productivity: ["Closed 2 tasks"],
    };
    const { extractor } = createExtractorStub({ kind: "ok", facts });

    const extractResponse = await extractSessionHandler(makeExtractDeps(extractor), {
      transcript: "user: implemented auth\nassistant: shipped it",
    });
    const firstExtractContent = extractResponse.content?.[0];
    const extractText =
      firstExtractContent && firstExtractContent.type === "text"
        ? firstExtractContent.text
        : undefined;
    const preview = readStructured<Preview>(extractResponse.structuredContent, extractText);

    const memStub = createMemWalStub({ healthy: true });
    const commitResponse = await commitSessionHandler(makeCommitDeps(memStub.memwal), {
      approved: preview.candidates,
      transcriptChunks: preview.transcriptChunks,
    });

    expect(commitResponse.isError).not.toBe(true);

    // Every stored write — candidates and transcript chunks — carries a header
    // that parses back to the same sessionId stamped during extraction.
    for (const call of memStub.calls) {
      const { meta } = parseMemory(call.text);
      expect(meta).not.toBeNull();
      expect(meta?.sessionId).toBe("sess-fixed");
    }

    // The session candidate's stored body strips the header and matches the
    // original summary; the skill body retains its appended Evidence line.
    const sessionCall = memStub.calls.find((c) => c.namespace === "sessions")!;
    expect(parseMemory(sessionCall.text).body).toBe(facts.sessionSummary);
    expect(parseMemory(sessionCall.text).meta?.type).toBe("session");

    const skillCall = memStub.calls.find((c) => c.namespace === "skills")!;
    const skillParsed = parseMemory(skillCall.text);
    expect(skillParsed.meta?.type).toBe("skill");
    expect(skillParsed.body).toContain("JWT handling");
    expect(skillParsed.body).toContain("Evidence:");

    // Transcript chunks carry type "transcript" and their index in the header.
    const transcriptCall = memStub.calls.find((c) => c.namespace === "transcripts")!;
    const transcriptParsed = parseMemory(transcriptCall.text);
    expect(transcriptParsed.meta?.type).toBe("transcript");
    expect(typeof transcriptParsed.meta?.index).toBe("number");
  });

  it("blocks every write when the relayer health gate fails", async () => {
    // Validates: Requirement 15.6 (originally numbered 14.4 in tasks.md).
    const memStub = createMemWalStub({ healthy: false });

    const approved = [
      { id: "s1", type: "session", text: "Session summary text." },
      { id: "k1", type: "skill", text: "TypeScript" },
      { id: "p1", type: "productivity", text: "Closed 2 tasks" },
    ];

    const response = await commitSessionHandler(makeCommitDeps(memStub.memwal), {
      approved,
    });

    expect(response.isError).toBe(true);
    expect(memStub.isHealthy).toHaveBeenCalledTimes(1);
    // Crucially: no write was attempted on any candidate.
    expect(memStub.remember).not.toHaveBeenCalled();
    expect(memStub.calls).toHaveLength(0);

    const firstContent = response.content?.[0];
    expect(firstContent?.type).toBe("text");
    expect(firstContent && "text" in firstContent ? firstContent.text : "").toMatch(
      /relayer/i,
    );
  });

  it("validation: rejects an empty approved set without performing the health check or any storage", async () => {
    // Validates: Requirement 15.7
    const memStub = createMemWalStub({ healthy: true });

    const response = await commitSessionHandler(makeCommitDeps(memStub.memwal), {
      approved: [],
    });

    expect(response.isError).toBe(true);
    // Validation runs before the health gate per the handler's documented
    // contract, so neither the health check nor any write should fire.
    expect(memStub.isHealthy).not.toHaveBeenCalled();
    expect(memStub.remember).not.toHaveBeenCalled();
  });

  it("validation: rejects an invalid candidate type, identifies it in the error, and stores nothing", async () => {
    // Validates: Requirement 15.8
    const memStub = createMemWalStub({ healthy: true });

    const response = await commitSessionHandler(makeCommitDeps(memStub.memwal), {
      approved: [
        { id: "good-1", type: "session", text: "ok" },
        { id: "bad-1", type: "not-a-real-type", text: "should be rejected" },
        { id: "good-2", type: "skill", text: "TypeScript" },
      ],
    });

    expect(response.isError).toBe(true);
    expect(memStub.isHealthy).not.toHaveBeenCalled();
    expect(memStub.remember).not.toHaveBeenCalled();

    const firstContent = response.content?.[0];
    const errorText =
      firstContent && firstContent.type === "text" ? firstContent.text : "";
    // The error must identify the offending candidate so the developer
    // knows which one to fix without trial-and-error.
    expect(errorText).toMatch(/bad-1/);
    expect(errorText).toMatch(/not-a-real-type/);
  });
});
