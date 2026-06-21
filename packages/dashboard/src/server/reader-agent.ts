import "server-only";

/**
 * Server-only Reader Agent: recall + reason.
 *
 * The dashboard's read-only tabs (Skills, Productivity, Sessions, Reports)
 * surface recalled memories verbatim. The Reader Agent goes one step
 * further: it lets a non-developer viewer (team lead, recruiter) *converse*
 * with their team's memory. Each turn:
 *
 *   1. **Recall** the latest user message from MemWal — the same delegated,
 *      per-request `MemWalClient` the recall server action uses, so the
 *      delegate key never leaves the server boundary. Recall is the *only*
 *      source of grounding; we never call MemWal's own `ask()` helper.
 *   2. **Reason** over the recalled context with an OpenAI-compatible chat
 *      model (the `openai` SDK's Chat Completions API) under a preset system
 *      prompt that pins the agent's persona and rules. We own the full prompt
 *      here (system message + context block + conversation) rather than
 *      delegating reasoning to MemWal, so each preset can impose its own
 *      grounding discipline (cite skill evidence, avoid vanity
 *      token-counting, never invent facts).
 *
 * Two presets ship today:
 *   - `recruiting` — reasons like a technical recruiter over the `skills`
 *     namespace, citing concrete skill evidence.
 *   - `productivity` — reasons like an engineering manager over the
 *     `productivity` and `reports` namespaces, focused on real output.
 *
 * The module returns a discriminated union so the calling server action and
 * client component branch on a single `ok` flag; it never throws.
 */

import OpenAI from "openai";

import type { Namespace } from "@uberwal/shared";

import { getMemWalClientFromSession } from "./memwal-factory.js";

/** Presets the Reader Agent supports. Each pins a persona and namespaces. */
export type ReaderPreset = "recruiting" | "productivity";

/**
 * Default chat model used for reasoning — matches the MCP server's
 * extractor. It can be overridden per call via the `OPENAI_MODEL`
 * environment variable (see {@link resolveModel}).
 */
export const READER_MODEL = "openai.gpt-oss-120b";

/** Recall tuning shared by every preset namespace lookup. */
const RECALL_LIMIT = 10;
/**
 * Higher per-namespace recall cap used in session-scoped mode. Because results
 * are filtered down to the selected sessions afterwards, we pull a wider set
 * first so a selected session's memories aren't crowded out by other sessions
 * before the filter runs.
 */
const SCOPED_RECALL_LIMIT = 50;
/**
 * Namespaces read when the assistant is scoped to selected sessions. Unlike the
 * preset namespaces (which tailor an unscoped persona), a session-scoped read
 * pulls the full per-session content so the persona reasons over everything in
 * the chosen session(s). `reports` is excluded (aggregated, not per-session).
 */
const SESSION_SCOPE_NAMESPACES: readonly Namespace[] = [
  "sessions",
  "skills",
  "productivity",
  "transcripts",
];
/**
 * Default recall distance threshold for the Reader Agent.
 *
 * Matches the dashboard's recall default of **1.0** ("no upper-distance
 * filtering") so a reader — including a share-link recipient — reasons over all
 * available memories rather than having a relevance threshold drop rows.
 * `MemWalClient.recall` clamps to [0, 1].
 */
const RECALL_MAX_DISTANCE = 1.0;

/**
 * Per-preset system prompts.
 *
 * Each prompt pins the agent's persona and — critically — its grounding
 * discipline. The recalled context is appended as a separate block at call
 * time (see {@link buildSystemPrompt}); these strings describe *how* the
 * agent must reason over that block.
 */
