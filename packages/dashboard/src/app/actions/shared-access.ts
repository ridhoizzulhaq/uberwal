"use server";

/**
 * Recipient-side server actions for the server-mediated ("token") share model.
 *
 * These actions require NO session. A recipient holds only an opaque token;
 * the server resolves it to a stored share, decrypts the delegate key in
 * memory for a single request, enforces the share's manifest, and returns only
 * manifest-allowed content. The delegate key is never returned to the client
 * and never logged.
 *
 * Three entry points:
 *   - {@link getShareMeta} tells the recipient page what it may render.
 *   - {@link recallByToken} recalls one allowed namespace (with optional
 *     blob-id filtering) on the recipient's behalf.
 *   - {@link askReaderByToken} runs a Reader Agent turn constrained to the
 *     intersection of the preset's namespaces and the share's manifest.
 */

import OpenAI from "openai";

import type { Namespace } from "@uberwal/shared";
import { MemWalClient } from "@uberwal/shared";

import { getShareStore, type ShareRecord } from "../../server/share-store.js";
import { getSession } from "../../server/session.js";
import type { ShareMode } from "../../server/share-manifest.js";
import { filterByManifestScope } from "../../server/manifest-scope.js";
import {
  gatherSessionNamespace,
  queriesForNamespace,
  sortTranscriptsByIndex,
  SESSION_PASS_LIMIT,
  SESSION_PASS_MAX_DISTANCE,
  type SessionRecallFn,
} from "../../server/session-gather.js";
import {
  PRESET_NAMESPACES,
  PRESET_SYSTEM_PROMPTS,
  READER_MODEL,
  runReader,
  type ReaderMessage,
  type ReaderPreset,
  type RunReaderResult,
  type UsedMemory,
} from "../../server/reader-agent.js";
import type { RecallNamespaceResult } from "./recall.js";
import type { RecallEntry } from "@uberwal/shared";
import type { SessionSummary } from "./recall.js";

/** Default recall distance threshold — `1.0` means no upper-distance filter. */
const DEFAULT_MAX_DISTANCE = 1.0;

/** Result of {@link getShareMeta}. */
export type ShareMetaResult =
  | {
      ok: true;
      mode: ShareMode;
      namespaces: Namespace[];
      label: string | null;
      sharedBy: string;
      revoked: boolean;
      sessionScoped: boolean;
      /** Project/repository this share is scoped to, when set. */
      repo: string | null;
    }
  | { ok: false; message: string; needsLogin?: boolean; forbidden?: boolean };

/**
 * Build a per-request `MemWalClient` from a resolved share record.
 *
 * Throws when `RELAYER_URL` is missing so callers collapse it into a flat
 * `{ ok: false, message }`. The decrypted delegate key is used only to
 * construct the short-lived client and is never logged.
 */
function clientForRecord(record: ShareRecord): MemWalClient {
  const serverUrl = process.env["RELAYER_URL"];
  if (typeof serverUrl !== "string" || serverUrl.length === 0) {
    throw new Error(
      "RELAYER_URL environment variable is required to resolve shared memories.",
    );
  }
  return MemWalClient.fromCredentials({
    key: record.delegateKey,
    accountId: record.ownerAccountId,
    serverUrl,
    namespace: "default",
  });
}

/**
 * Extract a human-readable message from a thrown value. Never renders
 * `[object Object]`; never includes the delegate key.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Shared request failed.";
}

/**
 * Resolve the sender display value: the owner's linked email when present,
 * else the FULL account id (never abbreviated). A legacy `sharedBy` that was
 * stored in the abbreviated `0x…` form is treated as unusable so it is
 * replaced by the full account id.
 */
function senderDisplay(record: ShareRecord): string {
  const stored = record.sharedBy;
  if (stored !== null && stored.length > 0 && !stored.includes("…")) {
    return stored;
  }
  return record.ownerAccountId;
}

/**
 * Recipient access gate for addressed shares.
 *
 * - Link-only shares (no `recipientAccountId`) keep bearer access — anyone
 *   with the token may view (unchanged behavior).
 * - Addressed shares require the viewer to be logged in as the EXACT recipient
 *   account, turning the link into an account-gated share. A missing session
 *   reports `needsLogin`; a wrong account reports `forbidden`. In both cases no
 *   share content is revealed.
 */
