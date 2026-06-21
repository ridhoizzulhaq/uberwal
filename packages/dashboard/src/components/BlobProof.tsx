"use client";

import { useState } from "react";
import { SealCheck, Copy, Check } from "@phosphor-icons/react";

export interface BlobProofProps {
  /** The full Walrus blob id — the content-addressed integrity handle. */
  blobId: string;
  /** Tailwind max-width utility applied to the truncated id. */
  idWidthClass?: string;
}

/**
 * BlobProof — renders a recall entry's `blob_id` as an integrity affordance.
 *
 * The row reads as proof the memory is "Stored on Walrus": a verification
 * seal, the truncated mono blob id, and a copy-to-clipboard control. Clicking
 * copies the full blob id and surfaces a transient "Copied" state. The full id
 * is always present in the DOM (mono, truncated) so it remains inspectable and
 * accessible.
 */
export function BlobProof({ blobId, idWidthClass = "max-w-[96px]" }: BlobProofProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard?.writeText(blobId);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); the id stays
      // visible in the DOM so it can still be selected manually.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Stored on Walrus · ${blobId}`}
      aria-label={
        copied
          ? `Blob ID copied to clipboard`
          : `Copy blob ID ${blobId}, stored on Walrus`
      }
      className="group/proof flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 text-muted transition-colors duration-150 hover:bg-canvas hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-border"
    >
      <SealCheck
        weight="fill"
        className="h-3.5 w-3.5 shrink-0 text-pastel-greenText"
        aria-hidden="true"
      />
      <span className="sr-only">Stored on Walrus, blob ID: </span>
      <span className={`font-mono text-[10px] truncate ${idWidthClass}`}>
        {blobId}
      </span>
      {copied ? (
        <Check weight="bold" className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Copy
          weight="regular"
          className="h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity duration-150 group-hover/proof:opacity-100"
          aria-hidden="true"
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

export default BlobProof;
