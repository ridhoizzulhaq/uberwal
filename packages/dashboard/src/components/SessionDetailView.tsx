"use client";

/**
 * SessionDetailView — the presentational body of a session's detail.
 *
 * Renders the four fixed sections in order — Summary, Skills, Productivity,
 * Transcript — exactly as they were previously inlined in the owner route
 * `app/s/[sessionId]/page.tsx`. It is purely presentational: it takes already
 * gathered data and owns no fetching, so it is reused by BOTH the owner detail
 * page and the recipient session-centric view (`/v/<token>`).
 *
 *   1. Summary       — the session summary's full text (never truncated).
 *   2. Skills        — grid of {@link SkillCard}.
 *   3. Productivity  — grid of {@link ProductivityCard}.
 *   4. Transcript    — the transcript chunks IN FULL via {@link TranscriptCard},
 *                      in the caller-provided (index-sorted) order.
 *
 * Each section shows a serif heading + a count and a quiet per-section empty
 * state.
 */

import type { RecallEntry } from "@uberwal/shared";

import { SkillCard } from "./SkillCard";
import { ProductivityCard } from "./ProductivityCard";
import { TranscriptCard } from "./TranscriptCard";
import { BlobProof } from "./BlobProof";
import { Card } from "./ui";

export interface SessionDetailViewProps {
  summary: RecallEntry | null;
  skills: RecallEntry[];
  productivity: RecallEntry[];
  transcripts: RecallEntry[];
}

/** A serif section heading paired with a mono count. */
function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="font-serif text-[19px] font-semibold tracking-tight text-ink">{label}</h2>
      <span className="font-mono text-xs text-muted">{count}</span>
    </div>
  );
}

/** Quiet per-section empty state. */
function SectionEmpty({ label }: { label: string }) {
  return (
    <p className="rounded-lg border border-border bg-surface px-4 py-6 text-sm text-muted">
      No {label}.
    </p>
  );
}

export function SessionDetailView({
  summary,
  skills,
  productivity,
  transcripts,
}: SessionDetailViewProps) {
  return (
    <>
      {/* Summary */}
      <section className="flex flex-col gap-3">
        <SectionHeading label="Summary" count={summary !== null ? 1 : 0} />
        {summary !== null ? (
          <Card className="flex flex-col">
            <div className="p-6">
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
                {summary.text}
              </p>
            </div>
            {summary.blob_id ? (
              <div className="flex items-center justify-end border-t border-border bg-canvas px-6 py-3">
                <BlobProof blobId={summary.blob_id} idWidthClass="max-w-[180px]" />
              </div>
            ) : null}
          </Card>
        ) : (
          <SectionEmpty label="summary" />
        )}
      </section>

      {/* Skills */}
      <section className="flex flex-col gap-3">
        <SectionHeading label="Skills" count={skills.length} />
        {skills.length > 0 ? (
          <ul
            aria-label="Skills"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {skills.map((entry, index) => (
              <li key={`${entry.blob_id}-${index}`}>
                <SkillCard entry={entry} />
              </li>
            ))}
          </ul>
        ) : (
          <SectionEmpty label="skills" />
        )}
      </section>

      {/* Productivity */}
      <section className="flex flex-col gap-3">
        <SectionHeading label="Productivity" count={productivity.length} />
        {productivity.length > 0 ? (
          <ul
            aria-label="Productivity"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {productivity.map((entry, index) => (
              <li key={`${entry.blob_id}-${index}`}>
                <ProductivityCard entry={entry} />
              </li>
            ))}
          </ul>
        ) : (
          <SectionEmpty label="productivity" />
        )}
      </section>

      {/* Transcript */}
      <section className="flex flex-col gap-3">
        <SectionHeading label="Transcript" count={transcripts.length} />
        {transcripts.length > 0 ? (
          <ul aria-label="Transcript" className="flex flex-col gap-3">
            {transcripts.map((entry, index) => (
              <li key={`${entry.blob_id}-${index}`}>
                <TranscriptCard entry={entry} />
              </li>
            ))}
          </ul>
        ) : (
          <SectionEmpty label="transcript" />
        )}
      </section>
    </>
  );
}

export default SessionDetailView;