async function recipientGate(
  record: ShareRecord,
): Promise<
  | { ok: true }
  | { ok: false; message: string; needsLogin?: boolean; forbidden?: boolean }
> {
  const required = record.recipientAccountId;
  if (typeof required !== "string" || required.length === 0) {
    return { ok: true };
  }
  const session = await getSession();
  if (session === null) {
    return {
      ok: false,
      message: "Please sign in as the recipient account to view this shared link.",
      needsLogin: true,
    };
  }
  if (session.accountId !== required) {
    return {
      ok: false,
      message: "This share is addressed to a different account.",
      forbidden: true,
    };
  }
  return { ok: true };
}

/**
 * Resolve a token to lightweight metadata the recipient page renders from.
 *
 * Returns `{ ok: false }` for an unknown/undecryptable token. For a known
 * token it returns the mode, the allowed namespaces, the label, who shared it,
 * whether the share has been revoked, and whether it is scoped to specific
 * sessions — never the delegate key, the blob-id list, or the actual session
 * ids.
 */
export async function getShareMeta(input: {
  token: string;
}): Promise<ShareMetaResult> {
  const record = await getShareStore().getByToken(input.token);
  if (record === null) {
    return { ok: false, message: "This share link is not valid or has expired." };
  }
  const gate = await recipientGate(record);
  if (!gate.ok) {
    return gate;
  }
  const sessionIds = record.manifest.sessionIds;
  const sharedBy = senderDisplay(record);
  return {
    ok: true,
    mode: record.manifest.mode,
    namespaces: record.manifest.namespaces,
    label: record.label,
    sharedBy,
    revoked: record.revokedAt !== null,
    sessionScoped: sessionIds !== undefined && sessionIds.length > 0,
    repo: record.manifest.repo ?? null,
  };
}

/**
 * Recall one namespace on a recipient's behalf, enforcing the manifest.
 *
 * The server, not the recipient, holds the key: this loads the share, rejects
 * unknown/revoked tokens, rejects namespaces the manifest does not allow, then
 * recalls with the decrypted key. When the manifest carries a non-empty
 * `blobIds` whitelist, results are filtered to those ids before returning.
 */
