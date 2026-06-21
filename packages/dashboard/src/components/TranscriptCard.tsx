"use client";

/**
 * TranscriptCard — renders a single transcript chunk IN FULL, with structure.
 *
 * A chunk is the raw, sanitized conversation text for one (or part of one)
 * turn. Rather than dumping the whole string into a single paragraph — which
 * reads as an undifferentiated wall of text — this card:
 *
 *   1. Splits the chunk into speaker segments at role markers (`User:`,
 *      `Assistant:`, `<assistant>`, `**User:**`, etc.), labelling each with a
 *      small pastel Badge so the reader can scan who said what.
 *   2. Splits each segment's body on blank lines into separate paragraphs, so
 *      long turns get a readable rhythm instead of one dense block.
 *
 * Text is still rendered verbatim (no markdown interpretation) with preserved
 * whitespace (`whitespace-pre-wrap`) and long-token wrapping (`break-words`).
 *
 * The footer carries a small "Transcript" Badge with the per-session chunk
 * index when present (`entry.index`) and the {@link BlobProof} "Stored on
 * Walrus" affordance, mirroring the other card components.
 */

import type { RecallEntry } from "@uberwal/shared";
import { Badge, Card } from "./ui";
import type { BadgeVariant } from "./ui";
import { BlobProof } from "./BlobProof";

/** One speaker segment parsed out of a transcript chunk. */
interface Segment {
  /** Display role label ("User", "Assistant", "System", …) or null for an unlabelled preamble. */
  role: string | null;
  /** The segment body with the role marker stripped from its first line. */
  body: string;
}

/**
 * Matches a role marker at the start of a line and captures the role word.
 * Tolerates leading whitespace, markdown decoration (`**`, `#`, `>`, …) and
 * angle-bracket tag forms (`<assistant>`). Mirrors the chunker's TURN_START
 * so the UI segments the same boundaries the server split on.
 */
const ROLE_MARKER =
  /^[ \t]*(?:[#>*_~`-]+[ \t]*)*(?:<\s*\/?\s*)?(user|human|assistant|ai|system|developer|tool)\s*(?:>|:)\s?/i;

/** Title-case a captured role token, special-casing the "AI" initialism. */
function formatRole(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === "ai") return "AI";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Pick a muted pastel Badge variant per role; everything else stays neutral. */
function roleVariant(role: string | null): BadgeVariant {
  if (role === "User" || role === "Human") return "blue";
  if (role === "Assistant" || role === "AI") return "green";
  return "neutral";
}

/** Split a chunk into ordered speaker segments. Never returns an empty list. */
function parseSegments(text: string): Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let role: string | null = null;
  let buffer: string[] = [];
  let started = false;

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body.length > 0 || role !== null) segments.push({ role, body });
  };

  for (const line of lines) {
    const match = ROLE_MARKER.exec(line);
    if (match) {
      if (started) flush();
      role = formatRole(match[1] as string);
      buffer = [line.slice(match[0].length)];
      started = true;
    } else {
      buffer.push(line);
      started = true;
    }
  }
  if (started) flush();

  return segments.length > 0 ? segments : [{ role: null, body: text.trim() }];
}

/** Split a body into paragraphs on blank lines, trimming and dropping empties. */
function toParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export interface TranscriptCardProps {
  entry: RecallEntry;
}

export function TranscriptCard({ entry }: TranscriptCardProps) {
  const hasIndex = typeof entry.index === "number";
  const segments = parseSegments(entry.text);

  return (
    <Card className="flex flex-col animate-slide-up">
      <div className="flex flex-col gap-5 p-6">
        {segments.map((segment, segmentIndex) => {
          const paragraphs = toParagraphs(segment.body);
          return (
            <div key={segmentIndex} className="flex flex-col gap-2">
              {segment.role ? (
                <Badge variant={roleVariant(segment.role)}>{segment.role}</Badge>
              ) : null}
              {paragraphs.length > 0 ? (
                <div className="flex flex-col gap-2 text-sm leading-relaxed text-ink">
                  {paragraphs.map((paragraph, paragraphIndex) => (
                    <p
                      key={paragraphIndex}
                      className="whitespace-pre-wrap break-words"
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-canvas px-6 py-3">
        <span className="flex items-center gap-2">
          <Badge variant="neutral">
            {hasIndex ? `Transcript #${entry.index}` : "Transcript"}
          </Badge>
        </span>

        {entry.blob_id ? (
          <BlobProof blobId={entry.blob_id} idWidthClass="max-w-[120px]" />
        ) : null}
      </div>
    </Card>
  );
}

export default TranscriptCard;
