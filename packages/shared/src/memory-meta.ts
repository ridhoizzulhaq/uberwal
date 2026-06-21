/**
 * Memory metadata codec — a tiny, pure (no I/O) header embedded inside the
 * TEXT that MemWal stores per memory.
 *
 * MemWal only persists a single string per memory (`remember(text, namespace)`)
 * and recall returns `{ blob_id, text, distance }`. There is no native slot
 * for structured metadata, so to record *which session* a stored
 * skill/productivity/transcript came from we prepend a compact, self-describing
 * header line to the stored text at commit time and strip it back out at recall
 * time.
 *
 * Wire format (one line, terminated by the first `"\n"`):
 *
 *   UBERWAL_META:v1:<base64url(JSON.stringify(meta))>\n<body>
 *
 * Design choices:
 *   - The `UBERWAL_META:v1:` prefix is unambiguous and versioned so old
 *     memories (stored before this header existed) and arbitrary transcript
 *     text are never mistaken for metadata.
 *   - base64url keeps the header on a single line regardless of what the JSON
 *     contains (no stray newlines), so the first `"\n"` reliably delimits the
 *     header from the body.
 *   - {@link parseMemory} NEVER throws and is a strict no-op for any text that
 *     does not begin with the prefix, so backward compatibility is guaranteed.
 */

/** Structured metadata embedded in a stored memory's text header. */
export interface MemoryMeta {
  /** The session this memory was captured from. */
  sessionId: string;
  /** Candidate/storage type (e.g. "skill", "session", "productivity", "transcript"). */
  type?: string;
  /** Sequential index within the session (used for transcript chunks). */
  index?: number;
  /**
   * Project/repository this memory belongs to — a host-agnostic grouping label
   * (e.g. a workspace folder name or a git remote's last path segment), NOT a
   * GitHub integration. Lets many sessions be grouped under one project for
   * selecting, scoping the assistant, and sharing. Optional and backward
   * compatible: memories captured before the repo axis simply omit it.
   */
  repo?: string;
  /**
   * Capture time (epoch milliseconds) stamped when the session was extracted.
   * Optional and backward compatible: memories captured before this field
   * simply omit it. Gives every memory a sortable "when" without changing any
   * read semantics; also the foundation for future version selection.
   */
  capturedAt?: number;
}

/** Versioned, unambiguous prefix that marks a metadata header line. */
export const MEMORY_META_PREFIX = "UBERWAL_META:v1:";

/**
 * Embed `meta` as a header line in front of `body`.
 *
 * Returns `MEMORY_META_PREFIX + base64url(JSON.stringify(meta)) + "\n" + body`.
 * The body is preserved byte-for-byte (including any newlines or text that
 * itself looks like a header), so {@link parseMemory} can recover it exactly.
 */
export function encodeMemory(meta: MemoryMeta, body: string): string {
  const json = JSON.stringify(meta);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `${MEMORY_META_PREFIX}${encoded}\n${body}`;
}

/**
 * Parse a stored memory's text, splitting an optional metadata header from the
 * body.
 *
 * - Text that does not start with {@link MEMORY_META_PREFIX} is returned
 *   unchanged as the body with `meta: null`.
 * - Otherwise the segment between the prefix and the first `"\n"` is
 *   base64url-decoded and JSON-parsed. The result must be an object with a
 *   string `sessionId` (and an optional string `type`, optional finite-number
 *   `index`, and optional string `repo`).
 * - On ANY malformation (no newline, bad base64, bad JSON, missing/non-string
 *   `sessionId`) the entire input is treated as a plain body with `meta: null`.
 *
 * This function NEVER throws.
 */
export function parseMemory(text: string): { meta: MemoryMeta | null; body: string } {
  if (!text.startsWith(MEMORY_META_PREFIX)) {
    return { meta: null, body: text };
  }

  const newlineIndex = text.indexOf("\n");
  if (newlineIndex === -1) {
    // Header marker but no terminator — not a valid header. Treat as body.
    return { meta: null, body: text };
  }

  const encoded = text.slice(MEMORY_META_PREFIX.length, newlineIndex);
  const body = text.slice(newlineIndex + 1);

  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);

    if (typeof parsed !== "object" || parsed === null) {
      return { meta: null, body: text };
    }

    const record = parsed as Record<string, unknown>;
    const sessionId = record["sessionId"];
    if (typeof sessionId !== "string") {
      return { meta: null, body: text };
    }

    const meta: MemoryMeta = { sessionId };

    const type = record["type"];
    if (typeof type === "string") {
      meta.type = type;
    }

    const index = record["index"];
    if (typeof index === "number" && Number.isFinite(index)) {
      meta.index = index;
    }

    // Optional repo tag. Read explicitly (like every other field) because this
    // parser builds `meta` from known keys only — an unread key would be
    // silently dropped on the round-trip. Non-string values are ignored.
    const repo = record["repo"];
    if (typeof repo === "string" && repo.length > 0) {
      meta.repo = repo;
    }

    // Optional capture timestamp (epoch ms). Read explicitly like every other
    // field; non-finite/non-number values are ignored.
    const capturedAt = record["capturedAt"];
    if (typeof capturedAt === "number" && Number.isFinite(capturedAt)) {
      meta.capturedAt = capturedAt;
    }

    return { meta, body };
  } catch {
    // Bad base64 / bad JSON / anything unexpected → treat the whole thing as body.
    return { meta: null, body: text };
  }
}
