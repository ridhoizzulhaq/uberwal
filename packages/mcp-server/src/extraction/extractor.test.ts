/**
 * Unit tests for the defensive extraction parser and the end-to-end
 * `extractFacts` path with a mocked chat client.
 *
 * Validates: Requirements 1.2, 1.3, 1.4
 *
 * Scope:
 *  - `parseExtractionResponse` is the standalone defensive parser exposed by
 *    `extractor.ts`. These tests cover the rules its docstring promises:
 *    fenced/prose-wrapped JSON is recovered, brace balancing tolerates `}`
 *    inside string values, and shape/format violations throw an extraction
 *    error so the MCP `extract_session` tool can surface
 *    extraction-failed to the user without storing anything (Req 1.4).
 *  - `extractFacts` is exercised through `createExtractor` with a fake chat
 *    client to confirm the full call path (system/user messages, response
 *    shape handling, defensive parsing) works end-to-end and that parse
 *    failures propagate as `Error` to the tool layer.
 */

import { describe, expect, test } from "vitest";

import {
  type ChatClient,
  createExtractor,
  parseExtractionResponse,
} from "./extractor";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake `ChatClient` whose `chat.completions.create` always
 * resolves with a single choice whose message content is `rawText`. The
 * returned object also exposes the captured `params` from the last call so
 * tests can assert that the extractor forwarded the model id and the
 * system + user messages.
 */
function makeFakeClient(rawText: string): {
  client: ChatClient;
  calls: Array<Parameters<ChatClient["chat"]["completions"]["create"]>[0]>;
} {
  const calls: Array<Parameters<ChatClient["chat"]["completions"]["create"]>[0]> = [];
  const client: ChatClient = {
    chat: {
      completions: {
        async create(params) {
          calls.push(params);
          return {
            choices: [{ message: { content: rawText } }],
          };
        },
      },
    },
  };
  return { client, calls };
}

/**
 * Canonical well-formed extraction JSON used across several tests. Keeping a
 * single fixture documents the exact shape `parseExtractionResponse` accepts.
 */
const WELL_FORMED_JSON = JSON.stringify({
  sessionSummary: "Implemented JWT auth middleware in Express and added unit tests.",
  skills: [
    { text: "TypeScript", evidence: "Typed the middleware signature with Request/Response generics." },
    { text: "Express middleware", evidence: "Registered app.use(authMiddleware) in the route chain." },
    { text: "JWT handling", evidence: "Called jwt.verify(token, secret) to validate the bearer token." },
  ],
  productivity: ["Closed 2 tasks", "Wrote 14 unit tests"],
});

// ---------------------------------------------------------------------------
// parseExtractionResponse — happy paths
// ---------------------------------------------------------------------------

