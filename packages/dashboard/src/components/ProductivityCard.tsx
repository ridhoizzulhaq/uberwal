"use client";

import type { RecallEntry } from "@uberwal/shared";
import { formatDistance, relevanceBand } from "../lib/format";
import { Badge, Card } from "./ui";
import { BlobProof } from "./BlobProof";

export interface ProductivityCardProps {
  entry: RecallEntry;
}

export function ProductivityCard({ entry }: ProductivityCardProps) {
  const band = relevanceBand(entry.distance);

  return (
    <Card className="group flex h-full flex-col animate-slide-up">
      <div className="flex flex-1 flex-col p-6">
        <p className="flex-1 text-sm leading-relaxed text-ink">{entry.text}</p>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="flex items-center gap-2">
            <span className="sr-only">Relevance: </span>
            <Badge variant={band.variant}>{band.label}</Badge>
            <span className="font-mono text-[11px] tabular-nums text-muted">
              {formatDistance(entry.distance)}
            </span>
          </span>

          {entry.blob_id ? <BlobProof blobId={entry.blob_id} /> : null}
        </div>
      </div>
    </Card>
  );
}

export default ProductivityCard;
