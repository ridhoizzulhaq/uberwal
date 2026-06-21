/**
 * Claude-backed extraction service.
 *
 * Two responsibilities:
 *
 *   1. `extractFacts(transcript)` — Calls the configured chat model (via the
 *      OpenAI-compatible Chat Completions API) with the extraction prompts and
 *      returns a structured `ExtractedFacts` payload (a candidate session
 *      summary plus arrays of skill and productivity facts). The MCP
 *      `extract_session` tool wraps each item as a `CandidateFact` with a
 *      stable id and type before returning the Preview to the developer; this
 *      module's only job is to produce the raw extracted content.
 *
 *   2. `summarizeReport(skills, productivity)` — Calls the chat model with the
 *      summarization prompts and returns a prose report for the
 *      `generate_report` tool to store in the `reports` namespace.
 *
 * The extractor is intentionally thin: prompts live in `prompts.ts`, the
 * OpenAI client is injected so tests can mock it, and the JSON parser is
 * defensive (strips fences, locates the first JSON object, treats parse
 * failure as an extraction failure per the design's error-handling table).
 *
 * Validates: Requirements 1.2, 1.3, 5.2
 */

import OpenAI from "openai";

import {
  EXTRACTION_MODEL,
  EXTRACTION_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  buildSummarizationUserPrompt,
} from "./prompts.js";

/**
 * Structured output of `extractFacts`.
 *
 * The design splits a session into three candidate kinds (session summary,
 * skill facts, productivity metrics). Returning all three from a single
 * Claude call keeps token usage low and guarantees the summary and the facts
 * come from a single coherent reading of the transcript. The `extract_session`
 * tool consumes this object and wraps every item as a `CandidateFact`.
 */
export interface ExtractedFacts {
  /** Concise 1-3 sentence overview of the session, used as the candidate `session`-type fact. */
  sessionSummary: string;
  /**
   * Discrete skill or technology facts; each entry becomes one candidate
   * `skill`-type fact.
   *
   * Each skill is grounded: `text` is the atomic skill fact and the optional
   * `evidence` is a short supporting snippet drawn from the transcript that
   * demonstrates the skill (a brief quote or paraphrase). The evidence travels
   * with the candidate so a recruiter can verify a stored skill back to its
   * source session; it is omitted (or empty) when the transcript offers no
   * concrete grounding for the skill.
   */
  skills: { text: string; evidence?: string }[];
  /** Discrete productivity metrics; each entry becomes one candidate `productivity`-type fact. */
  productivity: string[];
}

/**
 * Pluggable extraction interface so the MCP server tool layer depends on the
 * shape, not the concrete `ClaudeExtractor` implementation. This keeps
 * `extract_session` and `generate_report` testable with a fake extractor.
 */
export interface Extractor {
  /**
   * Derive a candidate session summary, skill facts, and productivity metrics
   * from a session transcript. Throws on extraction failure (network error,
   * non-text response, malformed JSON, or shape mismatch); the calling tool
   * surfaces the failure to the user as an extraction-failed error and stores
   * nothing.
   */
  extractFacts(transcript: string): Promise<ExtractedFacts>;

  /**
   * Aggregate previously stored skill and productivity facts into a prose
   * report. Throws on summarization failure; the `generate_report` tool
   * translates that to a summarization-failure error and stores nothing.
   */
  summarizeReport(skills: readonly string[], productivity: readonly string[]): Promise<string>;
}

/**
 * Minimal subset of the OpenAI client that the extractor depends on.
 *
 * Carved out so tests can pass an in-memory fake without depending on the
 * full SDK type surface. The single method signature mirrors
 * `OpenAI.Chat.Completions.prototype.create` for the non-streaming path we
 * use.
 */
export interface ChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: { role: "system" | "user" | "assistant"; content: string }[];
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

/**
 * Options accepted by {@link createExtractor}.
 *
 * Either `apiKey` or a pre-built `client` must be supplied. `model` defaults
 * to {@link EXTRACTION_MODEL} but can be overridden. `baseURL` points the
 * OpenAI SDK at an OpenAI-compatible endpoint/gateway when set.
 */
export interface ClaudeExtractorOptions {
  /** Pre-built OpenAI-compatible client (used in tests). Wins over `apiKey` when both are provided. */
  client?: ChatClient;
  /** API key; used to construct a default `OpenAI` client when `client` is omitted. */
  apiKey?: string;
  /** Optional base URL for an OpenAI-compatible endpoint. */
  baseURL?: string;
  /** Override the chat model id; defaults to {@link EXTRACTION_MODEL}. */
  model?: string;
}