export async function recallByToken(input: {
  token: string;
  namespace: Namespace;
  query: string;
  limit?: number;
}): Promise<RecallNamespaceResult> {
  try {
    const record = await getShareStore().getByToken(input.token);
    if (record === null) {
      return { ok: false, message: "This share link is not valid or has expired." };
    }
    if (record.revokedAt !== null) {
      return { ok: false, message: "This share link has been revoked." };
    }
    const gate = await recipientGate(record);
    if (!gate.ok) {
      return { ok: false, message: gate.message };
    }
    if (!record.manifest.namespaces.includes(input.namespace)) {
      return { ok: false, message: "This namespace is not shared." };
    }

    const client = clientForRecord(record);

    const params: {
      namespace: Namespace;
      query: string;
      limit?: number;
      maxDistance: number;
    } = {
      namespace: input.namespace,
      query: input.query,
      maxDistance: DEFAULT_MAX_DISTANCE,
    };
    if (input.limit !== undefined) params.limit = input.limit;

    const result = await client.recall(params);

    // Manifest-level whitelists narrow what the recipient sees. When both a
    // blob-id whitelist and a session-id whitelist are present an entry must
    // satisfy BOTH; when only one is present that one applies; when neither is
    // present the whole (namespace-allowed) result set is shared.
    const filtered = filterByManifestScope(result.results, record.manifest);
    if (filtered !== result.results) {
      return { ok: true, results: filtered, total: filtered.length };
    }

    return { ok: true, results: result.results, total: result.total };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

/** Result of {@link listSessionsByToken}. */
export type ListSessionsByTokenResult =
  | { ok: true; sessions: SessionSummary[] }
  | { ok: false; message: string };

/**
 * List the shared sessions behind a token, for the session-centric recipient
 * view. Requires NO session — the server resolves the token and enforces the
 * manifest.
 *
 * Returns `{ ok: false }` for an unknown/revoked token. When `"sessions"` is
 * not in the manifest's namespaces, returns an empty list (the recipient view
 * falls back to per-namespace rendering). Otherwise recalls `sessions` via the
 * token's client, maps to {@link SessionSummary}, and — when the manifest
 * carries a non-empty `sessionIds` whitelist — keeps only sessions whose
 * `sessionId` is in that set.
 */
export async function listSessionsByToken(input: {
  token: string;
}): Promise<ListSessionsByTokenResult> {
  try {
    const record = await getShareStore().getByToken(input.token);
    if (record === null) {
      return { ok: false, message: "This share link is not valid or has expired." };
    }
    if (record.revokedAt !== null) {
      return { ok: false, message: "This share link has been revoked." };
    }
    const gate = await recipientGate(record);
    if (!gate.ok) {
      return { ok: false, message: gate.message };
    }
    if (!record.manifest.namespaces.includes("sessions")) {
      return { ok: true, sessions: [] };
    }

    const client = clientForRecord(record);
    const result = await client.recall({
      namespace: "sessions",
      query: "session summary",
      limit: SESSION_PASS_LIMIT,
      maxDistance: SESSION_PASS_MAX_DISTANCE,
    });

    let sessions: SessionSummary[] = result.results.map((entry) => ({
      sessionId: entry.sessionId ?? null,
      blob_id: entry.blob_id,
      text: entry.text,
      repo: entry.repo ?? null,
    }));

    const sessionIds = record.manifest.sessionIds;
    if (sessionIds !== undefined && sessionIds.length > 0) {
      const allowed = new Set(sessionIds);
      sessions = sessions.filter(
        (s) => s.sessionId !== null && allowed.has(s.sessionId),
      );
    }

    // Repo-scoped shares: keep only sessions tagged with the manifest's repo.
    const repo = record.manifest.repo;
    if (typeof repo === "string" && repo.length > 0) {
      sessions = sessions.filter((s) => s.repo === repo);
    }

    return { ok: true, sessions };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}

/** Result of {@link getSessionDetailByToken}. */
export type GetSessionDetailByTokenResult =
  | {
      ok: true;
      summary: RecallEntry | null;
      skills: RecallEntry[];
      productivity: RecallEntry[];
      transcripts: RecallEntry[];
    }
  | { ok: false; message: string };

/**
 * Gather one shared session's detail behind a token. Requires NO session.
 *
 * Resolves + validates the token, then — when the manifest carries a non-empty
 * `sessionIds` whitelist — rejects sessions not on it. It reuses the SAME
 * multi-pass {@link gatherSessionNamespace} helper as the owner action, but
 * recalls through a per-request token client (built like {@link recallByToken})
 * and ONLY gathers namespaces present in `manifest.namespaces`. So a Summary
 * share yields empty `transcripts`; skills / productivity are gathered only
 * when allowed. The `sessions` namespace is always used for the summary when
 * present in the manifest.
 *
 * Every recall is additionally narrowed by {@link filterByManifestScope} so any
 * `blobIds` / `sessionIds` whitelist on the manifest is enforced. Best-effort
 * coverage (semantic recall + 100/pass cap), not a guaranteed listing.
 */
export async function getSessionDetailByToken(input: {
  token: string;
  sessionId: string;
}): Promise<GetSessionDetailByTokenResult> {
  try {
    const record = await getShareStore().getByToken(input.token);
    if (record === null) {
      return { ok: false, message: "This share link is not valid or has expired." };
    }
    if (record.revokedAt !== null) {
      return { ok: false, message: "This share link has been revoked." };
    }

    const gate = await recipientGate(record);
    if (!gate.ok) {
      return { ok: false, message: gate.message };
    }

    const sessionIds = record.manifest.sessionIds;
    if (
      sessionIds !== undefined &&
      sessionIds.length > 0 &&
      !sessionIds.includes(input.sessionId)
    ) {
      return { ok: false, message: "This session is not shared." };
    }

    const allowed = new Set<Namespace>(record.manifest.namespaces);
    const client = clientForRecord(record);

    // Token recall fn: recall + enforce the manifest scope on every pass.
    const recall: SessionRecallFn = async (params) => {
      const result = await client.recall(params);
      return filterByManifestScope(result.results, record.manifest);
    };

    // Summary from `sessions` (only if the manifest allows it).
    const sessions = allowed.has("sessions")
      ? await gatherSessionNamespace({
          recall,
          namespace: "sessions",
          sessionId: input.sessionId,
          queries: queriesForNamespace("sessions", ""),
        })
      : [];
    const summary = sessions[0] ?? null;
    const summaryText = summary?.text ?? "";

    const gatherIfAllowed = async (
      namespace: Namespace,
    ): Promise<RecallEntry[]> =>
      allowed.has(namespace)
        ? gatherSessionNamespace({
            recall,
            namespace,
            sessionId: input.sessionId,
            queries: queriesForNamespace(namespace, summaryText),
          })
        : [];

    const [skills, productivity, transcripts] = await Promise.all([
      gatherIfAllowed("skills"),
      gatherIfAllowed("productivity"),
      gatherIfAllowed("transcripts"),
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

/**
 * Run one Reader Agent turn for a recipient, constrained to the manifest.
 *
 * Loads and validates the share, then intersects the preset's namespaces with
 * the manifest's allowed namespaces. If nothing remains, the preset isn't
 * available for this share and a friendly `{ ok: false }` is returned.
 * Otherwise it builds a per-request client from the decrypted key and hands it
 * to {@link runReader}.
 *
 * Note: blob-id-level filtering inside the reader is intentionally skipped this
 * wave — the reader reasons over namespace-level grounding only. Session-level
 * filtering (honoring `manifest.sessionIds` inside the reader's recall) is
 * likewise future work; the reader currently constrains only by namespace
 * intersection.
 */
export async function askReaderByToken(input: {
  token: string;
  preset: ReaderPreset;
  messages: ReaderMessage[];
  /**
   * When present and non-empty, the recipient assistant is SCOPED to these
   * shared sessions: it reads only the selected session(s), constrained to the
   * share's manifest namespaces. The selection is additionally intersected with
   * the manifest's `sessionIds` whitelist (when set) as defense-in-depth.
   */
  sessionIds?: string[];
}): Promise<RunReaderResult> {
  const record = await getShareStore().getByToken(input.token);
  if (record === null) {
    return { ok: false, message: "This share link is not valid or has expired." };
  }
  if (record.revokedAt !== null) {
    return { ok: false, message: "This share link has been revoked." };
  }

  const gate = await recipientGate(record);
  if (!gate.ok) {
    return { ok: false, message: gate.message };
  }

  // Defense-in-depth: a scoped request may only target sessions the manifest
  // allows. If the manifest carries a session whitelist, intersect with it.
  let scopedIds = input.sessionIds ?? [];
  const manifestSessionIds = record.manifest.sessionIds;
  if (manifestSessionIds !== undefined && manifestSessionIds.length > 0) {
    const allow = new Set(manifestSessionIds);
    scopedIds = scopedIds.filter((id) => allow.has(id));
  }
  const manifestRepo =
    typeof record.manifest.repo === "string" && record.manifest.repo.length > 0
      ? record.manifest.repo
      : undefined;
  // A repo-scoped share always reasons in scoped mode (repo-filtered), even
  // when the recipient hasn't selected individual sessions — so the assistant
  // can never surface memories outside the shared project.
  const scoped = scopedIds.length > 0 || manifestRepo !== undefined;

  // Trusted, non-memory provenance the recipient assistant should know. These
  // facts come from the share record, NOT from Walrus, so without this the
  // assistant cannot answer "whose work is this" / "what is this share" / "what
  // is its title".
  //
  // Present them as plainly-LABELED facts rather than redefining the word
  // "subject": the model then answers correctly for any phrasing —
  //   - "share title" / "subject title" -> the label,
  //   - "who is the subject" / "whose work is this" -> the developer (sender),
  // without conflating the two (the earlier bug) or collapsing them (the
  // over-correction where "subject title" was read as the person's job title).
  const subject =
    record.label !== null && record.label.trim().length > 0
      ? record.label.trim()
      : null;
  const sender = senderDisplay(record);
  const facts: string[] = [
    `- Shared by / author: ${sender} — the single developer whose captured work the memories below are (their linked email if available, otherwise their account id). The memories are this one developer's work; there is no separate person.`,
    subject !== null
      ? `- Share title: "${subject}" — the label the owner gave this shared view. It is a topic label, not a person and not a job title.`
      : `- Share title: (the owner did not set a title for this share).`,
  ];
  if (manifestRepo !== undefined) {
    facts.push(`- Project / repository: ${manifestRepo}.`);
  }
  const contextNote =
    "Share provenance (these facts come from the share record, NOT from the " +
    "recalled memories below). Use them to answer questions about what this " +
    "share is, its title, who shared it, or whose work it is:\n" +
    facts.join("\n");

  // For the UNSCOPED path the preset's namespaces must overlap the manifest;
  // the SCOPED path instead reads the manifest namespaces directly (see below),
  // so this gate only applies when not scoping by session or repo.
  if (!scoped) {
    const presetNamespaces = PRESET_NAMESPACES[input.preset];
    const allowed = new Set<Namespace>(record.manifest.namespaces);
    const intersection = presetNamespaces.filter((ns) => allowed.has(ns));
    if (intersection.length === 0) {
      return {
        ok: false,
        message: "This assistant preset isn't available for this shared view.",
      };
    }
  }

  try {
    const client = clientForRecord(record);
    return await runReader(
      {
        preset: input.preset,
        messages: input.messages,
        contextNote,
        // Scoped reads are constrained to the manifest's namespaces so a
        // Summary share can never surface transcripts via the assistant, and
        // to the manifest's repo (when set) so a project share can never
        // surface another project's memories.
        ...(scoped
          ? {
              ...(scopedIds.length > 0 ? { sessionIds: scopedIds } : {}),
              ...(manifestRepo !== undefined ? { repo: manifestRepo } : {}),
              scopeNamespaces: record.manifest.namespaces,
            }
          : {}),
      },
      client,
    );
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}


/** Per-token recall limit for the cross-source compare assistant. */
const COMPARE_RECALL_LIMIT = 10;

/**
 * A recalled memory tagged with the share it came from, so the cross-source
 * assistant can attribute claims to a specific person/share in its reasoning.
 */
interface SourcedMemory extends UsedMemory {
  /** Short, human-readable source label (share label or `share #i`). */
  source: string;
}

/**
 * Scan a conversation for the most recent non-empty user message — this is the
 * recall query for the turn. Returns `null` when there is nothing to recall on.
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
 * Resolve the chat model id, mirroring the Reader Agent: `OPENAI_MODEL` wins,
 * else the shared {@link READER_MODEL} default. Read at call time so a
 * deployment can switch models without a rebuild.
 */
function resolveCompareModel(): string {
  const override = process.env["OPENAI_MODEL"];
  return typeof override === "string" && override.length > 0 ? override : READER_MODEL;
}

/**
 * Build the OpenAI-compatible client, mirroring the Reader Agent's resolution
 * via `OPENAI_API_KEY` / `OPENAI_BASE_URL`. Construction throws synchronously
 * when the key is missing; the caller collapses that into `{ ok: false }`.
 */
function resolveCompareClient(): OpenAI {
  const apiKey =
    process.env["OPENAI_API_KEY"] ?? process.env["AWS_BEARER_TOKEN_BEDROCK"];
  const baseURL = process.env["OPENAI_BASE_URL"];
  return new OpenAI({
    apiKey,
    ...(typeof baseURL === "string" && baseURL.length > 0 ? { baseURL } : {}),
  });
}

/**
 * Build the system prompt for a cross-source compare turn.
 *
 * Reuses the preset persona, then lists the candidates in scope (each source's
 * sender + subject) up front so the model knows WHO it is comparing even for a
 * source that recalled no memories. After that, each recalled memory is
 * prefixed with its source label so the model can attribute every claim to a
 * specific share and never mix evidence between candidates.
 *
 * Candidate identity and subject are NOT stored in Walrus — they come from the
 * share record (SQLite). We inject them here so the assistant can name each
 * candidate; without this it would only see anonymous memory text.
 */
function buildCompareSystemPrompt(
  preset: ReaderPreset,
  sources: readonly string[],
  memories: readonly SourcedMemory[],
): string {
  const persona = PRESET_SYSTEM_PROMPTS[preset];
  const multi = sources.length > 1;
  const intro = [
    persona,
    "",
    multi
      ? "You are comparing multiple people side by side. Each context memory is tagged with its source. When you reference evidence, attribute it to the correct source. Never mix evidence between sources, and never invent facts that are not in the context."
      : "You are reasoning over a single shared source. Each context memory is tagged with its source; attribute evidence to that source and never invent facts that are not in the context.",
  ].join(" ");
  const roster =
    sources.length > 0
      ? [
          "",
          "Sources in this comparison — each line is ONE developer, shown as " +
            '"who shared it — share title" (the title is a topic label, not a person):',
          ...sources.map((label, index) => `${index + 1}. ${label}`),
        ]
      : [];
  if (memories.length === 0) {
    return [
      intro,
      ...roster,
      "",
      "Context memories:",
      "(no memories were recalled across the shared sources)",
    ].join("\n");
  }
  const lines = memories.map(
    (memory, index) =>
      `${index + 1}. [${memory.source}] [distance ${memory.distance.toFixed(3)}] ${memory.text}`,
  );
  return [intro, ...roster, "", "Context memories:", ...lines].join("\n");
}

/** Input accepted by {@link askCompare}. */
export interface AskCompareInput {
  /** Opaque share tokens to reason across. Invalid/revoked ones are skipped. */
  tokens: string[];
  /** Reasoning persona; selects which namespaces are recalled. */
  preset: ReaderPreset;
  /** Running conversation. The latest user turn drives recall. */
  messages: ReaderMessage[];
}

/**
 * Run one cross-source Reader Agent turn over MANY shares at once.
 *
 * For each token: load the share, skip unknown/revoked ones, build a
 * per-request client from the decrypted delegate key, and recall the
 * intersection of the preset's namespaces and the share's manifest (limited per
 * namespace). Each recalled memory is tagged with a short source label, all are
 * merged, and the combined context is reasoned over by an OpenAI-compatible
 * model under the preset persona — mirroring the Reader Agent's model path.
 *
 * Returns the standard discriminated union and never throws: any failure (no
 * usable shares, missing config, recall/SDK error) collapses to
 * `{ ok: false, message }`. The delegate keys are used only in-memory for this
 * turn and are never logged or returned.
 */
export async function askCompare(input: AskCompareInput): Promise<RunReaderResult> {
  try {
    const query = latestUserQuery(input.messages);
    if (query === null) {
      return { ok: false, message: "No user message to respond to." };
    }

    const presetNamespaces = PRESET_NAMESPACES[input.preset];
    const store = getShareStore();

    const merged: SourcedMemory[] = [];
    /** Roster of candidates in scope ("sender — subject"), for the prompt. */
    const sources: string[] = [];
    let usableShares = 0;

    for (let i = 0; i < input.tokens.length; i++) {
      const token = input.tokens[i];
      if (token === undefined || token.length === 0) continue;

      const record = await store.getByToken(token);
      if (record === null || record.revokedAt !== null) continue;

      const allowed = new Set<Namespace>(record.manifest.namespaces);
      const namespaces = presetNamespaces.filter((ns) => allowed.has(ns));
      if (namespaces.length === 0) continue;

      // Candidate identity + subject come from the share record (SQLite), NOT
      // from Walrus — the recalled memories carry neither. The sender is the
      // share's linked email (else the FULL account id, never abbreviated) and
      // the subject is the share label, so the assistant can name each
      // candidate and their subject when comparing.
      const subject =
        record.label !== null && record.label.trim().length > 0
          ? record.label.trim()
          : null;
      const sender = senderDisplay(record);
      const source =
        subject !== null ? `${sender} — ${subject}` : `${sender} (share #${i + 1})`;
      sources.push(source);

      const client = clientForRecord(record);
      const whitelist = record.manifest.blobIds;
      const allowList =
        whitelist !== undefined && whitelist.length > 0 ? new Set(whitelist) : null;

      let contributed = false;
      for (const namespace of namespaces) {
        const recalled = await client.recall({
          namespace,
          query,
          limit: COMPARE_RECALL_LIMIT,
          maxDistance: DEFAULT_MAX_DISTANCE,
        });
        for (const entry of recalled.results) {
          if (allowList !== null && !allowList.has(entry.blob_id)) continue;
          merged.push({ text: entry.text, distance: entry.distance, source });
          contributed = true;
        }
      }
      if (contributed || namespaces.length > 0) usableShares += 1;
    }

    if (usableShares === 0) {
      return {
        ok: false,
        message: "None of the provided links are valid for this assistant.",
      };
    }

    // Strongest grounding first, regardless of source.
    merged.sort((a, b) => a.distance - b.distance);

    const chatClient = resolveCompareClient();
    const system = buildCompareSystemPrompt(input.preset, sources, merged);
    const response = await chatClient.chat.completions.create({
      model: resolveCompareModel(),
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
      return { ok: false, message: "The assistant returned an empty reply." };
    }

    const usedMemories: UsedMemory[] = merged.map((memory) => ({
      text: memory.text,
      distance: memory.distance,
    }));

    return { ok: true, reply, usedMemories };
  } catch (error) {
    return { ok: false, message: toErrorMessage(error) };
  }
}
