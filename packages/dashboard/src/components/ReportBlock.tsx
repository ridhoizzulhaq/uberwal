"use client";

import type { RecallEntry } from "@uberwal/shared";
import { formatDistance } from "../lib/format";
import { Card } from "./ui";
import { BlobProof } from "./BlobProof";

export interface ReportBlockProps {
  entry: RecallEntry;
}

function toParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function ReportBlock({ entry }: ReportBlockProps) {
  const paragraphs = toParagraphs(entry.text);

  return (
    <Card className="flex flex-col animate-slide-up">
      <div className="p-6">
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink">
          {paragraphs.map((paragraph, index) => (
            <p key={index} className="whitespace-pre-line break-words">
              {paragraph}
            </p>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-canvas px-6 py-3">
        <span className="font-mono text-[11px] text-muted">
          <span className="sr-only">Distance score: </span>
          <span aria-hidden="true" className="opacity-60">dist </span>
          <span className="tabular-nums">{formatDistance(entry.distance)}</span>
        </span>

        {entry.blob_id ? <BlobProof blobId={entry.blob_id} idWidthClass="max-w-[120px]" /> : null}
      </div>
    </Card>
  );
}

export default ReportBlock;
