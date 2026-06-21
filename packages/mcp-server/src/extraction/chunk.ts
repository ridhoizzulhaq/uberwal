/**
 * Transcript chunking for the `transcripts` namespace.
 *
 * A coding-session transcript is split into discrete chunks so that semantic
 * recall can surface the *relevant* part of a long session rather than one
 * giant low-signal blob. Chunks are committed automatically (no per-chunk
 * review) during `commit_session`, while skill/productivity facts stay
 * review-first.
 *
 * Strategy:
 *  1. Split the transcript on conversation-turn boundaries (lines that begin
 *     with a role marker such as `User:`, `Assistant:`, `Human:`, `System:`,
 *     `**User:**`, or `<assistant>`). Each turn becomes one chunk.
 *  2. If a single turn exceeds {@link MAX_CHUNK_CHARS}, it is further split
 *     into fixed-size windows with a small overlap so context isn't lost at
 *     the seam.
 *  3. When the transcript contains no recognizable turn markers, the whole
 *     text is treated as a single turn (then size-split if necessary).
 *
 * Chunking runs **after** sanitization, so every chunk this produces is
 * already redacted.
 *
 * The function is pure and deterministic for straightforward unit testing.
 */

import type { TranscriptChunk } from "../tools/candidate.js";

/** Maximum characters in a single chunk before it is size-split. */
export const MAX_CHUNK_CHARS = 4_000;

/** Overlap (in characters) between adjacent size-split windows of one turn. */
export const CHUNK_OVERLAP_CHARS = 200;

/**
 * Matches the start of a conversation turn at the beginning of a line.
 *
 * Tolerates leading whitespace, optional markdown bold/heading decoration,
 * and either a `:`/`>` delimiter (prose transcripts) — plus angle-bracket
 * tag forms like `<user>` / `<assistant>`. Case-insensitive.
 */
const TURN_START =
  /^[ \t]*(?:[#>*_~`-]+[ \t]*)*(?:<\s*\/?\s*)?(?:user|human|assistant|ai|system|developer|tool)(?:\s*>|\s*[:>])/i;

/** Options accepted by {@link chunkTranscript}. */
export interface ChunkOptions {
  /** Override the max chunk size (characters). Defaults to {@link MAX_CHUNK_CHARS}. */
  maxChars?: number;
  /** Override the inter-window overlap (characters). Defaults to {@link CHUNK_OVERLAP_CHARS}. */
  overlap?: number;
}

/**
 * Split `text` into windows of at most `maxChars`, advancing by
 * `maxChars - overlap` each step so adjacent windows share `overlap`
 * characters of context. Always makes forward progress (step ≥ 1).
 */
function splitBySize(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const step = Math.max(1, maxChars - overlap);
  const windows: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    windows.push(text.slice(start, start + maxChars));
    if (start + maxChars >= text.length) break;
  }
  return windows;
}

/**
 * Group transcript lines into conversation turns.
 *
 * A new turn begins at each line matching {@link TURN_START}. Lines before the
 * first marker (a preamble, if any) form their own leading turn so no content
 * is dropped. When no markers are found at all, the whole transcript is a
 * single turn.
 */
function splitIntoTurns(text: string): string[] {
  const lines = text.split("\n");
  const turns: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (TURN_START.test(line) && current.length > 0) {
      turns.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) turns.push(current.join("\n"));

  return turns;
}

/**
 * Chunk a (already-sanitized) transcript into ordered {@link TranscriptChunk}s.
 *
 * Chunks are numbered sequentially from 0 in reading order. Empty/whitespace
 * chunks are dropped, and the indices remain contiguous after dropping.
 *
 * @param transcript The sanitized transcript text.
 * @param options    Optional size/overlap overrides (mainly for tests).
 * @returns Ordered chunks; an empty array when the transcript is blank.
 */
export function chunkTranscript(
  transcript: string,
  options: ChunkOptions = {},
): TranscriptChunk[] {
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    return [];
  }

  const maxChars = options.maxChars ?? MAX_CHUNK_CHARS;
  const overlap = Math.min(
    options.overlap ?? CHUNK_OVERLAP_CHARS,
    Math.max(0, maxChars - 1),
  );

  const chunks: TranscriptChunk[] = [];
  let index = 0;

  for (const turn of splitIntoTurns(transcript)) {
    for (const window of splitBySize(turn, maxChars, overlap)) {
      if (window.trim().length === 0) continue;
      chunks.push({ index, text: window });
      index += 1;
    }
  }

  return chunks;
}