describe("parseExtractionResponse: success paths", () => {
  test("well-formed JSON object returns ExtractedFacts with trimmed fields", () => {
    const result = parseExtractionResponse(WELL_FORMED_JSON);
    expect(result.sessionSummary).toBe(
      "Implemented JWT auth middleware in Express and added unit tests.",
    );
    // Skills are grounded objects: each carries `text` plus the transcript
    // `evidence` snippet that demonstrates the skill.
    expect(result.skills).toEqual([
      { text: "TypeScript", evidence: "Typed the middleware signature with Request/Response generics." },
      { text: "Express middleware", evidence: "Registered app.use(authMiddleware) in the route chain." },
      { text: "JWT handling", evidence: "Called jwt.verify(token, secret) to validate the bearer token." },
    ]);
    expect(result.productivity).toEqual(["Closed 2 tasks", "Wrote 14 unit tests"]);
  });

  test("skills accept bare strings for back-compat and parse to { text } with no evidence", () => {
    // Responses (or stored fixtures) predating the grounded schema emit a
    // plain string per skill; the parser must coerce each to `{ text }`
    // without inventing evidence.
    const legacy = JSON.stringify({
      sessionSummary: "Refactored the auth layer.",
      skills: ["TypeScript", "Express middleware"],
      productivity: ["Closed 1 task"],
    });
    const result = parseExtractionResponse(legacy);
    expect(result.skills).toEqual([{ text: "TypeScript" }, { text: "Express middleware" }]);
    // No evidence key is fabricated for the back-compat shape.
    expect(result.skills[0]?.evidence).toBeUndefined();
  });

  test("skill objects with empty/blank text are dropped; blank evidence is omitted", () => {
    const mixed = JSON.stringify({
      sessionSummary: "Mixed-quality skills.",
      skills: [
        { text: "  GraphQL  ", evidence: "  Wrote a resolver for the users query.  " },
        { text: "   ", evidence: "should be dropped because text is blank" },
        { text: "Docker", evidence: "   " },
      ],
      productivity: [],
    });
    const result = parseExtractionResponse(mixed);
    // text/evidence are trimmed; the blank-text entry is gone; the blank
    // evidence becomes an evidence-free skill.
    expect(result.skills).toEqual([
      { text: "GraphQL", evidence: "Wrote a resolver for the users query." },
      { text: "Docker" },
    ]);
  });

  test("markdown-fenced JSON (```json ... ```) is unwrapped before parsing", () => {
    // Claude often returns JSON inside a tagged code fence even when asked
    // for raw JSON; the parser must strip the fence before calling JSON.parse.
    const fenced = "```json\n" + WELL_FORMED_JSON + "\n```";
    const result = parseExtractionResponse(fenced);
    expect(result.sessionSummary).toContain("JWT auth middleware");
    expect(result.skills.map((s) => s.text)).toContain("TypeScript");
    expect(result.productivity).toHaveLength(2);
  });

  test("bare-fenced JSON (``` ... ```) is unwrapped before parsing", () => {
    // The fence regex must accept code blocks without a language tag.
    const fenced = "```\n" + WELL_FORMED_JSON + "\n```";
    const result = parseExtractionResponse(fenced);
    expect(result.sessionSummary).toContain("JWT auth middleware");
    expect(result.skills.map((s) => s.text)).toEqual([
      "TypeScript",
      "Express middleware",
      "JWT handling",
    ]);
  });

  test("prose-wrapped JSON is located via the first balanced object", () => {
    // Models occasionally emit a friendly preamble/postscript around the
    // JSON; the parser locates the first `{...}` object regardless.
    const wrapped =
      "Here's the structured extraction you asked for:\n\n" +
      WELL_FORMED_JSON +
      "\n\nHope that helps! Let me know if you want any adjustments.";
    const result = parseExtractionResponse(wrapped);
    expect(result.sessionSummary).toContain("JWT auth middleware");
    expect(result.skills).toHaveLength(3);
  });

  test("nested JSON with `}` inside string values preserves brace balance", () => {
    // The locator counts braces with string/escape awareness so a `}` inside
    // a quoted string does not prematurely close the outer object.
    const tricky = JSON.stringify({
      sessionSummary: "Refactored handler to swap `if (x) { ... }` with early returns }}}",
      skills: [
        {
          text: 'Wrote regex `^\\{\\s*"id"\\s*:\\s*\\d+\\s*\\}$`',
          evidence: 'Matched JSON objects shaped like { "id": 7 }',
        },
        { text: "Cleaned up nested blocks" },
      ],
      productivity: ["Removed 3 nested blocks like } else { ... }"],
    });
    // Add prose around the object so the locator must skip it.
    const proseWrapped = "Result follows: " + tricky + " — done.";
    const result = parseExtractionResponse(proseWrapped);
    // The summary's trailing `}}}` would close the outer object early if the
    // locator weren't string-aware; surviving them confirms brace balance.
    expect(result.sessionSummary).toContain("}}}");
    expect(result.sessionSummary).toContain("{ ... }");
    expect(result.skills).toHaveLength(2);
    // Escaped quotes inside the regex string survive JSON parsing.
    expect(result.skills[0]?.text).toContain('"id"');
    // Evidence travels with the grounded skill through the brace-aware locator.
    expect(result.skills[0]?.evidence).toContain('{ "id": 7 }');
    // A `}` inside the productivity entry's string did not split the object.
    expect(result.productivity[0]).toContain("} else {");
  });
});

// ---------------------------------------------------------------------------
// parseExtractionResponse — failure paths
// ---------------------------------------------------------------------------

