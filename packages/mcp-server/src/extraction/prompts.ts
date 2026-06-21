/**
 * Prompt templates for the Claude-backed extraction service.
 *
 * Two prompt families live here:
 *
 *   1. Extraction (used by `extract_session`): drives Claude to derive a
 *      candidate session summary, a list of discrete skill facts, and a list
 *      of discrete productivity metrics from a raw session transcript. The
 *      response is expected as a single JSON object so the extractor can
 *      parse it defensively (see `extractor.ts`).
 *   2. Summarization (used by `generate_report`): drives Claude to aggregate
 *      a batch of recalled skill facts and productivity metrics into a prose
 *      report covering skill highlights and productivity patterns.
 *
 * Both system prompts emphasize that Uberwal only stores items the
 * developer later approves, so it is safer to under-extract (omit weak
 * signals) than to over-extract (invent facts).
 *
 * The user-prompt builders are pure string functions so they can be tested
 * deterministically and so the extractor stays free of template logic.
 *
 * Validates: Requirements 1.2, 1.3, 5.2
 */

/**
 * The default chat model used for both extraction and summarization.
 *
 * This is an OpenAI-compatible model id. It can be overridden via the
 * `OPENAI_MODEL` environment variable (surfaced through the MCP server
 * config) or the `model` option of `createExtractor`.
 */
export const EXTRACTION_MODEL = "openai.gpt-oss-120b";

/**
 * System prompt for the extraction call.
 *
 * Asks Claude to act as a coding-session analyst and to emit a single JSON
 * object with three fields. The phrasing makes the JSON-only constraint
 * explicit because, while we parse defensively, terse output reduces the
 * chance of malformed responses and saves tokens.
 */
export const EXTRACTION_SYSTEM_PROMPT = [
  "You are an analyst who reviews coding-session transcripts between a developer",
  "and an AI coding assistant. Your job is to extract three things from the",
  "transcript:",
  "",
  '  1. "sessionSummary" — a concise 1-3 sentence overview of what the developer',
  "     worked on during the session. Plain prose, no bullet points.",
  '  2. "skills" — an array of discrete, atomic skill or technology facts the',
  "     transcript demonstrates the developer using or learning. Each entry is",
  '     an OBJECT of the form {"text": string, "evidence": string} where:',
  '       - "text" is one self-contained skill sentence (e.g. "Implemented JWT',
  '         auth middleware in Express (TypeScript)").',
  '       - "evidence" is a brief (one short sentence or quote) grounding drawn',
  "         FROM THE TRANSCRIPT that demonstrates the skill, so the stored fact",
  "         can be verified back to its source. Quote or tightly paraphrase the",
  "         transcript; never invent evidence. If the transcript offers no",
  '         concrete grounding for the skill, use an empty string ("").',
  "     Prefer concrete, verifiable facts; omit vague impressions.",
  '  3. "productivity" — an array of discrete, atomic productivity metrics or',
  "     output observations grounded in the transcript (e.g. \"Closed 3 PRs and",
  '     resolved 5 review comments in one session"). Prefer measurable',
  "     observations; omit speculation.",
  "",
  "Hard requirements:",
  "  - Respond with a SINGLE JSON object and nothing else. No markdown fences,",
  "    no commentary, no leading or trailing prose.",
  "  - All three top-level fields must be present. Use an empty array when no",
  "    items of that kind appear in the transcript; never invent items.",
  '  - Every "productivity" entry must be a non-empty string. Every "skills"',
  '    entry must be an object with a non-empty "text"; its "evidence" must',
  "    come from the transcript (use an empty string when none applies).",
  "",
  'Schema: {"sessionSummary": string, "skills": {"text": string, "evidence": string}[], "productivity": string[]}',
].join("\n");

/**
 * Build the extraction user-message body wrapping the developer's transcript.
 *
 * The transcript is delimited so a model that drifts toward chatty output is
 * still anchored to the JSON contract from the system prompt. We pass the
 * transcript verbatim — empty/whitespace transcripts are rejected upstream
 * by `isValidTranscript` and never reach this builder.
 */
export function buildExtractionUserPrompt(transcript: string): string {
  return [
    "Extract the session summary, skill facts, and productivity metrics from",
    "the following coding-session transcript. Respond with the JSON object",
    "described in the system prompt.",
    "",
    "<transcript>",
    transcript,
    "</transcript>",
  ].join("\n");
}

/**
 * System prompt for the report-summarization call.
 *
 * Asks Claude to weave previously stored skill facts and productivity metrics
 * into a readable report. Unlike extraction, the response is free-form prose
 * because the dashboard renders it with paragraph formatting.
 */
export const SUMMARIZATION_SYSTEM_PROMPT = [
  "You are an analyst who writes short professional reports from a developer's",
  "stored skill facts and productivity metrics. Each input bullet is a discrete",
  "fact previously approved by the developer; treat the bullets as ground truth.",
  "",
  "Write a concise report (300-500 words) with two clearly delineated sections:",
  '  - "Skill portfolio highlights" — group the skill facts into themes',
  "    (languages, frameworks, infrastructure, etc.) and call out notable",
  "    strengths.",
  '  - "Productivity patterns" — surface trends and notable metrics from the',
  "    productivity facts, including any quantitative claims.",
  "",
  "Style: plain prose with paragraph breaks between sections. Do not invent",
  "facts beyond what the bullets state, and do not include any JSON, markdown",
  "fences, or section markers other than the two short headings.",
].join("\n");

/**
 * Build the summarization user-message body listing the recalled facts.
 *
 * Bullets each list with a leading `- ` so the model has unambiguous structure
 * to draw from. Empty lists are rendered as a placeholder line so the model
 * still produces a valid two-section report; the calling tool is responsible
 * for the not-enough-data gating (Requirement 5.5) before reaching this point.
 */
export function buildSummarizationUserPrompt(
  skills: readonly string[],
  productivity: readonly string[],
): string {
  const skillsBlock =
    skills.length === 0 ? "(no skill facts available)" : skills.map((s) => `- ${s}`).join("\n");
  const productivityBlock =
    productivity.length === 0
      ? "(no productivity facts available)"
      : productivity.map((p) => `- ${p}`).join("\n");

  return [
    "Write the report described in the system prompt using the following facts.",
    "",
    "Skill facts:",
    skillsBlock,
    "",
    "Productivity facts:",
    productivityBlock,
  ].join("\n");
}
