"use client";

/**
 * Compare workspace — a consumer (lead / recruiter) surface for reviewing
 * several shared people side by side.
 *
 * A user pastes one or more share links (`/v/<token>`) or bare tokens; we parse
 * out the token and hold the list IN MEMORY ONLY (no localStorage). Each token
 * becomes a column showing a compact, recall-driven view of its key namespaces.
 * A single cross-source assistant at the top reasons across ALL added shares
 * via `askCompare`. The delegate keys never reach the browser — every recall
 * and reasoning turn is mediated server-side.
 *
 * Lives outside the (dashboard) route group → root layout only, zero login.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, Warning, X } from "@phosphor-icons/react";
import type { Namespace } from "@uberwal/shared";
import { getShareMeta, askCompare, type ShareMetaResult } from "../actions/shared-access";
import { ReaderChat } from "../../components/ReaderChat";
import { TokenNamespaceView } from "../../components/TokenNamespaceView";
import { Badge, Button, Card } from "../../components/ui";

/**
 * Namespaces a compare column shows by default, kept compact. Intersected with
 * each share's actual manifest so we never render a namespace it can't recall.
 */
const COMPARE_NAMESPACES: readonly Namespace[] = ["skills", "productivity"];

/**
 * Parse a pasted value into a bare token. Accepts a full `/v/<token>` URL
 * (with or without origin, query, or fragment) or a bare token. Returns the
 * trimmed token, or `null` when nothing usable remains.
 */
function parseToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let candidate = trimmed;
  const marker = "/v/";
  const markerIndex = candidate.indexOf(marker);
  if (markerIndex !== -1) {
    candidate = candidate.slice(markerIndex + marker.length);
  }
  // Strip anything after the token segment (path, query, or fragment).
  candidate = candidate.split(/[/?#]/)[0] ?? "";
  candidate = candidate.trim();
  return candidate.length > 0 ? candidate : null;
}

/** Short, display-friendly form of a token for column headers. */
function shortToken(token: string): string {
  return token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-4)}` : token;
}

interface CompareColumnProps {
  token: string;
  onRemove: (token: string) => void;
}

function CompareColumn({ token, onRemove }: CompareColumnProps) {
  const [meta, setMeta] = useState<ShareMetaResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getShareMeta({ token });
      if (!cancelled) setMeta(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const invalid = meta !== null && (!meta.ok || meta.revoked);
  const modeBadge =
    meta !== null && meta.ok
      ? meta.mode === "summary"
        ? { variant: "blue" as const, label: "Summary" }
        : { variant: "yellow" as const, label: "Full" }
      : null;

  const visibleNamespaces =
    meta !== null && meta.ok
      ? COMPARE_NAMESPACES.filter((ns) => meta.namespaces.includes(ns))
      : [];

  return (
    <Card className="flex min-w-0 flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate font-serif text-base font-semibold tracking-tight text-ink">
            {meta !== null && meta.ok && meta.label !== null && meta.label.length > 0
              ? meta.label
              : shortToken(token)}
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted">{shortToken(token)}</span>
            {modeBadge !== null ? <Badge variant={modeBadge.variant}>{modeBadge.label}</Badge> : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRemove(token)}
          aria-label={`Remove ${shortToken(token)}`}
          className="-mr-2 -mt-1 flex-shrink-0 text-muted hover:text-ink"
        >
          <X size={14} weight="bold" aria-hidden="true" />
        </Button>
      </div>

      {meta === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : invalid ? (
        <div className="flex items-center gap-2 self-start rounded-full bg-pastel-red px-3 py-1">
          <Warning size={13} weight="bold" className="text-pastel-redText" aria-hidden="true" />
          <span className="text-xs font-medium text-pastel-redText">
            {meta.ok && meta.revoked ? "Link revoked" : "Invalid or expired link"}
          </span>
        </div>
      ) : visibleNamespaces.length === 0 ? (
        <p className="text-sm text-muted">No comparable namespaces shared.</p>
      ) : (
        <div className="flex flex-col gap-8">
          {visibleNamespaces.map((namespace) => (
            <section key={namespace} className="flex flex-col gap-3">
              <h3 className="font-serif text-base font-semibold capitalize tracking-tight text-ink">
                {namespace}
              </h3>
              <TokenNamespaceView token={token} namespace={namespace} />
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function ComparePage() {
  // In-memory only. Never persisted to localStorage/sessionStorage.
  const [tokens, setTokens] = useState<string[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [inputError, setInputError] = useState<string | null>(null);

  const handleAdd = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const token = parseToken(draft);
      if (token === null) {
        setInputError("Paste a share link or token.");
        return;
      }
      if (tokens.includes(token)) {
        setInputError("That link is already added.");
        return;
      }
      setTokens((current) => [...current, token]);
      setDraft("");
      setInputError(null);
    },
    [draft, tokens],
  );

  const handleRemove = useCallback((token: string) => {
    setTokens((current) => current.filter((t) => t !== token));
  }, []);

  return (
    <main className="min-h-screen bg-canvas">
      {/* Top bar */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-6 py-4">
          <span className="font-serif text-lg font-semibold tracking-tight text-ink">
            Uberwal
          </span>
          <Badge variant="neutral">Compare</Badge>
          <p className="basis-full text-sm text-muted sm:basis-auto sm:ml-auto">
            Review shared people side by side. Nothing is saved.
          </p>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-10">
        {/* Add links */}
        <section className="flex flex-col gap-3">
          <h2 className="font-serif text-[22px] font-semibold tracking-tight text-ink">
            Shared links
          </h2>
          <form onSubmit={handleAdd} className="flex w-full items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <input
                type="text"
                value={draft}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  if (inputError !== null) setInputError(null);
                }}
                placeholder="Paste a /v/<token> link or a bare token…"
                aria-label="Share link or token"
                className={[
                  "w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm text-ink",
                  "placeholder:text-muted transition-colors duration-150",
                  "focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20",
                ].join(" ")}
              />
              {inputError !== null ? (
                <span className="text-xs text-pastel-redText">{inputError}</span>
              ) : null}
            </div>
            <Button type="submit" variant="primary" className="flex-shrink-0">
              <Plus size={15} weight="bold" aria-hidden="true" />
              Add
            </Button>
          </form>
        </section>

        {/* Cross-source assistant */}
        {tokens.length > 0 ? (
          <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="font-serif text-[22px] font-semibold tracking-tight text-ink">
                Cross-source assistant
              </h2>
              <p className="text-sm leading-relaxed text-muted">
                Ask one question across all {tokens.length}{" "}
                {tokens.length === 1 ? "source" : "sources"}. Answers are grounded in the
                shared memories.
              </p>
            </div>
            <ReaderChat
              initialPreset="recruiting"
              ask={(chatInput) => askCompare({ ...chatInput, tokens })}
            />
          </section>
        ) : null}

        {/* Columns */}
        {tokens.length === 0 ? (
          <Card className="p-8">
            <p className="text-sm text-muted">
              Add one or more shared links above to compare people side by side.
            </p>
          </Card>
        ) : (
          <section
            className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3"
            aria-label="Compared sources"
          >
            {tokens.map((token) => (
              <CompareColumn key={token} token={token} onRemove={handleRemove} />
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