export const PRESET_SYSTEM_PROMPTS: Record<ReaderPreset, string> = {
  recruiting: [
    "You are a technical recruiter assistant reasoning about a developer's",
    "skills for a specific role. Focus on concrete evidence of skill and",
    "fit. Ground every assessment in the recalled skill facts provided in",
    'the "Context memories" block, and cite the supporting facts you rely',
    'on — including any "Evidence:" lines attached to a skill. Never invent',
    "skills, technologies, or experience that do not appear in the recalled",
    "context. If the context does not support a claim, say so plainly rather",
    "than guessing. Be concise and specific.",
  ].join(" "),
  productivity: [
    "You are an engineering manager assistant reasoning about a developer's",
    "output and work patterns. Focus on what was actually shipped, the kind",
    "of work done, and the context around it. Do NOT reduce productivity to",
    "vanity token-counting or raw activity volume. Ground every claim in the",
    'recalled facts provided in the "Context memories" block; if the context',
    "does not support a claim, say so rather than speculating. Be concise and",
    "specific.",
  ].join(" "),
};

/**
 * Namespaces each preset recalls from.
 *
 * Recruiting reads only `skills`; productivity reads both `productivity` and
 * `reports` so the manager view sees discrete metrics and the prose reports
 * that summarize them.
 */
export const PRESET_NAMESPACES: Record<ReaderPreset, readonly Namespace[]> = {
  recruiting: ["skills"],
  productivity: ["productivity", "reports"],
};

/**
 * Neutral system prompt used when the assistant is SCOPED to selected sessions
 * (the owner reviewing their own work). Unlike the recruiting/productivity
 * personas, it does not role-play an evaluator and never frames the developer
 * as a job candidate — it just answers questions grounded in the selected
 * session(s)' memories.
 */
export const NEUTRAL_READER_PROMPT = [
  "You are an assistant helping a developer review their own captured work.",
  "Answer the user's question grounded STRICTLY in the recalled memories in the",
  '"Context memories" block — these come from the session(s) the developer',
  "selected. Never invent facts, skills, or outcomes that are not in the",
  "context; if the context does not support an answer, say so plainly. Be",
  "concise, specific, and neutral — do NOT frame the developer as a job",
  "candidate or assess them for a role. Cite the memories you rely on.",
].join(" ");

/** One conversation turn shared between the client, action, and this module. */
export interface ReaderMessage {
  role: "user" | "assistant";
  content: string;
}

/** A recalled memory the reasoning turn was grounded in. */
export interface UsedMemory {
  text: string;
  distance: number;
}

/** Input accepted by {@link runReader}. */
export interface RunReaderInput {
  preset: ReaderPreset;
  messages: ReaderMessage[];
  /**
   * When present and non-empty, the assistant is SCOPED to these sessions: it
   * recalls across the per-session namespaces and keeps only memories whose
   * `sessionId` is in this set, so it reasons strictly over the selected
   * session(s). When omitted, the assistant reads the preset's namespaces
   * across all of the viewer's memories (the original behavior).
   */
  sessionIds?: string[];
  /**
   * Optional project/repository filter. When set, the SCOPED recall keeps only
   * memories whose `repo` matches, so the assistant reasons over one project.
   * Combined with `sessionIds` it narrows further (an entry must match both);
   * supplied alone it triggers scoped mode for the whole repo.
   */
  repo?: string;
  /**
   * Optional allow-list constraining which of the per-session namespaces the
   * SCOPED recall may read. Used by the share/recipient path to keep the scoped
   * assistant inside the share's manifest (e.g. a Summary share must not read
   * `transcripts`). When omitted, the scoped read uses all
   * {@link SESSION_SCOPE_NAMESPACES} (the owner reviewing their own work).
   */
  scopeNamespaces?: Namespace[];
}

/**
 * Minimal recall surface the Reader Agent depends on.
 *
 * Both the session-based `MemWalClient` (via `getMemWalClientFromSession`) and
 * a per-request client built from explicit share credentials structurally
 * satisfy this, so {@link runReader} can accept either without importing the
 * concrete client type or coupling to how the client was constructed.
 */
export interface ReaderRecallClient {
  recall(params: {
    namespace: Namespace;
    query: string;
    limit?: number;
    maxDistance?: number;
  }): Promise<{
    results: { blob_id: string; text: string; distance: number; sessionId?: string | null; repo?: string | null }[];
    total: number;
  }>;
}