/**
 * Concrete `Extractor` backed by the OpenAI Chat Completions API.
 *
 * Holds an injected client and the model id; both calls share the same
 * `runMessages` helper which sends a system + user message pair and returns
 * the assistant's text. JSON parsing is delegated to
 * {@link parseExtractionResponse} so the parsing rules stay testable in
 * isolation.
 */
export class ClaudeExtractor implements Extractor {
  private readonly client: ChatClient;
  private readonly model: string;

  /**
   * Internal constructor — production code goes through {@link createExtractor}
   * so default-client construction lives in one place.
   */
  constructor(client: ChatClient, model: string) {
    this.client = client;
    this.model = model;
  }

  /**
   * Issue a chat completion (system + user) and return the assistant text.
   * A missing/empty completion is surfaced as an error so callers don't end
   * up parsing the empty string.
   */
  private async runMessages(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const text = response.choices?.[0]?.message?.content ?? "";

    if (text.length === 0) {
      throw new Error("The model returned an empty response (no message content).");
    }
    return text;
  }

  /**
   * @inheritdoc
   *
   * Calls the model with the extraction prompts and parses the response with
   * {@link parseExtractionResponse}. Both transport errors and parse failures
   * propagate as `Error`; the `extract_session` tool layer catches these and
   * returns the user-facing extraction-failed message.
   */
  async extractFacts(transcript: string): Promise<ExtractedFacts> {
    const raw = await this.runMessages(
      EXTRACTION_SYSTEM_PROMPT,
      buildExtractionUserPrompt(transcript),
    );
    return parseExtractionResponse(raw);
  }

  /**
   * @inheritdoc
   *
   * Calls the model with the summarization prompts and returns the trimmed
   * response text. Empty responses are surfaced as an error so the calling
   * tool can return a summarization-failure message.
   */
  async summarizeReport(
    skills: readonly string[],
    productivity: readonly string[],
  ): Promise<string> {
    const raw = await this.runMessages(
      SUMMARIZATION_SYSTEM_PROMPT,
      buildSummarizationUserPrompt(skills, productivity),
    );
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new Error("The model returned an empty summary.");
    }
    return trimmed;
  }
}

/**
 * Build a {@link ClaudeExtractor} from environment-friendly options.
 *
 * - When `client` is supplied it is used directly (test path).
 * - Otherwise an `OpenAI` client is constructed from `apiKey` (and an
 *   optional `baseURL` for OpenAI-compatible endpoints).
 * - One of `client` or `apiKey` must be provided; otherwise we throw early so
 *   the MCP server fails fast at startup rather than per-tool.
 */
export function createExtractor(options: ClaudeExtractorOptions): ClaudeExtractor {
  const model = options.model ?? EXTRACTION_MODEL;

  if (options.client !== undefined) {
    return new ClaudeExtractor(options.client, model);
  }
  if (options.apiKey === undefined || options.apiKey.length === 0) {
    throw new Error(
      "createExtractor requires either an explicit `client` or a non-empty `apiKey`.",
    );
  }
  // The OpenAI client structurally satisfies the narrow `ChatClient` surface
  // we depend on; the cast pins the wider SDK type without leaking it to
  // callers. `baseURL` is only passed when provided so the SDK default applies.
  const client = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
  }) as unknown as ChatClient;
  return new ClaudeExtractor(client, model);
}

// ---------------------------------------------------------------------------
// Defensive JSON parsing for extraction responses
// ---------------------------------------------------------------------------

/**
 * Strip a fenced code block wrapper if present, returning the inner body.
 *
 * Handles common shapes Claude emits even when asked for JSON only:
 *
 *   ```json\n{...}\n```
 *   ```\n{...}\n```
 *
 * When no fence is detected the input is returned unchanged. The function
 * never throws — fence detection failure simply means the next step (object
 * locator) sees the original string.
 */
function stripMarkdownFences(input: string): string {
  const trimmed = input.trim();
  // Match an opening fence (with optional language tag) and a closing fence.
  // The `[\s\S]` class lets the body span newlines without `s` flag support.
  const fence = /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(trimmed);
  if (match && typeof match[1] === "string") {
    return match[1].trim();
  }
  return trimmed;
}

/**
 * Locate the first `{ ... }` JSON object substring inside `input`.
 *
 * Uses brace-balance counting (with awareness of strings and escape
 * sequences) so embedded `}` characters inside string values do not close the
 * object prematurely. Returns `null` when no balanced object is found.
 */
