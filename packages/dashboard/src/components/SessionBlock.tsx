"use client";

import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { RecallEntry } from "@uberwal/shared";
import { formatDistance, truncateSession } from "../lib/format";
import { Button, Card } from "./ui";
import { BlobProof } from "./BlobProof";

export interface SessionBlockProps {
  entry: RecallEntry;
}

export function SessionBlock({ entry }: SessionBlockProps) {
  const [expanded, setExpanded] = useState<boolean>(false);

  const { display, isTruncated, full } = truncateSession(entry.text);
  const visibleText = expanded ? full : display;

  return (
    <Card className="flex flex-col animate-slide-up">
      <div className="p-6">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
          {visibleText}
          {isTruncated && !expanded ? (
            <span aria-hidden="true" className="text-border">{"…"}</span>
          ) : null}
        </p>

        {isTruncated ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-3 -ml-3 text-muted hover:text-ink"
          >
            <CaretDown
              weight="bold"
              className="h-3.5 w-3.5 transition-transform duration-150"
              style={{ transform: expanded ? "rotate(180deg)" : "none" }}
              aria-hidden="true"
            />
            {expanded ? "Show less" : "Show more"}
          </Button>
        ) : null}
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

export default SessionBlock;