describe("parseExtractionResponse: failure paths", () => {
  test("malformed JSON throws an extraction error", () => {
    // Claude returned what looks like a JSON object but the contents do not
    // parse (trailing comma is not legal JSON). The MCP tool layer will
    // catch this Error and surface extraction-failed (Req 1.4).
    const malformed =
      '{ "sessionSummary": "ok", "skills": ["a",], "productivity": [] }';
    expect(() => parseExtractionResponse(malformed)).toThrow(/not valid JSON/i);
  });

  test("empty string throws an extraction error", () => {
    expect(() => parseExtractionResponse("")).toThrow(/empty/i);
  });

  test("whitespace-only string throws an extraction error", () => {
    // Equivalent to the empty-string case: the early guard rejects both
    // because `String.prototype.trim` collapses them to "".
    expect(() => parseExtractionResponse("   \n\t  ")).toThrow(/empty/i);
  });

  test("response with no JSON object at all throws", () => {
    expect(() => parseExtractionResponse("absolutely no JSON here, just prose")).toThrow(
      /did not contain a JSON object/i,
    );
  });

  test("missing sessionSummary throws", () => {
    const missingSummary = JSON.stringify({
      skills: ["TypeScript"],
      productivity: ["Closed 1 task"],
    });
    expect(() => parseExtractionResponse(missingSummary)).toThrow(/sessionSummary/);
  });

  test("blank sessionSummary throws", () => {
    // `coerceStringArray`-style permissiveness applies to the array members,
    // not to the summary itself: the summary must be a non-empty string.
    const blankSummary = JSON.stringify({
      sessionSummary: "   ",
      skills: ["TypeScript"],
      productivity: [],
    });
    expect(() => parseExtractionResponse(blankSummary)).toThrow(/sessionSummary/);
  });

  test("missing skills array throws", () => {
    const missingSkills = JSON.stringify({
      sessionSummary: "summary",
      productivity: ["Closed 1 task"],
    });
    expect(() => parseExtractionResponse(missingSkills)).toThrow(/skills/);
  });

  test("missing productivity array throws", () => {
    const missingProductivity = JSON.stringify({
      sessionSummary: "summary",
      skills: ["TypeScript"],
    });
    expect(() => parseExtractionResponse(missingProductivity)).toThrow(/productivity/);
  });

  test("top-level value that is a JSON array (not an object) throws", () => {
    // `findFirstJsonObject` looks for `{`, so a bare array short-circuits
    // before reaching the shape check; this still surfaces as an
    // extraction error rather than a silent success.
    expect(() => parseExtractionResponse('["not", "an", "object"]')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractFacts — end-to-end with mocked chat client
// ---------------------------------------------------------------------------

describe("ClaudeExtractor.extractFacts (mocked chat client)", () => {
  test("forwards the transcript to the model and returns parsed ExtractedFacts on a well-formed response", async () => {
    const { client, calls } = makeFakeClient(WELL_FORMED_JSON);
    const extractor = createExtractor({ client, model: "openai.gpt-oss-120b" });

    const transcript = "User: add JWT auth\nAssistant: implemented middleware...";
    const facts = await extractor.extractFacts(transcript);

    // Result is the parsed JSON object.
    expect(facts.sessionSummary).toContain("JWT auth middleware");
    expect(facts.skills).toEqual([
      { text: "TypeScript", evidence: "Typed the middleware signature with Request/Response generics." },
      { text: "Express middleware", evidence: "Registered app.use(authMiddleware) in the route chain." },
      { text: "JWT handling", evidence: "Called jwt.verify(token, secret) to validate the bearer token." },
    ]);
    expect(facts.productivity).toEqual(["Closed 2 tasks", "Wrote 14 unit tests"]);

    // The extractor used the configured model and embedded the transcript
    // in the user message so the model has the content it needs to extract.
    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first?.model).toBe("openai.gpt-oss-120b");
    expect(first?.messages).toHaveLength(2);
    expect(first?.messages[0]?.role).toBe("system");
    expect(typeof first?.messages[0]?.content).toBe("string");
    expect(first?.messages[1]?.role).toBe("user");
    expect(first?.messages[1]?.content).toContain(transcript);
  });

  test("recovers a fenced/prose-wrapped Claude response via the defensive parser", async () => {
    // Even when Claude wraps the JSON with a code fence and surrounding prose
    // the extractor must still produce ExtractedFacts (the same defensive
    // rules verified by the parser-only tests above).
    const wrapped =
      "Sure! Here is the extraction:\n```json\n" + WELL_FORMED_JSON + "\n```\nLet me know!";
    const { client } = makeFakeClient(wrapped);
    const extractor = createExtractor({ client });

    const facts = await extractor.extractFacts("transcript text");
    expect(facts.sessionSummary).toContain("JWT auth middleware");
    expect(facts.skills.length).toBeGreaterThan(0);
  });

  test("propagates parse failure as a thrown Error so the tool layer can surface extraction-failed", async () => {
    // Claude returned non-JSON; the extractor must reject it. The MCP tool
    // catches this and returns the Req 1.4 / 1.5 user-facing error without
    // touching MemWal — these tests assert only the propagation shape.
    const { client } = makeFakeClient("absolutely no JSON here, just prose");
    const extractor = createExtractor({ client });

    await expect(extractor.extractFacts("transcript")).rejects.toThrow(
      /did not contain a JSON object/i,
    );
  });

  test("propagates an empty model response as an extraction error", async () => {
    // The runMessages helper rejects an empty message content before the
    // parser runs.
    const client: ChatClient = {
      chat: {
        completions: {
          // Returns a choice with empty content.
          async create() {
            return { choices: [{ message: { content: "" } }] };
          },
        },
      },
    };
    const extractor = createExtractor({ client });

    await expect(extractor.extractFacts("transcript")).rejects.toThrow(/empty/i);
  });
});