/**
 * Result of a reasoning turn.
 *
 * `{ ok: true }` carries the assistant reply plus the memories it was
 * grounded in (so the UI can show a "based on N memories" affordance).
 * `{ ok: false }` carries a flat, client-safe message — no session, missing
 * API key, or any thrown error all collapse here.
 */
export type RunReaderResult =
  | { ok: true; reply: string; usedMemories: UsedMemory[] }
  | { ok: false; message: string };

/**
 * Minimal subset of the OpenAI client the reader depends on.
 *
 * Mirrors the MCP server's `ChatClient` so tests can inject an in-memory
 * fake without pulling in the full SDK type surface.
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
 * Extract a human-readable message from a thrown value.
 *
 * Mirrors the recall action's helper so the Reader Agent surfaces useful SDK
 * and network error messages while never rendering `[object Object]`.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Reader request failed.";
}

/**
 * The latest user message is the recall query for this turn.
 *
 * The conversation may end with an assistant message (e.g. when re-running),
 * so we scan from the end for the most recent `user` turn. Returns `null`
 * when there is no user content to recall on.
 */
function latestUserQuery(messages: readonly ReaderMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message !== undefined && message.role === "user") {
      const trimmed = message.content.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/**
 * Build the full system prompt: preset persona + recalled context block.
 *
 * The context block lists each recalled memory with its distance so the
 * model can weigh relevance. When no memories were recalled we say so
 * explicitly, which (combined with the preset's "never invent" rule) steers
 * the model toward an honest "I don't have enough context" answer.
 */
function buildSystemPrompt(
  persona: string,
  memories: readonly UsedMemory[],
): string {
  if (memories.length === 0) {
    return [
      persona,
      "",
      "Context memories:",
      "(no memories were recalled for this query)",
    ].join("\n");
  }
  const lines = memories.map(
    (memory, index) =>
      `${index + 1}. [distance ${memory.distance.toFixed(3)}] ${memory.text}`,
  );
  return [persona, "", "Context memories:", ...lines].join("\n");
}

/**
 * Resolve the chat model id for this turn.
 *
 * Reads `OPENAI_MODEL` from the server environment, falling back to
 * {@link READER_MODEL}. Read at call time so deployments can switch models
 * without a rebuild.
 */
function resolveModel(): string {
  const override = process.env["OPENAI_MODEL"];
  return typeof override === "string" && override.length > 0 ? override : READER_MODEL;
}

/**
 * Build the OpenAI client for this turn.
 *
 * Constructs an `OpenAI` client from `OPENAI_API_KEY` (and the optional
 * `OPENAI_BASE_URL` for OpenAI-compatible endpoints). Construction throws
 * synchronously when the key is missing; that error is caught by
 * {@link runReader} and collapsed into the `{ ok: false, message }` union, so
 * a misconfigured deployment surfaces a clean error rather than a crash.
 */
function resolveClient(): ChatClient {
  const apiKey =
    process.env["OPENAI_API_KEY"] ?? process.env["AWS_BEARER_TOKEN_BEDROCK"];
  const baseURL = process.env["OPENAI_BASE_URL"];
  // The OpenAI client structurally satisfies the narrow surface we depend on;
  // the cast pins the wider type without leaking it.
  return new OpenAI({
    apiKey,
    ...(typeof baseURL === "string" && baseURL.length > 0 ? { baseURL } : {}),
  }) as unknown as ChatClient;
}

/**
 * Run one Reader Agent turn: recall from the preset's namespaces, then reason
 * over the merged context with Claude under the preset system prompt.
 *
 * Returns a discriminated union and never throws:
 *   - `{ ok: false, message: "Not authenticated" }` when there is no session.
 *   - `{ ok: false, message }` for an empty conversation, a recall/SDK/network
 *     failure (including OpenAI auth or endpoint errors), or any
 *     other thrown error.
 *   - `{ ok: true, reply, usedMemories }` on success.
 *
 * The recalled memories are merged across namespaces and sorted by ascending
 * distance (most relevant first) so the context block and the
 * `usedMemories` affordance present the strongest grounding first.
 *
 * The MemWal client can be supplied explicitly via the optional `client`
 * argument (used by the shared/recipient path, which has no session). When it
 * is omitted, the client is rebuilt from the session cookie via
 * {@link getMemWalClientFromSession}; a missing session then collapses to
 * `{ ok: false, message: "Not authenticated" }`.
 */
export async function runReader(
  input: RunReaderInput,
  client?: ReaderRecallClient,
): Promise<RunReaderResult> {
  try {
    const recallClient = client ?? (await getMemWalClientFromSession());
    if (recallClient === null) {
      return { ok: false, message: "Not authenticated" };
    }

    const query = latestUserQuery(input.messages);
    if (query === null) {
      return { ok: false, message: "No user message to respond to." };
    }

    const chatClient = resolveClient();

    // Recall context for this turn. Two modes:
    //   - SCOPED (sessionIds and/or repo present): recall across the
    //     per-session namespaces, then keep only memories that match the
    //     selected session set (when given) AND the repo filter (when given) —
    //     so the assistant reasons strictly over the chosen session(s)/project.
    //   - UNSCOPED (default): recall from the preset's namespaces across all
    //     of the viewer's memories (original behavior; also the share path).
    const scopedSessionIds =
      input.sessionIds !== undefined && input.sessionIds.length > 0
        ? new Set(input.sessionIds)
        : null;
    const scopeRepo =
      typeof input.repo === "string" && input.repo.length > 0 ? input.repo : null;
    const scoped = scopedSessionIds !== null || scopeRepo !== null;

    const merged: UsedMemory[] = [];
    if (scoped) {
      // Constrain the per-session namespaces to the optional allow-list so a
      // recipient's scoped read never escapes the share manifest.
      const scopeNs =
        input.scopeNamespaces !== undefined
          ? SESSION_SCOPE_NAMESPACES.filter((ns) =>
              input.scopeNamespaces!.includes(ns),
            )
          : SESSION_SCOPE_NAMESPACES;
      for (const namespace of scopeNs) {
        const recalled = await recallClient.recall({
          namespace,
          query,
          limit: SCOPED_RECALL_LIMIT,
          maxDistance: RECALL_MAX_DISTANCE,
        });
        for (const entry of recalled.results) {
          const sid = entry.sessionId ?? null;
          const entryRepo = entry.repo ?? null;
          const sessionOk =
            scopedSessionIds === null || (sid !== null && scopedSessionIds.has(sid));
          const repoOk = scopeRepo === null || entryRepo === scopeRepo;
          if (sessionOk && repoOk) {
            merged.push({ text: entry.text, distance: entry.distance });
          }
        }
      }
    } else {
      const namespaces = PRESET_NAMESPACES[input.preset];
      for (const namespace of namespaces) {
        const recalled = await recallClient.recall({
          namespace,
          query,
          limit: RECALL_LIMIT,
          maxDistance: RECALL_MAX_DISTANCE,
        });
        for (const entry of recalled.results) {
          merged.push({ text: entry.text, distance: entry.distance });
        }
      }
    }
    merged.sort((a, b) => a.distance - b.distance);

    // Scoped (owner reviewing selected sessions / a project) → neutral prompt.
    // Unscoped (recipient/share path) → the preset persona.
    const persona = scoped
      ? NEUTRAL_READER_PROMPT
      : PRESET_SYSTEM_PROMPTS[input.preset];
    const system = buildSystemPrompt(persona, merged);
    const response = await chatClient.chat.completions.create({
      model: resolveModel(),
      messages: [
        { role: "system", content: system },
        ...input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    });

    const reply = (response.choices?.[0]?.message?.content ?? "").trim();

    if (reply.length === 0) {
      return { ok: false, message: "The reader agent returned an empty reply." };
    }

    return { ok: true, reply, usedMemories: merged };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}