function findFirstJsonObject(input: string): string | null {
  const start = input.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      // The previous character was a backslash inside a string; skip this one.
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Coerce an unknown value into a `string[]`.
 *
 * - Non-array inputs return `[]`.
 * - Non-string members are dropped.
 * - String members are trimmed; empty results after trimming are dropped.
 *
 * This is deliberately permissive: the design treats malformed JSON as an
 * extraction failure, but well-formed JSON with a few stray non-string
 * entries is salvaged so the developer still sees the valid candidates in
 * the Preview.
 */
function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Coerce an unknown value into a grounded `skills` array of
 * `{ text, evidence? }` objects.
 *
 * Defensive and back-compat-aware, mirroring the permissiveness of
 * {@link coerceStringArray}:
 *
 * - Non-array inputs return `[]`.
 * - An object member is read for its `text` and optional `evidence` string
 *   fields; both are trimmed. `evidence` is only attached when it is a
 *   non-empty string after trimming.
 * - A bare string member is treated as a skill with no grounding —
 *   `{ text }` — so responses (or stored fixtures) that predate the grounded
 *   schema still parse cleanly.
 * - Members whose `text` is empty after trimming (or whose shape yields no
 *   usable text) are dropped, so the Preview only surfaces real skill facts.
 *
 * The design treats malformed JSON as an extraction failure, but well-formed
 * JSON with a few stray/legacy entries is salvaged so the developer still
 * sees the valid candidates in the Preview.
 */
function coerceSkillArray(value: unknown): { text: string; evidence?: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { text: string; evidence?: string }[] = [];
  for (const item of value) {
    // Back-compat: a bare string becomes `{ text }` with no evidence.
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) out.push({ text: trimmed });
      continue;
    }
    // Grounded shape: `{ text, evidence? }`. Anything else (numbers, null,
    // arrays) is ignored, matching the string-array coercion's tolerance.
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const rawText = record["text"];
      if (typeof rawText !== "string") continue;
      const text = rawText.trim();
      if (text.length === 0) continue;
      const rawEvidence = record["evidence"];
      if (typeof rawEvidence === "string") {
        const evidence = rawEvidence.trim();
        if (evidence.length > 0) {
          out.push({ text, evidence });
          continue;
        }
      }
      out.push({ text });
    }
  }
  return out;
}

/**
 * Parse a raw Claude extraction response into {@link ExtractedFacts}.
 *
 * Steps:
 *   1. Strip surrounding markdown fences (`stripMarkdownFences`).
 *   2. Locate the first balanced JSON object substring (`findFirstJsonObject`).
 *   3. `JSON.parse` the substring.
 *   4. Validate the top-level shape — `sessionSummary` must be a string and
 *      `skills` / `productivity` must be arrays. Inner array members are
 *      coerced defensively: `productivity` members are trimmed strings (stray
 *      non-strings dropped), and `skills` members become grounded
 *      `{ text, evidence? }` objects (accepting either an object or a bare
 *      string for back-compat; entries with empty `text` dropped). Missing or
 *      wrong-typed top-level fields are treated as a parse failure.
 *
 * Any failure throws an `Error` whose message is suitable for the MCP tool
 * layer to wrap into the user-facing extraction-failed response.
 *
 * Exported so unit tests can exercise the parsing rules directly without
 * spinning up a Claude mock.
 *
 * Validates: Requirements 1.2, 1.3
 */
export function parseExtractionResponse(rawText: string): ExtractedFacts {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new Error("Extraction response is empty.");
  }

  const stripped = stripMarkdownFences(rawText);
  const jsonSlice = findFirstJsonObject(stripped);
  if (jsonSlice === null) {
    throw new Error("Extraction response did not contain a JSON object.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Extraction response was not valid JSON: ${reason}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Extraction response was not a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const summary = record["sessionSummary"];
  if (typeof summary !== "string" || summary.trim().length === 0) {
    throw new Error('Extraction response is missing a non-empty "sessionSummary" string.');
  }

  if (!Array.isArray(record["skills"])) {
    throw new Error('Extraction response is missing a "skills" array.');
  }
  if (!Array.isArray(record["productivity"])) {
    throw new Error('Extraction response is missing a "productivity" array.');
  }

  return {
    sessionSummary: summary.trim(),
    skills: coerceSkillArray(record["skills"]),
    productivity: coerceStringArray(record["productivity"]),
  };
}
